/**
 * Unit tests for the chat-artifact IPC handlers (TASK.72), exercised as the
 * exported handle* functions off a REAL node fs in scratch tmpdirs (no
 * Electron ipcMain). The load-bearing suites are the security gates:
 * containment (allowed roots = tab workspace / `<home>/.anycode` / tmpdir /
 * darwin-only literal `/tmp`, TASK.77-B), the open allowlist (non-image
 * extensions can never reach `openPath`), the inline byte cap, SVG refused
 * for inline read (active format), and per-tab per-path consent grants
 * (TASK.77-A) that widen WHERE a refused path may be read/opened without
 * ever widening WHAT the extension gates allow.
 */

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedArtifactRoots,
  ArtifactConsentStore,
  handleArtifactAllow,
  handleArtifactOpen,
  handleArtifactPreview,
  handleArtifactReadImage,
  handleArtifactReveal,
  isUnderRoot,
  MAX_INLINE_IMAGE_BYTES,
  NodeArtifactsFs,
  resolveContainedPath,
  type ArtifactsIpcDeps,
} from "./artifacts-ipc.js";

const TAB_ID = "tab-1";
const fs = new NodeArtifactsFs();
const dirs: string[] = [];

async function tmpDir(prefix = "artipc-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function seed(path: string, content: string | Buffer = "x"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

interface Rig {
  deps: ArtifactsIpcDeps;
  workspace: string;
  home: string;
  tmp: string;
  openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  reveal: ReturnType<typeof vi.fn<(path: string) => void>>;
  confirmOpen: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
  consent: ArtifactConsentStore;
  openPreview: ReturnType<typeof vi.fn<ArtifactsIpcDeps["openPreview"]>>;
}

/** workspace/home/tmp are three DISJOINT tmpdirs — the tmp root passed to deps is ours, not the OS one. */
async function makeRig(opts?: {
  noTab?: boolean;
  openError?: string;
  /** Answer of the outside-the-roots open confirmation (default: approve). */
  confirm?: boolean;
  /** Makes the confirmation itself throw — a gate that cannot be shown. */
  confirmThrows?: boolean;
}): Promise<Rig> {
  const workspace = await tmpDir();
  const home = await tmpDir();
  const tmp = await tmpDir();
  const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue(opts?.openError ?? "");
  const reveal = vi.fn<(path: string) => void>();
  const confirmOpen = vi.fn<(path: string) => Promise<boolean>>().mockImplementation(async () => {
    if (opts?.confirmThrows === true) throw new Error("no window to attach the sheet to");
    return opts?.confirm ?? true;
  });
  const consent = new ArtifactConsentStore();
  const openPreview = vi.fn<ArtifactsIpcDeps["openPreview"]>().mockResolvedValue({
    ok: true,
    value: { previewId: "preview-1", url: "file:///stub", kind: "file" },
  });
  const deps: ArtifactsIpcDeps = {
    home: () => home,
    tmpdir: () => tmp,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : workspace),
    fs,
    openPath,
    reveal,
    confirmOpen,
    consent,
    openPreview,
  };
  return { deps, workspace, home, tmp, openPath, reveal, confirmOpen, consent, openPreview };
}

// ---------------------------------------------------------------------------

describe("isUnderRoot", () => {
  it("accepts a child and the root itself, refuses siblings/prefix-siblings/parents", () => {
    expect(isUnderRoot("/a/b/c.png", "/a/b", "linux")).toBe(true);
    expect(isUnderRoot("/a/b", "/a/b", "linux")).toBe(true);
    expect(isUnderRoot("/a/b2/c.png", "/a/b", "linux")).toBe(false); // prefix sibling
    expect(isUnderRoot("/a/c.png", "/a/b", "linux")).toBe(false);
    expect(isUnderRoot("/a", "/a/b", "linux")).toBe(false);
  });

  it("normalizes trailing separators, dot segments, and (darwin) case", () => {
    expect(isUnderRoot("/a/b/c.png", "/a/b/", "linux")).toBe(true);
    expect(isUnderRoot("/a/x/../b/c.png", "/a/b", "linux")).toBe(true);
    expect(isUnderRoot("/A/B/c.png", "/a/b", "darwin")).toBe(true);
    expect(isUnderRoot("/A/B/c.png", "/a/b", "linux")).toBe(false);
    expect(isUnderRoot("C:\\WS\\x.png", "c:\\ws", "win32")).toBe(true);
  });
});

describe("allowedArtifactRoots", () => {
  it("is exactly workspace + <home>/.anycode + tmp on linux/win32 (home itself is NOT a root)", () => {
    expect(allowedArtifactRoots("/ws", "/home/u", "/tmp-x", "linux")).toEqual(["/ws", "/home/u/.anycode", "/tmp-x"]);
    // `join()` is the host's real path.join (NOT platform-parameterized) —
    // the expected middle element is computed the SAME way the function
    // itself computes it, so this test is honest on any host OS.
    expect(allowedArtifactRoots("C:\\ws", "C:\\Users\\u", "C:\\Users\\u\\AppData\\Local\\Temp", "win32")).toEqual([
      "C:\\ws",
      join("C:\\Users\\u", ".anycode"),
      "C:\\Users\\u\\AppData\\Local\\Temp",
    ]);
  });

  // TASK.77-B: darwin ONLY appends the literal "/tmp" (owner decision 31.07 —
  // os.tmpdir() on macOS is a per-app /var/folders/... path, not /tmp, and
  // agents routinely write to the literal path). Explicit `platform` arg per
  // recon C §2 — never stub os.platform().
  it("darwin: appends the literal /tmp root, on top of the injected tmp root", () => {
    expect(allowedArtifactRoots("/ws", "/home/u", "/tmp-x", "darwin")).toEqual([
      "/ws",
      "/home/u/.anycode",
      "/tmp-x",
      "/tmp",
    ]);
  });

  it("linux: unaffected by the darwin-only branch — no extra /tmp literal beyond the injected root", () => {
    expect(allowedArtifactRoots("/ws", "/home/u", "/tmp", "linux")).toEqual(["/ws", "/home/u/.anycode", "/tmp"]);
  });

  it("win32: unaffected — a C:\\tmp-shaped path is not contained by any returned root", () => {
    const roots = allowedArtifactRoots("C:\\ws", "C:\\Users\\u", "C:\\Users\\u\\AppData\\Local\\Temp", "win32");
    expect(roots).toHaveLength(3); // no darwin-only literal appended
    expect(roots).toEqual(["C:\\ws", join("C:\\Users\\u", ".anycode"), "C:\\Users\\u\\AppData\\Local\\Temp"]);
    expect(roots.some((root) => isUnderRoot("C:\\tmp\\evil.exe", root, "win32"))).toBe(false);
  });

  it("darwin: the generic per-root realpath+isUnderRoot mechanism contains a file under a SYMLINKED root (mirrors macOS's real /tmp -> /private/tmp, via a scratch fixture — never the real OS tmpdir)", async () => {
    const scratch = await tmpDir("tmp-root-fixture-");
    const realTarget = join(scratch, "private-tmp-real");
    const linkRoot = join(scratch, "tmp-link");
    await mkdir(realTarget, { recursive: true });
    await symlink(realTarget, linkRoot);
    await seed(join(realTarget, "scratch/plot.png"), "png");
    const resolvedFile = await realpath(join(linkRoot, "scratch/plot.png"));
    const resolvedRoot = await realpath(linkRoot);
    expect(isUnderRoot(resolvedFile, resolvedRoot, "darwin")).toBe(true);
  });
});

describe("resolveContainedPath", () => {
  it("resolves a file inside the workspace (absolute and workspace-relative forms)", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "out/icon.png"), "png");
    const abs = await resolveContainedPath(deps, TAB_ID, join(workspace, "out/icon.png"));
    const rel = await resolveContainedPath(deps, TAB_ID, "out/icon.png");
    expect(abs).toEqual({ realPath: await realpath(join(workspace, "out/icon.png")) });
    expect(rel).toEqual(abs);
  });

  it("resolves a file under <home>/.anycode (codex generated_images case) and under tmpdir", async () => {
    const { deps, home, tmp } = await makeRig();
    await seed(join(home, ".anycode/codex/profile-acc2/generated_images/icon.png"), "png");
    await seed(join(tmp, "scratch/plot.png"), "png");
    expect(await resolveContainedPath(deps, TAB_ID, join(home, ".anycode/codex/profile-acc2/generated_images/icon.png"))).toHaveProperty("realPath");
    expect(await resolveContainedPath(deps, TAB_ID, join(tmp, "scratch/plot.png"))).toHaveProperty("realPath");
  });

  it("expands ~/… into home for an allowed app-owned artifact", async () => {
    const { deps, home } = await makeRig();
    const image = join(home, ".anycode/codex/generated_images/icon.png");
    await seed(image, "png");
    expect(await resolveContainedPath(deps, TAB_ID, "~/.anycode/codex/generated_images/icon.png")).toEqual({ realPath: await realpath(image) });
  });

  it("refuses a file outside every root (e.g. directly under home)", async () => {
    const { deps, home } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    expect(await resolveContainedPath(deps, TAB_ID, join(home, "secret.png"))).toEqual({ failure: "outside_allowed_roots" });
  });

  it("refuses a symlink inside the workspace that points outside every root", async () => {
    const { deps, workspace, home } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    await symlink(join(home, "secret.png"), join(workspace, "linked.png"));
    expect(await resolveContainedPath(deps, TAB_ID, join(workspace, "linked.png"))).toEqual({ failure: "outside_allowed_roots" });
  });

  it("refuses `..` traversal out of the workspace", async () => {
    const { deps, workspace, home } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    // A real relative path FROM the workspace TO an existing out-of-root file.
    const traversal = relative(workspace, join(home, "secret.png"));
    expect(traversal.startsWith("..")).toBe(true);
    const result = await resolveContainedPath(deps, TAB_ID, traversal);
    expect(result).toEqual({ failure: "outside_allowed_roots" });
  });

  it("reports not_found for a missing file and no_workspace for an unknown tab", async () => {
    const { deps, workspace } = await makeRig();
    expect(await resolveContainedPath(deps, TAB_ID, join(workspace, "nope.png"))).toEqual({ failure: "not_found" });
    const noTab = await makeRig({ noTab: true });
    expect(await resolveContainedPath(noTab.deps, TAB_ID, join(workspace, "x.png"))).toEqual({ failure: "no_workspace" });
  });
});

describe("handleArtifactReadImage", () => {
  it("reads an in-root PNG as base64 with its mime type", async () => {
    const { deps, workspace } = await makeRig();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await seed(join(workspace, "icon.png"), bytes);
    const result = await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "icon.png") });
    expect(result).toEqual({ ok: true, mime: "image/png", dataBase64: bytes.toString("base64"), sizeBytes: bytes.length });
  });

  it("accepts every previewable extension and refuses SVG (active format) for inline read", async () => {
    const { deps, workspace } = await makeRig();
    for (const ext of ["jpg", "jpeg", "gif", "webp"]) {
      await seed(join(workspace, `img.${ext}`), "x");
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, `img.${ext}`) })).toMatchObject({ ok: true });
    }
    await seed(join(workspace, "icon.svg"), "<svg/>");
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "icon.svg") })).toEqual({ ok: false, reason: "not_previewable" });
    await seed(join(workspace, "notes.txt"), "x");
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "notes.txt") })).toEqual({ ok: false, reason: "not_previewable" });
  });

  it("refuses a path outside allowed roots, a missing file, and an invalid payload", async () => {
    const { deps, workspace, home } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "secret.png") })).toEqual({ ok: false, reason: "outside_allowed_roots" });
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "gone.png") })).toEqual({ ok: false, reason: "not_found" });
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a directory named like an image", async () => {
    const { deps, workspace } = await makeRig();
    await mkdir(join(workspace, "dir.png"), { recursive: true });
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "dir.png") })).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a file larger than the inline cap", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "huge.png"), Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 1));
    expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(workspace, "huge.png") })).toEqual({ ok: false, reason: "too_large" });
  });

  // TASK.77-A DoD: consent widens WHERE a preview may read from, per-path,
  // per-tab; a default rig (no Allow ever called) reproduces the pre-77-A
  // behavior exactly (the suite above already proves that with zero changes).
  describe("TASK.77-A consent", () => {
    it("without any Allow call, outside-roots is refused exactly as before (default unchanged)", async () => {
      const { deps, home, consent } = await makeRig();
      await seed(join(home, "outside.png"), "png");
      expect(consent.isAllowed(TAB_ID, join(home, "outside.png"))).toBe(false);
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "outside.png") })).toEqual({
        ok: false,
        reason: "outside_allowed_roots",
      });
    });

    it("Allow unlocks preview for the granted realPath only — a DIFFERENT outside path stays refused", async () => {
      const { deps, home, consent } = await makeRig();
      await seed(join(home, "a.png"), "png");
      await seed(join(home, "b.png"), "png");
      const allowResult = await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(home, "a.png") });
      expect(allowResult).toEqual({ ok: true, realPath: await realpath(join(home, "a.png")) });
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "a.png") })).toMatchObject({ ok: true });
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "b.png") })).toEqual({
        ok: false,
        reason: "outside_allowed_roots",
      });
      expect(consent.isAllowed(TAB_ID, join(home, "b.png"))).toBe(false);
    });

    it("a grant is per-tab: a second tab never sees the first tab's consent for the SAME path", async () => {
      const rig = await makeRig();
      await seed(join(rig.home, "shared.png"), "png");
      const TAB_2 = "tab-2";
      const twoTabDeps: ArtifactsIpcDeps = {
        ...rig.deps,
        workspaceForTab: (tabId) => (tabId === TAB_ID || tabId === TAB_2 ? rig.workspace : undefined),
      };
      await handleArtifactAllow(twoTabDeps, { tabId: TAB_ID, path: join(rig.home, "shared.png") });
      expect(await handleArtifactReadImage(twoTabDeps, { tabId: TAB_ID, path: join(rig.home, "shared.png") })).toMatchObject({ ok: true });
      expect(await handleArtifactReadImage(twoTabDeps, { tabId: TAB_2, path: join(rig.home, "shared.png") })).toEqual({
        ok: false,
        reason: "outside_allowed_roots",
      });
    });

    it("extension gates still apply post-consent: a consented PNG reads, a consented .command still can't inline-preview (not_previewable) or open (not_openable)", async () => {
      const { deps, home } = await makeRig({ confirm: true });
      await seed(join(home, "icon.png"), "png");
      await seed(join(home, "run.command"), "#!/bin/sh\n");
      await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(home, "icon.png") });
      await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(home, "run.command") });
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "icon.png") })).toMatchObject({ ok: true });
      expect(await handleArtifactReadImage(deps, { tabId: TAB_ID, path: join(home, "run.command") })).toEqual({ ok: false, reason: "not_previewable" });
      expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "run.command") })).toEqual({ ok: false, reason: "not_openable" });
    });

    it("Allow on a missing file reports not_found (no consent recorded)", async () => {
      const { deps, workspace, consent } = await makeRig();
      expect(await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(workspace, "gone.png") })).toEqual({ ok: false, reason: "not_found" });
      expect(consent.isAllowed(TAB_ID, join(workspace, "gone.png"))).toBe(false);
    });

    it("Allow on an unknown tab reports no_workspace", async () => {
      const { deps, workspace } = await makeRig({ noTab: true });
      expect(await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(workspace, "x.png") })).toEqual({ ok: false, reason: "no_workspace" });
    });
  });
});

describe("handleArtifactOpen", () => {
  it("openPaths an in-root image (allowlisted extension)", async () => {
    const { deps, workspace, openPath, reveal } = await makeRig();
    await seed(join(workspace, "icon.png"), "png");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(workspace, "icon.png") })).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(await realpath(join(workspace, "icon.png")));
    expect(reveal).not.toHaveBeenCalled();
  });

  it("keeps SVG reveal-only: an active format must never reach openPath", async () => {
    const { deps, workspace, openPath } = await makeRig();
    await seed(join(workspace, "icon.svg"), "<svg/>");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(workspace, "icon.svg") })).toEqual({ ok: false, reason: "not_openable" });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("NEVER openPaths a non-image (.command would EXECUTE) — refused not_openable", async () => {
    const { deps, workspace, openPath, reveal } = await makeRig();
    await seed(join(workspace, "run.command"), "#!/bin/sh\nrm -rf ~\n");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(workspace, "run.command") })).toEqual({ ok: false, reason: "not_openable" });
    expect(openPath).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("opens outside the roots only after the user confirms — and names the path in the prompt", async () => {
    const { deps, home, openPath, confirmOpen } = await makeRig({ confirm: true });
    await seed(join(home, "outside.png"), "png");
    const real = await realpath(join(home, "outside.png"));
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "outside.png") })).toEqual({ ok: true });
    // Asked about the RESOLVED path, not the model-authored string.
    expect(confirmOpen).toHaveBeenCalledWith(real);
    expect(openPath).toHaveBeenCalledWith(real);
  });

  it("does not open when the user declines, and never asks for an in-root file", async () => {
    const declined = await makeRig({ confirm: false });
    await seed(join(declined.home, "outside.png"), "png");
    expect(await handleArtifactOpen(declined.deps, { tabId: TAB_ID, path: join(declined.home, "outside.png") })).toEqual({
      ok: false,
      reason: "declined",
    });
    expect(declined.openPath).not.toHaveBeenCalled();

    const inRoot = await makeRig();
    await seed(join(inRoot.workspace, "icon.png"), "png");
    expect(await handleArtifactOpen(inRoot.deps, { tabId: TAB_ID, path: join(inRoot.workspace, "icon.png") })).toEqual({ ok: true });
    expect(inRoot.confirmOpen).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the confirmation cannot be shown", async () => {
    const { deps, home, openPath } = await makeRig({ confirmThrows: true });
    await seed(join(home, "outside.png"), "png");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "outside.png") })).toEqual({ ok: false, reason: "declined" });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("keeps the extension gate ahead of the prompt — no confirmation can widen it", async () => {
    const { deps, home, openPath, confirmOpen } = await makeRig({ confirm: true });
    await seed(join(home, "run.command"), "#!/bin/sh\nrm -rf ~\n");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "run.command") })).toEqual({ ok: false, reason: "not_openable" });
    // Never even asked: an executable outside the roots is refused outright.
    expect(confirmOpen).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("degrades to reveal when openPath reports a launch failure", async () => {
    const { deps, workspace, openPath, reveal } = await makeRig({ openError: "no application" });
    await seed(join(workspace, "icon.png"), "png");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(workspace, "icon.png") })).toEqual({ ok: true, resolvedTo: "reveal" });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // TASK.77-A DoD: an Allow grant skips the OS confirmation modal for the
  // SAME consented path ONLY — every other outside-root path (and a fresh
  // rig with no grant at all) keeps the unchanged modal behavior proven above.
  it("skips confirmOpen ONLY for a consented path — a different outside path still prompts", async () => {
    const { deps, home, openPath, confirmOpen } = await makeRig({ confirm: true });
    await seed(join(home, "consented.png"), "png");
    await seed(join(home, "not-consented.png"), "png");
    await handleArtifactAllow(deps, { tabId: TAB_ID, path: join(home, "consented.png") });

    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "consented.png") })).toEqual({ ok: true });
    expect(confirmOpen).not.toHaveBeenCalled();

    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "not-consented.png") })).toEqual({ ok: true });
    expect(confirmOpen).toHaveBeenCalledTimes(1);
    expect(confirmOpen).toHaveBeenCalledWith(await realpath(join(home, "not-consented.png")));
    expect(openPath).toHaveBeenCalledTimes(2);
  });
});

describe("handleArtifactReveal", () => {
  it("reveals any in-root file (no extension gate — reveal never executes)", async () => {
    const { deps, workspace, reveal } = await makeRig();
    await seed(join(workspace, "run.command"), "x");
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(workspace, "run.command") })).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith(await realpath(join(workspace, "run.command")));
  });

  it("reveals a file OUTSIDE the allowed roots — showItemInFolder neither reads nor runs it", async () => {
    const { deps, home, reveal, confirmOpen } = await makeRig();
    await seed(join(home, "outside.png"), "png");
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(home, "outside.png") })).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith(await realpath(join(home, "outside.png")));
    // Reveal is not the gated action — it must never raise the open prompt.
    expect(confirmOpen).not.toHaveBeenCalled();
  });

  it("still refuses a path that does not resolve", async () => {
    const { deps, workspace, reveal } = await makeRig();
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(workspace, "gone.png") })).toEqual({ ok: false, reason: "not_found" });
    expect(reveal).not.toHaveBeenCalled();
  });
});

// Night-track wave-1 (owner ask): user click on a local .html/.htm/.md
// artifact link opens/reopens it in PreviewHost. `openPreview` is a plain
// mock here — the real PreviewHost wiring is main/index.ts's concern
// (`openPreview: (tabId, realPath) => previewHost.openForPathClick(tabId,
// realPath)`, the click-dedup entrypoint — owner smoke-test defect fix);
// this suite only proves the containment/extension gate ahead of it.
describe("handleArtifactPreview", () => {
  it("opens an in-root .md file — calls openPreview with the REALPATH, not the raw string", async () => {
    const { deps, workspace, openPreview } = await makeRig();
    await seed(join(workspace, "notes.md"), "# hi");
    const result = await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, "notes.md") });
    expect(result).toEqual({ ok: true, value: { previewId: "preview-1", url: "file:///stub", kind: "file" } });
    expect(openPreview).toHaveBeenCalledWith(TAB_ID, await realpath(join(workspace, "notes.md")));
  });

  it("opens an in-root .html/.htm file", async () => {
    const { deps, workspace, openPreview } = await makeRig();
    await seed(join(workspace, "report.html"), "<html></html>");
    await seed(join(workspace, "legacy.htm"), "<html></html>");
    expect(await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, "report.html") })).toMatchObject({ ok: true });
    expect(await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, "legacy.htm") })).toMatchObject({ ok: true });
    expect(openPreview).toHaveBeenCalledTimes(2);
  });

  it("refuses a path outside every allowed root — never calls openPreview", async () => {
    const { deps, home, openPreview } = await makeRig();
    await seed(join(home, "outside.md"), "# hi");
    const result = await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(home, "outside.md") });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ errorKind: "invalid_input" });
    if (!result.ok) {
      expect(result.error).toContain("outside_allowed_roots");
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("refuses an unsupported extension even when in-root — never calls openPreview", async () => {
    const { deps, workspace, openPreview } = await makeRig();
    await seed(join(workspace, "icon.png"), "png");
    await seed(join(workspace, "run.command"), "#!/bin/sh\n");
    for (const name of ["icon.png", "run.command"]) {
      const result = await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, name) });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ errorKind: "invalid_input" });
    }
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("refuses a missing file and an invalid payload — never calls openPreview", async () => {
    const { deps, workspace, openPreview } = await makeRig();
    expect((await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, "gone.md") })).ok).toBe(false);
    expect((await handleArtifactPreview(deps, { tabId: TAB_ID })).ok).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
  });
});

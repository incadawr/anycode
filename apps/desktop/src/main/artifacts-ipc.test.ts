/**
 * Unit tests for the chat-artifact IPC handlers, exercised as the
 * exported handle* functions off a REAL node fs in scratch tmpdirs (no
 * Electron ipcMain). The load-bearing suites are the security gates:
 * containment (allowed roots = tab workspace / `<home>/.anycode` / tmpdir /
 * darwin-only literal `/tmp`), the open allowlist (non-image
 * extensions can never reach `openPath`), the inline byte cap, SVG refused
 * for inline read (active format), and per-tab per-path consent grants
 * that widen WHERE a refused path may be read/opened without
 * ever widening WHAT the extension gates allow.
 */

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Registration-level binding tests (bottom of this file) drive the guarded
// ipcMain surface; the mock is inert for the direct-handler suites above
// (they never touch ipcMain). Same "capturing fake" precedent as
// panel-ipc.test.ts / md-doc-ipc.test.ts.
const { capturedArtifactHandlers } = vi.hoisted(() => ({
  capturedArtifactHandlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
      capturedArtifactHandlers.set(channel, listener);
    },
    on: (channel: string, listener: (event: unknown, raw: unknown) => void): void => {
      capturedArtifactHandlers.set(channel, listener as unknown as (event: unknown, raw: unknown) => unknown);
    },
  },
}));

import { addIpcGuardTrustedWindow, setIpcGuardMainWindow } from "./ipc-guard.js";
import { registerMdWindowTarget, resetMdWindowTargetsForTests } from "./preview/md-window-targets.js";
import { registerPreviewHost, type MdPreviewWindowLike, type PreviewCapturedImage } from "./preview/preview-host.js";
import { ARTIFACT_PREVIEW_CHANNEL, ARTIFACT_PREVIEWABLE_CHANNEL, ARTIFACT_READ_IMAGE_CHANNEL, registerArtifactsIpc } from "./artifacts-ipc.js";
import {
  allowedArtifactRoots,
  ArtifactConsentStore,
  handleArtifactAllow,
  handleArtifactOpen,
  handleArtifactPreview,
  handleArtifactPreviewable,
  handleArtifactReadImage,
  handleArtifactReveal,
  isUnderRoot,
  MAX_INLINE_IMAGE_BYTES,
  MAX_PREVIEWABLE_PATHS,
  NodeArtifactsFs,
  resolveContainedPath,
  TAIL_INDEX_MAX_ENTRIES,
  TAIL_INDEX_TTL_MS,
  WorkspaceTailIndex,
  type ArtifactsFs,
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
  openPreviewForId: ReturnType<typeof vi.fn<ArtifactsIpcDeps["openPreviewForId"]>>;
  mdPreviewRealSourcePath: ReturnType<typeof vi.fn<ArtifactsIpcDeps["mdPreviewRealSourcePath"]>>;
  tailIndex: WorkspaceTailIndex;
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
  const tailIndex = new WorkspaceTailIndex();
  const openPreview = vi.fn<ArtifactsIpcDeps["openPreview"]>().mockResolvedValue({
    ok: true,
    value: { previewId: "preview-1", url: "file:///stub", kind: "file" },
  });
  const openPreviewForId = vi.fn<ArtifactsIpcDeps["openPreviewForId"]>().mockResolvedValue({
    ok: true,
    value: { previewId: "preview-1", url: "file:///stub", kind: "file" },
  });
  const mdPreviewRealSourcePath = vi.fn<ArtifactsIpcDeps["mdPreviewRealSourcePath"]>();
  const deps: ArtifactsIpcDeps = {
    home: () => home,
    tmpdir: () => tmp,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : workspace),
    fs,
    openPath,
    reveal,
    confirmOpen,
    consent,
    tailIndex,
    openPreview,
    openPreviewForId,
    mdPreviewRealSourcePath,
  };
  return { deps, workspace, home, tmp, openPath, reveal, confirmOpen, consent, openPreview, openPreviewForId, mdPreviewRealSourcePath, tailIndex };
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

  // darwin ONLY appends the literal "/tmp" (owner decision 31.07 —
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
    await seed(join(home, ".anycode/codex/profile-account-b/generated_images/icon.png"), "png");
    await seed(join(tmp, "scratch/plot.png"), "png");
    expect(await resolveContainedPath(deps, TAB_ID, join(home, ".anycode/codex/profile-account-b/generated_images/icon.png"))).toHaveProperty("realPath");
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

describe("tail-match base", () => {
  it("root hit is unchanged and does not consult the tail index", async () => {
    const { deps, workspace, tailIndex } = await makeRig();
    await seed(join(workspace, "plan.md"));
    const findUnique = vi.spyOn(tailIndex, "findUnique");
    expect(await resolveContainedPath(deps, TAB_ID, "plan.md")).toEqual({ realPath: await realpath(join(workspace, "plan.md")) });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("links a unique tail match in a subdirectory", async () => {
    const { deps, workspace } = await makeRig();
    const target = join(workspace, "working-docs/brief-next-stage.md");
    await seed(target);
    // deeper tail also matches (seeded BEFORE the first resolve — the walk is cached per TTL)
    const nested = join(workspace, "working-docs/reviews/stage2.md");
    await seed(nested);
    expect(await resolveContainedPath(deps, TAB_ID, "brief-next-stage.md")).toEqual({ realPath: await realpath(target) });
    expect(await resolveContainedPath(deps, TAB_ID, "reviews/stage2.md")).toEqual({ realPath: await realpath(nested) });
  });

  it("does not link an ambiguous tail (two matches)", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "a/README.md"));
    await seed(join(workspace, "b/README.md"));
    expect(await resolveContainedPath(deps, TAB_ID, "README.md")).toEqual({ failure: "not_found" });
  });

  it("respects the walk caps: depth cap and skipped directories", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "a/b/c/d/e/f/g/deep.md"));
    await seed(join(workspace, "a/b/c/d/e/shallow.md"));
    await seed(join(workspace, "node_modules/pkg/hidden.md"));
    await seed(join(workspace, ".secret-dir/dotted.md"));
    expect(await resolveContainedPath(deps, TAB_ID, "deep.md")).toEqual({ failure: "not_found" }); // beyond TAIL_INDEX_MAX_DEPTH
    expect(await resolveContainedPath(deps, TAB_ID, "shallow.md")).toHaveProperty("realPath");
    expect(await resolveContainedPath(deps, TAB_ID, "hidden.md")).toEqual({ failure: "not_found" }); // node_modules skipped
    expect(await resolveContainedPath(deps, TAB_ID, "dotted.md")).toEqual({ failure: "not_found" }); // dot-dir skipped
  });

  it("refuses when the entry cap truncates the walk, even with a sole visible hit (mocked readdir)", async () => {
    // Regression: a duplicate beyond the budget must never be linked. The
    // budget is the walk's own TAIL_INDEX_MAX_ENTRIES, so the mocked trees
    // below are sized against it (filler entries are virtual — readdir is
    // mocked, no physical files are created). A listing cut mid-way — or a
    // queued directory never visited — cannot prove uniqueness, so the sole
    // visible hit is refused; the truncated listing is cached, so the
    // refusal is consistent until the TTL expires.
    const { workspace, home, tmp } = await makeRig();
    const makeMockFs = (tree: Record<string, string[]>, calls: string[]): ArtifactsFs => ({
      async readdir(path) {
        calls.push(path);
        return tree[path] ?? [];
      },
      stat: fs.stat.bind(fs),
      realpath: fs.realpath.bind(fs),
      readFileNoFollow: fs.readFileNoFollow.bind(fs),
    });
    await seed(join(workspace, "docs/dup.md"));

    // Budget-BOUNDARY variant: the whole tree consumes EXACTLY
    // TAIL_INDEX_MAX_ENTRIES entries (one flat listing, no subdirs) —
    // nothing truncated, so the sole tail hit links, and the walk stopped
    // after one readdir. (No physical file needed — findUnique returns the
    // raw path and does no realpath of its own.)
    const filler = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `f${from + i}`);
    const exactCalls: string[] = [];
    const exactIndex = new WorkspaceTailIndex();
    expect(
      await exactIndex.findUnique(
        makeMockFs({ [workspace]: ["dup.md", ...filler(TAIL_INDEX_MAX_ENTRIES - 1)] }, exactCalls),
        workspace,
        "dup.md",
      ),
    ).toEqual(join(workspace, "dup.md"));
    expect(exactCalls).toEqual([workspace]);

    // Truncation variant through the prose-link channel: docs/ is reached,
    // but its listing exceeds the budget (dup.md + 20 000 fillers), so it is
    // cut mid-way with `dup.md` among the listed survivors and unexamined
    // entries beyond the cap. `dup.md` misses at the root (the only real
    // file is docs/dup.md), the index's sole hit would realpath fine —
    // yet the truncated listing cannot prove uniqueness ⇒ refused.
    const docsDir = join(workspace, "docs");
    const truncatedCalls: string[] = [];
    const truncatedDeps: ArtifactsIpcDeps = {
      home: () => home,
      tmpdir: () => tmp,
      workspaceForTab: (tabId) => (tabId === TAB_ID ? workspace : undefined),
      fs: makeMockFs({ [workspace]: ["docs/"], [docsDir]: ["dup.md", ...filler(TAIL_INDEX_MAX_ENTRIES)] }, truncatedCalls),
      openPath: async () => "",
      reveal: () => {},
      confirmOpen: async () => true,
      consent: new ArtifactConsentStore(),
      tailIndex: new WorkspaceTailIndex(),
      openPreview: async () => ({ ok: false, error: "unused" }) as never,
      openPreviewForId: async () => ({ ok: false, error: "unused" }) as never,
      mdPreviewRealSourcePath: () => undefined,
    };
    expect(await resolveContainedPath(truncatedDeps, TAB_ID, "dup.md")).toEqual({ failure: "not_found" });
    expect(truncatedCalls).toEqual([workspace, docsDir]); // bounded: no deeper readdir
    // …and the refusal is cached within the TTL (no second walk).
    await resolveContainedPath(truncatedDeps, TAB_ID, "dup.md");
    expect(truncatedCalls).toEqual([workspace, docsDir]);
  });

  it("caches the walk per workspace (TTL): a second call reuses the listing", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "working-docs/brief.md"));
    const readdirSpy = vi.spyOn(deps.fs, "readdir");
    expect(await resolveContainedPath(deps, TAB_ID, "brief.md")).toHaveProperty("realPath");
    const afterFirst = readdirSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await resolveContainedPath(deps, TAB_ID, "brief.md")).toHaveProperty("realPath");
    expect(readdirSpy.mock.calls.length).toBe(afterFirst); // no re-walk within the TTL
    // TTL expiry forces a fresh walk
    const later = Date.now() + TAIL_INDEX_TTL_MS + 1_000;
    await deps.tailIndex.findUnique(deps.fs, workspace, "brief.md", later);
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("concurrent lookups share one walk", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "working-docs/brief.md"));
    const readdirSpy = vi.spyOn(deps.fs, "readdir");
    const index = new WorkspaceTailIndex();
    await Promise.all([1, 2, 3].map(() => index.findUnique(deps.fs, workspace, "brief.md")));
    const roots = readdirSpy.mock.calls.filter(([dir]) => dir === workspace).length;
    expect(roots).toBe(1);
  });

  it("through handleArtifactPreviewable: a unique tail links only after stat confirms a regular file", async () => {
    const { deps, workspace } = await makeRig();
    const target = join(workspace, "working-docs/brief-next-stage.md");
    await seed(target);
    expect(await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: ["brief-next-stage.md"] })).toEqual({ paths: ["brief-next-stage.md"] });
  });

  it("through handleArtifactPreviewable: an outside-allowed-roots symlink tail is refused", async () => {
    const { deps, workspace, home } = await makeRig();
    await seed(join(home, "secret.md"));
    await mkdir(join(workspace, "docs"), { recursive: true });
    await symlink(join(home, "secret.md"), join(workspace, "docs/leak.md"));
    // unique tail match exists, but realpath escapes every root ⇒ refused
    expect(await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: ["leak.md"] })).toEqual({ paths: [] });
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

  // DoD: consent widens WHERE a preview may read from, per-path,
  // per-tab; a default rig (no Allow ever called) reproduces the pre-77-A
  // behavior exactly (the suite above already proves that with zero changes).
  describe("consent", () => {
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

  // DoD: an Allow grant skips the OS confirmation modal for the
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

  it("opens an in-root .markdown file — the extension added to the gate", async () => {
    const { deps, workspace, openPreview } = await makeRig();
    await seed(join(workspace, "notes.markdown"), "# hi");
    const result = await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(workspace, "notes.markdown") });
    expect(result).toMatchObject({ ok: true });
    expect(openPreview).toHaveBeenCalledWith(TAB_ID, await realpath(join(workspace, "notes.markdown")));
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

  it("refuses an out-of-root .markdown — widened WHAT is previewable, never WHERE", async () => {
    const { deps, home, openPreview } = await makeRig();
    await seed(join(home, "outside.markdown"), "# hi");
    const result = await handleArtifactPreview(deps, { tabId: TAB_ID, path: join(home, "outside.markdown") });
    expect(result.ok).toBe(false);
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

// slice 2: the yes/no existence-and-containment oracle behind the
// renderer's plain-text path scan (markdown/path-spans.ts). It never opens a
// window (unlike handleArtifactPreview above) — a stat is the whole
// filesystem interaction — and it echoes back the CALLER'S OWN input strings
// for whichever candidates verify, never a resolved realpath.
describe("handleArtifactPreviewable", () => {
  it("passes in-root existing .md/.markdown/.html files, echoing the original strings", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "notes.md"), "# hi");
    await seed(join(workspace, "notes.markdown"), "# hi");
    await seed(join(workspace, "report.html"), "<html></html>");
    const paths = ["notes.md", "notes.markdown", "report.html"];
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths });
    expect(result).toEqual({ paths });
  });

  it("drops an out-of-root existing file", async () => {
    const { deps, home } = await makeRig();
    await seed(join(home, "outside.md"), "# hi");
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: [join(home, "outside.md")] });
    expect(result).toEqual({ paths: [] });
  });

  it("drops an in-root path that does not exist", async () => {
    const { deps } = await makeRig();
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: ["gone.md"] });
    expect(result).toEqual({ paths: [] });
  });

  it("drops an in-root DIRECTORY sharing a previewable-looking name", async () => {
    const { deps, workspace } = await makeRig();
    await mkdir(join(workspace, "dir.md"), { recursive: true });
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: ["dir.md"] });
    expect(result).toEqual({ paths: [] });
  });

  it("drops a non-previewable extension even when in-root and existing", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "notes.txt"), "x");
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: ["notes.txt"] });
    expect(result).toEqual({ paths: [] });
  });

  it("returns { paths: [] } for a malformed payload, never throwing", async () => {
    const { deps } = await makeRig();
    await expect(handleArtifactPreviewable(deps, { tabId: TAB_ID })).resolves.toEqual({ paths: [] });
    await expect(handleArtifactPreviewable(deps, { paths: ["a.md"] })).resolves.toEqual({ paths: [] });
    await expect(handleArtifactPreviewable(deps, null)).resolves.toEqual({ paths: [] });
    await expect(handleArtifactPreviewable(deps, "nope")).resolves.toEqual({ paths: [] });
    // A non-string element fails the array-of-strings shape -> the whole batch is malformed.
    await expect(handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: [1, "a.md"] })).resolves.toEqual({ paths: [] });
  });

  it("caps at 64 paths — excess is dropped, not refused", async () => {
    const { deps, workspace } = await makeRig();
    const names = Array.from({ length: 80 }, (_, i) => `f${i}.md`);
    for (const name of names) {
      await seed(join(workspace, name), "x");
    }
    const result = await handleArtifactPreviewable(deps, { tabId: TAB_ID, paths: names });
    expect(result.paths).toHaveLength(MAX_PREVIEWABLE_PATHS);
    expect(result.paths).toEqual(names.slice(0, MAX_PREVIEWABLE_PATHS));
  });

  it("dedupes the input — a repeated path is verified once and reported once", async () => {
    const { deps, workspace } = await makeRig();
    await seed(join(workspace, "notes.md"), "# hi");
    const result = await handleArtifactPreviewable(deps, {
      tabId: TAB_ID,
      paths: ["notes.md", "notes.md", "notes.md"],
    });
    expect(result).toEqual({ paths: ["notes.md"] });
  });
});

// ── registration-level binding: the detached md popout acts only on its OWN tab ──

describe("registerArtifactsIpc — the md popout is bound to its own tab", () => {
  const MAIN_SENDER = { mainFrame: { frame: "main" } };
  const MAIN_EVENT = { sender: MAIN_SENDER, senderFrame: MAIN_SENDER.mainFrame };
  const POPOUT_SENDER = { mainFrame: { frame: "md-popout" } };
  const POPOUT_EVENT = { sender: POPOUT_SENDER, senderFrame: POPOUT_SENDER.mainFrame };

  function invoke(channel: string, event: unknown, raw: unknown): Promise<unknown> | unknown {
    const guarded = capturedArtifactHandlers.get(channel);
    if (guarded === undefined) throw new Error(`no registered handler for ${channel}`);
    return guarded(event, raw);
  }

  it("readImage from the popout: its OWN tab reads the workspace file, a FOREIGN tab refuses no_workspace", async () => {
    resetMdWindowTargetsForTests();
    setIpcGuardMainWindow(() => MAIN_SENDER);
    addIpcGuardTrustedWindow(POPOUT_SENDER, [ARTIFACT_READ_IMAGE_CHANNEL]);
    registerMdWindowTarget(POPOUT_SENDER, { tabId: TAB_ID, previewId: "p1" });
    const rig = await makeRig();
    capturedArtifactHandlers.clear();
    registerArtifactsIpc(rig.deps);
    // A file that provably EXISTS inside the rig tab's workspace: the
    // main-window call for that tab reads it fine (ok:true), so any refusal
    // on the popout's foreign-tab call can only come from the own-tab
    // binding, not from the path being unreadable.
    const img = join(rig.workspace, "probe.png");
    await seed(img, Buffer.from("not-a-real-png-but-a-file"));
    const own = (await invoke(ARTIFACT_READ_IMAGE_CHANNEL, POPOUT_EVENT, { tabId: TAB_ID, path: img })) as { ok: boolean };
    const foreign = (await invoke(ARTIFACT_READ_IMAGE_CHANNEL, POPOUT_EVENT, { tabId: "tab-other", path: img })) as {
      ok: boolean;
      reason?: string;
    };
    const main = (await invoke(ARTIFACT_READ_IMAGE_CHANNEL, MAIN_EVENT, { tabId: TAB_ID, path: img })) as { ok: boolean };
    expect(own.ok).toBe(true); // own tab: binding passes, real read happens
    expect(main).toEqual(own); // the main window gets the identical result
    expect(foreign).toEqual({ ok: false, reason: "no_workspace" }); // foreign tab: closest safe negative
  });

  it("previewable from the popout for a FOREIGN tab returns an empty subset without probing", async () => {
    resetMdWindowTargetsForTests();
    setIpcGuardMainWindow(() => MAIN_SENDER);
    addIpcGuardTrustedWindow(POPOUT_SENDER, [ARTIFACT_PREVIEWABLE_CHANNEL]);
    registerMdWindowTarget(POPOUT_SENDER, { tabId: TAB_ID, previewId: "p1" });
    const rig = await makeRig();
    capturedArtifactHandlers.clear();
    registerArtifactsIpc(rig.deps);
    const response = (await invoke(ARTIFACT_PREVIEWABLE_CHANNEL, POPOUT_EVENT, { tabId: "tab-other", paths: ["doc.md"] })) as {
      paths: string[];
    };
    expect(response).toEqual({ paths: [] });
  });
});

/**
 * Minimal md popout window double for the real-PreviewHost test below.
 * Counts show() calls because a dom-md window is shown ONCE at creation —
 * distinguishing a later FOCUS show from that is the whole point.
 */
class StubMdWindow implements MdPreviewWindowLike {
  showCalls = 0;
  constructor(public readonly previewId: string) {}
  isDestroyed(): boolean {
    return false;
  }
  destroy(): void {}
  show(): void {
    this.showCalls += 1;
  }
  showInactive(): void {}
  onClosed(): void {}
  capturePage(): Promise<PreviewCapturedImage> {
    throw new Error("not used in this suite");
  }
  setBackgroundThrottling(): void {}
}

// The preview channel binds a popout one level tighter than the tab-only
// artifact channels above: reusing an already-open preview for the requested
// path's REALPATH would let the popout reload/focus a DIFFERENT preview of
// the same document sitting in its own tab, so a passing request is reloaded
// BY ID (deps.openPreviewForId), never by a path search.
describe("registerArtifactsIpc — the md popout's preview channel is bound to its own preview", () => {
  const MAIN_SENDER = { mainFrame: { frame: "main" } };
  const MAIN_EVENT = { sender: MAIN_SENDER, senderFrame: MAIN_SENDER.mainFrame };
  const POPOUT_SENDER = { mainFrame: { frame: "md-popout" } };
  const POPOUT_EVENT = { sender: POPOUT_SENDER, senderFrame: POPOUT_SENDER.mainFrame };

  function invoke(channel: string, event: unknown, raw: unknown): Promise<unknown> | unknown {
    const guarded = capturedArtifactHandlers.get(channel);
    if (guarded === undefined) throw new Error(`no registered handler for ${channel}`);
    return guarded(event, raw);
  }

  /**
   * p1 = the popout's own dom-md preview backed by notes.md; p2 = an HTML
   * preview of report.html living in the SAME tab — exactly the shape a
   * compromised popout would aim at.
   */
  async function makePopoutRig() {
    resetMdWindowTargetsForTests();
    setIpcGuardMainWindow(() => MAIN_SENDER);
    addIpcGuardTrustedWindow(POPOUT_SENDER, [ARTIFACT_PREVIEW_CHANNEL]);
    registerMdWindowTarget(POPOUT_SENDER, { tabId: TAB_ID, previewId: "p1" });
    const rig = await makeRig();
    capturedArtifactHandlers.clear();
    registerArtifactsIpc(rig.deps);
    await seed(join(rig.workspace, "notes.md"), "# own doc");
    await seed(join(rig.workspace, "report.html"), "<html></html>");
    const ownRealPath = await realpath(join(rig.workspace, "notes.md"));
    rig.mdPreviewRealSourcePath.mockImplementation((tabId: string, previewId: string) =>
      tabId === TAB_ID && previewId === "p1" ? ownRealPath : undefined,
    );
    return { rig, ownRealPath };
  }

  it("a popout cannot open ANOTHER preview's path in its own tab — negative shape, no reload/focus", async () => {
    const { rig } = await makePopoutRig();
    const response = await invoke(ARTIFACT_PREVIEW_CHANNEL, POPOUT_EVENT, {
      tabId: TAB_ID,
      path: join(rig.workspace, "report.html"),
    });
    expect(response).toEqual({ ok: false, error: "invalid artifact-preview request", errorKind: "invalid_input" });
    // p2 was neither reloaded nor focused: neither open leg ever ran.
    expect(rig.openPreview).not.toHaveBeenCalled();
    expect(rig.openPreviewForId).not.toHaveBeenCalled();
  });

  it("a popout still reloads ITS OWN document — addressed BY ID, not by the path's first preview", async () => {
    const { rig, ownRealPath } = await makePopoutRig();
    const response = await invoke(ARTIFACT_PREVIEW_CHANNEL, POPOUT_EVENT, {
      tabId: TAB_ID,
      path: join(rig.workspace, "notes.md"),
    });
    expect(response).toMatchObject({ ok: true });
    expect(rig.openPreviewForId).toHaveBeenCalledWith(TAB_ID, "p1", ownRealPath);
    expect(rig.openPreview).not.toHaveBeenCalled(); // the main-window by-path leg stays out of the popout path
  });

  it("the main-window sender stays unrestricted — the same other-preview path still opens", async () => {
    const { rig } = await makePopoutRig();
    const response = await invoke(ARTIFACT_PREVIEW_CHANNEL, MAIN_EVENT, {
      tabId: TAB_ID,
      path: join(rig.workspace, "report.html"),
    });
    expect(response).toMatchObject({ ok: true });
    expect(rig.openPreview).toHaveBeenCalledWith(TAB_ID, await realpath(join(rig.workspace, "report.html")));
  });

  it("a popout whose own md preview is gone (closed/transferred/flipped to web) gets the negative shape", async () => {
    const { rig } = await makePopoutRig();
    rig.mdPreviewRealSourcePath.mockReturnValue(undefined);
    const response = await invoke(ARTIFACT_PREVIEW_CHANNEL, POPOUT_EVENT, {
      tabId: TAB_ID,
      path: join(rig.workspace, "notes.md"),
    });
    expect(response).toEqual({ ok: false, error: "invalid artifact-preview request", errorKind: "invalid_input" });
    expect(rig.openPreview).not.toHaveBeenCalled();
    expect(rig.openPreviewForId).not.toHaveBeenCalled();
  });

  it("a popout cannot steer a FOREIGN tab — refused even before the own-preview lookup", async () => {
    const { rig } = await makePopoutRig();
    const response = await invoke(ARTIFACT_PREVIEW_CHANNEL, POPOUT_EVENT, {
      tabId: "tab-other",
      path: join(rig.workspace, "report.html"),
    });
    expect(response).toEqual({ ok: false, error: "invalid artifact-preview request", errorKind: "invalid_input" });
    expect(rig.openPreview).not.toHaveBeenCalled();
    expect(rig.openPreviewForId).not.toHaveBeenCalled();
  });

  /**
   * The exact repro behind the by-id reload: the same document opened TWICE
   * in one tab (BrowserOpen without a previewId) leaves two live previews
   * with the same realpath, and a by-path search would always reload the
   * FIRST one. This test wires the guarded handler to a REAL PreviewHost
   * over fake md windows (resolveArtifact bound exactly like main/index.ts
   * binds it) and asserts sender→preview isolation on docVersion/focus.
   */
  it("two live previews of ONE document: the sender's OWN preview reloads/focuses, the first path match stays untouched", async () => {
    resetMdWindowTargetsForTests();
    setIpcGuardMainWindow(() => MAIN_SENDER);
    const P1_SENDER = { mainFrame: { frame: "md-popout-1" } };
    const P1_EVENT = { sender: P1_SENDER, senderFrame: P1_SENDER.mainFrame };
    const P2_SENDER = { mainFrame: { frame: "md-popout-2" } };
    const P2_EVENT = { sender: P2_SENDER, senderFrame: P2_SENDER.mainFrame };
    addIpcGuardTrustedWindow(P1_SENDER, [ARTIFACT_PREVIEW_CHANNEL]);
    addIpcGuardTrustedWindow(P2_SENDER, [ARTIFACT_PREVIEW_CHANNEL]);
    const rig = await makeRig();

    const mdWindows = new Map<string, StubMdWindow>();
    const host = registerPreviewHost({
      createWindow: () => {
        throw new Error("web windows are not used in this scenario");
      },
      createPanelView: () => {
        throw new Error("panel views are not used in this scenario");
      },
      createMdWindow: (opts) => {
        const win = new StubMdWindow(opts.previewId);
        mdWindows.set(opts.previewId, win);
        return win;
      },
      displayMode: () => "window",
      // Same binding main/index.ts uses: the artifacts deps' own strict resolver.
      resolveArtifact: (tabId, path) => resolveContainedPath(rig.deps, tabId, path),
      autoOpenEnabled: () => false,
      liveReloadEnabled: () => false,
      watchFile: () => ({ close() {} }),
      postToHost: () => false,
      statMdSource: async () => ({ size: 1, isFile: true }),
      readMdSourceNoFollow: async () => Buffer.from(""),
      captureMainWindowRect: async () => null,
      logger: { log() {}, warn() {}, error() {} },
      now: () => 1,
    });
    rig.deps.openPreview = (tabId, realPath) => host.openForPathClick(tabId, realPath);
    rig.deps.openPreviewForId = (tabId, previewId, realPath) => host.openForPreviewId(tabId, previewId, realPath);
    rig.deps.mdPreviewRealSourcePath = (tabId, previewId) => host.getMdDocRef(tabId, previewId)?.realSourcePath;

    capturedArtifactHandlers.clear();
    registerArtifactsIpc(rig.deps);

    await seed(join(rig.workspace, "doc.md"), "# doc");
    const docPath = join(rig.workspace, "doc.md");
    const open1 = await host.openForTab(TAB_ID, { path: docPath });
    const open2 = await host.openForTab(TAB_ID, { path: docPath });
    expect(open1.ok).toBe(true);
    expect(open2.ok).toBe(true);
    const p1 = open1.ok ? open1.value.previewId : "";
    const p2 = open2.ok ? open2.value.previewId : "";
    expect(p1).not.toBe(p2);
    expect(host.listForTab(TAB_ID)).toHaveLength(2);
    registerMdWindowTarget(P1_SENDER, { tabId: TAB_ID, previewId: p1 });
    registerMdWindowTarget(P2_SENDER, { tabId: TAB_ID, previewId: p2 });

    // From p2's popout: p2 reloads (docVersion bumps, focus show), p1 untouched.
    const fromP2 = await invoke(ARTIFACT_PREVIEW_CHANNEL, P2_EVENT, { tabId: TAB_ID, path: docPath });
    expect(fromP2).toMatchObject({ ok: true, value: { previewId: p2 } });
    expect(host.getMdDocRef(TAB_ID, p2)?.docVersion).toBe(1);
    expect(host.getMdDocRef(TAB_ID, p1)?.docVersion).toBe(0);
    expect(mdWindows.get(p2)!.showCalls).toBe(2); // creation + the focus show
    expect(mdWindows.get(p1)!.showCalls).toBe(1); // creation only — untouched

    // From p1's popout: the opposite.
    const fromP1 = await invoke(ARTIFACT_PREVIEW_CHANNEL, P1_EVENT, { tabId: TAB_ID, path: docPath });
    expect(fromP1).toMatchObject({ ok: true, value: { previewId: p1 } });
    expect(host.getMdDocRef(TAB_ID, p1)?.docVersion).toBe(1);
    expect(host.getMdDocRef(TAB_ID, p2)?.docVersion).toBe(1);
    expect(mdWindows.get(p1)!.showCalls).toBe(2);
    expect(mdWindows.get(p2)!.showCalls).toBe(2);

    // The main window keeps the unchanged by-path click contract: the FIRST
    // same-realpath preview (p1) is the one a path click reloads/focuses.
    const fromMain = await invoke(ARTIFACT_PREVIEW_CHANNEL, MAIN_EVENT, { tabId: TAB_ID, path: docPath });
    expect(fromMain).toMatchObject({ ok: true, value: { previewId: p1 } });
    expect(host.getMdDocRef(TAB_ID, p1)?.docVersion).toBe(2);
    expect(host.getMdDocRef(TAB_ID, p2)?.docVersion).toBe(1);
    expect(mdWindows.get(p1)!.showCalls).toBe(3);
    expect(mdWindows.get(p2)!.showCalls).toBe(2);
    expect(host.listForTab(TAB_ID)).toHaveLength(2); // never stacked a third preview
  });
});

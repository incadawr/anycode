/**
 * Unit tests for the chat-artifact IPC handlers (TASK.72), exercised as the
 * exported handle* functions off a REAL node fs in scratch tmpdirs (no
 * Electron ipcMain). The load-bearing suites are the security gates:
 * containment (allowed roots = tab workspace / `<home>/.anycode` / tmpdir;
 * symlink escapes refused AFTER realpath), the open allowlist (non-image
 * extensions can never reach `openPath`), the inline byte cap, and SVG
 * refused for inline read (active format).
 */

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedArtifactRoots,
  handleArtifactOpen,
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
}

/** workspace/home/tmp are three DISJOINT tmpdirs — the tmp root passed to deps is ours, not the OS one. */
async function makeRig(opts?: { noTab?: boolean; openError?: string }): Promise<Rig> {
  const workspace = await tmpDir();
  const home = await tmpDir();
  const tmp = await tmpDir();
  const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue(opts?.openError ?? "");
  const reveal = vi.fn<(path: string) => void>();
  const deps: ArtifactsIpcDeps = {
    home: () => home,
    tmpdir: () => tmp,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : workspace),
    fs,
    openPath,
    reveal,
  };
  return { deps, workspace, home, tmp, openPath, reveal };
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
  it("is exactly workspace + <home>/.anycode + tmp (home itself is NOT a root)", () => {
    expect(allowedArtifactRoots("/ws", "/home/u", "/tmp-x")).toEqual(["/ws", "/home/u/.anycode", "/tmp-x"]);
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

  it("refuses open outside allowed roots without touching the shell", async () => {
    const { deps, home, openPath, reveal } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(home, "secret.png") })).toEqual({ ok: false, reason: "outside_allowed_roots" });
    expect(openPath).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("degrades to reveal when openPath reports a launch failure", async () => {
    const { deps, workspace, openPath, reveal } = await makeRig({ openError: "no application" });
    await seed(join(workspace, "icon.png"), "png");
    expect(await handleArtifactOpen(deps, { tabId: TAB_ID, path: join(workspace, "icon.png") })).toEqual({ ok: true, resolvedTo: "reveal" });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe("handleArtifactReveal", () => {
  it("reveals any in-root file (no extension gate — reveal never executes)", async () => {
    const { deps, workspace, reveal } = await makeRig();
    await seed(join(workspace, "run.command"), "x");
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(workspace, "run.command") })).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith(await realpath(join(workspace, "run.command")));
  });

  it("refuses reveal outside allowed roots and for a missing file", async () => {
    const { deps, home, workspace, reveal } = await makeRig();
    await seed(join(home, "secret.png"), "png");
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(home, "secret.png") })).toEqual({ ok: false, reason: "outside_allowed_roots" });
    expect(await handleArtifactReveal(deps, { tabId: TAB_ID, path: join(workspace, "gone.png") })).toEqual({ ok: false, reason: "not_found" });
    expect(reveal).not.toHaveBeenCalled();
  });
});

import { mkdtemp, mkdir, writeFile, unlink, symlink, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceFileObserver, type WorkspaceMetadataFs } from "./workspace-file-observer.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "workspace-observer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
function observer(root: string, options = {}) {
  const value = createWorkspaceFileObserver({ workspace: root, enabled: () => true, ...options });
  cleanups.push(() => value.dispose());
  return value;
}

it("baselines metadata, then detects real creation, modification and deletion", async () => {
  const root = await workspace();
  await writeFile(join(root, "before"), "a");
  const value = observer(root);
  expect((await value.refresh()).changes).toEqual([]);
  await writeFile(join(root, "before"), "longer");
  await writeFile(join(root, "new"), "b");
  expect((await value.refresh()).changes).toEqual([
    { path: "before", kind: "modified" }, { path: "new", kind: "created" },
  ]);
  await unlink(join(root, "before"));
  expect((await value.refresh()).changes).toEqual([{ path: "before", kind: "deleted" }]);
});

it("never traverses excluded trees, symlinks, or canonical paths outside the root", async () => {
  const root = await workspace(), outside = await workspace();
  for (const name of [".git", "node_modules", ".cache", "cache"]) await mkdir(join(root, name));
  await symlink(outside, join(root, "link"), "dir");
  await mkdir(join(root, "escape"));
  const reads: string[] = [];
  const injected: WorkspaceMetadataFs = {
    lstat: path => fs.lstat(path),
    realpath: path => path === join(root, "escape") ? Promise.resolve(outside) : fs.realpath(path),
    async opendir(path) { reads.push(path); return fs.opendir(path); },
  };
  expect((await observer(root, { fs: injected }).refresh()).coverage).toBe("partial");
  expect(reads).toEqual([root]);
  // The injected interface has no content-reading operation.
});

it("caps streaming entries and preserves unvisited baseline on partial/error samples", async () => {
  const root = await workspace();
  await writeFile(join(root, "a"), "a");
  await writeFile(join(root, "b"), "b");
  let fail = false, capped = false, deleted = false;
  const injected: WorkspaceMetadataFs = {
    lstat: path => fs.lstat(path), realpath: path => fs.realpath(path),
    async *opendir(path) {
      if (fail) throw new Error("denied");
      yield { name: "a" };
      if (capped) { yield { name: ".cache" }; yield { name: ".git" }; return; }
      if (!deleted) yield { name: "b" };
    },
  };
  const value = observer(root, { fs: injected, maxEntries: 2 });
  await value.refresh();
  capped = true;
  expect(await value.refresh()).toMatchObject({ coverage: "partial", reason: "cap", changes: [] });
  fail = true;
  expect((await value.refresh()).coverage).toBe("partial");
  fail = capped = false;
  await unlink(join(root, "b"));
  deleted = true;
  expect((await value.refresh()).changes).toEqual([{ path: "b", kind: "deleted" }]);
});

it("bounds a stalled operation by deadline and disposes an in-flight sample", async () => {
  vi.useFakeTimers();
  const injected: WorkspaceMetadataFs = {
    lstat: () => new Promise(() => {}), realpath: async p => p,
    async *opendir() {},
  };
  const value = observer("/workspace", { fs: injected });
  const pending = value.refresh();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ coverage: "partial", reason: "deadline" });
  expect(value.refresh()).toBe(pending);
  const another = observer("/workspace", { fs: injected });
  const next = another.refresh();
  another.dispose();
  expect(await next).toMatchObject({ coverage: "unknown", reason: "disposed" });
  expect((await another.refresh()).reason).toBe("disposed");
});

it("uses injected time for deadlines and does no IO while disabled", async () => {
  let time = 0;
  const realpath = vi.fn(async (p: string) => { time = 3000; return p; });
  const opendir = vi.fn();
  const injected: WorkspaceMetadataFs = { realpath, lstat: vi.fn(async () => ({
    isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
    size: 0, mtimeMs: 0, ctimeMs: 0, ino: 1, dev: 1,
  })), opendir };
  expect((await observer("/workspace", { fs: injected, now: () => time }).refresh()).coverage).toBe("partial");
  expect(opendir).not.toHaveBeenCalled();
  const value = observer("/workspace", { fs: injected, enabled: () => false });
  realpath.mockClear();
  expect((await value.refresh()).coverage).toBe("unknown");
  expect(realpath).not.toHaveBeenCalled();
});

it("serializes concurrent Windows refreshes and retains baseline through rename/delete", async () => {
  let names = ["Old.txt"], blocked: (() => void) | undefined, entered = false;
  const injected: WorkspaceMetadataFs = {
    realpath: async p => p,
    lstat: async p => ({ isSymbolicLink: () => false, isDirectory: () => p === "C:\\work",
      isFile: () => p !== "C:\\work", size: 1, mtimeMs: 1, ctimeMs: 1, ino: 42, dev: 1 }),
    async *opendir() { if (blocked) await new Promise<void>(resolve => { blocked = resolve; entered = true; }); for (const name of names) yield { name }; },
  };
  const value = observer("C:\\work", { fs: injected, platform: "win32" });
  await value.refresh();
  names = ["New.txt"];
  blocked = () => {};
  const first = value.refresh(), second = value.refresh();
  expect(first).toBe(second);
  await vi.waitFor(() => expect(entered).toBe(true));
  blocked!(); blocked = undefined;
  expect((await first).changes).toEqual([
    { path: "New.txt", kind: "created" }, { path: "Old.txt", kind: "deleted" },
  ]);
  names = [];
  expect((await value.refresh()).changes).toEqual([{ path: "New.txt", kind: "deleted" }]);
});

it("does not let a late directory open change baseline after deadline", async () => {
  const root = await workspace();
  await writeFile(join(root, "kept"), "x");
  let stalled = false, release: (() => void) | undefined;
  const close = vi.fn(async () => {});
  const injected: WorkspaceMetadataFs = {
    realpath: p => fs.realpath(p), lstat: p => fs.lstat(p),
    async opendir(p) {
      if (stalled) {
        await new Promise<void>(resolve => { release = resolve; });
        return { close, async *[Symbol.asyncIterator]() { throw new Error("must not iterate"); } };
      }
      return fs.opendir(p);
    },
  };
  const value = observer(root, { fs: injected, deadlineMs: 100 });
  await value.refresh();
  stalled = true;
  const pending = value.refresh();
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(await pending).toMatchObject({ coverage: "partial", reason: "deadline", changes: [] });
  release!();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  stalled = false;
  await unlink(join(root, "kept"));
  expect((await value.refresh()).changes).toEqual([{ path: "kept", kind: "deleted" }]);
});

it("rejects malformed entry names before accessing them and ignores symlink files", async () => {
  const root = await workspace(), outside = await workspace();
  await writeFile(join(outside, "secret"), "private");
  await symlink(join(outside, "secret"), join(root, "link"));
  const lstat = vi.fn((p: string) => fs.lstat(p));
  const injected: WorkspaceMetadataFs = {
    realpath: p => fs.realpath(p), lstat,
    async *opendir() { for (const name of ["../secret", "bad\0name", "link"]) yield { name }; },
  };
  expect(await observer(root, { fs: injected }).refresh()).toMatchObject({ coverage: "partial", changes: [] });
  expect(lstat.mock.calls.map(([p]) => p)).toEqual([root, join(root, "link")]);
});

it("exposes incomplete baseline coverage without inventing creations on recovery", async () => {
  const root = await workspace();
  await writeFile(join(root, "present"), "x");
  let fail = true;
  const injected: WorkspaceMetadataFs = {
    lstat: p => fs.lstat(p), realpath: p => fs.realpath(p),
    async opendir(p) { if (fail) throw new Error("permission denied"); return fs.opendir(p); },
  };
  const value = observer(root, { fs: injected });
  expect(await value.refresh()).toMatchObject({ coverage: "partial", baselineCoverage: "unknown", changes: [] });
  fail = false;
  expect(await value.refresh()).toMatchObject({ coverage: "complete", baselineCoverage: "partial", changes: [] });
  await writeFile(join(root, "created"), "y");
  expect(await value.refresh()).toMatchObject({ coverage: "complete", baselineCoverage: "complete",
    changes: [{ path: "created", kind: "created" }] });
});

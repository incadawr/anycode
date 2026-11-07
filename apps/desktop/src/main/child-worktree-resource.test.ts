import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeGitAdapter } from "@anycode/core/node-git";
import { NodeExecutionAdapter } from "@anycode/core/node-execution";
import { ChildWorktreeResources } from "./child-worktree-resource.js";

let scratch: string, root: string, userData: string;
const appRunId = randomUUID();
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_TERMINAL_PROMPT: "0",
  } }).trim();
}
function adapter(cwd: string) {
  return new NodeGitAdapter({ cwd, exec: new NodeExecutionAdapter() });
}
function manager(options: Partial<ConstructorParameters<typeof ChildWorktreeResources>[0]> = {}) {
  return new ChildWorktreeResources({ userData, appRunId, gitForWorkspace: adapter, ...options });
}
const sessions = { parentSessionId: "parent", childSessionId: "child" };
async function receipts() {
  const dir = path.join(userData, "child-worktrees");
  return Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))
    .map(async (f) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))));
}
beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "child-worktree-")));
  root = path.join(scratch, "repo"); userData = path.join(scratch, "data");
  await fs.mkdir(root); git(root, "init", "-b", "main");
  await fs.writeFile(path.join(root, "same.txt"), "base");
  git(root, "add", "."); git(root, "commit", "-m", "Initial");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(scratch, { recursive: true, force: true }); });

it("allocates two independent checkouts without copying dirty parent files", async () => {
  await fs.writeFile(path.join(root, "same.txt"), "staged"); git(root, "add", ".");
  await fs.writeFile(path.join(root, "same.txt"), "dirty");
  await fs.writeFile(path.join(root, "untracked.txt"), "private");
  const resources = manager(); const snapshot = await resources.snapshot(root, root);
  const a = await resources.allocate(snapshot, sessions);
  const b = await resources.allocate(snapshot, { ...sessions, childSessionId: "other" });
  expect(a.path).not.toBe(b.path); expect(a.branch).not.toBe(b.branch);
  expect(a.path).toBe(path.join(root, ".anycode/worktrees", `child-${a.id}`));
  expect(a.branch).toBe(`anycode-wt/child-${a.id}`);
  expect(a.id).toMatch(/^[a-f0-9-]{36}$/);
  for (const child of [a, b]) {
    expect(git(child.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
    expect(await fs.readFile(path.join(child.path, "same.txt"), "utf8")).toBe("base");
    await expect(fs.stat(path.join(child.path, "untracked.txt"))).rejects.toThrow();
  }
  await fs.writeFile(path.join(a.path, "same.txt"), "first");
  await fs.writeFile(path.join(b.path, "same.txt"), "second");
  expect(await fs.readFile(path.join(root, "same.txt"), "utf8")).toBe("dirty");
  expect(git(root, "show", ":same.txt")).toBe("staged");
  expect(git(root, "status", "--porcelain")).not.toContain(".anycode");
  expect(await receipts()).toEqual(expect.arrayContaining([a, b]));
  expect(a).toMatchObject({ version: 1, appRunId, ...sessions, sourceRoot: root,
    storageRoot: root, projectRoot: root, phase: "active", reason: null });
});

it("uses linked parent's own HEAD but stores children under main checkout", async () => {
  const linked = path.join(scratch, "linked"); git(root, "worktree", "add", "-b", "linked", linked);
  await fs.writeFile(path.join(linked, "same.txt"), "linked");
  git(linked, "commit", "-am", "Linked change");
  const resources = manager(); const snapshot = await resources.snapshot(linked, root);
  const child = await resources.allocate(snapshot, sessions);
  expect(snapshot.baseSha).toBe(git(linked, "rev-parse", "HEAD"));
  expect(snapshot.baseSha).not.toBe(git(root, "rev-parse", "HEAD"));
  expect(child.storageRoot).toBe(root); expect(child.sourceRoot).toBe(linked);
  expect(await fs.readFile(path.join(child.path, "same.txt"), "utf8")).toBe("linked");
});

it("pins admission SHA even if source HEAD moves before add", async () => {
  const resources = manager(); const snapshot = await resources.snapshot(root, root);
  await fs.writeFile(path.join(root, "same.txt"), "new commit"); git(root, "commit", "-am", "Move HEAD");
  const child = await resources.allocate(snapshot, sessions);
  expect(git(child.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
  expect(git(root, "rev-parse", "HEAD")).not.toBe(snapshot.baseSha);
});

it.each(["non-repo", "unborn", "subdirectory", "valid"])("checks %s admission before add", async (kind) => {
  const source = path.join(scratch, "source"); await fs.mkdir(source);
  if (kind === "unborn") git(source, "init", "-b", "main");
  const cwd = kind === "subdirectory" ? path.join(root, "sub") : source;
  if (kind === "subdirectory") await fs.mkdir(cwd);
  const add = vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd");
  const resources = manager();
  const allocateFromSource = async () => resources.allocate(
    await resources.snapshot(kind === "valid" ? root : cwd, root), sessions);
  if (kind === "valid") {
    await expect(allocateFromSource()).resolves.toMatchObject({ phase: "active" });
    expect(add).toHaveBeenCalledTimes(1);
    return;
  }
  await expect(allocateFromSource()).rejects.toThrow(
    kind === "non-repo" ? /Git repository/ : kind === "unborn" ? /unborn HEAD/ : /checkout root/);
  expect(add).not.toHaveBeenCalled();
});

it.each(["open", "write", "sync"])("does not call add when intent %s fails", async (failure) => {
  const add = vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd");
  const brokenFs = { ...fs, open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
    if (failure === "open" && args[1] === "wx") throw new Error("disk unavailable");
    const handle = await fs.open(...args);
    if (args[1] !== "wx") return handle;
    return Object.assign(handle, { [failure === "write" ? "writeFile" : "sync"]:
      async () => { throw new Error("intent persistence failed"); } });
  }) };
  const resources = manager({ fs: brokenFs }); const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/intent/);
  expect(add).not.toHaveBeenCalled();
});

it("writes exclusive durable intent before add and retains partial add residue", async () => {
  vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd").mockImplementation(async (spec) => {
    const [receipt] = await receipts(); expect(receipt).toMatchObject({ phase: "intent", path: spec.path });
    expect(spec.baseRef).toBe(receipt.baseSha);
    await fs.mkdir(spec.path, { recursive: true });
    await fs.writeFile(path.join(spec.path, "residue"), "keep");
    return { ok: false, reason: "partial add" };
  });
  const resources = manager(); const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("unknown");
  expect(await fs.readFile(path.join(receipt.path, "residue"), "utf8")).toBe("keep");
});

it("keeps original intent if atomic update fails after successful add", async () => {
  const resources = manager({ fs: { ...fs, rename: async () => { throw new Error("disk full"); } } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("intent");
  expect(git(receipt.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
});

it("retains checkout when post-add listed identity disagrees", async () => {
  const resources = manager({ gitForWorkspace: (cwd) => {
    const instance = adapter(cwd); const list = instance.worktreeList.bind(instance);
    instance.worktreeList = async () => {
      const result = await list();
      if (result.ok) result.value.forEach((item) => { if (!item.isMain) item.branch = "unexpected"; });
      return result;
    };
    return instance;
  } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("unknown");
  expect(git(receipt.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
});


it("never overwrites an existing intent or calls add on an exclusive-create collision", async () => {
  const add = vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd");
  const resources = manager({ fs: { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (args[1] === "wx") await fs.writeFile(args[0], "existing ownership");
    return fs.open(...args);
  } } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/intent/);
  expect(add).not.toHaveBeenCalled();
  const directory = path.join(userData, "child-worktrees");
  const [file] = await fs.readdir(directory);
  expect(await fs.readFile(path.join(directory, file!), "utf8")).toBe("existing ownership");
});

it("atomically replaces a complete intent with a synced update", async () => {
  const resources = manager({ fs: { ...fs, rename: async (from, to) => {
    const before = JSON.parse(await fs.readFile(to, "utf8"));
    const after = JSON.parse(await fs.readFile(from, "utf8"));
    expect(before.phase).toBe("intent"); expect(after.phase).toBe("active");
    expect(after.id).toBe(before.id);
    await fs.rename(from, to);
  } } });
  const snapshot = await resources.snapshot(root, root);
  await resources.allocate(snapshot, sessions);
  expect((await fs.readdir(path.join(userData, "child-worktrees"))).length).toBe(1);
});

it("keeps a recovery receipt when add throws without saving external error text", async () => {
  vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd").mockRejectedValue(new Error("sensitive external text"));
  const resources = manager(); const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("unknown");
  expect(JSON.stringify(receipt)).not.toContain("sensitive external text");
});

it("canonicalizes a linked source alias before recording ownership", async () => {
  const alias = path.join(scratch, "alias"); await fs.symlink(root, alias);
  const resources = manager(); const snapshot = await resources.snapshot(alias, alias);
  const child = await resources.allocate(snapshot, sessions);
  expect(child.sourceRoot).toBe(root); expect(child.projectRoot).toBe(root);
  expect(child.storageRoot).toBe(root);
});

it("retains residue if canonical path disagrees after add", async () => {
  const resources = manager({ fs: { ...fs, realpath: async (target: string) => {
    const result = await fs.realpath(target);
    return path.basename(target).startsWith("child-") ? path.join(scratch, "elsewhere") : result;
  } } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("unknown");
  expect(git(receipt.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
});

it("retains checkout when the post-add registration read fails", async () => {
  let reads = 0;
  const resources = manager({ gitForWorkspace: (cwd) => {
    const instance = adapter(cwd); const list = instance.worktreeList.bind(instance);
    instance.worktreeList = async () => ++reads === 1 ? list() : { ok: false, reason: "truncated" };
    return instance;
  } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  const [receipt] = await receipts(); expect(receipt.phase).toBe("unknown");
  expect(git(receipt.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
});

it("records nothing created when namespace exclusion fails before add", async () => {
  vi.spyOn(NodeGitAdapter.prototype, "ensureWorktreeNamespaceIgnored")
    .mockResolvedValue({ ok: false, reason: "sensitive external text" });
  const add = vi.spyOn(NodeGitAdapter.prototype, "worktreeAdd");
  const resources = manager(); const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow("checkout creation was not attempted");
  expect(add).not.toHaveBeenCalled();
  const [receipt] = await receipts();
  expect(receipt).toMatchObject({ phase: "not-created", reason: "Allocation stopped before checkout creation" });
  expect(await resources.read(receipt.id)).toEqual(receipt);
  await expect(fs.stat(receipt.path)).rejects.toThrow();
  expect(git(root, "branch", "--list", receipt.branch)).toBe("");
  expect(JSON.stringify(receipt)).not.toContain("sensitive external text");
});

it("retains checkout and records uncertainty when directory fsync fails after replace", async () => {
  let syncs = 0;
  const resources = manager({ fs: { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (args[1] === "r") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (++syncs === 3) throw new Error("directory fsync failed after rename");
        await sync();
      };
    }
    return handle;
  } } });
  const snapshot = await resources.snapshot(root, root);
  await expect(resources.allocate(snapshot, sessions)).rejects.toThrow(/retained/);
  expect(syncs).toBe(4);
  const [receipt] = await receipts();
  expect(receipt.phase).toBe("unknown");
  expect(git(receipt.path, "rev-parse", "HEAD")).toBe(snapshot.baseSha);
  expect(git(root, "rev-parse", receipt.branch)).toBe(snapshot.baseSha);
});

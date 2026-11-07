import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeGitAdapter } from "@anycode/core/node-git";
import { NodeExecutionAdapter } from "@anycode/core/node-execution";
import { ChildWorktreeResources, type ChildWorktreeReceipt } from "./child-worktree-resource.js";
import { settleChildWorktree } from "./child-worktree-cleanup.js";

let scratch: string, root: string, resources: ChildWorktreeResources, receipt: ChildWorktreeReceipt;
const appRunId = "current-run";
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_TERMINAL_PROMPT: "0",
  } }).trim();
}
const adapter = (cwd: string) => new NodeGitAdapter({ cwd, exec: new NodeExecutionAdapter() });
const permission = () => ({ appRunId, childSessionId: receipt.childSessionId,
  actualExit: true, admissionStopped: true, writersStopped: true });
const settle = (overrides: Partial<Parameters<typeof settleChildWorktree>[0]> = {}) =>
  settleChildWorktree({ resources, receipt, permission: permission(),
    hasOtherClaims: async () => false, ...overrides });
beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "child-cleanup-")));
  root = path.join(scratch, "repo"); await fs.mkdir(root); git(root, "init", "-b", "main");
  await fs.writeFile(path.join(root, "file"), "base");
  await fs.writeFile(path.join(root, ".gitignore"), "cache\n");
  git(root, "add", "."); git(root, "commit", "-m", "Initial");
  resources = new ChildWorktreeResources({ userData: path.join(scratch, "data"), appRunId });
  receipt = await resources.allocate(await resources.snapshot(root, root),
    { parentSessionId: "parent", childSessionId: "child" });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(scratch, { recursive: true, force: true }); });

it("removes only the no-op checkout, persists disposition and always keeps the branch", async () => {
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  expect(await settle()).toEqual({ phase: "removed", reason: "Empty checkout removed; branch retained" });
  expect(remove).toHaveBeenCalledExactlyOnceWith({ path: receipt.path });
  await expect(fs.stat(receipt.path)).rejects.toThrow();
  expect(git(root, "rev-parse", receipt.branch)).toBe(receipt.baseSha);
  expect(await resources.read(receipt.id)).toMatchObject({ phase: "removed" });
  await settle(); expect(remove).toHaveBeenCalledTimes(1);
});

it.each(["tracked", "staged", "untracked", "ignored", "assume-unchanged", "skip-worktree", "commit"])(
  "keeps %s work with files, index and refs unchanged", async (kind) => {
    const filename = kind === "ignored" ? "cache" : kind === "untracked" ? "new" : "file";
    if (kind === "assume-unchanged" || kind === "skip-worktree")
      git(receipt.path, "update-index", `--${kind}`, "file");
    await fs.writeFile(path.join(receipt.path, filename), "work");
    if (kind === "staged" || kind === "commit") git(receipt.path, "add", ".");
    if (kind === "commit") git(receipt.path, "commit", "-m", "Work");
    const head = git(receipt.path, "rev-parse", "HEAD");
    const index = await fs.readFile(git(receipt.path, "rev-parse", "--git-path", "index"));
    const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
    const result = await settle(); expect(result.phase).toBe("retained");
    expect(result.reason).toMatch(kind === "commit" ? /HEAD/ : /pristine/);
    expect(remove).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(receipt.path, filename), "utf8")).toBe("work");
    expect(await fs.readFile(git(receipt.path, "rev-parse", "--git-path", "index"))).toEqual(index);
    expect(git(receipt.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "rev-parse", receipt.branch)).toBe(head);
    expect(await resources.read(receipt.id)).toMatchObject({ phase: "retained", reason: result.reason });
  });

it.each(["exit", "admission", "writers", "run", "session", "claim", "claim-error", "locked", "main",
  "branch", "head", "path", "detached", "prunable", "duplicate", "list-error", "list-throw",
  "pristine-error", "truncated", "truncated-status", "truncated-index", "missing", "alias", "receipt", "corrupt", "read-error", "inactive", "receipt-path", "receipt-branch", "receipt-sha", "main-path"])(
  "refuses uncertain ownership/lifecycle: %s", async (kind) => {
    const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
    const proof = permission();
    const claim = vi.fn(async () => { if (kind === "claim-error") throw Error("unavailable"); return kind === "claim"; });
    if (kind === "exit") proof.actualExit = false;
    if (kind === "admission") proof.admissionStopped = false;
    if (kind === "writers") proof.writersStopped = false;
    if (kind === "run") proof.appRunId = "previous-run";
    if (kind === "session") proof.childSessionId = "another";
    if (kind === "locked") git(root, "worktree", "lock", receipt.path);
    if (kind === "branch") git(receipt.path, "switch", "-c", "other");
    if (kind === "head") git(receipt.path, "commit", "--allow-empty", "-m", "Commit only");
    if (kind === "detached") git(receipt.path, "checkout", "--detach");
    if (kind === "missing") await fs.rename(receipt.path, `${receipt.path}-moved`);
    if (kind === "alias") {
      await fs.rename(receipt.path, `${receipt.path}-moved`);
      await fs.symlink(`${receipt.path}-moved`, receipt.path);
    }
    if (kind === "receipt") receipt = { ...receipt, parentSessionId: "forged" };
    if (kind === "corrupt") await fs.writeFile(path.join(scratch, "data/child-worktrees", `${receipt.id}.json`), "{");
    if (kind === "read-error") vi.spyOn(resources, "read").mockRejectedValue(Error("disk"));
    if (kind === "inactive") receipt = await resources.update(receipt, "retained", "kept");
    if (kind.startsWith("receipt-")) {
      receipt = { ...receipt, ...(kind === "receipt-path" ? { path: root } : kind === "receipt-branch" ? { branch: "other" } : { baseSha: "invalid" }) };
      await fs.writeFile(path.join(scratch, "data/child-worktrees", `${receipt.id}.json`), JSON.stringify(receipt));
    }
    if (["main-path", "main", "path", "prunable", "duplicate", "list-error", "list-throw"].includes(kind)) {
      const list = NodeGitAdapter.prototype.worktreeList;
      vi.spyOn(NodeGitAdapter.prototype, "worktreeList").mockImplementation(async function (this: NodeGitAdapter) {
        if (kind === "list-error") return { ok: false, reason: "failed read" };
        if (kind === "list-throw") throw Error("failed read");
        const result = await list.call(this);
        if (result.ok) {
          const entry = result.value.find((e) => e.path === receipt.path)!;
          if (kind === "main-path") result.value.find(e => e.isMain)!.path += "-other";
          if (kind === "main") entry.isMain = true;
          if (kind === "path") entry.path += "-other";
          if (kind === "prunable") entry.prunable = true;
          if (kind === "duplicate") result.value.push({ ...entry });
        }
        return result;
      });
    }
    if (kind === "pristine-error") vi.spyOn(NodeGitAdapter.prototype, "worktreeIsPristine")
      .mockResolvedValue({ ok: false, reason: "failed read" });
    if (kind.startsWith("truncated")) {
      const run = NodeExecutionAdapter.prototype.runBinary;
      vi.spyOn(NodeExecutionAdapter.prototype, "runBinary").mockImplementation(async function (this: NodeExecutionAdapter, ...args) {
        const result = await run.apply(this, args);
        const command = kind === "truncated-index" ? "ls-files" : kind === "truncated-status" ? "status" : "worktree";
        return { ...result, stdoutTruncated: args[0].args.includes(command) };
      });
    }
    const listed = vi.spyOn(NodeGitAdapter.prototype, "worktreeList");
    expect((await settle({ permission: proof, hasOtherClaims: claim })).phase).toBe(kind === "head" ? "retained" : "unknown");
    expect(remove).not.toHaveBeenCalled();
    if (kind === "claim") expect(claim).toHaveBeenCalledOnce();
    if (["claim", "inactive", "receipt-path", "receipt-branch", "receipt-sha"].includes(kind)) expect(listed).not.toHaveBeenCalled();
    expect(git(root, "rev-parse", kind === "receipt-branch" ? `anycode-wt/child-${receipt.id}` : receipt.branch)).toBe(kind === "head"
      ? git(receipt.path, "rev-parse", "HEAD") : kind === "receipt-sha" ? git(root, "rev-parse", "HEAD") : receipt.baseSha);
    if (!["missing", "alias", "receipt-path"].includes(kind)) expect(await fs.readFile(path.join(receipt.path, "file"), "utf8")).toBe("base");
  });

it("retains on non-force remove error and records a sanitized diagnosis", async () => {
  vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove").mockResolvedValue({ ok: false, reason: "private stderr" });
  expect(await settle()).toEqual({ phase: "unknown", reason: "Non-force removal failed" });
  expect(await fs.readFile(path.join(receipt.path, "file"), "utf8")).toBe("base");
  expect(await resources.read(receipt.id)).toMatchObject({ phase: "unknown", reason: "Non-force removal failed" });
});

it("does not remove when the pre-removal receipt update fails", async () => {
  vi.spyOn(resources, "update").mockRejectedValue(Error("disk full"));
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  expect((await settle()).phase).toBe("unknown"); expect(remove).not.toHaveBeenCalled();
});

it("never cleans a previous run receipt even with matching stale lifecycle proof", async () => {
  const old = new ChildWorktreeResources({ userData: path.join(scratch, "data"), appRunId: "old-run" });
  receipt = await old.allocate(await old.snapshot(root, root),
    { parentSessionId: "parent", childSessionId: "old-child" });
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  expect((await settle({ permission: { ...permission(), appRunId: "old-run" } })).phase).toBe("unknown");
  expect(remove).not.toHaveBeenCalled();
  expect(await resources.read(receipt.id)).toEqual(receipt);
  expect(await fs.readFile(path.join(receipt.path, "file"), "utf8")).toBe("base");
});

it("leaves durable uncertainty when final receipt persistence fails after removal", async () => {
  const update = resources.update.bind(resources);
  vi.spyOn(resources, "update").mockImplementation(async (...args) => {
    if (args[1] === "removed") throw Error("disk full");
    return update(...args);
  });
  expect((await settle()).phase).toBe("unknown");
  const pending = await resources.read(receipt.id);
  expect(pending).toMatchObject({ phase: "unknown", reason: "Empty checkout removal pending" });
  await expect(fs.stat(receipt.path)).rejects.toThrow();
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  await settle({ receipt: pending }); expect(remove).not.toHaveBeenCalled();
  expect(git(root, "rev-parse", receipt.branch)).toBe(receipt.baseSha);
});

it("refuses a claim appearing after the first check", async () => {
  const claims = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  expect((await settle({ hasOtherClaims: claims })).phase).toBe("unknown");
  expect(remove).not.toHaveBeenCalled();
});

it("keeps checkout on a thrown remove error", async () => {
  vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove").mockRejectedValue(Error("private text"));
  expect((await settle()).phase).toBe("unknown");
  expect(await fs.readFile(path.join(receipt.path, "file"), "utf8")).toBe("base");
  expect(await resources.read(receipt.id)).toMatchObject({ phase: "unknown" });
});

it("refuses a registration without a readable HEAD", async () => {
  const list = NodeGitAdapter.prototype.worktreeList;
  vi.spyOn(NodeGitAdapter.prototype, "worktreeList").mockImplementation(async function (this: NodeGitAdapter) {
    const result = await list.call(this);
    if (result.ok) result.value.find((entry) => entry.path === receipt.path)!.head = "";
    return result;
  });
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  expect(await settle()).toEqual({ phase: "unknown", reason: "Registered HEAD could not be read" });
  expect(remove).not.toHaveBeenCalled();
});

it("does not remove after the settlement deadline expires during claim verification", async () => {
  const controller = new AbortController();
  let checks = 0;
  const remove = vi.spyOn(NodeGitAdapter.prototype, "worktreeRemove");
  const result = await settle({ signal: controller.signal, hasOtherClaims: async () => {
    if (++checks === 2) controller.abort();
    return false;
  } });
  expect(result.phase).toBe("unknown");
  expect(remove).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(receipt.path, "file"), "utf8")).toBe("base");
});

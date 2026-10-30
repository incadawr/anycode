import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "./node-execution.js";
import { NodeGitReadAdapter } from "./node-git-read.js";
import { gitInputSchema, type GitInput } from "../../tools/schemas.js";

let dir: string;
let reader: NodeGitReadAdapter;
const signal = () => new AbortController().signal;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } });
const read = (input: GitInput) => reader.read(input, dir, signal());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anycode-git-read-"));
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  mkdirSync(join(dir, "docs")); writeFileSync(join(dir, "docs", "a b.txt"), "old version\n");
  git("add", "."); git("commit", "-qm", "initial");
  git("update-ref", "refs/remotes/origin/develop", "HEAD"); git("checkout", "-qb", "feature");
  writeFileSync(join(dir, "docs", "a b.txt"), "new version\n"); git("commit", "-qam", "new version");
  reader = new NodeGitReadAdapter(new NodeExecutionAdapter());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("NodeGitReadAdapter", () => {
  it("reads historical content, branch history, and the other supported views", async () => {
    expect((await read({ operation: "show", revision: "origin/develop", path: "docs/a b.txt" })).stdout).toBe("old version\n");
    expect((await read({ operation: "log", revision: "develop..HEAD", format: "oneline" })).stdout).toContain("new version");
    expect((await read({ operation: "diff", revision: "develop", endRevision: "HEAD", format: "name-only" })).stdout).toContain("a b.txt");
    expect((await read({ operation: "blame", path: "docs/a b.txt", revision: "HEAD", startLine: 1, endLine: 1 })).stdout).toContain("new version");
    expect((await read({ operation: "ls-tree", revision: "HEAD", path: "docs" })).stdout).toContain("docs");
    expect((await read({ operation: "rev-parse", revision: "HEAD" })).stdout.trim()).toBe(git("rev-parse", "HEAD").trim());
    expect((await read({ operation: "branch" })).stdout).toContain("feature");
    expect((await read({ operation: "status" })).stdout).toBe("");
  });
  it("rejects unsafe revisions and paths before an operation executes", async () => {
    for (const revision of ["--output=x", "HEAD:foo", "HEAD\n-x", "HEAD...", "HEAD..--output=x"]) {
      await expect(read({ operation: "log", revision })).rejects.toThrow();
    }
    for (const path of ["--output=x", "../outside", ":(top)*", "/tmp/outside"]) {
      await expect(read({ operation: "show", revision: "HEAD", path })).rejects.toThrow();
    }
    symlinkSync(tmpdir(), join(dir, "escape"));
    await expect(read({ operation: "show", revision: "HEAD", path: "escape/file" })).rejects.toThrow();
  });
  it("suppresses configured and inherited executable helpers", async () => {
    const sentinel = join(dir, "sentinel");
    const cmd = `touch ${sentinel}`;
    git("config", "core.pager", cmd); git("config", "core.fsmonitor", cmd);
    git("config", "diff.external", cmd); git("config", "diff.evil.textconv", cmd); git("config", "format.pretty", "%G?"); git("config", "log.showSignature", "true"); git("config", "gpg.program", cmd); git("config", "filter.evil.clean", cmd);
    git("config", "filter.evil.process", cmd); git("config", "filter.evil.required", "true");
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil diff=evil\n");
    writeFileSync(join(dir, "docs", "a b.txt"), "working\n");
    const old = process.env.GIT_EXTERNAL_DIFF; const oldTrace = process.env.GIT_TRACE; process.env.GIT_EXTERNAL_DIFF = cmd; process.env.GIT_TRACE = join(dir, "trace");
    try { expect((await read({ operation: "diff", revision: "HEAD" })).status).toBe("completed"); expect((await read({ operation: "show", revision: "HEAD" })).status).toBe("completed"); expect((await read({ operation: "log", revision: "HEAD", format: "stat" })).status).toBe("completed"); } finally { if (old === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = old; if (oldTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = oldTrace; }
    expect(existsSync(sentinel)).toBe(false); expect(existsSync(join(dir, "trace"))).toBe(false);
  });
  it("reports truncated output with a visible notice", async () => {
    writeFileSync(join(dir, "docs", "a b.txt"), "界".repeat(30000));
    git("add", "docs/a b.txt"); git("commit", "-qm", "large");
    const out = await read({ operation: "show", revision: "HEAD", path: "docs/a b.txt" });
    expect(out.stdoutTruncated).toBe(true); expect(out.notice).toContain("truncated");
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(100000);
  });
  it("reads deleted historical files from nested workspaces and linked worktrees", async () => {
    git("rm", "-q", "docs/a b.txt"); git("commit", "-qm", "delete file"); mkdirSync(join(dir, "docs"), { recursive: true });
    const result = await reader.read({ operation: "show", revision: "origin/develop", path: "a b.txt" }, join(dir, "docs"), signal());
    expect(result.stdout).toBe("old version\n");
    const linked = join(dir, "linked"); git("worktree", "add", "-q", "--detach", linked, "HEAD");
    const linkedResult = await reader.read({ operation: "rev-parse", revision: "HEAD" }, linked, signal());
    expect(linkedResult.stdout.trim()).toBe(git("rev-parse", "HEAD").trim());
  });
  it("fails clearly outside a repository, on unknown revisions, and without execution", async () => {
    await expect(read({ operation: "rev-parse", revision: "unknown-ref" })).rejects.toThrow();
    await expect(new NodeGitReadAdapter({ run: async () => { throw new Error("unexpected"); } }).read({ operation: "status" }, dir, signal())).rejects.toThrow("unavailable");
    const outside = mkdtempSync(join(tmpdir(), "git-outside-"));
    try { await expect(reader.read({ operation: "status" }, outside, signal())).rejects.toThrow(); }
    finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("does not invoke a transport helper for a missing promised object", async () => {
    const sentinel = join(dir, "network-helper");
    const blob = git("rev-parse", "HEAD:docs/a b.txt").trim();
    git("config", "remote.origin.url", `ext::touch ${sentinel}`);
    git("config", "protocol.ext.allow", "always");
    git("config", "remote.origin.promisor", "true");
    git("config", "remote.origin.partialclonefilter", "blob:none");
    rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    // Establish that the repository really invokes its configured helper without the guard.
    spawnSync("git", ["-c", "protocol.allow=never", "show", "HEAD:docs/a b.txt"], {
      cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_NO_LAZY_FETCH: "0", GIT_ALLOW_PROTOCOL: undefined },
    });
    expect(existsSync(sentinel)).toBe(true);
    rmSync(sentinel);
    // Simulate older Git, which ignores GIT_NO_LAZY_FETCH.
    const execution = new NodeExecutionAdapter();
    const oldGit = new NodeGitReadAdapter({ run: execution.run.bind(execution), runBinary: request => execution.runBinary({ ...request, env: { ...request.env, GIT_NO_LAZY_FETCH: undefined } }) });
    const result = await oldGit.read({ operation: "show", revision: "HEAD", path: "docs/a b.txt" }, dir, signal());
    expect(result.exitCode).not.toBe(0); expect(existsSync(sentinel)).toBe(false);
  });
  it("reports binary historical blobs", async () => {
    writeFileSync(join(dir, "binary.dat"), Buffer.from([0, 1, 2, 3])); git("add", "binary.dat"); git("commit", "-qm", "binary");
    await expect(read({ operation: "show", revision: "HEAD", path: "binary.dat" })).rejects.toThrow("binary");
  });

  it("handles unborn and detached HEAD", async () => {
    git("checkout", "-q", "--detach", "HEAD");
    expect((await read({ operation: "status" })).exitCode).toBe(0);
    const unborn = mkdtempSync(join(tmpdir(), "git-unborn-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: unborn });
      expect((await reader.read({ operation: "status" }, unborn, signal())).exitCode).toBe(0);
      expect((await reader.read({ operation: "log" }, unborn, signal())).exitCode).not.toBe(0);
    } finally { rmSync(unborn, { recursive: true, force: true }); }
  });
  it("fails closed when discovery is cancelled or times out", async () => {
    for (const status of ["cancelled", "timed_out"] as const) {
      const exec = { run: async () => { throw new Error("unexpected"); }, runBinary: async () => ({ status, exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1 }) };
      await expect(new NodeGitReadAdapter(exec).read({ operation: "status" }, dir, signal())).rejects.toThrow(status);
    }
  });
  it("bounds both captured streams and preserves truncation flags", async () => {
    const exec = { run: async () => { throw new Error("unexpected"); }, runBinary: async (request: { args: string[] }) => {
      const root = request.args.includes("--show-toplevel");
      const query = request.args.includes("--get-regexp");
      return { status: root || !query ? "completed" as const : "failed" as const, exitCode: query ? 1 : 0, signal: null,
        stdout: root ? `${dir}\n` : query ? "" : "界".repeat(20000), stderr: root || query ? "" : "x".repeat(20000),
        stdoutTruncated: !root && !query, stderrTruncated: !root && !query, durationMs: 1 };
    } };
    const result = await new NodeGitReadAdapter(exec).read({ operation: "status" }, dir, signal());
    expect(result.stdoutTruncated).toBe(true); expect(result.stderrTruncated).toBe(true);
    expect(result.notice).toContain("truncated"); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100000);
  });

  it("supports Unicode paths and confines an unqualified tree listing to the workspace", async () => {
    writeFileSync(join(dir, "docs", "файл.txt"), "содержимое\n");
    git("add", "docs/файл.txt"); git("commit", "-qm", "unicode");
    const cwd = join(dir, "docs");
    const file = await reader.read({ operation: "show", revision: "HEAD", path: "файл.txt" }, cwd, signal());
    const tree = await reader.read({ operation: "ls-tree", revision: "HEAD" }, cwd, signal());
    expect(file.stdout).toBe("содержимое\n");
    expect(tree.stdout).toContain("a b.txt"); expect(tree.stdout).not.toContain("docs\t");
  });

  it("includes empty branch commits when no log paths are requested", async () => {
    git("commit", "--allow-empty", "-qm", "empty branch commit");
    const result = await read({ operation: "log", revision: "develop..HEAD", format: "oneline" });
    expect(result.stdout).toContain("empty branch commit");
  });

  it("scopes commit patches and stats without hiding empty commits", async () => {
    mkdirSync(join(dir, "sibling"));
    writeFileSync(join(dir, "sibling", "secret.txt"), "sibling secret\n");
    writeFileSync(join(dir, "docs", "a b.txt"), "workspace change\n");
    git("add", "."); git("commit", "-qm", "both directories");
    git("commit", "--allow-empty", "-qm", "empty commit");
    const cwd = join(dir, "docs");
    const show = await reader.read({ operation: "show", revision: "HEAD~1" }, cwd, signal());
    const showStat = await reader.read({ operation: "show", revision: "HEAD~1", format: "stat" }, cwd, signal());
    const log = await reader.read({ operation: "log", format: "stat" }, cwd, signal());
    expect(show.stdout).toContain("workspace change");
    for (const output of [show.stdout, showStat.stdout, log.stdout]) {
      expect(output).toContain("a b.txt");
      expect(output).not.toContain("sibling");
      expect(output).not.toContain("secret.txt");
    }
    expect(log.stdout).toContain("empty commit");
  });

  it("rejects an operation naming a configured executable Git alias", async () => {
    const sentinel = join(dir, "alias-sentinel");
    git("config", "alias.aliastrip", "!touch alias-sentinel");
    // Confirm the alias is executable in this repository before testing the tool boundary.
    git("aliastrip");
    expect(existsSync(sentinel)).toBe(true);
    rmSync(sentinel);

    const parsed = gitInputSchema.safeParse({ operation: "aliastrip" });
    if (parsed.success) await read(parsed.data);
    expect(existsSync(sentinel)).toBe(false);
    expect(parsed.success).toBe(false);
  });

  it("passes pager safeguards and only built-in commands to Git", async () => {
    const execution = new NodeExecutionAdapter();
    const calls: Array<{ args: string[]; env?: Record<string, string | undefined> }> = [];
    const observing = new NodeGitReadAdapter({ run: execution.run.bind(execution), runBinary: request => {
      calls.push(request);
      return execution.runBinary(request);
    } });
    const result = await observing.read({ operation: "show", revision: "HEAD" }, dir, signal());
    expect(result.exitCode).toBe(0);
    for (const call of calls) {
      expect(call.args).toContain("--no-pager");
      expect(call.args).toContain("core.pager=cat");
      expect(call.env?.GIT_PAGER).toBe("cat");
      expect(call.env?.PAGER).toBe("cat");
    }
    const finalArgs = calls.at(-1)!.args;
    expect(finalArgs[finalArgs.indexOf("-C") + 2]).toBe("show");
  });

});

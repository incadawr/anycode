import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "./node-execution.js";
import {
  GIT_DIFF_MAX_OUTPUT_BYTES,
  GIT_WORKTREE_ADD_TIMEOUT_MS,
  NodeGitAdapter,
  parseBranchList,
  parseLogRecords,
  parsePorcelainV2Status,
  parseWorktreeListZ,
} from "./node-git.js";
import type { BinaryExecRequest, ExecRequest, ExecResult, ExecutionPort } from "../../ports/execution.js";

// ---------------------------------------------------------------------------
// Section 1: pure parser units (no git). Fixtures use the exact byte layout git
// emits (verified against real `git status --porcelain=v2 -z` / for-each-ref /
// log): NUL (\x00) field separators, RS (\x1e) record terminators.

describe("parsePorcelainV2Status", () => {
  it("parses an unborn HEAD (sha null, branch name preserved)", () => {
    const raw = "# branch.oid (initial)\x00# branch.head main\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.head).toEqual({ branch: "main", detached: false, sha: null, ahead: null, behind: null });
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([]);
    expect(s.untracked).toEqual([]);
  });

  it("splits a staged change and untracked files by XY code", () => {
    const raw =
      "# branch.oid abc123\x00# branch.head main\x00" +
      "1 M. N... 100644 100644 100644 hH hI a.txt\x00" +
      "? b.txt\x00? untracked.txt\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.head.sha).toBe("abc123");
    expect(s.staged).toEqual([{ path: "a.txt", kind: "modified" }]);
    expect(s.unstaged).toEqual([]);
    expect(s.untracked).toEqual(["b.txt", "untracked.txt"]);
  });

  it("routes a worktree-only change (Y != '.') to unstaged", () => {
    const raw = "# branch.oid abc\x00# branch.head main\x00" + "1 .M N... 100644 100644 100644 hH hI a.txt\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([{ path: "a.txt", kind: "modified" }]);
  });

  it("parses a rename record (type 2) consuming the origPath NUL token", () => {
    const raw =
      "# branch.oid abc\x00# branch.head main\x00" +
      "2 R. N... 100644 100644 100644 hH hI R100 renamed-a.txt\x00a.txt\x00" +
      "? b.txt\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.staged).toEqual([{ path: "renamed-a.txt", kind: "renamed", renamedFrom: "a.txt" }]);
    expect(s.untracked).toEqual(["b.txt"]);
  });

  it("preserves spaces, unicode and quotes in paths (byte-exact under -z)", () => {
    const raw =
      "# branch.oid abc\x00# branch.head main\x00" +
      "1 M. N... 100644 100644 100644 hH hI café with spaces.txt\x00" +
      '? q"uote.txt\x00' +
      "? snowman-☃.txt\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.staged).toEqual([{ path: "café with spaces.txt", kind: "modified" }]);
    expect(s.untracked).toEqual(['q"uote.txt', "snowman-☃.txt"]);
  });

  it("parses an unmerged record (type u) as a single unstaged 'unmerged' change", () => {
    const raw =
      "# branch.oid abc\x00# branch.head main\x00" +
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.unstaged).toEqual([{ path: "conflict.txt", kind: "unmerged" }]);
    expect(s.staged).toEqual([]);
  });

  it("parses a detached HEAD", () => {
    const raw = "# branch.oid abc\x00# branch.head (detached)\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.head.detached).toBe(true);
    expect(s.head.branch).toBeNull();
    expect(s.head.sha).toBe("abc");
  });

  it("parses ahead/behind from branch.ab", () => {
    const raw =
      "# branch.oid abc\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -3\x00";
    const s = parsePorcelainV2Status(raw);
    expect(s.head.ahead).toBe(2);
    expect(s.head.behind).toBe(3);
  });
});

describe("parseBranchList", () => {
  it("maps current-branch marker and NUL fields", () => {
    // %(HEAD) is " " (space) for non-current, "*" for current; lines LF-separated.
    const raw = " \x00feature\x00d49e72c\n*\x00main\x00d49e72c\n";
    const b = parseBranchList(raw);
    expect(b).toEqual([
      { name: "feature", current: false, sha: "d49e72c" },
      { name: "main", current: true, sha: "d49e72c" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseBranchList("")).toEqual([]);
  });
});

describe("parseLogRecords", () => {
  it("parses RS-terminated, NUL-separated records with epoch-ms author dates", () => {
    const raw =
      "sha1\x00Alice\x001700000000\x00first subject\x1e\nsha2\x00Bob\x001700000001\x00second\x1e";
    const l = parseLogRecords(raw);
    expect(l).toEqual([
      { sha: "sha1", authorName: "Alice", authorDate: 1700000000000, subject: "first subject" },
      { sha: "sha2", authorName: "Bob", authorDate: 1700000001000, subject: "second" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseLogRecords("")).toEqual([]);
  });
});

describe("parseWorktreeListZ", () => {
  it("parses main, linked, detached, locked and prunable porcelain records", () => {
    const raw =
      "worktree /repo\0HEAD aaaa\0branch refs/heads/main\0\0" +
      "worktree /repo/wt one\0HEAD bbbb\0branch refs/heads/feature/x\0locked in use\0\0" +
      "worktree /repo/wt-detached\0HEAD cccc\0detached\0prunable missing gitdir\0\0";
    expect(parseWorktreeListZ(raw)).toEqual([
      {
        path: "/repo",
        head: "aaaa",
        branch: "main",
        detached: false,
        isMain: true,
        locked: false,
        prunable: false,
      },
      {
        path: "/repo/wt one",
        head: "bbbb",
        branch: "feature/x",
        detached: false,
        isMain: false,
        locked: true,
        prunable: false,
      },
      {
        path: "/repo/wt-detached",
        head: "cccc",
        branch: null,
        detached: true,
        isMain: false,
        locked: false,
        prunable: true,
      },
    ]);
  });

  it("handles empty, bare, unicode paths and unknown future attributes", () => {
    expect(parseWorktreeListZ("")).toEqual([]);
    expect(parseWorktreeListZ("worktree /tmp/имя с пробелами\0bare\0future value\0\0")).toEqual([
      {
        path: "/tmp/имя с пробелами",
        head: null,
        branch: null,
        detached: false,
        isMain: true,
        locked: false,
        prunable: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Section 2: mock-exec (RecordingExec). Proves argv construction, SAFE_GIT_ENV /
// GIT_DIR-family neutralization on every method (L2), the pre-spawn ref guard


const CWD = "/tmp/fake-workspace";

interface RecordedCall {
  file: string;
  args: string[];
  cwd?: string;
  // SAFE_GIT_ENV carries `undefined` values (unset sentinels), so the recorded
  // env admits `string | undefined` to let assertions inspect neutralized keys.
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
}

function okResult(stdout: string): ExecResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

class RecordingExec implements ExecutionPort {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly responder: (args: string[]) => ExecResult = () => okResult("")) {}
  run(): Promise<ExecResult> {
    throw new Error("run() is not used by NodeGitAdapter");
  }
  runBinary(req: BinaryExecRequest): Promise<ExecResult> {
    this.calls.push({
      file: req.file,
      args: req.args,
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
      abortSignal: req.abortSignal,
    });
    return Promise.resolve(this.responder(req.args));
  }
}

/** ExecutionPort without runBinary — exercises the honest-disable path. */
class NoRunBinaryExec implements ExecutionPort {
  run(): Promise<ExecResult> {
    throw new Error("run() is not used by NodeGitAdapter");
  }
}

function assertSafeEnv(call: RecordedCall, expectedCwd = CWD, expectedTimeout = 30_000): void {
  expect(call.file).toBe("git");
  expect(call.cwd).toBe(expectedCwd);
  expect(call.timeoutMs).toBe(expectedTimeout);
  const env = call.env ?? {};
  // Positive protective env, plus the ad-hoc-config injection kill-switch.
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  expect(env.LC_ALL).toBe("C");
  expect(env.GIT_CONFIG_COUNT).toBe("0");
  // The GIT_DIR family + inherited exec drivers carry NO effective value: each is
  // either absent or present-as-`undefined` (Node unsets undefined keys in the
  // child), so no relocation/exec vector reaches git.
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_EXTERNAL_DIFF",
    "GIT_SSH_COMMAND",
  ] as const) {
    expect(env[key]).toBeUndefined();
  }
}

describe("NodeGitAdapter (mock exec)", () => {
  it("honestly disables every method when runBinary is absent", async () => {
    const adapter = new NodeGitAdapter({ exec: new NoRunBinaryExec(), cwd: CWD });
    const results = [
      await adapter.status(),
      await adapter.listBranches(),
      await adapter.log(),
      await adapter.diff(),
      await adapter.switchBranch("feature"),
      await adapter.createBranch("feature"),
      await adapter.stageAll(),
      await adapter.commit("msg"),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("runBinary");
    }
  });

  it("spawns every method with SAFE_GIT_ENV, neutralizing the GIT_DIR family (L2)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.status();
    await adapter.listBranches();
    await adapter.log();
    await adapter.diff();
    await adapter.switchBranch("feature");
    await adapter.createBranch("feature2");
    await adapter.stageAll();
    await adapter.commit("msg");
    // commit spawns commit + rev-parse; every other method spawns once => 9.
    expect(exec.calls.length).toBe(9);
    for (const call of exec.calls) assertSafeEnv(call);
  });

  it("builds machine-format argv for read methods", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.status();
    await adapter.listBranches();
    await adapter.log();
    await adapter.log({ limit: 5 });
    expect(exec.calls[0]?.args).toEqual(["status", "--porcelain=v2", "--branch", "-z"]);
    expect(exec.calls[1]?.args).toEqual([
      "for-each-ref",
      "refs/heads",
      "--format=%(HEAD)%00%(refname:short)%00%(objectname)",
    ]);
    expect(exec.calls[2]?.args).toEqual(["log", "-n", "20", "--pretty=format:%H%x00%an%x00%at%x00%s%x1e"]);
    expect(exec.calls[3]?.args).toEqual(["log", "-n", "5", "--pretty=format:%H%x00%an%x00%at%x00%s%x1e"]);
  });

  it("maps diff targets and always places a path after '--' (R7)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.diff();
    await adapter.diff({ target: "staged" });
    await adapter.diff({ target: "worktree" });
    await adapter.diff({ path: "--output=/tmp/pwn" });
    await adapter.diff({ target: "staged", path: "src/x.ts" });
    expect(exec.calls[0]?.args).toEqual(["diff", "HEAD"]);
    expect(exec.calls[1]?.args).toEqual(["diff", "--cached"]);
    expect(exec.calls[2]?.args).toEqual(["diff"]);
    expect(exec.calls[3]?.args).toEqual(["diff", "HEAD", "--", "--output=/tmp/pwn"]);
    expect(exec.calls[4]?.args).toEqual(["diff", "--cached", "--", "src/x.ts"]);
  });

  it("builds argv for write methods (commit message is a distinct argv element)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.switchBranch("feature");
    await adapter.createBranch("only");
    await adapter.createBranch("both", { switch: true });
    await adapter.stageAll();
    await adapter.commit("--amend");
    expect(exec.calls[0]?.args).toEqual(["switch", "feature"]);
    expect(exec.calls[1]?.args).toEqual(["branch", "only"]);
    expect(exec.calls[2]?.args).toEqual(["switch", "-c", "both"]);
    expect(exec.calls[3]?.args).toEqual(["add", "-A"]);
    expect(exec.calls[4]?.args).toEqual(["commit", "-m", "--amend"]);
    expect(exec.calls[5]?.args).toEqual(["rev-parse", "HEAD"]);
  });

  it("rejects unsafe ref names BEFORE any spawn (R7: no spawn happened)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    const unsafe = ["", "-", "-D", "--force", "-c evil", "\n", "a\tb", ""];
    for (const name of unsafe) {
      const sw = await adapter.switchBranch(name);
      expect(sw.ok).toBe(false);
      const cr = await adapter.createBranch(name, { switch: true });
      expect(cr.ok).toBe(false);
    }
    expect(exec.calls.length).toBe(0);
  });

  it("stages/unstages exact paths strictly after '--' (structural flag-injection defense)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.stage!(["src/a.ts", "-rf", "--force"]);
    await adapter.unstage!(["src/a.ts", "--staged"]);
    expect(exec.calls[0]?.args).toEqual(["add", "--", "src/a.ts", "-rf", "--force"]);
    expect(exec.calls[1]?.args).toEqual(["restore", "--staged", "--", "src/a.ts", "--staged"]);
  });

  it("refuses empty-array stage/unstage WITHOUT any spawn (R7)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    const st = await adapter.stage!([]);
    const un = await adapter.unstage!([]);
    expect(st.ok).toBe(false);
    expect(un.ok).toBe(false);
    expect(exec.calls.length).toBe(0);
  });

  // --- destructive methods (slice 5.8): argv discipline (§6#4) ---------------

  it("discard places every path (even flag-looking ones) strictly after '--' (§6#4)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    // A path that looks like a destructive flag must ride as a pathspec, never a flag.
    await adapter.discard!(["src/a.ts", "-rf", "--hard", "--output=/tmp/pwn"]);
    expect(exec.calls[0]?.args).toEqual([
      "restore",
      "--worktree",
      "--",
      "src/a.ts",
      "-rf",
      "--hard",
      "--output=/tmp/pwn",
    ]);
  });

  it("refuses empty-array discard WITHOUT any spawn (R7)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    const r = await adapter.discard!([]);
    expect(r.ok).toBe(false);
    expect(exec.calls.length).toBe(0);
  });

  it("builds stash-push argv with the message as a distinct verbatim argv element", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.stashPush!();
    await adapter.stashPush!({ includeUntracked: true });
    await adapter.stashPush!({ message: "wip: fix" });
    // A message that LOOKS like flags rides verbatim after -m, never re-interpreted.
    await adapter.stashPush!({ includeUntracked: true, message: "--include-untracked; rm -rf /" });
    expect(exec.calls[0]?.args).toEqual(["stash", "push"]);
    expect(exec.calls[1]?.args).toEqual(["stash", "push", "--include-untracked"]);
    expect(exec.calls[2]?.args).toEqual(["stash", "push", "-m", "wip: fix"]);
    expect(exec.calls[3]?.args).toEqual([
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "--include-untracked; rm -rf /",
    ]);
  });

  it("builds stash-pop argv", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.stashPop!();
    expect(exec.calls[0]?.args).toEqual(["stash", "pop"]);
  });

  it("resetHead builds argv from switch literals only (target pinned to HEAD, §6#4)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.resetHead!("mixed");
    await adapter.resetHead!("hard");
    // The two argv shapes are the ONLY ones constructible: literal HEAD, no interpolation.
    expect(exec.calls[0]?.args).toEqual(["reset", "--mixed", "HEAD"]);
    expect(exec.calls[1]?.args).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("spawns destructive methods with SAFE_GIT_ENV, neutralizing the GIT_DIR family (L2/L6)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.discard!(["a.txt"]);
    await adapter.stashPush!({ includeUntracked: true, message: "m" });
    await adapter.stashPop!();
    await adapter.resetHead!("hard");
    expect(exec.calls.length).toBe(4);
    for (const call of exec.calls) assertSafeEnv(call);
  });



  it("raises the output cap to GIT_DIFF_MAX_OUTPUT_BYTES on diff spawns ONLY (§6#7d, R6)", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });
    await adapter.status(); // calls[0]
    await adapter.log(); // calls[1]
    await adapter.diff(); // calls[2] (delegates to diffDetailed)
    await adapter.diffDetailed!({ target: "staged" }); // calls[3]
    // Non-diff spawns keep the default cap (undefined override => DEFAULT_MAX_OUTPUT_BYTES).
    expect(exec.calls[0]?.maxOutputBytes).toBeUndefined();
    expect(exec.calls[1]?.maxOutputBytes).toBeUndefined();
    // Diff spawns carry the 2 MiB override so the wire cap becomes reachable.
    expect(exec.calls[2]?.maxOutputBytes).toBe(GIT_DIFF_MAX_OUTPUT_BYTES);
    expect(exec.calls[3]?.maxOutputBytes).toBe(GIT_DIFF_MAX_OUTPUT_BYTES);
    expect(GIT_DIFF_MAX_OUTPUT_BYTES).toBe(2_097_152);
  });

  it("honestly disables all worktree methods without runBinary", async () => {
    const adapter = new NodeGitAdapter({ exec: new NoRunBinaryExec(), cwd: CWD });
    for (const result of [
      await adapter.worktreeAdd({ path: "wt", branch: "feature" }),
      await adapter.worktreeList(),
      await adapter.worktreeRemove({ path: "wt" }),
      await adapter.worktreePrune(),
      await adapter.deleteBranch("feature"),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("runBinary");
    }
  });

  it("prunes worktree metadata and deletes branches only through merged-safe argv", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });

    expect(await adapter.worktreePrune()).toEqual({ ok: true, value: null });
    expect(await adapter.deleteBranch("anycode-wt/finished")).toEqual({ ok: true, value: null });

    expect(exec.calls.map((call) => call.args)).toEqual([
      ["worktree", "prune"],
      ["branch", "-d", "--", "anycode-wt/finished"],
    ]);
    for (const call of exec.calls) assertSafeEnv(call);
    expect(exec.calls.flatMap((call) => call.args)).not.toContain("-D");
  });

  it("rejects unsafe branch deletion refs before spawning", async () => {
    const exec = new RecordingExec();
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });

    for (const name of ["", "-d", "--force", "bad\nref", "bad\tref", "\u007f"]) {
      const result = await adapter.deleteBranch(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("unsafe ref");
    }
    expect(exec.calls).toEqual([]);
  });

  it("reports prune and safe branch deletion failures without retrying forcefully", async () => {
    const failed = (): ExecResult => ({
      ...okResult(""),
      exitCode: 1,
      stderr: "error: branch is not fully merged",
    });
    const exec = new RecordingExec(failed);
    const adapter = new NodeGitAdapter({ exec, cwd: CWD });

    expect((await adapter.worktreePrune()).ok).toBe(false);
    expect((await adapter.deleteBranch("anycode-wt/unmerged")).ok).toBe(false);
    expect(exec.calls.map((call) => call.args)).toEqual([
      ["worktree", "prune"],
      ["branch", "-d", "--", "anycode-wt/unmerged"],
    ]);
    expect(exec.calls.flatMap((call) => call.args)).not.toContain("-D");
  });

  it("builds guarded worktree argv and threads SAFE_GIT_ENV, timeout and abort", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-wt-mock-")));
    try {
      const exec = new RecordingExec((args) => {
        if (args[0] === "worktree" && args[1] === "add") {
          const separator = args.indexOf("--");
          const target = args[separator + 1];
          if (target !== undefined) mkdirSync(target, { recursive: true });
        }
        return okResult("");
      });
      const controller = new AbortController();
      const adapter = new NodeGitAdapter({ exec, cwd: root, signal: controller.signal });

      const added = await adapter.worktreeAdd({
        path: "worktrees/feature one",
        branch: "feature/one",
        baseRef: "origin/main",
      });
      await adapter.worktreeList();
      await adapter.worktreeRemove({ path: "worktrees/feature one" });
      await adapter.worktreeRemove({ path: "worktrees/feature one", force: true });

      expect(added).toEqual({ ok: true, value: { path: join(root, "worktrees", "feature one") } });
      expect(exec.calls.map((call) => call.args)).toEqual([
        ["worktree", "add", "-b", "feature/one", "--", join(root, "worktrees", "feature one"), "origin/main"],
        ["worktree", "list", "--porcelain", "-z"],
        ["-C", join(root, "worktrees", "feature one"), "status", "--porcelain=v2", "--ignored=matching", "--untracked-files=all", "-z"],
        ["-C", join(root, "worktrees", "feature one"), "ls-files", "-v", "-z"],
        ["worktree", "remove", "--", join(root, "worktrees", "feature one")],
        ["worktree", "remove", "--force", "--", join(root, "worktrees", "feature one")],
      ]);
      assertSafeEnv(exec.calls[0]!, root, GIT_WORKTREE_ADD_TIMEOUT_MS);
      for (const call of exec.calls.slice(1)) assertSafeEnv(call, root);
      for (const call of exec.calls) expect(call.abortSignal).toBe(controller.signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("idempotently excludes the .anycode worktree namespace in the common repo", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-exclude-")));
    const common = join(root, ".git");
    try {
      await mkdir(common, { recursive: true });
      const exec = new RecordingExec(() => okResult(`${common}\n`));
      const adapter = new NodeGitAdapter({ exec, cwd: root });
      expect(await adapter.ensureWorktreeNamespaceIgnored()).toEqual({ ok: true, value: null });
      expect(await adapter.ensureWorktreeNamespaceIgnored()).toEqual({ ok: true, value: null });
      expect(await readFile(join(common, "info", "exclude"), "utf8")).toBe("/.anycode/worktrees/\n");
      expect(exec.calls.map((call) => call.args)).toEqual([
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ]);
      for (const call of exec.calls) assertSafeEnv(call, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked repository-local exclude file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-exclude-link-")));
    const common = join(root, ".git");
    const victim = join(root, "victim");
    try {
      await writeFile(victim, "keep\n");
      await mkdir(join(common, "info"), { recursive: true });
      await symlink(victim, join(common, "info", "exclude"));
      const exec = new RecordingExec(() => okResult(`${common}\n`));
      const adapter = new NodeGitAdapter({ exec, cwd: root });

      await expect(adapter.ensureWorktreeNamespaceIgnored()).resolves.toMatchObject({ ok: false });
      await expect(readFile(victim, "utf8")).resolves.toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe worktree refs and paths before spawning", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-wt-guard-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-wt-outside-")));
    try {
      await symlink(outside, join(root, "link"));
      const exec = new RecordingExec();
      const adapter = new NodeGitAdapter({ exec, cwd: root });
      for (const branch of ["", "-b", "--force", "bad\nref"]) {
        expect((await adapter.worktreeAdd({ path: "wt", branch })).ok).toBe(false);
      }
      expect((await adapter.worktreeAdd({ path: "wt", branch: "safe", baseRef: "--evil" })).ok).toBe(false);
      for (const candidate of [".", "../outside", ".git/wt", "link/wt"]) {
        expect((await adapter.worktreeAdd({ path: candidate, branch: "safe" })).ok).toBe(false);
        expect((await adapter.worktreeRemove({ path: candidate })).ok).toBe(false);
      }
      expect(exec.calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("parses worktreeList output and reports add/list/remove failures honestly", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-git-wt-fail-")));
    try {
      const porcelain = `worktree ${root}\0HEAD aaaa\0branch refs/heads/main\0\0`;
      const listExec = new RecordingExec(() => okResult(porcelain));
      const listed = await new NodeGitAdapter({ exec: listExec, cwd: root }).worktreeList();
      expect(listed.ok && listed.value[0]?.path).toBe(root);

      const failed = (): ExecResult => ({
        ...okResult(""),
        exitCode: 128,
        stderr: "fatal: refused",
      });
      const failExec = new RecordingExec(failed);
      const adapter = new NodeGitAdapter({ exec: failExec, cwd: root });
      expect((await adapter.worktreeAdd({ path: "wt", branch: "feature" })).ok).toBe(false);
      expect((await adapter.worktreeList()).ok).toBe(false);
      expect((await adapter.worktreeRemove({ path: "wt" })).ok).toBe(false);

      const truncatedExec = new RecordingExec(() => ({ ...okResult(porcelain), stdoutTruncated: true }));
      const truncated = await new NodeGitAdapter({ exec: truncatedExec, cwd: root }).worktreeList();
      expect(truncated).toEqual({ ok: false, reason: "git worktree list output truncated" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: hermetic real-git integration (pattern shadow-git.test.ts). Real
// `git init` in a tmpdir, real status/diff/commit; executable flag-injection PoC
// (§6); read-effect-freedom (L5); orphan re-proof (L10).

/** Runs a git CLI command for test setup; scrubs global/system config for hermeticity. */
function runGitCli(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function initRepo(dir: string): void {
  runGitCli(dir, ["init", "-q"]);
  runGitCli(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  runGitCli(dir, ["config", "user.name", "Test User"]);
  runGitCli(dir, ["config", "user.email", "test@anycode.invalid"]);
  runGitCli(dir, ["config", "commit.gpgsign", "false"]);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is reaped (or the deadline), tolerating OS reap lag. */
async function waitPidDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

/** Forwards to a real NodeExecutionAdapter but shortens the timeout so a hung
 *  spawn's kill discipline can be observed without waiting GIT_OP_TIMEOUT_MS. */
class ShortTimeoutExec implements ExecutionPort {
  constructor(
    private readonly inner: NodeExecutionAdapter,
    private readonly timeoutMs: number,
  ) {}
  run(request: ExecRequest): Promise<ExecResult> {
    return this.inner.run(request);
  }
  runBinary(request: BinaryExecRequest): Promise<ExecResult> {
    return this.inner.runBinary!({ ...request, timeoutMs: this.timeoutMs });
  }
}

describe("NodeGitAdapter real git integration", () => {
  const exec = new NodeExecutionAdapter();
  let dirs: string[] = [];

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-git-"));
    dirs.push(dir);
    initRepo(dir);
    return dir;
  }

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  it(
    "captures the base cycle: stage+commit, status buckets, diff content",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });

      await writeFile(join(dir, "a.txt"), "v1\n");
      expect((await adapter.stageAll()).ok).toBe(true);
      const c = await adapter.commit("first commit");
      expect(c.ok).toBe(true);
      if (c.ok) expect(c.value.sha).toBe(runGitCli(dir, ["rev-parse", "HEAD"]).trim());

      await writeFile(join(dir, "a.txt"), "v2\n");
      await writeFile(join(dir, "b.txt"), "new\n");
      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.head.branch).toBe("main");
        expect(s.value.head.detached).toBe(false);
        expect(s.value.head.sha).not.toBeNull();
        expect(s.value.unstaged).toEqual([{ path: "a.txt", kind: "modified" }]);
        expect(s.value.untracked).toContain("b.txt");
      }

      const d = await adapter.diff({ target: "head" });
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.value).toContain("-v1");
        expect(d.value).toContain("+v2");
      }
    },
    30_000,
  );

  it(
    "parses escaped paths byte-exactly (spaces / unicode / quote)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "café with spaces.txt"), "x");
      await writeFile(join(dir, "snowman-☃.txt"), "y");
      await writeFile(join(dir, 'q"uote.txt'), "z");
      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.untracked).toContain("café with spaces.txt");
        expect(s.value.untracked).toContain("snowman-☃.txt");
        expect(s.value.untracked).toContain('q"uote.txt');
      }
    },
    30_000,
  );

  it(
    "reports a staged rename with renamedFrom",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "old.txt"), "content\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      runGitCli(dir, ["mv", "old.txt", "new.txt"]);
      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) expect(s.value.staged).toContainEqual({ path: "new.txt", kind: "renamed", renamedFrom: "old.txt" });
    },
    30_000,
  );

  it(
    "reports a detached HEAD",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      const c = await adapter.commit("c1");
      const sha = c.ok ? c.value.sha : "";
      runGitCli(dir, ["checkout", "-q", sha]);
      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.head.detached).toBe(true);
        expect(s.value.head.branch).toBeNull();
        expect(s.value.head.sha).toBe(sha);
      }
    },
    30_000,
  );

  it(
    "handles an unborn HEAD: status ok (sha null), log ok+[], diff head fails, first commit works",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });

      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.head.sha).toBeNull();
        expect(s.value.head.branch).toBe("main");
      }
      expect(await adapter.log()).toEqual({ ok: true, value: [] });
      expect((await adapter.diff({ target: "head" })).ok).toBe(false);

      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      expect((await adapter.commit("first")).ok).toBe(true);
    },
    30_000,
  );

  it(
    "computes ahead/behind against a local bare upstream",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");

      const bare = await mkdtemp(join(tmpdir(), "anycode-git-bare-"));
      dirs.push(bare);
      runGitCli(bare, ["init", "--bare", "-q"]);
      runGitCli(dir, ["remote", "add", "origin", bare]);
      runGitCli(dir, ["push", "-q", "-u", "origin", "main"]);

      await writeFile(join(dir, "a.txt"), "2\n");
      await adapter.stageAll();
      await adapter.commit("c2 ahead");

      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.head.ahead).toBe(1);
        expect(s.value.head.behind).toBe(0);
      }
    },
    30_000,
  );

  it(
    "lists branches with the current flag, switches and creates branches",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      runGitCli(dir, ["branch", "feature"]);

      const b = await adapter.listBranches();
      expect(b.ok).toBe(true);
      if (b.ok) {
        expect(b.value.map((x) => x.name).sort()).toEqual(["feature", "main"]);
        expect(b.value.find((x) => x.name === "main")?.current).toBe(true);
        expect(b.value.find((x) => x.name === "feature")?.current).toBe(false);
      }

      expect((await adapter.switchBranch("feature")).ok).toBe(true);
      const s2 = await adapter.status();
      if (s2.ok) expect(s2.value.head.branch).toBe("feature");

      expect((await adapter.createBranch("newbr", { switch: true })).ok).toBe(true);
      const s3 = await adapter.status();
      if (s3.ok) expect(s3.value.head.branch).toBe("newbr");

      // an already-existing branch name fails honestly (no throw)
      expect((await adapter.createBranch("main")).ok).toBe(false);
    },
    30_000,
  );

  it(
    "returns newest-first log records with epoch-ms author dates",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      for (const [content, msg] of [
        ["1\n", "first"],
        ["2\n", "second"],
        ["3\n", "third"],
      ] as const) {
        await writeFile(join(dir, "a.txt"), content);
        await adapter.stageAll();
        await adapter.commit(msg);
      }
      const l = await adapter.log({ limit: 2 });
      expect(l.ok).toBe(true);
      if (l.ok) {
        expect(l.value.length).toBe(2);
        expect(l.value[0]?.subject).toBe("third");
        expect(l.value[1]?.subject).toBe("second");
        expect(l.value[0]?.authorName).toBe("Test User");
        expect(Number.isInteger(l.value[0]?.authorDate)).toBe(true);
        expect(l.value[0]?.authorDate).toBeGreaterThan(0);
      }
    },
    30_000,
  );

  it(
    "read methods are effect-free: .git/index bytes are unchanged (L5)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      await writeFile(join(dir, "b.txt"), "untracked\n");

      await adapter.status(); // warm-up absorbs any one-time refresh
      const before = await readFile(join(dir, ".git", "index"));
      await adapter.status();
      await adapter.log();
      await adapter.listBranches();
      await adapter.diff({ target: "head" });
      await adapter.diff({ target: "worktree" });
      const after = await readFile(join(dir, ".git", "index"));
      expect(after.equals(before)).toBe(true);
    },
    30_000,
  );

  // --- PoC battery (§6): executable flag-injection vectors ------------------

  it(
    "PoC: diff path '--output=<f>' lands after '--' and writes NO file",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      await writeFile(join(dir, "a.txt"), "2\n"); // real change: a flag WOULD have effect

      const pwn = join(dir, "PWNED");
      const r = await adapter.diff({ path: `--output=${pwn}` });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(""); // pathspec matches nothing → empty diff
      expect(existsSync(pwn)).toBe(false); // git never wrote the file
    },
    30_000,
  );

  it(
    "PoC: diff path '-R' is a pathspec, not the reverse flag",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      await writeFile(join(dir, "a.txt"), "2\n"); // real change

      const r = await adapter.diff({ path: "-R" });
      expect(r.ok).toBe(true);
      // As the reverse FLAG, `git diff HEAD -R` would emit a (reversed) non-empty
      // diff of a.txt. As a pathspec after `--`, "-R" matches nothing => empty.
      if (r.ok) expect(r.value).toBe("");
    },
    30_000,
  );

  it(
    "PoC: commit('--amend') commits the literal subject and does NOT amend",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "1\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      await writeFile(join(dir, "b.txt"), "2\n");
      await adapter.stageAll();

      const c = await adapter.commit("--amend");
      expect(c.ok).toBe(true);
      expect(Number(runGitCli(dir, ["rev-list", "--count", "HEAD"]).trim())).toBe(2); // not an amend
      expect(runGitCli(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("--amend"); // literal subject
    },
    30_000,
  );

  it(
    "PoC: neutralizes inherited GIT_* exec/relocation vectors leaked from process.env",
    async () => {
      // The real cwd repo (branch "main") with a committed file + a pending
      // worktree change, so `diff` has content that WOULD drive an external diff.
      const dir = await makeRepo();
      await writeFile(join(dir, "a.txt"), "v1\n");
      runGitCli(dir, ["add", "-A"]);
      runGitCli(dir, ["commit", "-q", "-m", "c1"]);
      await writeFile(join(dir, "a.txt"), "v2\n");

      // A SECOND real repo whose HEAD sits on a DISTINCTIVE branch; an inherited
      // GIT_DIR would silently relocate the adapter's reads here.
      const leaked = await mkdtemp(join(tmpdir(), "anycode-git-leaked-"));
      dirs.push(leaked);
      runGitCli(leaked, ["init", "-q"]);
      runGitCli(leaked, ["symbolic-ref", "HEAD", "refs/heads/leaked-branch"]);
      runGitCli(leaked, ["config", "user.name", "Leaked"]);
      runGitCli(leaked, ["config", "user.email", "leaked@anycode.invalid"]);
      await writeFile(join(leaked, "leaked.txt"), "leaked\n");
      runGitCli(leaked, ["add", "-A"]);
      runGitCli(leaked, ["commit", "-q", "-m", "leaked commit"]);

      // Executable payloads: if git ever runs them, the marker file appears.
      const extDiffMarker = join(leaked, "EXTDIFF_FIRED");
      const fsmonMarker = join(leaked, "FSMONITOR_FIRED");
      const extDiffScript = join(leaked, "extdiff.sh");
      const fsmonScript = join(leaked, "fsmon.sh");
      await writeFile(extDiffScript, `#!/bin/sh\n: > "${extDiffMarker}"\n`, { mode: 0o755 });
      await writeFile(fsmonScript, `#!/bin/sh\n: > "${fsmonMarker}"\n`, { mode: 0o755 });

      // Inherited attack env: exec-on-diff, exec-on-status (via ad-hoc config
      // injection of core.fsmonitor), and a repo relocation.
      const polluted: Record<string, string> = {
        GIT_EXTERNAL_DIFF: extDiffScript, // arbitrary exec on `git diff`
        GIT_DIR: join(leaked, ".git"), // relocate reads to the leaked repo
        GIT_CONFIG_COUNT: "1", // ad-hoc config injection...
        GIT_CONFIG_KEY_0: "core.fsmonitor", // ...of an exec-on-status hook program
        GIT_CONFIG_VALUE_0: fsmonScript,
      };
      const saved: Record<string, string | undefined> = {};
      for (const k of Object.keys(polluted)) saved[k] = process.env[k];

      try {
        Object.assign(process.env, polluted);
        const adapter = new NodeGitAdapter({ exec, cwd: dir });

        // diff() would exec GIT_EXTERNAL_DIFF; status() would exec core.fsmonitor.
        const d = await adapter.diff({ target: "worktree" });
        const s = await adapter.status();

        // (1) No inherited exec vector fired — neutralized, not merely unused.
        expect(existsSync(extDiffMarker)).toBe(false);
        expect(existsSync(fsmonMarker)).toBe(false);

        // (2) The adapter operated on the REAL cwd repo, not the leaked GIT_DIR:
        // it reports the cwd repo's branch, never the leaked one.
        expect(s.ok).toBe(true);
        if (s.ok) expect(s.value.head.branch).toBe("main");

        // (3) diff read the cwd repo's real change via git's INTERNAL differ.
        expect(d.ok).toBe(true);
        if (d.ok) {
          expect(d.value).toContain("-v1");
          expect(d.value).toContain("+v2");
        }
      } finally {
        for (const k of Object.keys(polluted)) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    },
    30_000,
  );

  it(
    "returns ok:false (no throw) for a non-git cwd",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-git-norepo-"));
      dirs.push(dir);
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      expect((await adapter.status()).ok).toBe(false);
      expect((await adapter.log()).ok).toBe(false);
      expect((await adapter.diff()).ok).toBe(false);
    },
    30_000,
  );

  it(
    "reaps a hung git spawn through the adapter's runBinary path (orphan discipline, L10)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-git-orphan-"));
      dirs.push(dir);
      const fakeGit = join(dir, "git");
      const pidFile = join(dir, "pid.txt");
      // A fake `git` that records its pid then execs a long sleep — the shape of a
      // hung git call the adapter must have reaped by runBinary's kill discipline.
      await writeFile(fakeGit, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 5\n`, { mode: 0o755 });

      const shortExec = new ShortTimeoutExec(new NodeExecutionAdapter(), 1500);
      const adapter = new NodeGitAdapter({ exec: shortExec, cwd: dir, gitBinary: fakeGit });
      const r = await adapter.status();
      expect(r.ok).toBe(false); // timed out

      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(Number.isNaN(pid)).toBe(false);
      expect(await waitPidDead(pid)).toBe(true); // ESRCH: process group reaped
    },
    15_000,
  );

  it(
    "stages exact paths and unstages one back to the worktree (5.4-R1 non-destructive half)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      // Seed an initial commit so HEAD exists (unstage/restore --staged needs it).
      await writeFile(join(dir, "seed.txt"), "seed\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      await writeFile(join(dir, "a.txt"), "a\n");
      await writeFile(join(dir, "b.txt"), "b\n");

      // stage() takes EXACTLY the two named paths (not `add -A`).
      expect((await adapter.stage!(["a.txt", "b.txt"])).ok).toBe(true);
      const staged = await adapter.status();
      expect(staged.ok).toBe(true);
      if (staged.ok) {
        expect(staged.value.staged.map((c) => c.path).sort()).toEqual(["a.txt", "b.txt"]);
        expect(staged.value.untracked).toEqual([]);
      }

      // unstage() removes exactly a.txt from the index; b.txt stays staged.
      expect((await adapter.unstage!(["a.txt"])).ok).toBe(true);
      const after = await adapter.status();
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value.staged.map((c) => c.path)).toEqual(["b.txt"]);
        expect(after.value.untracked).toEqual(["a.txt"]);
      }
    },
    30_000,
  );

  it(
    "unstage on an unborn HEAD fails honestly (restore --staged needs HEAD, R5)",
    async () => {
      const dir = await makeRepo(); // fresh init, no commits => unborn HEAD
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "a\n");
      expect((await adapter.stage!(["a.txt"])).ok).toBe(true);

      const r = await adapter.unstage!(["a.txt"]);
      expect(r.ok).toBe(false); // no HEAD to restore from
      // The file is still staged (the failed unstage left the index untouched).
      const s = await adapter.status();
      if (s.ok) expect(s.value.staged.map((c) => c.path)).toEqual(["a.txt"]);
    },
    30_000,
  );

  it(
    "reaps an in-flight git spawn when the injected AbortSignal fires (orphan discipline §6#4)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-git-abort-"));
      dirs.push(dir);
      const fakeGit = join(dir, "git");
      const pidFile = join(dir, "pid.txt");
      // Hung `git` shim: record pid, then exec a long sleep. Only the injected
      // AbortSignal can reap it inside the poll window (the timeout is 30s).
      await writeFile(fakeGit, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 5\n`, { mode: 0o755 });

      const controller = new AbortController();
      const adapter = new NodeGitAdapter({
        exec: new NodeExecutionAdapter(),
        cwd: dir,
        gitBinary: fakeGit,
        signal: controller.signal,
      });
      const pending = adapter.status(); // hangs on the sleeping shim

      // Wait until the shim has recorded its pid, then abort.
      let pid = Number.NaN;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          pid = Number((await readFile(pidFile, "utf-8")).trim());
          if (!Number.isNaN(pid)) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(Number.isNaN(pid)).toBe(false);

      controller.abort();
      const r = await pending;
      expect(r.ok).toBe(false); // cancelled, not completed
      expect(await waitPidDead(pid)).toBe(true); // ESRCH: process group reaped
    },
    15_000,
  );

  // --- destructive tail (slice 5.8) PoC battery (§6#1-#3, #7) ----------------

  it(
    "PoC (§6#1): discard reverts EXACTLY one worktree file to its index version, others + untracked byte-identical",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "a-v1\n");
      await writeFile(join(dir, "b.txt"), "b-v1\n");
      await writeFile(join(dir, "c.txt"), "c-v1\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      // Modify all three tracked files in the worktree; add one untracked file.
      await writeFile(join(dir, "a.txt"), "a-v2\n");
      await writeFile(join(dir, "b.txt"), "b-v2\n");
      await writeFile(join(dir, "c.txt"), "c-v2\n");
      await writeFile(join(dir, "untracked.txt"), "keep-me\n");

      const r = await adapter.discard(["a.txt"]);
      expect(r.ok).toBe(true);

      // Only a.txt reverted to its committed (index) content; the rest untouched.
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a-v1\n");
      expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b-v2\n");
      expect(await readFile(join(dir, "c.txt"), "utf-8")).toBe("c-v2\n");
      expect(await readFile(join(dir, "untracked.txt"), "utf-8")).toBe("keep-me\n");
    },
    30_000,
  );

  it(
    "PoC (§6#1): discard of a path OUTSIDE the repo fails honestly and changes nothing outside",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "a-v1\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      await writeFile(join(dir, "a.txt"), "a-v2\n"); // dirty change that WOULD revert on a bad pathspec

      const outsideDir = await mkdtemp(join(tmpdir(), "anycode-git-outside-"));
      dirs.push(outsideDir);
      const outside = join(outsideDir, "secret.txt");
      await writeFile(outside, "SECRET\n");

      // Absolute path outside the repo AND a deep-traversal relative path: git
      // refuses both ("outside repository"), applying nothing.
      const r1 = await adapter.discard([outside]);
      const r2 = await adapter.discard(["../../../../../../../../etc/hosts"]);
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
      expect(await readFile(outside, "utf-8")).toBe("SECRET\n"); // untouched
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a-v2\n"); // in-repo file untouched too
    },
    30_000,
  );

  it(
    "PoC (§6#1): discard with a mixed valid + nonexistent pathspec aborts atomically (pinned to real git behavior)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "a-v1\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      await writeFile(join(dir, "a.txt"), "a-v2\n");

      const r = await adapter.discard(["a.txt", "does-not-exist.txt"]);
      // ACTUAL git behavior (verified): a nonexistent pathspec errors (exit 1) and
      // git applies NOTHING — the valid a.txt is NOT reverted. Honest fail, no
      // partial effect.
      expect(r.ok).toBe(false);
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a-v2\n");
    },
    30_000,
  );

  it(
    "PoC (§6#2): resetHead('hard') restores tracked files to HEAD, clears the index, does NOT rewrite history",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "committed\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      const headBefore = runGitCli(dir, ["rev-parse", "HEAD"]).trim();

      // Dirty worktree edit + a staged-but-uncommitted new file.
      await writeFile(join(dir, "a.txt"), "worktree-edit\n");
      await writeFile(join(dir, "b.txt"), "new-staged\n");
      await adapter.stage!(["b.txt"]);

      const r = await adapter.resetHead("hard");
      expect(r.ok).toBe(true);

      // a.txt back to committed content; HEAD unchanged (no history rewrite).
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("committed\n");
      expect(runGitCli(dir, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
      // Index cleared; b.txt (staged-new) is removed by --hard => fully clean tree.
      expect(existsSync(join(dir, "b.txt"))).toBe(false);
      const s = await adapter.status();
      expect(s.ok).toBe(true);
      if (s.ok) {
        expect(s.value.staged).toEqual([]);
        expect(s.value.unstaged).toEqual([]);
        expect(s.value.untracked).toEqual([]);
      }
    },
    30_000,
  );

  it(
    "PoC (§6#2): resetHead('mixed') unstages the index but PRESERVES worktree edits, HEAD unchanged",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "committed\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      const headBefore = runGitCli(dir, ["rev-parse", "HEAD"]).trim();

      await writeFile(join(dir, "a.txt"), "worktree-edit\n");
      await adapter.stage!(["a.txt"]); // stage the edit

      const r = await adapter.resetHead("mixed");
      expect(r.ok).toBe(true);
      // --mixed keeps the worktree edit but drops it from the index.
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("worktree-edit\n");
      expect(runGitCli(dir, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
      const s = await adapter.status();
      if (s.ok) {
        expect(s.value.staged).toEqual([]);
        expect(s.value.unstaged).toEqual([{ path: "a.txt", kind: "modified" }]);
      }
    },
    30_000,
  );

  it(
    "PoC (§6#3): stash push --include-untracked clears the tree; pop restores byte-for-byte; empty pop fails; message verbatim",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "committed\n");
      await adapter.stageAll();
      await adapter.commit("c1");

      // Dirty tracked change + an untracked file.
      await writeFile(join(dir, "a.txt"), "dirty\n");
      await writeFile(join(dir, "untracked.txt"), "new\n");

      // A message that LOOKS like flags + a shell metacharacter payload: it must
      // land verbatim (argv element after -m, no shell) and never be interpreted.
      const injection = "--include-untracked; rm -rf /";
      const push = await adapter.stashPush({ includeUntracked: true, message: injection });
      expect(push.ok).toBe(true);

      // Worktree is clean: tracked reverted, untracked stashed away.
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("committed\n");
      expect(existsSync(join(dir, "untracked.txt"))).toBe(false);
      const clean = await adapter.status();
      if (clean.ok) {
        expect(clean.value.unstaged).toEqual([]);
        expect(clean.value.untracked).toEqual([]);
      }

      // The injection string is a verbatim, uninterpreted stash description.
      expect(runGitCli(dir, ["stash", "list"])).toContain(injection);

      // Pop restores both files byte-for-byte.
      const pop = await adapter.stashPop();
      expect(pop.ok).toBe(true);
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("dirty\n");
      expect(await readFile(join(dir, "untracked.txt"), "utf-8")).toBe("new\n");

      // Stash is now empty: a second pop fails honestly (no throw).
      const emptyPop = await adapter.stashPop();
      expect(emptyPop.ok).toBe(false);
    },
    30_000,
  );

  it(
    "PoC (§6#3): stashPush on a clean tree is honest {ok:true} ('No local changes to save' = exit 0)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "a.txt"), "committed\n");
      await adapter.stageAll();
      await adapter.commit("c1");
      // Nothing dirty => git prints "No local changes to save" and exits 0.
      const r = await adapter.stashPush();
      expect(r.ok).toBe(true);
    },
    30_000,
  );

  it(
    "PoC (§6#7a): a > DEFAULT_MAX_OUTPUT_BYTES diff now arrives WHOLE with truncated:false (bug fixed)",
    async () => {
      const dir = await makeRepo();
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "big.txt"), "");
      await adapter.stageAll();
      await adapter.commit("empty big");

      // ~700 KB of added content: comfortably > DEFAULT_MAX_OUTPUT_BYTES (262_144)
      // where the OLD code silently cut mid-line, yet well under the 2 MiB cap.
      const lines: string[] = [];
      for (let i = 0; i < 40_000; i++) lines.push(`line-${i}-payload-xxxxxxxxxx`);
      const big = lines.join("\n") + "\n";
      expect(big.length).toBeGreaterThan(300_000);
      await writeFile(join(dir, "big.txt"), big);

      const d = await adapter.diffDetailed({ target: "worktree" });
      expect(d.ok).toBe(true);
      if (d.ok) {
        // Whole diff fit under the 2 MiB cap: honest truncated:false.
        expect(d.value.truncated).toBe(false);
        // Proves it exceeded the OLD default cap (would have been silently cut).
        expect(d.value.text.length).toBeGreaterThan(262_144);
        expect(d.value.text.length).toBeLessThan(GIT_DIFF_MAX_OUTPUT_BYTES);
        // The diff is COMPLETE: the very last added line is present.
        expect(d.value.text).toContain("line-39999-payload");
      }
      // The string-shape diff() delegate returns the SAME whole text (CLI parity).
      const legacy = await adapter.diff({ target: "worktree" });
      if (legacy.ok && d.ok) expect(legacy.value).toBe(d.value.text);
    },
    30_000,
  );

  it(
    "worktree add/list/remove isolates the checkout and preserves a dirty tree on non-force failure",
    async () => {
      const dir = await realpath(await makeRepo());
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "seed.txt"), "main\n");
      await adapter.stageAll();
      await adapter.commit("seed");

      const wtPath = join(dir, ".anycode", "worktrees", "feature");
      const add = await adapter.worktreeAdd({ path: wtPath, branch: "anycode-wt/feature", baseRef: "main" });
      expect(add).toEqual({ ok: true, value: { path: wtPath } });
      expect(existsSync(wtPath)).toBe(true);

      const list = await adapter.worktreeList();
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value).toHaveLength(2);
        expect(list.value[0]?.isMain).toBe(true);
        expect(list.value.find((item) => item.path === wtPath)?.branch).toBe("anycode-wt/feature");
      }

      await writeFile(join(wtPath, "only-in-worktree.txt"), "precious\n");
      const mainStatus = await adapter.status();
      if (mainStatus.ok) expect(mainStatus.value.untracked).not.toContain("only-in-worktree.txt");

      const refused = await adapter.worktreeRemove({ path: wtPath });
      expect(refused.ok).toBe(false);
      expect(await readFile(join(wtPath, "only-in-worktree.txt"), "utf-8")).toBe("precious\n");

      expect((await adapter.worktreeRemove({ path: wtPath, force: true })).ok).toBe(true);
      expect(existsSync(wtPath)).toBe(false);
      const after = await adapter.worktreeList();
      if (after.ok) expect(after.value).toHaveLength(1);
    },
    30_000,
  );

  it(
    "prunes stale worktree metadata and refuses to delete an unmerged branch",
    async () => {
      const dir = await realpath(await makeRepo());
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "seed.txt"), "seed\n");
      await adapter.stageAll();
      await adapter.commit("seed");

      runGitCli(dir, ["branch", "anycode-wt/merged"]);
      expect((await adapter.deleteBranch("anycode-wt/merged")).ok).toBe(true);
      expect(runGitCli(dir, ["branch", "--list", "anycode-wt/merged"]).trim()).toBe("");

      runGitCli(dir, ["switch", "-q", "-c", "anycode-wt/unmerged"]);
      await writeFile(join(dir, "branch-only.txt"), "precious commit\n");
      await adapter.stageAll();
      await adapter.commit("branch-only");
      runGitCli(dir, ["switch", "-q", "main"]);

      const refused = await adapter.deleteBranch("anycode-wt/unmerged");
      expect(refused.ok).toBe(false);
      expect(runGitCli(dir, ["branch", "--list", "anycode-wt/unmerged"])).toContain("anycode-wt/unmerged");
      expect((await adapter.worktreePrune()).ok).toBe(true);
    },
    30_000,
  );

  it(
    "refuses non-force removal when ignored user content would otherwise be silently deleted",
    async () => {
      const dir = await realpath(await makeRepo());
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, ".gitignore"), "secret.env\n");
      await adapter.stageAll();
      await adapter.commit("ignore rule");
      const wtPath = join(dir, ".anycode", "worktrees", "ignored-safety");
      expect((await adapter.worktreeAdd({ path: wtPath, branch: "anycode-wt/ignored-safety" })).ok).toBe(true);
      await writeFile(join(wtPath, "secret.env"), "PRECIOUS\n");

      expect(await new NodeGitAdapter({ exec, cwd: wtPath }).worktreeIsPristine()).toEqual({ ok: true, value: false });
      expect((await adapter.worktreeRemove({ path: wtPath })).ok).toBe(false);
      expect(await readFile(join(wtPath, "secret.env"), "utf8")).toBe("PRECIOUS\n");
      expect((await adapter.worktreeRemove({ path: wtPath, force: true })).ok).toBe(true);
    },
    30_000,
  );

  it(
    "refuses non-force removal when assume-unchanged or skip-worktree hides tracked edits",
    async () => {
      const dir = await realpath(await makeRepo());
      const adapter = new NodeGitAdapter({ exec, cwd: dir });
      await writeFile(join(dir, "seed.txt"), "base\n");
      await adapter.stageAll();
      await adapter.commit("seed");
      for (const [index, flag] of ["--assume-unchanged", "--skip-worktree"].entries()) {
        const name = `hidden-${index}`;
        const wtPath = join(dir, ".anycode", "worktrees", name);
        expect((await adapter.worktreeAdd({ path: wtPath, branch: `anycode-wt/${name}` })).ok).toBe(true);
        runGitCli(wtPath, ["update-index", flag, "seed.txt"]);
        await writeFile(join(wtPath, "seed.txt"), `PRECIOUS-${flag}\n`);

        expect(await new NodeGitAdapter({ exec, cwd: wtPath }).worktreeIsPristine()).toEqual({ ok: true, value: false });
        expect((await adapter.worktreeRemove({ path: wtPath })).ok).toBe(false);
        expect(await readFile(join(wtPath, "seed.txt"), "utf8")).toContain("PRECIOUS");
        expect((await adapter.worktreeRemove({ path: wtPath, force: true })).ok).toBe(true);
      }
    },
    30_000,
  );

  it(
    "worktree operations neutralize inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE",
    async () => {
      const dir = await realpath(await makeRepo());
      const decoy = await realpath(await makeRepo());
      for (const repo of [dir, decoy]) {
        await writeFile(join(repo, "seed.txt"), repo);
        const repoAdapter = new NodeGitAdapter({ exec, cwd: repo });
        await repoAdapter.stageAll();
        await repoAdapter.commit("seed");
      }

      const target = join(dir, "safe-worktree");
      const saved = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      let result: Awaited<ReturnType<NodeGitAdapter["worktreeAdd"]>>;
      try {
        process.env.GIT_DIR = join(decoy, ".git");
        process.env.GIT_WORK_TREE = decoy;
        process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");
        result = await new NodeGitAdapter({ exec, cwd: dir }).worktreeAdd({
          path: target,
          branch: "safe-feature",
        });
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(result!.ok).toBe(true);
      const realList = parseWorktreeListZ(runGitCli(dir, ["worktree", "list", "--porcelain", "-z"]));
      const decoyList = parseWorktreeListZ(runGitCli(decoy, ["worktree", "list", "--porcelain", "-z"]));
      expect(realList.some((item) => item.path === target)).toBe(true);
      expect(decoyList).toHaveLength(1);
      expect((await new NodeGitAdapter({ exec, cwd: dir }).worktreeRemove({ path: target })).ok).toBe(true);
    },
    30_000,
  );
});

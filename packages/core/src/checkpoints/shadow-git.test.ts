import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CHECKPOINT_GIT_TIMEOUT_MS,
  ShadowGitCheckpoints,
  deriveCheckpointLabel,
  type ShadowGitCheckpointsOptions,
} from "./shadow-git.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { SqlitePersistenceAdapter } from "../adapters/node/sqlite-persistence.js";
import type { BinaryExecRequest, ExecResult, ExecutionPort } from "../ports/execution.js";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";
import type { CheckpointMeta, CheckpointRecord, CheckpointStore } from "../ports/checkpoints.js";
import type { HistoryItem } from "../types/history.js";

// ---------------------------------------------------------------------------
// Test doubles

function ok(stdout = ""): ExecResult {
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

function fail(stderr = "boom"): ExecResult {
  return {
    status: "failed",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

interface RecordedCall {
  file: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

class FakeExec implements ExecutionPort {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly responder: (args: string[], index: number) => ExecResult) {}
  run(): Promise<ExecResult> {
    throw new Error("run() must never be used by checkpoints/ (R2/L5: runBinary only)");
  }
  runBinary(req: BinaryExecRequest): Promise<ExecResult> {
    this.calls.push({ file: req.file, args: [...req.args], cwd: req.cwd, timeoutMs: req.timeoutMs, env: req.env });
    return Promise.resolve(this.responder([...req.args], this.calls.length - 1));
  }
}

/** Happy plumbing responder producing deterministic tree/commit hashes. */
function happyGit(): (args: string[]) => ExecResult {
  let n = 0;
  return (args) => {
    switch (args[0]) {
      case "write-tree":
        return ok(`tree${n}\n`);
      case "commit-tree":
        return ok(`commit${n++}\n`);
      default:
        return ok("");
    }
  };
}

class FakeFs implements FileSystemPort {
  readonly existing = new Set<string>();
  readonly writes: { path: string; content: string }[] = [];
  readonly mkdirs: string[] = [];
  readFile(): Promise<string> {
    return Promise.reject(new Error("not used"));
  }
  writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
    this.existing.add(path);
    return Promise.resolve();
  }
  stat(): Promise<FileStat> {
    return Promise.reject(new Error("not used"));
  }
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(path));
  }
  mkdir(path: string): Promise<void> {
    this.mkdirs.push(path);
    this.existing.add(path);
    return Promise.resolve();
  }
  readdir(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

class FakeStore implements CheckpointStore {
  readonly saved: CheckpointRecord[] = [];
  readonly saveOpts: ({ keepPerSession?: number } | undefined)[] = [];
  seed(records: CheckpointRecord[]): void {
    this.saved.push(...records);
  }
  saveCheckpoint(record: CheckpointRecord, opts?: { keepPerSession?: number }): Promise<void> {
    this.saved.push(record);
    this.saveOpts.push(opts);
    return Promise.resolve();
  }
  listCheckpoints(sessionId: string, opts?: { limit?: number }): Promise<CheckpointMeta[]> {
    const metas = this.saved
      .filter((r) => r.sessionId === sessionId)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        commitHash: r.commitHash,
        createdAt: r.createdAt,
        reason: r.reason,
        label: r.label,
      }));
    return Promise.resolve(opts?.limit !== undefined ? metas.slice(0, opts.limit) : metas);
  }
  getCheckpoint(id: string): Promise<CheckpointRecord | null> {
    const r = this.saved.find((x) => x.id === id);
    return Promise.resolve(r ? { ...r } : null);
  }
}

const WORKSPACE = "/tmp/anycode-ws";
const ROOT = "/tmp/anycode-cproot";
const SESSION = "sess-1";

function expectedGitDir(): string {
  return join(ROOT, createHash("sha256").update(WORKSPACE).digest("hex").slice(0, 16));
}

function expectedEnv(): Record<string, string> {
  const gitDir = expectedGitDir();
  return {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: WORKSPACE,
    GIT_INDEX_FILE: join(gitDir, `index-${SESSION}`),
    GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "anycode",
    GIT_AUTHOR_EMAIL: "checkpoint@anycode.invalid",
    GIT_COMMITTER_NAME: "anycode",
    GIT_COMMITTER_EMAIL: "checkpoint@anycode.invalid",
  };
}

function makeService(
  exec: ExecutionPort,
  fs: FileSystemPort,
  store: CheckpointStore,
  extra?: Partial<ShadowGitCheckpointsOptions>,
): ShadowGitCheckpoints {
  return new ShadowGitCheckpoints({
    exec,
    fs,
    store,
    workspace: WORKSPACE,
    checkpointsRoot: ROOT,
    sessionId: SESSION,
    now: () => 1000,
    ...extra,
  });
}

// ---------------------------------------------------------------------------

describe("deriveCheckpointLabel", () => {
  it("takes only the first line", () => {
    expect(deriveCheckpointLabel("first line\nsecond line")).toBe("first line");
  });
  it("returns empty for empty/blank input", () => {
    expect(deriveCheckpointLabel("")).toBe("");
    expect(deriveCheckpointLabel("   \n  ")).toBe("");
  });
  it("strips control characters (tab/CR) and trims", () => {
    expect(deriveCheckpointLabel("hello\tworld\r")).toBe("helloworld");
    expect(deriveCheckpointLabel("  spaced  ")).toBe("spaced");
  });
  it("truncates to CHECKPOINT_LABEL_MAX_CHARS (64)", () => {
    const label = deriveCheckpointLabel("x".repeat(100));
    expect(label).toHaveLength(64);
  });
});

describe("ShadowGitCheckpoints.capture", () => {
  it("emits the exact plumbing sequence with the isolated base-env on first capture", async () => {
    const exec = new FakeExec(happyGit());
    const fs = new FakeFs();
    const store = new FakeStore();
    const svc = makeService(exec, fs, store);

    const res = await svc.capture({ userInput: "add a feature", historySnapshot: [] });
    expect(res).toEqual({ kind: "created", id: expect.any(String), label: "add a feature" });

    expect(exec.calls.map((c) => c.args)).toEqual([
      ["init", "--quiet"],
      ["add", "-A"],
      ["write-tree"],
      ["commit-tree", "tree0", "-m", "anycode checkpoint: auto — add a feature"],
      ["update-ref", `refs/anycode/sessions/${SESSION}`, "commit0"],
    ]);

    for (const call of exec.calls) {
      expect(call.file).toBe("git");
      expect(call.cwd).toBe(WORKSPACE);
      expect(call.timeoutMs).toBe(CHECKPOINT_GIT_TIMEOUT_MS);
      expect(call.env).toEqual(expectedEnv());
    }


    expect(fs.mkdirs).toContain(expectedGitDir());
    expect(fs.writes).toEqual([
      { path: join(expectedGitDir(), "info", "exclude"), content: ".git/\nnode_modules/\n" },
    ]);

    // persisted record + prune bound
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      sessionId: SESSION,
      commitHash: "commit0",
      createdAt: 1000,
      reason: "auto",
      label: "add a feature",
      historyJson: "[]",
    });
    expect(store.saveOpts[0]).toEqual({ keepPerSession: 50 });
  });

  it("serializes the pre-turn history snapshot into the record", async () => {
    const exec = new FakeExec(happyGit());
    const store = new FakeStore();
    const svc = makeService(exec, new FakeFs(), store);
    const snapshot: HistoryItem[] = [{ id: "h1", createdAt: 1, message: { role: "user", content: "prior" } }];
    await svc.capture({ userInput: "next", historySnapshot: snapshot });
    expect(JSON.parse(store.saved[0]!.historyJson)).toEqual(snapshot);
  });

  it("skips init when the gitDir HEAD already exists (idempotent)", async () => {
    const exec = new FakeExec(happyGit());
    const fs = new FakeFs();
    fs.existing.add(join(expectedGitDir(), "HEAD"));
    const svc = makeService(exec, fs, new FakeStore());

    await svc.capture({ userInput: "hi", historySnapshot: [] });
    expect(exec.calls[0]!.args).toEqual(["add", "-A"]);
    expect(exec.calls.some((c) => c.args[0] === "init")).toBe(false);
    expect(fs.mkdirs).toHaveLength(0);
    expect(fs.writes).toHaveLength(0);
  });

  it("chains the second capture onto the first as its parent (-p) and inits once", async () => {
    const exec = new FakeExec(happyGit());
    const svc = makeService(exec, new FakeFs(), new FakeStore());

    await svc.capture({ userInput: "one", historySnapshot: [] });
    await svc.capture({ userInput: "two", historySnapshot: [] });

    expect(exec.calls.filter((c) => c.args[0] === "init")).toHaveLength(1);
    const commitCalls = exec.calls.filter((c) => c.args[0] === "commit-tree");
    expect(commitCalls[0]!.args).toEqual(["commit-tree", "tree0", "-m", "anycode checkpoint: auto — one"]);
    expect(commitCalls[1]!.args).toEqual([
      "commit-tree",
      "tree1",
      "-p",
      "commit0",
      "-m",
      "anycode checkpoint: auto — two",
    ]);
  });

  it("seeds the parent chain from the store's newest checkpoint on first capture (resume)", async () => {
    const exec = new FakeExec(happyGit());
    const store = new FakeStore();
    store.seed([
      {
        id: "prev",
        sessionId: SESSION,
        commitHash: "prevhash",
        createdAt: 500,
        reason: "auto",
        label: "old",
        historyJson: "[]",
      },
    ]);
    const svc = makeService(exec, new FakeFs(), store);

    await svc.capture({ userInput: "resumed", historySnapshot: [] });
    const commit = exec.calls.find((c) => c.args[0] === "commit-tree")!;
    expect(commit.args).toEqual(["commit-tree", "tree0", "-p", "prevhash", "-m", "anycode checkpoint: auto — resumed"]);
  });

  it("fails once (with a reason) then skips silently after any step error (fail-soft R6)", async () => {
    const base = happyGit();
    const exec = new FakeExec((args) => (args[0] === "write-tree" ? fail("bad tree") : base(args)));
    const store = new FakeStore();
    const svc = makeService(exec, new FakeFs(), store);

    const res1 = await svc.capture({ userInput: "x", historySnapshot: [] });
    expect(res1.kind).toBe("failed");
    if (res1.kind === "failed") expect(res1.reason).toContain("git write-tree failed");

    const callsAfterFirst = exec.calls.length;
    const res2 = await svc.capture({ userInput: "y", historySnapshot: [] });
    expect(res2).toEqual({ kind: "skipped" });
    // disabled service performs no further spawns and never persists.
    expect(exec.calls.length).toBe(callsAfterFirst);
    expect(store.saved).toHaveLength(0);
  });

  it("reports failed (then skipped) when the execution port has no runBinary", async () => {
    const execNoBinary = {
      run() {
        throw new Error("run should not be called");
      },
    } as unknown as ExecutionPort;
    const svc = makeService(execNoBinary, new FakeFs(), new FakeStore());

    const res = await svc.capture({ userInput: "x", historySnapshot: [] });
    expect(res.kind).toBe("failed");
    if (res.kind === "failed") expect(res.reason).toContain("runBinary");
    expect(await svc.capture({ userInput: "y", historySnapshot: [] })).toEqual({ kind: "skipped" });
  });
});

describe("ShadowGitCheckpoints.rewind", () => {
  function targetRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
    return {
      id: "target-id",
      sessionId: SESSION,
      commitHash: "TARGET",
      createdAt: 100,
      reason: "auto",
      label: "t",
      historyJson: JSON.stringify([{ id: "h1", createdAt: 1, message: { role: "user", content: "hi" } }]),
      ...overrides,
    };
  }

  function rewindResponder(diffOut: string): (args: string[]) => ExecResult {
    return (args) => {
      switch (args[0]) {
        case "write-tree":
          return ok("safetytree\n");
        case "commit-tree":
          return ok("SAFETY\n");
        case "diff-tree":
          return ok(diffOut);
        default:
          return ok("");
      }
    };
  }

  it("returns not-found for an unknown checkpoint", async () => {
    const svc = makeService(new FakeExec(happyGit()), new FakeFs(), new FakeStore());
    const res = await svc.rewind("nope", { scope: "both", currentHistory: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no checkpoint");
  });

  it("aborts fail-closed when the safety checkpoint fails, without touching files (R9)", async () => {
    const base = happyGit();
    const exec = new FakeExec((args) => (args[0] === "add" ? fail("cannot add") : base(args)));
    const store = new FakeStore();
    store.seed([targetRecord()]);
    const svc = makeService(exec, new FakeFs(), store);

    const res = await svc.rewind("target-id", { scope: "both", currentHistory: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("safety checkpoint failed");
    expect(exec.calls.some((c) => c.args[0] === "read-tree")).toBe(false);
  });

  it("uses two-tree read-tree <safety> <target> with -u, counts diff paths, returns snapshot", async () => {
    const exec = new FakeExec(rewindResponder("src/a.ts\nsrc/b.ts\n"));
    const store = new FakeStore();
    store.seed([targetRecord()]);
    const svc = makeService(exec, new FakeFs(), store);

    const currentHistory: HistoryItem[] = [{ id: "cur", createdAt: 2, message: { role: "user", content: "now" } }];
    const res = await svc.rewind("target-id", { scope: "both", currentHistory });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.restoredPaths).toBe(2);
      expect(res.historyItems).toEqual([{ id: "h1", createdAt: 1, message: { role: "user", content: "hi" } }]);
      expect(res.safetyCheckpointId).toEqual(expect.any(String));
    }

    const readTree = exec.calls.find((c) => c.args[0] === "read-tree")!;
    expect(readTree.args).toEqual(["read-tree", "-u", "-m", "SAFETY", "TARGET"]);

    // safety captured with reason pre-rewind, fixed label, and the CURRENT history.
    const safety = store.saved.find((r) => r.reason === "pre-rewind")!;
    expect(safety.label).toBe("before /rewind");
    expect(JSON.parse(safety.historyJson)).toEqual(currentHistory);
  });

  it("ignores a 40-hex commit-header line in diff-tree output (A9)", async () => {
    const header = "abcdef0123456789abcdef0123456789abcdef01";
    const exec = new FakeExec(rewindResponder(`${header}\nsrc/a.ts\n`));
    const store = new FakeStore();
    store.seed([targetRecord()]);
    const svc = makeService(exec, new FakeFs(), store);

    const res = await svc.rewind("target-id", { scope: "files", currentHistory: [] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.restoredPaths).toBe(1);
  });

  it("scope files leaves the conversation snapshot null but still restores files", async () => {
    const exec = new FakeExec(rewindResponder("a.ts\n"));
    const store = new FakeStore();
    store.seed([targetRecord()]);
    const svc = makeService(exec, new FakeFs(), store);

    const res = await svc.rewind("target-id", { scope: "files", currentHistory: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.historyItems).toBeNull();
      expect(res.restoredPaths).toBe(1);
    }
    expect(exec.calls.some((c) => c.args[0] === "read-tree")).toBe(true);
  });

  it("scope conversation skips file ops entirely (no read-tree/diff-tree)", async () => {
    const exec = new FakeExec(rewindResponder("a.ts\n"));
    const store = new FakeStore();
    store.seed([targetRecord()]);
    const svc = makeService(exec, new FakeFs(), store);

    const res = await svc.rewind("target-id", { scope: "conversation", currentHistory: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.restoredPaths).toBeNull();
      expect(res.historyItems).toEqual([{ id: "h1", createdAt: 1, message: { role: "user", content: "hi" } }]);
    }
    expect(exec.calls.some((c) => c.args[0] === "read-tree")).toBe(false);
    expect(exec.calls.some((c) => c.args[0] === "diff-tree")).toBe(false);
  });

  // Ownership boundary: the checkpoints table is GLOBAL (getCheckpoint is id-only),
  // and the wire `rewind_request` endpoint forwards a renderer-controlled id. Two
  // sessions share ONE store; each may only list its own checkpoints, so a foreign
  // id must be rejected at the service boundary before any conversation snapshot
  // (or safety capture) is touched.
  it("rejects rewinding another session's checkpoint and does not leak its history (PoC)", async () => {
    const store = new FakeStore();
    const A_HISTORY: HistoryItem[] = [{ id: "a1", createdAt: 1, message: { role: "user", content: "SECRET-A" } }];
    const svcA = makeService(new FakeExec(happyGit()), new FakeFs(), store, { sessionId: "sess-A" });
    const svcB = makeService(new FakeExec(happyGit()), new FakeFs(), store, { sessionId: "sess-B" });

    const capA = await svcA.capture({ userInput: "A turn", historySnapshot: A_HISTORY });
    expect(capA.kind).toBe("created");
    const aCheckpointId = capA.kind === "created" ? capA.id : "";
    const countAfterCapture = store.saved.length;

    const bHistory: HistoryItem[] = [{ id: "b1", createdAt: 2, message: { role: "user", content: "B-current" } }];
    const res = await svcB.rewind(aCheckpointId, { scope: "conversation", currentHistory: bHistory });

    // Before the fix this returned ok:true with A's historyItems — the cross-session leak.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("another session");
    // No safety checkpoint row written for the rejected foreign id (guard precedes performCapture).
    expect(store.saved.length).toBe(countAfterCapture);
  });

  it("allows a session to rewind its OWN checkpoint (regression alongside the ownership guard)", async () => {
    const store = new FakeStore();
    const svcA = makeService(new FakeExec(rewindResponder("a.ts\n")), new FakeFs(), store, { sessionId: "sess-A" });
    store.seed([targetRecord({ sessionId: "sess-A" })]);

    const conv = await svcA.rewind("target-id", { scope: "conversation", currentHistory: [] });
    expect(conv.ok).toBe(true);
    if (conv.ok) {
      expect(conv.historyItems).toEqual([{ id: "h1", createdAt: 1, message: { role: "user", content: "hi" } }]);
    }

    const both = await svcA.rewind("target-id", { scope: "both", currentHistory: [] });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.restoredPaths).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Real git (integration): proves the plumbing sequence + two-tree rewind on a
// real repo, and that the workspace's own .git is never touched (L6). The
// orphan-kill discipline of the single spawn path (runBinary) is proven
// additively in adapters/node/node-execution.test.ts.

describe("ShadowGitCheckpoints real git integration", () => {
  const exec = new NodeExecutionAdapter();
  const fsPort = new NodeFileSystemAdapter();
  let workspace = "";
  let root = "";
  let store: SqlitePersistenceAdapter | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (root) await rm(root, { recursive: true, force: true });
    workspace = "";
    root = "";
  });

  it(
    "captures, mutates and rewinds real files, leaving ignored files untouched (:memory: store)",
    async () => {
      workspace = await mkdtemp(join(tmpdir(), "anycode-cp-ws-"));
      root = await mkdtemp(join(tmpdir(), "anycode-cp-root-"));
      store = new SqlitePersistenceAdapter(":memory:");
      await store.createSession({ id: "s1", workspace, model: "m", mode: "build" });

      await writeFile(join(workspace, "a.txt"), "v1");
      await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
      await writeFile(join(workspace, "ignored.txt"), "keep");

      const svc = new ShadowGitCheckpoints({ exec, fs: fsPort, store, workspace, checkpointsRoot: root, sessionId: "s1" });

      const cp1 = await svc.capture({ userInput: "first turn", historySnapshot: [] });
      expect(cp1.kind).toBe("created");

      // No .git leaks into the workspace; the shadow gitDir lives under root.
      await expect(access(join(workspace, ".git"))).rejects.toThrow();
      const gitDir = join(root, createHash("sha256").update(workspace).digest("hex").slice(0, 16));
      await expect(access(join(gitDir, "HEAD"))).resolves.toBeUndefined();

      // Mutate: change a tracked file, add a new one, change the ignored one.
      await writeFile(join(workspace, "a.txt"), "v2");
      await writeFile(join(workspace, "b.txt"), "new");
      await writeFile(join(workspace, "ignored.txt"), "changed");
      const cp2 = await svc.capture({ userInput: "second turn", historySnapshot: [] });
      expect(cp2.kind).toBe("created");

      const cp1Id = cp1.kind === "created" ? cp1.id : "";
      const res = await svc.rewind(cp1Id, { scope: "files", currentHistory: [] });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.restoredPaths).toBe(2);

      expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v1");
      await expect(access(join(workspace, "b.txt"))).rejects.toThrow();
      // Ignored file is outside every tree, so the two-tree swap never touches it.
      expect(await readFile(join(workspace, "ignored.txt"), "utf-8")).toBe("changed");

      // Two checkpoints (+ one safety) recorded.
      const list = await store.listCheckpoints("s1");
      expect(list.length).toBe(3);
    },
    30_000,
  );

  it(
    "never touches a workspace that is itself a git repo (L6)",
    async () => {
      workspace = await mkdtemp(join(tmpdir(), "anycode-cp-wsgit-"));
      root = await mkdtemp(join(tmpdir(), "anycode-cp-root-"));
      store = new SqlitePersistenceAdapter(":memory:");
      await store.createSession({ id: "s1", workspace, model: "m", mode: "build" });

      execFileSync("git", ["init", "-q"], { cwd: workspace });
      await writeFile(join(workspace, "a.txt"), "v1");
      const headBefore = await readFile(join(workspace, ".git", "HEAD"), "utf-8");

      const svc = new ShadowGitCheckpoints({ exec, fs: fsPort, store, workspace, checkpointsRoot: root, sessionId: "s1" });
      const cp1 = await svc.capture({ userInput: "first", historySnapshot: [] });
      expect(cp1.kind).toBe("created");
      await writeFile(join(workspace, "a.txt"), "v2");
      await svc.capture({ userInput: "second", historySnapshot: [] });

      const cp1Id = cp1.kind === "created" ? cp1.id : "";
      const res = await svc.rewind(cp1Id, { scope: "files", currentHistory: [] });
      expect(res.ok).toBe(true);

      // User .git HEAD is byte-identical; our ref lives only in the external gitDir.
      expect(await readFile(join(workspace, ".git", "HEAD"), "utf-8")).toBe(headBefore);
      await expect(access(join(workspace, ".git", "refs", "anycode"))).rejects.toThrow();
      expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("v1");
    },
    30_000,
  );
});

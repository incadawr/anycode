/**
 * git-wire e2e (slice 5.7, design slice-5.7-cut.md §2.3-C5 / §6): the git command
 * path exercised end-to-end over the REAL worker_threads MessageChannel + REAL
 * Session + REAL zod, with the GitBridge built over the harness's own outbound
 * (HarnessOptions.git factory). Two layers:
 *
 *  (a) a mock GitPort — every op round-trips to the right git_result; a scripted
 *      turn triggers a fresh git_status after turn-end; zod-garbage is dropped
 *      silently with ZERO spawns and ZERO git_result (§6#2/#8).
 *  (b) a REAL NodeGitAdapter over a tmp git repo — a commit created through the
 *      wire matches `git rev-parse HEAD`; stage/unstage move porcelain; ZERO
 *      permission_request over the whole test (lock L4); a git_result never

 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter, NodeGitAdapter } from "@anycode/core";
import type { GitBranchInfo, GitCommitInfo, GitHead, GitOpResult, GitPort, GitStatusSummary } from "@anycode/core";
import { GIT_WIRE_DIFF_MAX_CHARS } from "../shared/protocol.js";
import type { GitCommand, HostToUiMessage } from "../shared/protocol.js";
import { GitBridge, MAX_PENDING_GIT_COMMANDS } from "./git-bridge.js";
import { createHarness, finishStep, textStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isGitResult = (m: HostToUiMessage): m is Of<"git_result"> => m.type === "git_result";
const isGitStatus = (m: HostToUiMessage): m is Of<"git_status"> => m.type === "git_status";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const gitResultFor = (id: string) => (m: HostToUiMessage): m is Of<"git_result"> => m.type === "git_result" && m.requestId === id;

function head(): GitHead {
  return { branch: "main", detached: false, sha: "abc123", ahead: null, behind: null };
}
function summary(over?: Partial<GitStatusSummary>): GitStatusSummary {
  return { head: head(), staged: [], unstaged: [], untracked: [], ...over };
}

/** Deterministic mock GitPort recording every call, so a spawn count is observable. */
class EchoGitPort implements GitPort {
  readonly calls: string[] = [];
  statusCalls = 0;
  async status(): Promise<GitOpResult<GitStatusSummary>> {
    this.calls.push("status");
    this.statusCalls += 1;
    return { ok: true, value: summary({ untracked: ["x.txt"] }) };
  }
  async listBranches(): Promise<GitOpResult<GitBranchInfo[]>> {
    this.calls.push("listBranches");
    return { ok: true, value: [{ name: "main", current: true, sha: "s1" }] };
  }
  async log(): Promise<GitOpResult<GitCommitInfo[]>> {
    this.calls.push("log");
    return { ok: true, value: [{ sha: "c1", authorName: "A", authorDate: 0, subject: "s" }] };
  }
  async diff(): Promise<GitOpResult<string>> {
    this.calls.push("diff");
    return { ok: true, value: "unified diff" };
  }
  async switchBranch(): Promise<GitOpResult<null>> {
    this.calls.push("switchBranch");
    return { ok: true, value: null };
  }
  async createBranch(): Promise<GitOpResult<null>> {
    this.calls.push("createBranch");
    return { ok: true, value: null };
  }
  async stageAll(): Promise<GitOpResult<null>> {
    this.calls.push("stageAll");
    return { ok: true, value: null };
  }
  async commit(): Promise<GitOpResult<{ sha: string }>> {
    this.calls.push("commit");
    return { ok: true, value: { sha: "committed-sha" } };
  }
  async stage(): Promise<GitOpResult<null>> {
    this.calls.push("stage");
    return { ok: true, value: null };
  }
  async unstage(): Promise<GitOpResult<null>> {
    this.calls.push("unstage");
    return { ok: true, value: null };
  }
  // Slice 5.8 destructive tail (existing tests never invoke these; the garbage-drop
  // test proves zod refuses them BEFORE the bridge is consulted).
  async discard(paths: string[]): Promise<GitOpResult<null>> {
    this.calls.push(`discard:${paths.join(",")}`);
    return { ok: true, value: null };
  }
  async stashPush(opts?: { message?: string; includeUntracked?: boolean }): Promise<GitOpResult<null>> {
    this.calls.push(`stashPush:${opts?.message ?? ""}:${opts?.includeUntracked ?? false}`);
    return { ok: true, value: null };
  }
  async stashPop(): Promise<GitOpResult<null>> {
    this.calls.push("stashPop");
    return { ok: true, value: null };
  }
  async resetHead(mode: "mixed" | "hard"): Promise<GitOpResult<null>> {
    this.calls.push(`resetHead:${mode}`);
    return { ok: true, value: null };
  }
}

/**
 * A GitPort whose `resetHead` blocks on a shared barrier while status() stays
 * instant — so a flood of destructive commands leaves the first in-flight and the
 * rest either queued or refused, and peak concurrency is observable (§6#9).
 */
class BarrierGitPort implements GitPort {
  inFlight = 0;
  maxConcurrent = 0;
  resetCalls = 0;
  private release: (() => void) | null = null;
  private readonly barrier: Promise<void>;
  constructor() {
    this.barrier = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  open(): void {
    this.release?.();
  }
  async status(): Promise<GitOpResult<GitStatusSummary>> {
    return { ok: true, value: summary() };
  }
  async listBranches(): Promise<GitOpResult<GitBranchInfo[]>> {
    return { ok: true, value: [] };
  }
  async log(): Promise<GitOpResult<GitCommitInfo[]>> {
    return { ok: true, value: [] };
  }
  async diff(): Promise<GitOpResult<string>> {
    return { ok: true, value: "" };
  }
  async switchBranch(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async createBranch(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async stageAll(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async commit(): Promise<GitOpResult<{ sha: string }>> {
    return { ok: true, value: { sha: "x" } };
  }
  async resetHead(): Promise<GitOpResult<null>> {
    this.resetCalls += 1;
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    await this.barrier;
    this.inFlight -= 1;
    return { ok: true, value: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe("git-wire e2e — mock GitPort over the real MessageChannel", () => {
  it("round-trips every op to the correct git_result and pushes git_status after mutations (§6#1)", async () => {
    const mock = new EchoGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const roundtrip = async (
        requestId: string,
        command: GitCommand,
        expected: Record<string, unknown>,
      ): Promise<void> => {
        h.send({ type: "git_command", requestId, command });
        const res = await h.waitFor(gitResultFor(requestId));
        expect(res.outcome).toMatchObject(expected);
      };

      await roundtrip("q-branches", { op: "branches" }, { ok: true, kind: "branches" });
      await roundtrip("q-log", { op: "log", limit: 5 }, { ok: true, kind: "log" });
      await roundtrip("q-diff", { op: "diff", target: "head" }, { ok: true, kind: "diff", truncated: false });
      await roundtrip("q-refresh", { op: "refresh" }, { ok: true, kind: "unit" });
      await roundtrip("q-switch", { op: "switch_branch", name: "dev" }, { ok: true, kind: "unit" });
      await roundtrip("q-create", { op: "create_branch", name: "feat", switch: true }, { ok: true, kind: "unit" });
      await roundtrip("q-stage", { op: "stage", paths: ["a.txt"] }, { ok: true, kind: "unit" });
      await roundtrip("q-unstage", { op: "unstage", paths: ["a.txt"] }, { ok: true, kind: "unit" });
      await roundtrip("q-stageall", { op: "stage_all" }, { ok: true, kind: "unit" });
      await roundtrip("q-commit", { op: "commit", message: "m" }, { ok: true, kind: "commit", sha: "committed-sha" });

      // A mutation pushed at least one non-null git_status (buffered).
      await h.waitUntil(() => h.received.some((m) => m.type === "git_status" && m.status !== null));
      // L4: no user-initiated git command ever raised a permission_request.
      expect(h.received.filter(isPermissionRequest).length).toBe(0);
    } finally {
      h.close();
    }
  });

  it("drops zod-garbage git_command silently: zero spawns, zero git_result (§6#2)", async () => {
    const mock = new EchoGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Each of these fails the frozen zod schema (unknown op / extra key under
      // .strict() / oversized message / non-string requestId / empty paths) and
      // is dropped in Session.route BEFORE the bridge is ever consulted.
      h.send({ type: "git_command", requestId: "j1", command: { op: "discard" } as unknown as GitCommand });
      h.send({ type: "git_command", requestId: "j2", command: { op: "stage_all", extra: 1 } as unknown as GitCommand });
      h.send({ type: "git_command", requestId: "j3", command: { op: "commit", message: "x".repeat(20_000) } as unknown as GitCommand });
      h.send({ type: "git_command", requestId: 42 as unknown as string, command: { op: "branches" } });
      h.send({ type: "git_command", requestId: "j5", command: { op: "stage", paths: [] } as unknown as GitCommand });
      await h.flush();
      await h.flush();

      // The ui_ready snapshot (slice 5.7-hostfix) legitimately reads status once;
      // the garbage commands must add ZERO further port calls (mock.calls holds
      // plain method-name strings, so exclude the lone "status" read).
      expect(mock.calls.filter((c) => c !== "status").length).toBe(0);
      expect(h.received.filter(isGitResult).length).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a scripted turn triggers refreshAfterTurn → a fresh git_status arrives after turn-end (§6#8)", async () => {
    const mock = new EchoGitPort();
    const h = createHarness({ steps: [textStep("done"), finishStep()], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      // Let the ui_ready snapshot (slice 5.7-hostfix) settle first, so `before`
      // captures the post-snapshot count and the assertion still proves the TURN
      // caused a fresh status read (not the connect snapshot, un-coalesced).
      await h.waitUntil(() => h.received.some(isGitStatus));
      const before = mock.statusCalls;

      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      // onUserMessage's finally fires git.refreshAfterTurn() after the turn tears down.
      await h.waitUntil(() => mock.statusCalls > before);
      await h.waitUntil(() => h.received.some((m) => m.type === "git_status" && m.status !== null));
    } finally {
      h.close();
    }
  });

  it("round-trips every DESTRUCTIVE op (confirmed:true) to unit + pushes git_status (slice 5.8)", async () => {
    const mock = new EchoGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const roundtrip = async (requestId: string, command: GitCommand): Promise<void> => {
        h.send({ type: "git_command", requestId, command });
        const res = await h.waitFor(gitResultFor(requestId));
        expect(res.outcome).toMatchObject({ ok: true, kind: "unit" });
      };

      await roundtrip("q-discard", { op: "discard", paths: ["a.txt", "b.txt"], confirmed: true });
      await roundtrip("q-stashpush", { op: "stash_push", message: "wip", includeUntracked: true, confirmed: true });
      await roundtrip("q-stashpop", { op: "stash_pop", confirmed: true });
      await roundtrip("q-reset", { op: "reset", mode: "hard", confirmed: true });

      // Each op reached the port with its payload verbatim (no re-interpretation).
      expect(mock.calls).toContain("discard:a.txt,b.txt");
      expect(mock.calls).toContain("stashPush:wip:true");
      expect(mock.calls).toContain("stashPop");
      expect(mock.calls).toContain("resetHead:hard");
      // A destructive mutation pushed at least one fresh git_status (buffered).
      await h.waitUntil(() => h.received.some((m) => m.type === "git_status" && m.status !== null));
      expect(h.received.filter(isPermissionRequest).length).toBe(0);
    } finally {
      h.close();
    }
  });

  it("drops garbage-confirmed DESTRUCTIVE git_command silently: zero spawns, zero git_result (§6#5)", async () => {
    const mock = new EchoGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Every one of these fails the frozen zod confirmed-gate (missing / false /
      // "true" / 1 confirmed, out-of-enum mode, missing mode, empty paths, extra
      // key under .strict()) and is dropped in Session.route BEFORE the bridge —
      // the garbage never gets an oracle (no git_result, no spawn).
      const garbage: unknown[] = [
        { op: "discard", paths: ["a"] },
        { op: "discard", paths: ["a"], confirmed: false },
        { op: "discard", paths: ["a"], confirmed: "true" },
        { op: "discard", paths: ["a"], confirmed: 1 },
        { op: "discard", paths: [], confirmed: true },
        { op: "discard", paths: ["a"], confirmed: true, force: true },
        { op: "stash_push" },
        { op: "stash_pop" },
        { op: "reset", mode: "soft", confirmed: true },
        { op: "reset", confirmed: true },
      ];
      garbage.forEach((command, i) => {
        h.send({ type: "git_command", requestId: `g${i}`, command: command as GitCommand });
      });
      await h.flush();
      await h.flush();

      // The ui_ready snapshot (slice 5.7-hostfix) legitimately reads status once;
      // the garbage-confirmed commands must add ZERO further port calls.
      expect(mock.calls.filter((c) => c !== "status").length).toBe(0);
      expect(h.received.filter(isGitResult).length).toBe(0);
    } finally {
      h.close();
    }
  });

  it("bounds a flood of confirmed destructive commands to MAX_PENDING; max-concurrency == 1 (§6#9)", async () => {
    const mock = new BarrierGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: mock, outbound }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const TOTAL = 100;
      for (let i = 0; i < TOTAL; i += 1) {
        h.send({ type: "git_command", requestId: `f${i}`, command: { op: "reset", mode: "hard", confirmed: true } });
      }

      const isQueueFull = (m: HostToUiMessage): boolean =>
        m.type === "git_result" && !m.outcome.ok && /queue full/.test(m.outcome.reason);

      // The first MAX_PENDING enqueue (one in-flight on the barrier + the rest
      // queued behind the single-flight chain); every command beyond that is an
      // immediate queue-full refusal WITHOUT enqueuing.
      const expectedRefusals = TOTAL - MAX_PENDING_GIT_COMMANDS;
      await h.waitUntil(() => h.received.filter(isQueueFull).length === expectedRefusals, 5_000);
      expect(mock.maxConcurrent).toBeLessThanOrEqual(1);

      // Drain: release the barrier; the enqueued commands complete serially.
      mock.open();
      const isUnit = (m: HostToUiMessage): boolean =>
        m.type === "git_result" && m.outcome.ok && m.outcome.kind === "unit";
      await h.waitUntil(() => h.received.filter(isUnit).length === MAX_PENDING_GIT_COMMANDS, 5_000);
      // Never more than one git child at any instant, even while draining.
      expect(mock.maxConcurrent).toBe(1);
      expect(h.received.filter(isQueueFull).length).toBe(expectedRefusals);
    } finally {
      h.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("git-wire e2e — REAL git in a tmp repo", () => {
  let dirs: string[] = [];

  function runGitCli(dir: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  }

  async function makeSeededRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-gitwire-"));
    dirs.push(dir);
    runGitCli(dir, ["init", "-q"]);
    runGitCli(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    runGitCli(dir, ["config", "user.name", "Test User"]);
    runGitCli(dir, ["config", "user.email", "test@anycode.invalid"]);
    runGitCli(dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "seed.txt"), "seed\n");
    runGitCli(dir, ["add", "-A"]);
    runGitCli(dir, ["commit", "-q", "-m", "seed"]);
    return dir;
  }

  /** Content-hash of a directory tree (sorted, path + bytes; mtime-independent). */
  async function hashDir(dir: string): Promise<string> {
    const hash = createHash("sha256");
    async function walk(current: string, rel: string): Promise<void> {
      const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const abs = join(current, entry.name);
        const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          hash.update(`D:${relPath}\n`);
          await walk(abs, relPath);
        } else if (entry.isFile()) {
          hash.update(`F:${relPath}:`);
          hash.update(await readFile(abs));
          hash.update("\n");
        }
      }
    }
    await walk(dir, "");
    return hash.digest("hex");
  }

  interface ShadowCheckpoint {
    gitDir: string;
    commit: string;
    runCkpt: (args: string[]) => string;
  }

  /**
   * Builds a shadow-git-style checkpoint of `workspace` in an ISOLATED GIT_DIR that
   * lives OUTSIDE the workspace, mirroring shadow-git.ts:111/114-126 env-addressing
   * EXACTLY (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY; init/add -A/
   * write-tree/commit-tree/update-ref plumbing — never touching the user's .git and
   * never resolving the repo from cwd). This is the concrete store the reset theorem
   * (§6#2) must not be able to corrupt.
   */
  async function makeShadowCheckpoint(workspace: string): Promise<ShadowCheckpoint> {
    const ckptRoot = await mkdtemp(join(tmpdir(), "anycode-ckpt-"));
    dirs.push(ckptRoot);
    const gitDir = join(ckptRoot, createHash("sha256").update(workspace).digest("hex").slice(0, 16));
    await mkdir(join(gitDir, "info"), { recursive: true });
    const env = {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workspace,
      GIT_INDEX_FILE: join(gitDir, "index-s1"),
      GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "anycode",
      GIT_AUTHOR_EMAIL: "checkpoint@anycode.invalid",
      GIT_COMMITTER_NAME: "anycode",
      GIT_COMMITTER_EMAIL: "checkpoint@anycode.invalid",
    };
    const runCkpt = (args: string[]): string => execFileSync("git", args, { cwd: workspace, encoding: "utf-8", env });
    runCkpt(["init", "--quiet"]);
    await writeFile(join(gitDir, "info", "exclude"), ".git/\nnode_modules/\n");
    runCkpt(["add", "-A"]);
    const tree = runCkpt(["write-tree"]).trim();
    const commit = runCkpt(["commit-tree", tree, "-m", "anycode checkpoint"]).trim();
    runCkpt(["update-ref", "refs/anycode/sessions/s1", commit]);
    return { gitDir, commit, runCkpt };
  }

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
    dirs = [];
  });

  it(
    "drives a real commit + stage/unstage porcelain through the wire; sha == rev-parse; zero permission_request (§6#1, L4)",
    async () => {
      const dir = await makeSeededRepo();
      const h = createHarness({
        steps: [],
        git: (outbound) =>
          new GitBridge({ git: new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: dir }), outbound }),
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        // The ui_ready-triggered snapshot (slice 5.7-hostfix) provides the first
        // git_status against the REAL adapter — no manual pushSnapshot needed.
        const snap = await h.waitFor(isGitStatus, 5_000);
        expect(snap.status).not.toBeNull();
        expect(snap.status?.head.branch).toBe("main");

        // Stage a new untracked file via the wire → porcelain shows it staged.
        await writeFile(join(dir, "a.txt"), "hello\n");
        h.send({ type: "git_command", requestId: "stage", command: { op: "stage", paths: ["a.txt"] } });
        const staged = await h.waitFor(gitResultFor("stage"), 5_000);
        expect(staged.outcome).toMatchObject({ ok: true, kind: "unit" });
        expect(runGitCli(dir, ["status", "--porcelain"])).toMatch(/A\s+a\.txt/);

        // Unstage it → back to untracked.
        h.send({ type: "git_command", requestId: "unstage", command: { op: "unstage", paths: ["a.txt"] } });
        const unstaged = await h.waitFor(gitResultFor("unstage"), 5_000);
        expect(unstaged.outcome).toMatchObject({ ok: true, kind: "unit" });
        expect(runGitCli(dir, ["status", "--porcelain"])).toMatch(/\?\?\s+a\.txt/);

        // stage_all + commit via the wire; the reported sha must equal rev-parse HEAD.
        h.send({ type: "git_command", requestId: "stageall", command: { op: "stage_all" } });
        await h.waitFor(gitResultFor("stageall"), 5_000);
        h.send({ type: "git_command", requestId: "commit", command: { op: "commit", message: "wire commit" } });
        const committed = await h.waitFor(gitResultFor("commit"), 5_000);
        expect(committed.outcome.ok).toBe(true);
        if (committed.outcome.ok && committed.outcome.kind === "commit") {
          expect(committed.outcome.sha).toBe(runGitCli(dir, ["rev-parse", "HEAD"]).trim());
        }

        // L4: the whole user-initiated git path never raised a permission_request.
        expect(h.received.filter(isPermissionRequest).length).toBe(0);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  it(
    "git_result is sendDirect (never replayed); git_status is buffered (replayed on re-bind) — ruling R6",
    async () => {
      const dir = await makeSeededRepo();
      const h = createHarness({
        steps: [],
        git: (outbound) => new GitBridge({ git: new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: dir }), outbound }),
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        // A mutation emits git_status (buffered) + git_result (sendDirect).
        await writeFile(join(dir, "b.txt"), "x\n");
        h.send({ type: "git_command", requestId: "sa", command: { op: "stage_all" } });
        await h.waitFor(gitResultFor("sa"), 5_000);
        // Post-5.7-hostfix the ui_ready connect snapshot is the 1st git_status
        // (sendDirect, un-buffered); wait for the mutation's BUFFERED git_status
        // (the 2nd) so the ring definitely holds one before the reload.
        await h.waitUntil(() => h.received.filter(isGitStatus).length >= 2, 5_000);

        // Simulate a renderer reload: re-send ui_ready → Outbound.replay() re-posts
        // the whole ring buffer. git_status (emit) is in it; git_result (sendDirect) is not.
        const mark = h.received.length;
        h.send({ type: "ui_ready" });
        await h.flush();
        await h.flush();
        const replayed = h.received.slice(mark);
        expect(replayed.some(isGitStatus)).toBe(true);
        expect(replayed.some(isGitResult)).toBe(false);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  it(
    "reset --hard through the wire cannot corrupt an out-of-workspace shadow-git checkpoint store (§6#2 — THE theorem)",
    async () => {
      const dir = await makeSeededRepo();
      // Dirty the tracked file so `reset --hard HEAD` has something to revert.
      await writeFile(join(dir, "seed.txt"), "seed-dirty\n");

      const ckpt = await makeShadowCheckpoint(dir);
      const hashBefore = await hashDir(ckpt.gitDir);
      // The checkpoint captured the DIRTY worktree (proves it is a real snapshot).
      expect(ckpt.runCkpt(["cat-file", "-p", `${ckpt.commit}:seed.txt`])).toBe("seed-dirty\n");

      const h = createHarness({
        steps: [],
        git: (outbound) =>
          new GitBridge({ git: new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: dir }), outbound }),
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "git_command", requestId: "reset", command: { op: "reset", mode: "hard", confirmed: true } });
        const res = await h.waitFor(gitResultFor("reset"), 10_000);
        expect(res.outcome).toMatchObject({ ok: true, kind: "unit" });
      } finally {
        h.close();
      }

      // 1) reset reverted the workspace worktree to HEAD (it really ran).
      expect(await readFile(join(dir, "seed.txt"), "utf-8")).toBe("seed\n");
      // 2) the checkpoint GIT_DIR is BYTE-IDENTICAL — reset never reached it.
      expect(await hashDir(ckpt.gitDir)).toBe(hashBefore);
      // 3) the checkpoint is still fully restorable (its dirty snapshot survives).
      expect(ckpt.runCkpt(["cat-file", "-p", `${ckpt.commit}:seed.txt`])).toBe("seed-dirty\n");
    },
    30_000,
  );

  it(
    "a hostile inherited GIT_DIR=<checkpoint> is neutralized by SAFE_GIT_ENV — reset hits only the cwd repo (§6#2 hostile)",
    async () => {
      const dir = await makeSeededRepo();
      await writeFile(join(dir, "seed.txt"), "seed-dirty\n");
      const ckpt = await makeShadowCheckpoint(dir);
      const hashBefore = await hashDir(ckpt.gitDir);

      const saved: Record<string, string | undefined> = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
      };
      // Inherit the checkpoint store's addressing into the adapter's process — the
      // exact relocation attack SAFE_GIT_ENV (node-git.ts:69-72) exists to defeat.
      process.env.GIT_DIR = ckpt.gitDir;
      process.env.GIT_INDEX_FILE = join(ckpt.gitDir, "index-s1");
      process.env.GIT_OBJECT_DIRECTORY = join(ckpt.gitDir, "objects");

      const h = createHarness({
        steps: [],
        git: (outbound) =>
          new GitBridge({ git: new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: dir }), outbound }),
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "git_command", requestId: "reset", command: { op: "reset", mode: "hard", confirmed: true } });
        const res = await h.waitFor(gitResultFor("reset"), 10_000);
        // A success PROVES reset resolved HEAD in the CWD repo: the checkpoint's own
        // HEAD is unborn, so an honored GIT_DIR would have failed HEAD resolution.
        expect(res.outcome).toMatchObject({ ok: true, kind: "unit" });
      } finally {
        h.close();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }

      // Reset touched only the workspace; the checkpoint store is byte-identical.
      expect(await readFile(join(dir, "seed.txt"), "utf-8")).toBe("seed\n");
      expect(await hashDir(ckpt.gitDir)).toBe(hashBefore);
    },
    30_000,
  );

  it(
    "a >500k-char diff is sliced to the wire cap with truncated:true via diffDetailed (§6#7c)",
    async () => {
      const dir = await makeSeededRepo();
      await writeFile(join(dir, "big.txt"), "0\n");
      runGitCli(dir, ["add", "-A"]);
      runGitCli(dir, ["commit", "-q", "-m", "add big"]);
      // Overwrite with > 500k chars but < 2 MiB: the adapter returns it WHOLE
      // (truncated:false at the 2 MiB diff cap), so the bridge is what slices it to
      // the wire cap and flips truncated:true (CONCERN-1 wire-slice branch).
      const huge = `${Array.from({ length: 20_000 }, (_v, i) => `lorem ipsum dolor sit amet consectetur ${i}`).join("\n")}\n`;
      expect(huge.length).toBeGreaterThan(GIT_WIRE_DIFF_MAX_CHARS);
      await writeFile(join(dir, "big.txt"), huge);

      const h = createHarness({
        steps: [],
        git: (outbound) =>
          new GitBridge({ git: new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: dir }), outbound }),
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "git_command", requestId: "diff", command: { op: "diff", target: "worktree" } });
        const res = await h.waitFor(gitResultFor("diff"), 10_000);
        expect(res.outcome.ok).toBe(true);
        if (res.outcome.ok && res.outcome.kind === "diff") {
          expect(res.outcome.truncated).toBe(true);
          expect(res.outcome.diff.length).toBe(GIT_WIRE_DIFF_MAX_CHARS);
        }
      } finally {
        h.close();
      }
    },
    30_000,
  );
});

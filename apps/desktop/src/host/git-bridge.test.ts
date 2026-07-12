/**
 * GitBridge unit tests over a mock GitPort + a spy outbound (slice 5.7, design
 * slice-5.7-cut.md §2.3-C5 / §6). Covers: the pure projection caps (§6#6), the
 * serialized single-child queue + flood bound (§6#5), single-flight refresh
 * (§2.3-C1.2), the git:null honest-refusal / zero-spawn path (§6#7), stage/unstage


 */

import { describe, expect, it } from "vitest";
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitDiffResult,
  GitDiffTarget,
  GitFileChange,
  GitHead,
  GitOpResult,
  GitPort,
  GitStatusSummary,
} from "@anycode/core";
import type { GitCommand, HostToUiMessage } from "../shared/protocol.js";
import { GIT_STATUS_MAX_FILES, GIT_WIRE_DIFF_MAX_CHARS } from "../shared/protocol.js";
import type { Outbound } from "./session.js";
import { GitBridge, MAX_PENDING_GIT_COMMANDS, projectGitStatus } from "./git-bridge.js";

// ── message narrowing helpers ───────────────────────────────────────────────
type GitResultMsg = Extract<HostToUiMessage, { type: "git_result" }>;
type GitStatusMsg = Extract<HostToUiMessage, { type: "git_status" }>;
const isResult = (m: HostToUiMessage): m is GitResultMsg => m.type === "git_result";
const isStatus = (m: HostToUiMessage): m is GitStatusMsg => m.type === "git_status";

const GIT_UNAVAILABLE = "git is unavailable in this workspace (not a git repository)";
const QUEUE_FULL = "git queue full; try again";
const STAGE_UNAVAILABLE = "stage/unstage unavailable on this git port";

// ── fixtures ─────────────────────────────────────────────────────────────────
function head(): GitHead {
  return { branch: "main", detached: false, sha: "abc123", ahead: null, behind: null };
}
function summary(over?: Partial<GitStatusSummary>): GitStatusSummary {
  return { head: head(), staged: [], unstaged: [], untracked: [], ...over };
}

function makeOutbound(): { emitted: HostToUiMessage[]; direct: HostToUiMessage[]; outbound: Pick<Outbound, "emit" | "sendDirect"> } {
  const emitted: HostToUiMessage[] = [];
  const direct: HostToUiMessage[] = [];
  const outbound: Pick<Outbound, "emit" | "sendDirect"> = {
    emit(message: HostToUiMessage): void {
      emitted.push(message);
    },
    sendDirect(message: HostToUiMessage): void {
      direct.push(message);
    },
  };
  return { emitted, direct, outbound };
}

function makeBridge(git: GitPort | null): {
  bridge: GitBridge;
  emitted: HostToUiMessage[];
  direct: HostToUiMessage[];
} {
  const o = makeOutbound();
  const bridge = new GitBridge({ git, outbound: o.outbound });
  return { bridge, emitted: o.emitted, direct: o.direct };
}

/**
 * Configurable GitPort mock: counts spawns + peak concurrency, and can HOLD every
 * call open (a shared gate) so the queue's serialization + single-flight
 * coalescing are observable.
 */
class MockGitPort implements GitPort {
  spawns = 0;
  active = 0;
  maxActive = 0;
  hold = false;
  statusFails = false;
  statusValue: GitStatusSummary = summary();
  diffValue = "diff-body";
  commitSha = "deadbeefcafe";
  private gates: Array<() => void> = [];

  releaseAll(): void {
    const gates = this.gates;
    this.gates = [];
    for (const gate of gates) {
      gate();
    }
  }

  private async track<T>(produce: () => T): Promise<T> {
    this.spawns += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) {
        await new Promise<void>((resolve) => {
          this.gates.push(resolve);
        });
      }
      return produce();
    } finally {
      this.active -= 1;
    }
  }

  status(): Promise<GitOpResult<GitStatusSummary>> {
    return this.track<GitOpResult<GitStatusSummary>>(() =>
      this.statusFails ? { ok: false, reason: "status boom" } : { ok: true, value: this.statusValue },
    );
  }
  listBranches(): Promise<GitOpResult<GitBranchInfo[]>> {
    return this.track<GitOpResult<GitBranchInfo[]>>(() => ({ ok: true, value: [] }));
  }
  log(): Promise<GitOpResult<GitCommitInfo[]>> {
    return this.track<GitOpResult<GitCommitInfo[]>>(() => ({ ok: true, value: [] }));
  }
  diff(): Promise<GitOpResult<string>> {
    return this.track<GitOpResult<string>>(() => ({ ok: true, value: this.diffValue }));
  }
  switchBranch(): Promise<GitOpResult<null>> {
    return this.track<GitOpResult<null>>(() => ({ ok: true, value: null }));
  }
  createBranch(): Promise<GitOpResult<null>> {
    return this.track<GitOpResult<null>>(() => ({ ok: true, value: null }));
  }
  stageAll(): Promise<GitOpResult<null>> {
    return this.track<GitOpResult<null>>(() => ({ ok: true, value: null }));
  }
  commit(): Promise<GitOpResult<{ sha: string }>> {
    return this.track<GitOpResult<{ sha: string }>>(() => ({ ok: true, value: { sha: this.commitSha } }));
  }
  stage(): Promise<GitOpResult<null>> {
    return this.track<GitOpResult<null>>(() => ({ ok: true, value: null }));
  }
  unstage(): Promise<GitOpResult<null>> {
    return this.track<GitOpResult<null>>(() => ({ ok: true, value: null }));
  }
}

/** Yields to the macrotask queue `n` times (drains microtasks between queue steps). */
async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe("projectGitStatus — caps + true dirtyCount (§6#6)", () => {
  it("caps each of the three lists at GIT_STATUS_MAX_FILES; dirtyCount is the TRUE total before the cap", () => {
    const untracked = Array.from({ length: 1500 }, (_, i) => `f${i}.txt`);
    const wire = projectGitStatus(summary({ untracked }));
    expect(wire.untracked.length).toBe(GIT_STATUS_MAX_FILES);
    expect(wire.untracked.length).toBe(1000);
    expect(wire.dirtyCount).toBe(1500);
    expect(wire.filesTruncated).toBe(true);
    expect(wire.head).toEqual(head());
  });

  it("caps staged/unstaged independently and flags truncation if ANY list overflows", () => {
    const staged: GitFileChange[] = Array.from({ length: GIT_STATUS_MAX_FILES + 3 }, (_, i) => ({
      path: `s${i}`,
      kind: "modified",
    }));
    const wire = projectGitStatus(summary({ staged, unstaged: [{ path: "u", kind: "modified" }] }));
    expect(wire.staged.length).toBe(GIT_STATUS_MAX_FILES);
    expect(wire.unstaged.length).toBe(1);
    expect(wire.dirtyCount).toBe(GIT_STATUS_MAX_FILES + 3 + 1);
    expect(wire.filesTruncated).toBe(true);
  });

  it("does not truncate when every list is under the cap", () => {
    const wire = projectGitStatus(summary({ untracked: ["a", "b"], staged: [{ path: "s", kind: "added" }] }));
    expect(wire.dirtyCount).toBe(3);
    expect(wire.filesTruncated).toBe(false);
    expect(wire.untracked).toEqual(["a", "b"]);
  });
});

describe("GitBridge — diff cap (§6#6)", () => {
  it("slices a diff longer than GIT_WIRE_DIFF_MAX_CHARS and flags truncated:true", async () => {
    const git = new MockGitPort();
    git.diffValue = "x".repeat(GIT_WIRE_DIFF_MAX_CHARS + 100);
    const { bridge, direct } = makeBridge(git);
    bridge.handleCommand({ requestId: "d", command: { op: "diff", target: "head" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result).toBeDefined();
    expect(result?.outcome.ok).toBe(true);
    if (result && result.outcome.ok && result.outcome.kind === "diff") {
      expect(result.outcome.diff.length).toBe(GIT_WIRE_DIFF_MAX_CHARS);
      expect(result.outcome.truncated).toBe(true);
    }
  });

  it("leaves an under-cap diff intact with truncated:false", async () => {
    const git = new MockGitPort();
    git.diffValue = "small diff";
    const { bridge, direct } = makeBridge(git);
    bridge.handleCommand({ requestId: "d", command: { op: "diff" } });
    await tick();
    const result = direct.filter(isResult)[0];
    if (result && result.outcome.ok && result.outcome.kind === "diff") {
      expect(result.outcome.diff).toBe("small diff");
      expect(result.outcome.truncated).toBe(false);
    }
  });
});

describe("GitBridge — serialized queue + flood bound (§6#5)", () => {
  it("runs at most one git child at a time (max-concurrency == 1)", async () => {
    const git = new MockGitPort();
    git.hold = true;
    const { bridge, direct } = makeBridge(git);
    for (let i = 0; i < 5; i += 1) {
      bridge.handleCommand({ requestId: `r${i}`, command: { op: "stage_all" } });
    }
    await tick();
    // Only the first task reached the port; the other four are queued behind the
    // single promise chain.
    expect(git.spawns).toBe(1);
    expect(git.maxActive).toBe(1);
    expect(direct.length).toBe(0);

    git.hold = false;
    git.releaseAll();
    await tick(20);
    // All five mutations report a unit result, and concurrency never exceeded 1
    // even once the queue drained (each awaits the previous fully).
    const results = direct.filter(isResult);
    expect(results.length).toBe(5);
    expect(results.every((m) => m.outcome.ok && m.outcome.kind === "unit")).toBe(true);
    expect(git.maxActive).toBe(1);
  });

  it("refuses commands beyond MAX_PENDING_GIT_COMMANDS immediately, without enqueuing", async () => {
    const git = new MockGitPort();
    git.hold = true;
    const { bridge, direct } = makeBridge(git);
    const overflow = 5;
    for (let i = 0; i < MAX_PENDING_GIT_COMMANDS + overflow; i += 1) {
      bridge.handleCommand({ requestId: `r${i}`, command: { op: "branches" } });
    }
    // Synchronously (before any task runs): exactly `overflow` immediate refusals.
    const refusals = direct.filter(isResult).filter((m) => !m.outcome.ok);
    expect(refusals.length).toBe(overflow);
    for (const r of refusals) {
      expect(r.outcome).toMatchObject({ ok: false, reason: QUEUE_FULL });
    }
    await tick();
    // Still one child while held (the 8 enqueued serialize behind the chain).
    expect(git.spawns).toBe(1);
    expect(git.maxActive).toBe(1);

    git.hold = false;
    git.releaseAll();
    await tick(30);
    // Every enqueued command eventually gets its own git_result (8 ok + `overflow` refusals).
    const all = direct.filter(isResult);
    expect(all.length).toBe(MAX_PENDING_GIT_COMMANDS + overflow);
    expect(all.filter((m) => m.outcome.ok).length).toBe(MAX_PENDING_GIT_COMMANDS);
  });
});

describe("GitBridge — single-flight refresh (§2.3-C1.2)", () => {
  it("coalesces concurrent turn-end refreshes into ONE status() spawn", async () => {
    const git = new MockGitPort();
    git.hold = true;
    const { bridge, emitted } = makeBridge(git);
    bridge.refreshAfterTurn();
    bridge.refreshAfterTurn();
    bridge.refreshAfterTurn();
    await tick();
    expect(git.spawns).toBe(1);

    git.hold = false;
    git.releaseAll();
    await tick();
    const statuses = emitted.filter(isStatus);
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((m) => m.status !== null)).toBe(true);
  });

  it("a transient status failure warns and does NOT publish null (ruling R9)", async () => {
    const git = new MockGitPort();
    git.statusFails = true;
    const { bridge, emitted } = makeBridge(git);
    bridge.refreshAfterTurn();
    await tick();
    expect(git.spawns).toBe(1);
    // No git_status published at all — the stale pill is left standing.
    expect(emitted.filter(isStatus).length).toBe(0);
  });
});

describe("GitBridge — git:null non-git workspace (§6#7, ruling R8)", () => {
  it("refuses every command honestly, snapshots {status:null} once on bind, and never emits status", async () => {
    const { bridge, emitted, direct } = makeBridge(null);

    bridge.pushSnapshot();
    expect(direct.filter(isStatus)).toEqual([{ type: "git_status", status: null }]);

    bridge.handleCommand({ requestId: "c", command: { op: "commit", message: "x" } });
    bridge.handleCommand({ requestId: "r", command: { op: "refresh" } });
    bridge.refreshAfterTurn(); // no-op on a null workspace
    await tick();

    const results = direct.filter(isResult);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.outcome).toMatchObject({ ok: false, reason: GIT_UNAVAILABLE });
    }
    // git:null can spawn nothing (there is no port to call); the only status
    // message is the single bind snapshot, and it is `null`.
    expect(emitted.filter(isStatus).length).toBe(0);
    expect(direct.filter(isStatus).length).toBe(1);
  });
});

describe("GitBridge — stage/unstage fail-closed when the optional port method is absent (ruling R7)", () => {
  const portNoStage: GitPort = {
    status: async () => ({ ok: true, value: summary() }),
    listBranches: async () => ({ ok: true, value: [] }),
    log: async () => ({ ok: true, value: [] }),
    diff: async () => ({ ok: true, value: "" }),
    switchBranch: async () => ({ ok: true, value: null }),
    createBranch: async () => ({ ok: true, value: null }),
    stageAll: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: true, value: { sha: "x" } }),
    // stage/unstage intentionally absent (a 5.4-era port).
  };

  it("stage and unstage refuse honestly instead of spawning", async () => {
    const { bridge, direct } = makeBridge(portNoStage);
    bridge.handleCommand({ requestId: "s", command: { op: "stage", paths: ["a.txt"] } });
    bridge.handleCommand({ requestId: "u", command: { op: "unstage", paths: ["a.txt"] } });
    await tick();
    const results = direct.filter(isResult);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.outcome).toMatchObject({ ok: false, reason: STAGE_UNAVAILABLE });
    }
  });
});

describe("GitBridge — wire posture: git_result=sendDirect, git_status=emit (ruling R6)", () => {
  it("routes a commit's git_result to sendDirect and its follow-up git_status to emit", async () => {
    const git = new MockGitPort();
    git.commitSha = "feedface";
    const { bridge, emitted, direct } = makeBridge(git);
    bridge.handleCommand({ requestId: "c", command: { op: "commit", message: "hello" } });
    await tick();

    // git_result on the ephemeral (sendDirect) channel — never buffered.
    const results = direct.filter(isResult);
    expect(results.length).toBe(1);
    expect(results[0]?.outcome).toMatchObject({ ok: true, kind: "commit", sha: "feedface" });
    expect(emitted.filter(isResult).length).toBe(0);

    // git_status (the mutation follow) on the buffered (emit) channel.
    expect(emitted.filter(isStatus).length).toBeGreaterThanOrEqual(1);
    expect(direct.filter(isStatus).length).toBe(0);
  });

  it("maps a listBranches success into a branches outcome", async () => {
    const git = new MockGitPort();
    const { bridge, direct } = makeBridge(git);
    bridge.handleCommand({ requestId: "b", command: { op: "branches" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result?.outcome).toMatchObject({ ok: true, kind: "branches", branches: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Slice 5.8 (design slice-5.8-cut.md §2.4): the destructive tail + the CONCERN-1
// diff-truncation propagation. The existing 5.7 diff-cap tests above use
// MockGitPort (which has NO diffDetailed), so they already exercise the diff()
// FALLBACK path; the tests below cover the preferred diffDetailed path and the
// four destructive ops.
// ═══════════════════════════════════════════════════════════════════════════

interface DestructiveCalls {
  discard: string[][];
  stashPush: Array<{ message?: string; includeUntracked?: boolean } | undefined>;
  stashPop: number;
  resetHead: Array<"mixed" | "hard">;
  status: number;
  diff: number;
  diffDetailed: Array<{ target?: GitDiffTarget; path?: string } | undefined>;
}

/** 8 required methods only — a 5.7-era port with NONE of the destructive methods. */
function portNoDestructive(): GitPort {
  return {
    status: async () => ({ ok: true, value: summary() }),
    listBranches: async () => ({ ok: true, value: [] }),
    log: async () => ({ ok: true, value: [] }),
    diff: async () => ({ ok: true, value: "" }),
    switchBranch: async () => ({ ok: true, value: null }),
    createBranch: async () => ({ ok: true, value: null }),
    stageAll: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: true, value: { sha: "x" } }),
  };
}

/** A port carrying the full destructive tail (arg-recording) + an optional diffDetailed. */
function destructivePort(opts?: {
  mutation?: GitOpResult<null>;
  diffDetailed?: GitOpResult<GitDiffResult>;
}): { port: GitPort; calls: DestructiveCalls } {
  const calls: DestructiveCalls = {
    discard: [],
    stashPush: [],
    stashPop: 0,
    resetHead: [],
    status: 0,
    diff: 0,
    diffDetailed: [],
  };
  const mutation: GitOpResult<null> = opts?.mutation ?? { ok: true, value: null };
  const port: GitPort = {
    status: async () => {
      calls.status += 1;
      return { ok: true, value: summary() };
    },
    listBranches: async () => ({ ok: true, value: [] }),
    log: async () => ({ ok: true, value: [] }),
    diff: async () => {
      calls.diff += 1;
      return { ok: true, value: "" };
    },
    switchBranch: async () => ({ ok: true, value: null }),
    createBranch: async () => ({ ok: true, value: null }),
    stageAll: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: true, value: { sha: "x" } }),
    discard: async (paths: string[]) => {
      calls.discard.push(paths);
      return mutation;
    },
    stashPush: async (o?: { message?: string; includeUntracked?: boolean }) => {
      calls.stashPush.push(o);
      return mutation;
    },
    stashPop: async () => {
      calls.stashPop += 1;
      return mutation;
    },
    resetHead: async (mode: "mixed" | "hard") => {
      calls.resetHead.push(mode);
      return mutation;
    },
    ...(opts?.diffDetailed !== undefined
      ? {
          diffDetailed: async (spec?: { target?: GitDiffTarget; path?: string }) => {
            calls.diffDetailed.push(spec);
            return opts.diffDetailed as GitOpResult<GitDiffResult>;
          },
        }
      : {}),
  };
  return { port, calls };
}

describe("GitBridge — diff prefers diffDetailed (CONCERN-1, §6#7b/c)", () => {
  it("uses diffDetailed and leaves diff() untouched for a small untruncated diff", async () => {
    const { port, calls } = destructivePort({
      diffDetailed: { ok: true, value: { text: "@@ -1 +1 @@\n-a\n+b", truncated: false } },
    });
    const { bridge, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "d", command: { op: "diff", target: "head" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result?.outcome).toEqual({ ok: true, kind: "diff", diff: "@@ -1 +1 @@\n-a\n+b", truncated: false });
    expect(calls.diffDetailed.length).toBe(1);
    expect(calls.diff).toBe(0);
  });

  it("§6#7b: adapter stdoutTruncated ⇒ wire truncated:true even BELOW the wire cap", async () => {
    const { port } = destructivePort({ diffDetailed: { ok: true, value: { text: "short diff", truncated: true } } });
    const { bridge, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "d", command: { op: "diff" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result?.outcome).toEqual({ ok: true, kind: "diff", diff: "short diff", truncated: true });
  });

  it("§6#7c: text ABOVE the wire cap (adapter truncated:false) ⇒ sliced to the cap, truncated:true", async () => {
    const big = "x".repeat(GIT_WIRE_DIFF_MAX_CHARS + 5_000);
    const { port } = destructivePort({ diffDetailed: { ok: true, value: { text: big, truncated: false } } });
    const { bridge, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "d", command: { op: "diff" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result?.outcome.ok).toBe(true);
    if (result && result.outcome.ok && result.outcome.kind === "diff") {
      expect(result.outcome.truncated).toBe(true);
      expect(result.outcome.diff.length).toBe(GIT_WIRE_DIFF_MAX_CHARS);
    }
  });

  it("propagates a diffDetailed failure honestly", async () => {
    const { port } = destructivePort({ diffDetailed: { ok: false, reason: "no HEAD" } });
    const { bridge, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "d", command: { op: "diff" } });
    await tick();
    const result = direct.filter(isResult)[0];
    expect(result?.outcome).toEqual({ ok: false, reason: "no HEAD" });
  });

  it("threads target + path into diffDetailed's spec", async () => {
    const { port, calls } = destructivePort({ diffDetailed: { ok: true, value: { text: "d", truncated: false } } });
    const { bridge } = makeBridge(port);
    bridge.handleCommand({ requestId: "d", command: { op: "diff", target: "staged", path: "src/x.ts" } });
    await tick();
    expect(calls.diffDetailed[0]).toEqual({ target: "staged", path: "src/x.ts" });
  });
});

describe("GitBridge — destructive tail presence-check fail-closed (§2.4)", () => {
  const cases: Array<{ name: string; command: GitCommand; reason: RegExp }> = [
    { name: "discard", command: { op: "discard", paths: ["a.ts"], confirmed: true }, reason: /discard unavailable/ },
    { name: "stash_push", command: { op: "stash_push", confirmed: true }, reason: /stash unavailable/ },
    { name: "stash_pop", command: { op: "stash_pop", confirmed: true }, reason: /stash unavailable/ },
    { name: "reset", command: { op: "reset", mode: "hard", confirmed: true }, reason: /reset unavailable/ },
  ];

  it.each(cases)("$name honestly refuses on a port without the optional method (no fresh status)", async ({ command, reason }) => {
    const { bridge, emitted, direct } = makeBridge(portNoDestructive());
    bridge.handleCommand({ requestId: "x", command });
    await tick(6);
    const result = direct.filter(isResult)[0];
    expect(result?.outcome.ok).toBe(false);
    if (result && !result.outcome.ok) {
      expect(result.outcome.reason).toMatch(reason);
    }
    // A refusal is not a mutation ⇒ no fresh git_status follow.
    expect(emitted.filter(isStatus).length).toBe(0);
  });
});

describe("GitBridge — destructive tail forwarding + fresh-status follow (§2.4)", () => {
  it("discard forwards its paths ⇒ unit reply + a fresh git_status", async () => {
    const { port, calls } = destructivePort();
    const { bridge, emitted, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "x", command: { op: "discard", paths: ["a.ts", "b.ts"], confirmed: true } });
    await tick(6);
    expect(calls.discard).toEqual([["a.ts", "b.ts"]]);
    expect(direct.filter(isResult)[0]?.outcome).toMatchObject({ ok: true, kind: "unit" });
    expect(emitted.filter(isStatus).length).toBeGreaterThanOrEqual(1);
  });

  it("stash_push forwards message + includeUntracked", async () => {
    const { port, calls } = destructivePort();
    const { bridge } = makeBridge(port);
    bridge.handleCommand({
      requestId: "x",
      command: { op: "stash_push", message: "wip", includeUntracked: true, confirmed: true },
    });
    await tick(6);
    expect(calls.stashPush).toEqual([{ message: "wip", includeUntracked: true }]);
  });

  it("stash_push bare passes an empty opts object (no phantom keys)", async () => {
    const { port, calls } = destructivePort();
    const { bridge } = makeBridge(port);
    bridge.handleCommand({ requestId: "x", command: { op: "stash_push", confirmed: true } });
    await tick(6);
    expect(calls.stashPush).toEqual([{}]);
  });

  it("stash_pop ⇒ unit reply", async () => {
    const { port, calls } = destructivePort();
    const { bridge, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "x", command: { op: "stash_pop", confirmed: true } });
    await tick(6);
    expect(calls.stashPop).toBe(1);
    expect(direct.filter(isResult)[0]?.outcome).toMatchObject({ ok: true, kind: "unit" });
  });

  it("reset forwards the mode literal (mixed / hard)", async () => {
    for (const mode of ["mixed", "hard"] as const) {
      const { port, calls } = destructivePort();
      const { bridge, direct } = makeBridge(port);
      bridge.handleCommand({ requestId: "x", command: { op: "reset", mode, confirmed: true } });
      await tick(6);
      expect(calls.resetHead).toEqual([mode]);
      expect(direct.filter(isResult)[0]?.outcome).toMatchObject({ ok: true, kind: "unit" });
    }
  });

  it("a destructive failure surfaces {ok:false} and pushes NO fresh git_status", async () => {
    const { port } = destructivePort({ mutation: { ok: false, reason: "no HEAD to reset" } });
    const { bridge, emitted, direct } = makeBridge(port);
    bridge.handleCommand({ requestId: "x", command: { op: "reset", mode: "hard", confirmed: true } });
    await tick(6);
    expect(direct.filter(isResult)[0]?.outcome).toEqual({ ok: false, reason: "no HEAD to reset" });
    expect(emitted.filter(isStatus).length).toBe(0);
  });

  it("ruling R1: the bridge re-checks NOTHING — a runtime confirmed:false still executes (zod is the sole gate)", async () => {
    const { port, calls } = destructivePort();
    const { bridge } = makeBridge(port);
    // The wire TYPE mandates confirmed:true and zod enforces it in Session.route
    // (protocol.test §6#5). The bridge deliberately adds no second "gate", so a
    // value that somehow bypassed zod is still executed — no fake boundary.
    bridge.handleCommand({
      requestId: "x",
      command: { op: "discard", paths: ["a.ts"], confirmed: false } as unknown as GitCommand,
    });
    await tick(6);
    expect(calls.discard).toEqual([["a.ts"]]);
  });
});

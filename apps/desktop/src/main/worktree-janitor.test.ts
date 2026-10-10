import { describe, expect, it, vi } from "vitest";
import type { GitPort, SessionMeta } from "@anycode/core";
import { runWorktreeJanitor, WORKTREE_JANITOR_SESSION_LIMIT } from "./worktree-janitor.js";

const ROOT = "/repo";
const TARGET = "/repo/.anycode/worktrees/task-5";
const BRANCH = "anycode-wt/task-5";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-1",
    workspace: ROOT,
    projectRoot: ROOT,
    model: "test",
    mode: "build",
    createdAt: 1,
    updatedAt: 1,
    continuationPending: true,
    continuationMode: "none",
    worktreeCleanup: {
      path: TARGET,
      mode: "auto",
      ownedByAnyCode: true,
      branch: BRANCH,
    },
    ...overrides,
  };
}

function registered() {
  return {
    path: TARGET,
    head: "abc",
    branch: BRANCH,
    detached: false,
    isMain: false,
    locked: false,
    prunable: false,
  };
}

function git(overrides: Partial<GitPort> = {}): GitPort {
  return {
    status: async () => ({ ok: false, reason: "unused" }),
    listBranches: async () => ({ ok: true, value: [{ name: BRANCH, current: false, sha: "abc" }] }),
    log: async () => ({ ok: false, reason: "unused" }),
    diff: async () => ({ ok: false, reason: "unused" }),
    switchBranch: async () => ({ ok: false, reason: "unused" }),
    createBranch: async () => ({ ok: false, reason: "unused" }),
    stageAll: async () => ({ ok: false, reason: "unused" }),
    commit: async () => ({ ok: false, reason: "unused" }),
    worktreeList: async () => ({ ok: true, value: [registered()] }),
    worktreeRemove: async () => ({ ok: true, value: null }),
    worktreePrune: async () => ({ ok: true, value: null }),
    worktreeIsPristine: async () => ({ ok: true, value: true }),
    deleteBranch: async () => ({ ok: true, value: null }),
    ...overrides,
  };
}

/**
 * The janitor's two persistence reads (TASK.142): the recency-bounded cleanup
 * list and the unbounded metadata-only claim scan. Most tests care about one
 * session set, so this fixture serves BOTH from the same source — the claim map
 * then equals the iterated set, exactly as before the split.
 */
type JanitorPersistence = Parameters<typeof runWorktreeJanitor>[0]["persistence"];

function persistenceOf(
  sessions: SessionMeta[] | (() => SessionMeta[]),
  touchSession: JanitorPersistence["touchSession"] = async () => {},
): JanitorPersistence {
  const load = async () => (typeof sessions === "function" ? sessions() : sessions);
  return { listSessionsForMaintenance: load, listWorktreeClaims: load, touchSession };
}

describe("runWorktreeJanitor", () => {
  it("removes an exact clean ledger, then its exact merged branch, and clears the claim", async () => {
    const order: string[] = [];
    const touchSession = vi.fn(async () => {});
    const rootGit = git({
      worktreeList: async () => {
        order.push("list-worktrees");
        return { ok: true, value: [registered()] };
      },
      worktreeRemove: async () => {
        order.push("remove-worktree");
        return { ok: true, value: null };
      },
      worktreePrune: async () => {
        order.push("prune");
        return { ok: true, value: null };
      },
      listBranches: async () => {
        order.push("list-branches");
        return { ok: true, value: [{ name: BRANCH, current: false, sha: "abc" }] };
      },
      deleteBranch: async (name) => {
        order.push(`delete:${name}`);
        return { ok: true, value: null };
      },
    });

    const result = await runWorktreeJanitor({
      persistence: persistenceOf([session()], touchSession),
      gitForWorkspace: (workspace) => workspace === ROOT ? rootGit : git(),
      exists: async () => true,
    });

    expect(result).toEqual({ examined: 1, cleaned: 1, retained: 0 });
    expect(order).toEqual([
      "list-worktrees",
      "remove-worktree",
      "prune",
      "list-branches",
      `delete:${BRANCH}`,
    ]);
    expect(touchSession).toHaveBeenCalledWith("session-1", {
      continuationPending: false,
      continuationMode: null,
      worktreeCleanup: null,
    });
  });

  it("retains dirty, locked, forceful, active, and multiply-claimed resources", async () => {
    const dirtyRemove = vi.fn(async () => ({ ok: true as const, value: null }));
    const dirtyDelete = vi.fn(async () => ({ ok: true as const, value: null }));
    const sessions = [
      session({ id: "dirty" }),
      session({ id: "force", worktreeCleanup: { path: "/repo/.anycode/worktrees/force", mode: "remove", ownedByAnyCode: true, branch: "anycode-wt/force" } }),
      session({ id: "active", worktree: { id: "task-5", path: TARGET, branch: BRANCH, baseRef: "HEAD", ownedByAnyCode: true } }),
      session({ id: "other", worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true, branch: BRANCH } }),
    ];

    const result = await runWorktreeJanitor({
      persistence: persistenceOf(sessions),
      gitForWorkspace: (workspace) => workspace === ROOT
        ? git({ worktreeRemove: dirtyRemove, deleteBranch: dirtyDelete })
        : git({ worktreeIsPristine: async () => ({ ok: true, value: false }) }),
      exists: async () => true,
    });

    expect(result).toEqual({ examined: 4, cleaned: 0, retained: 4 });
    expect(dirtyRemove).not.toHaveBeenCalled();
    expect(dirtyDelete).not.toHaveBeenCalled();
  });

  it("retains an unregistered existing directory and never infers it is disposable", async () => {
    const touchSession = vi.fn(async () => {});
    const remove = vi.fn(async () => ({ ok: true as const, value: null }));
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([session()], touchSession),
      gitForWorkspace: () => git({
        worktreeList: async () => ({ ok: true, value: [] }),
        worktreeRemove: remove,
      }),
      exists: async () => true,
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    expect(remove).not.toHaveBeenCalled();
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("never removes a foreign branch discovered from a legacy path-only ledger", async () => {
    const remove = vi.fn(async () => ({ ok: true as const, value: null }));
    const legacy = session({
      worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true },
    });
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([legacy]),
      gitForWorkspace: () => git({
        worktreeList: async () => ({
          ok: true,
          value: [{ ...registered(), branch: "user/precious" }],
        }),
        worktreeRemove: remove,
      }),
      exists: async () => true,
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("lists before pruning a stale registration, then cleans only after proving it absent", async () => {
    const order: string[] = [];
    let listed = 0;
    const touchSession = vi.fn(async () => {});
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([session()], touchSession),
      gitForWorkspace: () => git({
        worktreeList: async () => {
          order.push("list");
          listed += 1;
          return {
            ok: true,
            value: listed === 1 ? [{ ...registered(), prunable: true }] : [],
          };
        },
        worktreePrune: async () => {
          order.push("prune");
          return { ok: true, value: null };
        },
      }),
      exists: async () => false,
    });

    expect(result).toEqual({ examined: 1, cleaned: 1, retained: 0 });
    expect(order.slice(0, 3)).toEqual(["list", "prune", "list"]);
    expect(touchSession).toHaveBeenCalledOnce();
  });

  it("keeps the branch ledger when merged-only deletion refuses after checkout removal", async () => {
    const touchSession = vi.fn(async () => {});
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([session()], touchSession),
      gitForWorkspace: (workspace) => workspace === ROOT
        ? git({ deleteBranch: async () => ({ ok: false, reason: "not fully merged" }) })
        : git(),
      exists: async () => true,
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("clears an already-absent checkout and branch idempotently", async () => {
    const touchSession = vi.fn(async () => {});
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([session()], touchSession),
      gitForWorkspace: () => git({
        worktreeList: async () => ({ ok: true, value: [] }),
        listBranches: async () => ({ ok: true, value: [] }),
      }),
      exists: async () => false,
    });

    expect(result).toEqual({ examined: 1, cleaned: 1, retained: 0 });
    expect(touchSession).toHaveBeenCalledOnce();
  });

  it("retains an absent legacy path-only ledger instead of forgetting an unknown orphan branch", async () => {
    const touchSession = vi.fn(async () => {});
    const legacy = session({
      worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true },
    });
    const result = await runWorktreeJanitor({
      persistence: persistenceOf([legacy], touchSession),
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [] }) }),
      exists: async () => false,
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("bounds FS probing to the recent window — an >limit old session on an unreachable path is never loaded, statted, or git-probed", async () => {
    const touchSession = vi.fn(async () => {});
    const STALE_ROOT = "/Volumes/External/repo";
    // Five claim-bearing rows: the newest two are in-window, the older three sit
    // on an unmounted volume (the TCC prompt source).
    const sessions = [
      session({ id: "new-1" }),
      session({ id: "new-2" }),
      session({ id: "old-1", workspace: STALE_ROOT, projectRoot: STALE_ROOT }),
      session({ id: "old-2", workspace: STALE_ROOT, projectRoot: STALE_ROOT }),
      session({ id: "old-3", workspace: STALE_ROOT, projectRoot: STALE_ROOT }),
    ];
    const listArgs: Array<{ limit?: number } | undefined> = [];
    const gitForWorkspace = vi.fn((workspace: string) => {
      expect(workspace).not.toContain("/Volumes/External");
      return git({ worktreeList: async () => ({ ok: true, value: [] }) });
    });
    const exists = vi.fn(async (target: string) => {
      expect(target).not.toContain("/Volumes/External");
      return false;
    });

    const result = await runWorktreeJanitor({
      persistence: {
        listSessionsForMaintenance: async (opts) => {
          listArgs.push(opts);
          return opts?.limit === undefined ? sessions : sessions.slice(0, opts.limit);
        },
        listWorktreeClaims: async () => sessions,
        touchSession,
      },
      gitForWorkspace,
      exists,
      sessionLimit: 2,
    });

    // The injectable limit reached the store verbatim...
    expect(listArgs).toEqual([{ limit: 2 }]);
    // ...and only the two in-window rows were examined (the old three were never
    // iterated, so their unreachable workspaces were never git- or stat-probed).
    expect(result).toEqual({ examined: 2, cleaned: 0, retained: 2 });
    expect(gitForWorkspace.mock.calls.every(([w]) => w === ROOT)).toBe(true);
    expect(exists.mock.calls.every(([t]) => t === TARGET)).toBe(true);
  });

  it("an old child claimant OUTSIDE the limit sharing a recent cleanup target prevents deletion, without statting its unrelated unreachable path", async () => {
    const touchSession = vi.fn(async () => {});
    const STALE_ROOT = "/Volumes/External/repo";
    // S1 (recent) wants TARGET cleaned; S2 (old, outside the window) still OWNS
    // TARGET as its worktree, while its own workspace is unreachable.
    const recent = session({ id: "s1" });
    const staleClaimant = session({
      id: "s2",
      workspace: STALE_ROOT,
      projectRoot: STALE_ROOT,
      worktree: { id: "t", path: TARGET, branch: BRANCH, baseRef: "HEAD", ownedByAnyCode: true },
      worktreeCleanup: undefined,
    });
    const claims = vi.fn(async () => [recent, staleClaimant]);
    const exists = vi.fn(async (target: string) => {
      expect(target).not.toContain("/Volumes/External");
      return true;
    });

    const result = await runWorktreeJanitor({
      persistence: {
        listSessionsForMaintenance: async (opts) =>
          opts?.limit === undefined ? [recent, staleClaimant] : [recent],
        listWorktreeClaims: claims,
        touchSession,
      },
      gitForWorkspace: () => git(),
      exists,
      sessionLimit: 1,
    });

    // The claim query is what protected TARGET, and it is consulted exactly once.
    expect(claims).toHaveBeenCalledOnce();
    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    // Retained, not cleaned — the cleanup claim is never cleared.
    expect(touchSession).not.toHaveBeenCalled();
    // The stale claimant's own path was never probed.
    expect(exists).not.toHaveBeenCalledWith(STALE_ROOT);
  });

  it("defaults to WORKTREE_JANITOR_SESSION_LIMIT", async () => {
    const listArgs: Array<{ limit?: number } | undefined> = [];
    const result = await runWorktreeJanitor({
      persistence: {
        listSessionsForMaintenance: async (opts) => {
          listArgs.push(opts);
          return [];
        },
        listWorktreeClaims: async () => [],
        touchSession: vi.fn(async () => {}),
      },
      gitForWorkspace: () => git(),
      exists: async () => true,
    });

    expect(listArgs).toEqual([{ limit: WORKTREE_JANITOR_SESSION_LIMIT }]);
    expect(result).toEqual({ examined: 0, cleaned: 0, retained: 0 });
  });

  it("sanitizes injectable limits: 0, -5, 2.7 → 1, 1, 2; NaN and +/-Infinity → default; huge finite values → MAX_SAFE_INTEGER", async () => {
    const cases: Array<[number | undefined, number]> = [
      [0, 1],
      [-5, 1],
      [2.7, 2],
      [Number.NaN, WORKTREE_JANITOR_SESSION_LIMIT],
      [Number.POSITIVE_INFINITY, WORKTREE_JANITOR_SESSION_LIMIT],
      [Number.NEGATIVE_INFINITY, WORKTREE_JANITOR_SESSION_LIMIT],
      [Number.MAX_SAFE_INTEGER + 1e6, Number.MAX_SAFE_INTEGER],
    ];
    for (const [sessionLimit, expected] of cases) {
      const listArgs: Array<{ limit?: number } | undefined> = [];
      await runWorktreeJanitor({
        persistence: {
          listSessionsForMaintenance: async (opts) => {
            listArgs.push(opts);
            return [];
          },
          listWorktreeClaims: async () => [],
          touchSession: vi.fn(async () => {}),
        },
        gitForWorkspace: () => git(),
        exists: async () => true,
        sessionLimit,
      });
      expect(listArgs).toEqual([{ limit: expected }]);
    }
  });

  it("propagates a claim-query failure BEFORE any cleanup begins — uncertainty must never delete", async () => {
    const onGit = vi.fn(git);
    const exists = vi.fn(async () => true);
    await expect(
      runWorktreeJanitor({
        persistence: {
          listSessionsForMaintenance: async () => [session()],
          listWorktreeClaims: async () => {
            throw new Error("claim scan failed");
          },
          touchSession: vi.fn(async () => {}),
        },
        gitForWorkspace: onGit as unknown as (workspace: string) => GitPort,
        exists,
      }),
    ).rejects.toThrow("claim scan failed");
    expect(onGit).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});

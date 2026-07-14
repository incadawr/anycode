import { describe, expect, it, vi } from "vitest";
import type { GitPort, SessionMeta } from "@anycode/core";
import { runWorktreeJanitor } from "./worktree-janitor.js";

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
      persistence: { listSessions: async () => [session()], touchSession },
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
      persistence: { listSessions: async () => sessions, touchSession: vi.fn(async () => {}) },
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
      persistence: { listSessions: async () => [session()], touchSession },
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
      persistence: { listSessions: async () => [legacy], touchSession: vi.fn(async () => {}) },
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
      persistence: { listSessions: async () => [session()], touchSession },
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
      persistence: { listSessions: async () => [session()], touchSession },
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
      persistence: { listSessions: async () => [session()], touchSession },
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
      persistence: { listSessions: async () => [legacy], touchSession },
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [] }) }),
      exists: async () => false,
    });

    expect(result).toEqual({ examined: 1, cleaned: 0, retained: 1 });
    expect(touchSession).not.toHaveBeenCalled();
  });
});

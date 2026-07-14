import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitPort, GitStatusSummary, PersistencePort, SessionMeta } from "@anycode/core";
import {
  WORKTREE_EXCLUDE_PATTERN,
  WorktreeLifecycleService,
  type WorktreeFileSystem,
  type WorktreeGitPort,
} from "./worktree-lifecycle.js";

const ROOT = path.resolve("/repo");
const TARGET = path.join(ROOT, ".anycode", "worktrees", "feature");

function cleanStatus(): GitStatusSummary {
  return {
    head: { branch: "main", detached: false, sha: "abc", ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    untracked: [],
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-12345678",
    workspace: ROOT,
    model: "test",
    mode: "build",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fileSystem(overrides: Partial<WorktreeFileSystem> = {}): WorktreeFileSystem {
  return {
    exists: async () => false,
    realpath: async (target) => path.resolve(target),
    ...overrides,
  };
}

function git(overrides: Partial<WorktreeGitPort> = {}): WorktreeGitPort {
  return {
    status: async () => ({ ok: true, value: cleanStatus() }),
    worktreeIsPristine: async () => ({ ok: true, value: true }),
    worktreeAdd: async ({ path: target }) => ({ ok: true, value: { path: target } }),
    worktreeList: async () => ({ ok: true, value: [] }),
    worktreeRemove: async () => ({ ok: true, value: null }),
    ...overrides,
  };
}

function persistence(touchSession = vi.fn(async () => undefined)): {
  port: Pick<PersistencePort, "touchSession" | "listSessions" | "claimWorktree">;
  touchSession: typeof touchSession;
} {
  return {
    port: {
      touchSession,
      listSessions: async () => [],
      claimWorktree: async (id, _path, patch) => {
        await (touchSession as unknown as PersistencePort["touchSession"])(id, patch);
        return true;
      },
    },
    touchSession,
  };
}

function registered(target = TARGET, branch = "anycode-wt/feature") {
  return {
    path: target,
    head: "deadbeef",
    branch,
    detached: false,
    isMain: false,
    locked: false,
    prunable: false,
  };
}

describe("WorktreeLifecycleService", () => {
  it("blocks resume when the persisted worktree is no longer registered", async () => {
    const service = new WorktreeLifecycleService({
      session: session({ projectRoot: ROOT, workspace: TARGET, worktree: ownedWorktree() }),
      persistence: persistence().port,
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [] }) }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });
    await expect(service.validateActiveWorktree()).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a registered secondary worktree"),
    });
  });

  it("creates only inside .anycode/worktrees after ensuring the common exclude", async () => {
    const added = vi.fn<NonNullable<GitPort["worktreeAdd"]>>(async ({ path: target }) => ({
      ok: true,
      value: { path: target },
    }));
    const ensured = vi.fn(async () => ({ ok: true as const, value: null }));
    const db = persistence();
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeAdd: added }),
      ensureNamespaceIgnored: ensured,
      fs: fileSystem(),
    });

    const result = await service.enter({ name: "feature", baseRef: "main" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        transition: {
          kind: "enter_worktree",
          projectRoot: ROOT,
          toWorkspace: TARGET,
          worktree: { branch: "anycode-wt/feature", ownedByAnyCode: true },
        },
      },
    });
    expect(ensured).toHaveBeenCalledWith(ROOT, WORKTREE_EXCLUDE_PATTERN);
    expect(added).toHaveBeenCalledWith({ path: TARGET, branch: "anycode-wt/feature", baseRef: "main" });
    expect(db.touchSession).toHaveBeenCalledWith("session-12345678", {
      projectRoot: ROOT,
      workspace: TARGET,
      worktree: {
        id: "feature",
        path: TARGET,
        branch: "anycode-wt/feature",
        baseRef: "main",
        ownedByAnyCode: true,
      },
      continuationPending: true,
      continuationMode: "model",
      worktreeCleanup: null,
      worktreeTransition: {
        origin: "chrome",
        kind: "enter_worktree",
        projectRoot: ROOT,
        fromWorkspace: ROOT,
        toWorkspace: TARGET,
        worktree: {
          id: "feature",
          path: TARGET,
          branch: "anycode-wt/feature",
          baseRef: "main",
          ownedByAnyCode: true,
        },
      },
    });
  });

  it("fails closed when the repository-local namespace exclude cannot be guaranteed", async () => {
    const added = vi.fn<NonNullable<GitPort["worktreeAdd"]>>();
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: persistence().port,
      gitForWorkspace: () => git({ worktreeAdd: added }),
      ensureNamespaceIgnored: async () => ({ ok: false, reason: "common git dir is unavailable" }),
      fs: fileSystem(),
    });

    const result = await service.enter({ name: "feature" });

    expect(result).toEqual({
      ok: false,
      reason: "Cannot create a clean worktree namespace: common git dir is unavailable",
    });
    expect(added).not.toHaveBeenCalled();
  });

  it.each(["../escape", "-flag", "two..dots", "bad/name"])("rejects unsafe name %s", async (name) => {
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: persistence().port,
      gitForWorkspace: () => git(),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });
    await expect(service.enter({ name })).resolves.toMatchObject({ ok: false });
  });

  it("rejects nested enter before touching git or persistence", async () => {
    const db = persistence();
    const factory = vi.fn(() => git());
    const service = new WorktreeLifecycleService({
      session: session({ projectRoot: ROOT, workspace: TARGET, worktree: ownedWorktree() }),
      persistence: db.port,
      gitForWorkspace: factory,
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    await expect(service.enter({ name: "nested" })).resolves.toEqual({
      ok: false,
      reason: "Cannot enter a worktree from another worktree; exit to the project root first.",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(db.touchSession).not.toHaveBeenCalled();
  });

  it("enters only a registered, confined existing worktree and marks it external", async () => {
    const external = path.join(ROOT, "external-wt");
    const db = persistence();
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [registered(external, "topic")] }) }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    const result = await service.enter({ existing: external });

    expect(result).toMatchObject({
      ok: true,
      value: { transition: { toWorkspace: external, worktree: { branch: "topic", ownedByAnyCode: false } } },
    });
    expect(db.touchSession).toHaveBeenCalledWith(
      "session-12345678",
      expect.objectContaining({ worktree: expect.objectContaining({ ownedByAnyCode: false }) }),
    );
  });

  it("recovers AnyCode ownership when re-entering a retained namespaced worktree", async () => {
    const db = persistence();
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [registered()] }) }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    await expect(service.enter({ existing: TARGET })).resolves.toMatchObject({
      ok: true,
      value: { transition: { worktree: { ownedByAnyCode: true } } },
    });
  });

  it("rolls back a newly-created tree when durable metadata cannot be written", async () => {
    const removed = vi.fn<NonNullable<GitPort["worktreeRemove"]>>(async () => ({ ok: true, value: null }));
    let writes = 0;
    const db = persistence(vi.fn(async () => {
      writes++;
      if (writes === 2) throw new Error("disk full");
    }));
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeRemove: removed }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    const result = await service.enter({ name: "feature" });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("disk full") });
    expect(removed).toHaveBeenCalledWith({ path: TARGET });
  });

  it("records a durable cleanup ledger before creating a worktree", async () => {
    const db = persistence();
    const added = vi.fn<NonNullable<GitPort["worktreeAdd"]>>(async ({ path: target }) => ({
      ok: true,
      value: { path: target },
    }));
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeAdd: added }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    await service.enter({ name: "feature" }, "enter-call-1");

    expect(db.touchSession.mock.invocationCallOrder[0]).toBeLessThan(added.mock.invocationCallOrder[0]!);
    expect(db.touchSession).toHaveBeenNthCalledWith(1, "session-12345678", {
      projectRoot: ROOT,
      continuationPending: true,
      continuationMode: "none",
      worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true },
    });
    expect(db.touchSession).toHaveBeenLastCalledWith("session-12345678", expect.objectContaining({
      worktreeTransition: expect.objectContaining({ toolCallId: "enter-call-1" }),
    }));
  });

  it("retains the ledger when a failed add leaves an ambiguous registered checkout", async () => {
    const db = persistence();
    let existenceChecks = 0;
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>(async () => ({ ok: false, reason: "still busy" }));
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({
        worktreeAdd: async () => ({ ok: false, reason: "timed out" }),
        worktreeList: async () => ({ ok: true, value: [registered()] }),
        worktreeRemove: remove,
      }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem({ exists: async () => ++existenceChecks > 1 }),
    });

    await expect(service.enter({ name: "feature" }, "call-new")).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining(`Cleanup is still pending for: ${TARGET}`),
    });
    expect(remove).toHaveBeenCalledWith({ path: TARGET });
    expect(db.touchSession).toHaveBeenCalledTimes(1);
    expect(db.touchSession).toHaveBeenLastCalledWith("session-12345678", expect.objectContaining({
      worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true },
    }));
  });

  it("refuses an existing worktree claimed by another active session", async () => {
    const external = path.join(ROOT, "external-wt");
    const db = persistence();
    db.port.listSessions = async () => [session({
      id: "other-session",
      workspace: external,
      projectRoot: ROOT,
      worktree: { ...ownedWorktree(), path: external },
    })];
    const service = new WorktreeLifecycleService({
      session: session(),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [registered(external, "topic")] }) }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem(),
    });

    await expect(service.enter({ existing: external })).resolves.toEqual({
      ok: false,
      reason: "Worktree is already owned by active session other-session.",
    });
  });

  it("prepares dirty auto exit as retained and relocates metadata before rehost", async () => {
    const db = persistence();
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>();
    const service = exitService(db.port, (workspace) => workspace === TARGET
      ? git({ worktreeIsPristine: async () => ({ ok: true, value: false }) })
      : git({ worktreeList: async () => ({ ok: true, value: [registered()] }), worktreeRemove: remove }));

    const result = await service.exit({ cleanup: "auto" });

    expect(result).toMatchObject({
      ok: true,
      value: { cleanup: { kind: "none", reason: expect.stringContaining("dirty") } },
    });
    expect(remove).not.toHaveBeenCalled();
    expect(db.touchSession).toHaveBeenCalledWith("session-12345678", {
      projectRoot: ROOT,
      workspace: ROOT,
      worktree: null,
      continuationPending: true,
      continuationMode: "model",
      worktreeCleanup: null,
      worktreeTransition: {
        origin: "chrome",
        kind: "exit_worktree",
        projectRoot: ROOT,
        fromWorkspace: TARGET,
        toWorkspace: ROOT,
        worktree: ownedWorktree(),
        cleanup: "auto",
      },
    });
  });

  it("defers clean auto removal until post-rehost, then rechecks and clears continuation", async () => {
    const db = persistence();
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>(async () => ({ ok: true, value: null }));
    const factory = (workspace: string) => workspace === TARGET
      ? git()
      : git({ worktreeList: async () => ({ ok: true, value: [registered()] }), worktreeRemove: remove });
    const service = exitService(db.port, factory);
    const prepared = await service.exit({ cleanup: "auto" });
    expect(prepared).toMatchObject({ ok: true, value: { cleanup: { kind: "remove_clean" } } });
    expect(remove).not.toHaveBeenCalled();
    expect(db.touchSession).toHaveBeenCalledWith("session-12345678", expect.objectContaining({
      continuationPending: true,
      worktreeCleanup: { path: TARGET, mode: "auto", ownedByAnyCode: true },
    }));
    if (!prepared.ok) throw new Error(prepared.reason);

    const finalized = await service.finalizePostRehost({ projectRoot: ROOT, cleanup: prepared.value.cleanup });

    expect(finalized).toEqual({ ok: true, value: { removed: true, message: `Removed worktree: ${TARGET}` } });
    expect(remove).toHaveBeenCalledWith({ path: TARGET });
    expect(db.touchSession).toHaveBeenLastCalledWith("session-12345678", {
      worktreeCleanup: null,
      worktreeTransition: null,
    });
  });

  it("uses force only for explicit remove and only after rehost", async () => {
    const db = persistence();
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>(async () => ({ ok: true, value: null }));
    const service = exitService(db.port, (workspace) => workspace === ROOT
      ? git({ worktreeList: async () => ({ ok: true, value: [registered()] }), worktreeRemove: remove })
      : git());
    const prepared = await service.exit({ cleanup: "remove" });
    expect(remove).not.toHaveBeenCalled();
    if (!prepared.ok) throw new Error(prepared.reason);

    await service.finalizePostRehost({ projectRoot: ROOT, cleanup: prepared.value.cleanup });

    expect(remove).toHaveBeenCalledWith({ path: TARGET, force: true });
  });

  it("clears a durable cleanup ledger when a prior boot already removed the target", async () => {
    const db = persistence();
    const service = new WorktreeLifecycleService({
      session: session({ projectRoot: ROOT, workspace: ROOT, continuationPending: true }),
      persistence: db.port,
      gitForWorkspace: () => git({ worktreeList: async () => ({ ok: true, value: [] }) }),
      ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
      fs: fileSystem({
        realpath: async (target) => {
          if (path.resolve(target) === TARGET) throw new Error("missing");
          return path.resolve(target);
        },
      }),
    });
    await expect(service.finalizePostRehost({
      projectRoot: ROOT,
      cleanup: { kind: "remove_clean", target: TARGET, ownedByAnyCode: true },
    })).resolves.toEqual({
      ok: true,
      value: { removed: true, message: `Worktree already removed: ${TARGET}` },
    });
    expect(db.touchSession).toHaveBeenLastCalledWith("session-12345678", {
      worktreeCleanup: null,
      worktreeTransition: null,
    });
  });

  it("retains a clean-auto candidate that became dirty after relocation", async () => {
    const db = persistence();
    let statusChecks = 0;
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>();
    const service = exitService(db.port, (workspace) => {
      if (workspace === ROOT) return git({ worktreeList: async () => ({ ok: true, value: [registered()] }), worktreeRemove: remove });
      statusChecks++;
      const value = statusChecks === 1;
      return git({ worktreeIsPristine: async () => ({ ok: true, value }) });
    });
    const prepared = await service.exit({ cleanup: "auto" });
    if (!prepared.ok) throw new Error(prepared.reason);

    const finalized = await service.finalizePostRehost({ projectRoot: ROOT, cleanup: prepared.value.cleanup });

    expect(finalized).toMatchObject({ ok: true, value: { removed: false, message: expect.stringContaining("became dirty") } });
    expect(remove).not.toHaveBeenCalled();
    expect(db.touchSession).toHaveBeenLastCalledWith("session-12345678", {
      worktreeCleanup: null,
      worktreeTransition: null,
    });
  });

  it("never removes a cleanup target claimed by another session", async () => {
    const db = persistence();
    const remove = vi.fn<NonNullable<GitPort["worktreeRemove"]>>();
    const service = exitService(db.port, (workspace) => workspace === ROOT
      ? git({ worktreeList: async () => ({ ok: true, value: [registered()] }), worktreeRemove: remove })
      : git());
    const prepared = await service.exit({ cleanup: "auto" }, "exit-call");
    if (!prepared.ok) throw new Error(prepared.reason);
    db.port.listSessions = async () => [session({
      id: "other-session",
      projectRoot: ROOT,
      workspace: TARGET,
      worktree: ownedWorktree(),
    })];

    await expect(service.finalizePostRehost({ projectRoot: ROOT, cleanup: prepared.value.cleanup })).resolves.toEqual({
      ok: true,
      value: { removed: false, message: `Cleanup retained a worktree claimed by another session: ${TARGET}` },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses cleanup when the target resolves outside the project root", async () => {
    const db = persistence();
    const service = exitService(db.port, () => git({ worktreeList: async () => ({ ok: true, value: [registered()] }) }), {
      realpath: async (target) => target === TARGET ? "/outside/feature" : path.resolve(target),
    });

    await expect(service.exit({ cleanup: "auto" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("escapes") });
  });
});

function ownedWorktree() {
  return {
    id: "feature",
    path: TARGET,
    branch: "anycode-wt/feature",
    baseRef: "main",
    ownedByAnyCode: true,
  };
}

function exitService(
  port: Pick<PersistencePort, "touchSession" | "listSessions" | "claimWorktree">,
  gitForWorkspace: (workspace: string) => WorktreeGitPort,
  fsOverrides: Partial<WorktreeFileSystem> = {},
) {
  return new WorktreeLifecycleService({
    session: session({ projectRoot: ROOT, workspace: TARGET, worktree: ownedWorktree() }),
    persistence: port,
    gitForWorkspace,
    ensureNamespaceIgnored: async () => ({ ok: true, value: null }),
    fs: fileSystem(fsOverrides),
  });
}

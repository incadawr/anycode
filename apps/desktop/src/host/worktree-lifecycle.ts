import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  GitPort,
  PersistencePort,
  SessionMeta,
  WorktreeCleanup,
  WorktreeIdentity,
  WorkspaceTransition,
} from "@anycode/core";

const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORKTREE_NAMESPACE = path.join(".anycode", "worktrees");
export const WORKTREE_EXCLUDE_PATTERN = "/.anycode/worktrees/";
const BRANCH_PREFIX = "anycode-wt/";

export interface WorktreeFileSystem {
  exists(target: string): Promise<boolean>;
  realpath(target: string): Promise<string>;
}

export const nodeWorktreeFileSystem: WorktreeFileSystem = {
  async exists(target) {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  },
  realpath,
};

export type WorktreeGitPort = Pick<GitPort, "status" | "worktreeAdd" | "worktreeList" | "worktreeRemove" | "worktreeIsPristine">;
type WorktreeListResult = Awaited<ReturnType<NonNullable<GitPort["worktreeList"]>>>;
type GitWorktreeInfo = Extract<WorktreeListResult, { ok: true }>["value"][number];

export type WorktreeCleanupIntent =
  | { kind: "none"; reason: string }
  | { kind: "remove_clean"; target: string; ownedByAnyCode: true }
  | { kind: "remove_force"; target: string; ownedByAnyCode: boolean };

export interface PreparedWorktreeTransition {
  transition: WorkspaceTransition;
  cleanup: WorktreeCleanupIntent;
}

export type WorktreeLifecycleResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface WorktreeLifecycleOptions {
  session: SessionMeta;
  persistence: Pick<PersistencePort, "touchSession" | "listSessions" | "claimWorktree">;
  gitForWorkspace(workspace: string): WorktreeGitPort;
  /** Adds/verifies the repository-local common-git exclude entry. */
  ensureNamespaceIgnored(projectRoot: string, pattern: string): Promise<WorktreeLifecycleResult<null>>;
  fs?: WorktreeFileSystem;
}

/**
 * Prepares durable worktree transitions without changing the host cwd. The
 * caller must stop the current loop after a successful result and rehost the
 * same session at `transition.toWorkspace`.
 */
export class WorktreeLifecycleService {
  private readonly session: SessionMeta;
  private readonly persistence: Pick<PersistencePort, "touchSession" | "listSessions" | "claimWorktree">;
  private readonly gitForWorkspace: (workspace: string) => WorktreeGitPort;
  private readonly ensureNamespaceIgnored: WorktreeLifecycleOptions["ensureNamespaceIgnored"];
  private readonly fs: WorktreeFileSystem;

  constructor(options: WorktreeLifecycleOptions) {
    this.session = options.session;
    this.persistence = options.persistence;
    this.gitForWorkspace = options.gitForWorkspace;
    this.ensureNamespaceIgnored = options.ensureNamespaceIgnored;
    this.fs = options.fs ?? nodeWorktreeFileSystem;
  }

  /** Resume gate: validates persisted worktree identity before any model turn. */
  async validateActiveWorktree(): Promise<WorktreeLifecycleResult<null>> {
    const worktree = this.session.worktree;
    if (worktree === undefined) return ok(null);
    const projectRoot = this.session.projectRoot;
    if (projectRoot === undefined || this.session.workspace !== worktree.path) {
      return fail("Persisted worktree metadata does not match the session workspace.");
    }
    const roots = await this.resolveProjectRoot(projectRoot);
    if (!roots.ok) return roots;
    const target = await this.safeRealpath(worktree.path);
    if (!target.ok || !isWithin(roots.value.real, target.value)) {
      return fail(`Persisted worktree is missing or escapes the project root: ${worktree.path}`);
    }
    const registered = await this.findRegistered(roots.value.logical, target.value);
    if (!registered.ok) return registered;
    if (registered.value.branch !== worktree.branch) {
      return fail(`Persisted worktree branch changed (expected ${worktree.branch}).`);
    }
    return ok(null);
  }

  async enter(request: {
    name?: string;
    baseRef?: string;
    existing?: string;
  }, toolCallId?: string): Promise<WorktreeLifecycleResult<PreparedWorktreeTransition>> {
    const projectRoot = this.session.projectRoot ?? this.session.workspace;
    if (this.session.worktree !== undefined || this.session.workspace !== projectRoot) {
      return fail("Cannot enter a worktree from another worktree; exit to the project root first.");
    }
    if ((request.existing !== undefined) === (request.name !== undefined || request.baseRef !== undefined)) {
      if (request.existing !== undefined) {
        return fail("existing cannot be combined with name or baseRef.");
      }
    }

    const roots = await this.resolveProjectRoot(projectRoot);
    if (!roots.ok) return roots;
    if (request.existing !== undefined) {
      return this.enterExisting(request.existing, roots.value, toolCallId);
    }

    const name = request.name ?? defaultWorktreeName(this.session.id);
    const nameError = validateWorktreeName(name);
    if (nameError) return fail(nameError);
    const baseRef = request.baseRef ?? "HEAD";
    const refError = validateBaseRef(baseRef);
    if (refError) return fail(refError);

    const ignored = await this.ensureNamespaceIgnored(roots.value.logical, WORKTREE_EXCLUDE_PATTERN);
    if (!ignored.ok) {
      return fail(`Cannot create a clean worktree namespace: ${ignored.reason}`);
    }
    const target = path.join(roots.value.logical, WORKTREE_NAMESPACE, name);
    if (!isWithin(roots.value.logical, target)) {
      return fail("Generated worktree path escaped the project root.");
    }
    if (await this.fs.exists(target)) {
      return fail(`Worktree destination already exists: ${target}`);
    }

    const git = this.gitForWorkspace(roots.value.logical);
    if (!git.worktreeAdd || !git.worktreeRemove) {
      return fail("This Git adapter does not support safe worktree creation and rollback.");
    }
    const branch = `${BRANCH_PREFIX}${name}`;
    const intent = await this.persistCreationIntent(roots.value.logical, target);
    if (!intent.ok) return intent;
    const created = await git.worktreeAdd({ path: target, branch, baseRef });
    if (!created.ok) {
      const reconciled = await this.reconcileFailedCreation(git, target);
      return fail(
        `Could not create worktree: ${created.reason}${reconciled ? "" : ` Cleanup is still pending for: ${target}`}`,
      );
    }

    const createdReal = await this.safeRealpath(target);
    if (!createdReal.ok || !isWithin(roots.value.real, createdReal.value)) {
      const rollback = await git.worktreeRemove({ path: target });
      if (rollback.ok) await this.clearCreationIntent();
      const detail = rollback.ok ? "The unsafe worktree was rolled back." : `Rollback failed: ${rollback.reason}`;
      return fail(`Created worktree failed confinement validation. ${detail}`);
    }

    const worktree: WorktreeIdentity = {
      id: name,
      path: createdReal.value,
      branch,
      baseRef,
      ownedByAnyCode: true,
    };
    const transition: WorkspaceTransition = {
      kind: "enter_worktree",
      projectRoot: roots.value.logical,
      fromWorkspace: this.session.workspace,
      toWorkspace: createdReal.value,
      worktree,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
    const persisted = await this.persistEnter(roots.value.logical, worktree, transition);
    if (!persisted.ok) {
      const rollback = await git.worktreeRemove({ path: createdReal.value });
      if (rollback.ok) await this.clearCreationIntent();
      const detail = rollback.ok ? "The new worktree was rolled back." : `Rollback failed; retained path: ${createdReal.value}. ${rollback.reason}`;
      return fail(`${persisted.reason} ${detail}`);
    }

    return ok({
      transition,
      cleanup: { kind: "none", reason: "Entering a worktree does not remove a workspace." },
    });
  }

  async exit(request: {
    cleanup: WorktreeCleanup;
    continueAfterRehost?: boolean;
  }, toolCallId?: string): Promise<WorktreeLifecycleResult<PreparedWorktreeTransition>> {
    const worktree = this.session.worktree;
    const projectRoot = this.session.projectRoot;
    if (!worktree || !projectRoot) return fail("This session is not in a worktree.");
    if (this.session.workspace !== worktree.path) {
      return fail("Session worktree metadata does not match the current workspace; refusing relocation.");
    }

    const roots = await this.resolveProjectRoot(projectRoot);
    if (!roots.ok) return roots;
    const targetReal = await this.safeRealpath(worktree.path);
    if (!targetReal.ok || !isWithin(roots.value.real, targetReal.value)) {
      return fail(`Active worktree is missing or escapes the project root: ${worktree.path}`);
    }
    const registered = await this.findRegistered(roots.value.logical, targetReal.value);
    if (!registered.ok) return registered;

    const pristine = await this.pristineAt(targetReal.value);
    if (!pristine.ok) return pristine;
    const dirty = !pristine.value;
    let cleanup: WorktreeCleanupIntent;
    if (request.cleanup === "remove") {
      cleanup = { kind: "remove_force", target: targetReal.value, ownedByAnyCode: worktree.ownedByAnyCode };
    } else if (request.cleanup === "auto" && worktree.ownedByAnyCode && !dirty) {
      cleanup = { kind: "remove_clean", target: targetReal.value, ownedByAnyCode: true };
    } else {
      const reason = request.cleanup === "keep"
        ? "The worktree was explicitly retained."
        : !worktree.ownedByAnyCode
          ? "External worktrees are retained by automatic cleanup."
          : `The owned worktree is dirty and was retained: ${targetReal.value}`;
      cleanup = { kind: "none", reason };
    }

    const transition: WorkspaceTransition = {
      kind: "exit_worktree",
      projectRoot,
      fromWorkspace: targetReal.value,
      toWorkspace: projectRoot,
      worktree,
      cleanup: request.cleanup,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
    const persisted = await this.persistExit(projectRoot, cleanup, request.continueAfterRehost !== false, transition);
    if (!persisted.ok) return persisted;
    return ok({
      transition,
      cleanup,
    });
  }

  /**
   * Completes cleanup only after the caller has successfully rehosted at the
   * project root. Automatic cleanup re-checks both registration and dirtiness;
   * explicit remove is the only path that invokes force removal.
   */
  async finalizePostRehost(input: {
    projectRoot: string;
    cleanup: WorktreeCleanupIntent;
  }): Promise<WorktreeLifecycleResult<{ removed: boolean; message: string }>> {
    const expectedRoot = this.session.projectRoot ?? this.session.workspace;
    const expected = await this.resolveProjectRoot(expectedRoot);
    if (!expected.ok) return expected;
    const actual = await this.resolveProjectRoot(input.projectRoot);
    if (!actual.ok || actual.value.real !== expected.value.real) {
      return fail("Post-rehost cleanup was invoked outside the session project root.");
    }

    const intent = input.cleanup;
    if (intent.kind === "none") {
      return this.finishContinuation(false, intent.reason);
    }
    const target = await this.safeRealpath(intent.target);
    if (!target.ok) {
      // Idempotent crash recovery: removal may have completed before the
      // continuation ledger was cleared. If git no longer registers the path,
      // acknowledge it as already removed rather than wedging every respawn.
      const git = this.gitForWorkspace(actual.value.logical);
      const listed = await git.worktreeList?.();
      const stillRegistered = listed?.ok === true && listed.value.some((item) => path.resolve(item.path) === path.resolve(intent.target));
      if (!stillRegistered) return this.finishContinuation(true, `Worktree already removed: ${intent.target}`);
      return fail(`Cleanup target is missing but still registered: ${intent.target}`);
    }
    if (!isWithin(actual.value.real, target.value)) {
      return fail(`Cleanup target is missing or escapes the project root: ${intent.target}`);
    }
    const registered = await this.findRegistered(actual.value.logical, target.value);
    if (!registered.ok) return registered;

    const git = this.gitForWorkspace(actual.value.logical);
    if (!git.worktreeRemove) return fail("This Git adapter does not support worktree removal.");
    const exclusive = await this.ensureCleanupExclusive(target.value);
    if (!exclusive.ok) return exclusive;
    if (!exclusive.value) {
      return this.finishContinuation(false, `Cleanup retained a worktree claimed by another session: ${target.value}`);
    }
    if (intent.kind === "remove_clean") {
      const pristine = await this.pristineAt(target.value);
      if (!pristine.ok) return pristine;
      if (!pristine.value) {
        return this.finishContinuation(false, `Automatic cleanup retained a worktree that became dirty: ${target.value}`);
      }
    }
    const removed = await git.worktreeRemove({
      path: target.value,
      ...(intent.kind === "remove_force" ? { force: true } : {}),
    });
    if (!removed.ok) {
      return this.finishContinuation(
        false,
        `Worktree cleanup failed and was retained: ${target.value}. ${removed.reason}`,
      );
    }
    return this.finishContinuation(true, `Removed worktree: ${target.value}`);
  }

  private async enterExisting(
    existing: string,
    roots: { logical: string; real: string },
    toolCallId?: string,
  ): Promise<WorktreeLifecycleResult<PreparedWorktreeTransition>> {
    if (!path.isAbsolute(existing)) return fail("existing must be an absolute worktree path.");
    const existingReal = await this.safeRealpath(existing);
    if (!existingReal.ok || !isWithin(roots.real, existingReal.value)) {
      return fail(`Existing worktree is missing or escapes the project root: ${existing}`);
    }
    const registered = await this.findRegistered(roots.logical, existingReal.value);
    if (!registered.ok) return registered;
    const ownership = await this.ensureNotClaimed(existingReal.value);
    if (!ownership.ok) return ownership;
    if (!registered.value.branch) return fail("Detached or bare worktrees cannot be entered.");
    const id = path.basename(existingReal.value);
    const ownedNamespace = path.join(roots.real, WORKTREE_NAMESPACE);
    const ownedByAnyCode = isWithin(ownedNamespace, existingReal.value) && registered.value.branch.startsWith(BRANCH_PREFIX);
    const worktree: WorktreeIdentity = {
      id,
      path: existingReal.value,
      branch: registered.value.branch,
      baseRef: registered.value.head ?? registered.value.branch,
      ownedByAnyCode,
    };
    const transition: WorkspaceTransition = {
      kind: "enter_worktree",
      projectRoot: roots.logical,
      fromWorkspace: this.session.workspace,
      toWorkspace: existingReal.value,
      worktree,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
    const persisted = await this.persistEnter(roots.logical, worktree, transition);
    if (!persisted.ok) return persisted;
    return ok({
      transition,
      cleanup: { kind: "none", reason: "Entering a worktree does not remove a workspace." },
    });
  }

  private async resolveProjectRoot(root: string): Promise<WorktreeLifecycleResult<{ logical: string; real: string }>> {
    if (!path.isAbsolute(root)) return fail(`Project root must be absolute: ${root}`);
    const resolved = path.resolve(root);
    const rootReal = await this.safeRealpath(resolved);
    if (!rootReal.ok) return fail(`Project root is unavailable: ${resolved}`);
    return ok({ logical: resolved, real: rootReal.value });
  }

  private async safeRealpath(target: string): Promise<WorktreeLifecycleResult<string>> {
    try {
      return ok(await this.fs.realpath(target));
    } catch (error) {
      return fail(errorMessage(error));
    }
  }

  private async findRegistered(root: string, targetReal: string): Promise<WorktreeLifecycleResult<GitWorktreeInfo>> {
    const git = this.gitForWorkspace(root);
    if (!git.worktreeList) return fail("This Git adapter cannot validate registered worktrees.");
    const listed = await git.worktreeList();
    if (!listed.ok) return fail(`Could not validate registered worktrees: ${listed.reason}`);
    for (const item of listed.value) {
      const itemReal = await this.safeRealpath(item.path);
      if (itemReal.ok && itemReal.value === targetReal && !item.isMain) return ok(item);
    }
    return fail(`Path is not a registered secondary worktree: ${targetReal}`);
  }

  private async ensureNotClaimed(targetReal: string): Promise<WorktreeLifecycleResult<null>> {
    try {
      const sessions = await this.persistence.listSessions();
      for (const candidate of sessions) {
        if (candidate.id === this.session.id) continue;
        for (const candidatePath of [candidate.worktree?.path, candidate.worktreeCleanup?.path]) {
          if (candidatePath === undefined) continue;
          const claimed = await this.safeRealpath(candidatePath);
          if ((claimed.ok && claimed.value === targetReal) || path.resolve(candidatePath) === path.resolve(targetReal)) {
            return fail(`Worktree is already owned by active session ${candidate.id}.`);
          }
        }
      }
      return ok(null);
    } catch (error) {
      return fail(`Could not validate worktree ownership: ${errorMessage(error)}`);
    }
  }

  private async ensureCleanupExclusive(targetReal: string): Promise<WorktreeLifecycleResult<boolean>> {
    try {
      const sessions = await this.persistence.listSessions();
      for (const candidate of sessions) {
        if (candidate.id === this.session.id) continue;
        for (const candidatePath of [candidate.worktree?.path, candidate.worktreeCleanup?.path]) {
          if (candidatePath === undefined) continue;
          const claimed = await this.safeRealpath(candidatePath);
          if ((claimed.ok && claimed.value === targetReal) || path.resolve(candidatePath) === path.resolve(targetReal)) {
            return ok(false);
          }
        }
      }
      return ok(true);
    } catch (error) {
      return fail(`Could not revalidate cleanup ownership: ${errorMessage(error)}`);
    }
  }

  private async reconcileFailedCreation(git: WorktreeGitPort, target: string): Promise<boolean> {
    let registered = false;
    const listed = await git.worktreeList?.();
    if (listed?.ok) {
      registered = listed.value.some((item) => path.resolve(item.path) === path.resolve(target));
    }
    const exists = await this.fs.exists(target);
    if (!registered && !exists && listed?.ok) {
      await this.clearCreationIntent();
      return true;
    }
    const removed = await git.worktreeRemove?.({ path: target });
    if (removed?.ok) {
      await this.clearCreationIntent();
      return true;
    }
    // Ambiguous state: never forget the pre-add ledger. Boot recovery or the
    // user can reconcile the registered/path resource without an orphan.
    return false;
  }

  private async pristineAt(workspace: string): Promise<WorktreeLifecycleResult<boolean>> {
    const git = this.gitForWorkspace(workspace);
    if (!git.worktreeIsPristine) {
      return fail("Git adapter cannot prove the worktree has no ignored content; retaining it.");
    }
    const pristine = await git.worktreeIsPristine();
    return pristine.ok ? ok(pristine.value) : fail(`Could not verify all worktree content: ${pristine.reason}`);
  }

  async confirmTransition(): Promise<WorktreeLifecycleResult<null>> {
    try {
      await this.persistence.touchSession(this.session.id, { worktreeTransition: null });
      return ok(null);
    } catch (error) {
      return fail(`Could not confirm the durable worktree transition: ${errorMessage(error)}`);
    }
  }

  private async persistEnter(
    projectRoot: string,
    worktree: WorktreeIdentity,
    transition: WorkspaceTransition,
  ): Promise<WorktreeLifecycleResult<null>> {
    try {
      const patch = {
        projectRoot,
        workspace: worktree.path,
        worktree,
        continuationPending: true,
        continuationMode: "model",
        worktreeCleanup: null,
        worktreeTransition: { ...transition, origin: transition.toolCallId === undefined ? "chrome" : "tool" },
      } as const;
      if (this.persistence.claimWorktree === undefined) {
        return fail("Persistence cannot atomically claim a worktree.");
      }
      if (!(await this.persistence.claimWorktree(this.session.id, worktree.path, patch))) {
        return fail(`Worktree is already claimed by another session: ${worktree.path}`);
      }
      return ok(null);
    } catch (error) {
      return fail(`Could not persist the worktree transition: ${errorMessage(error)}`);
    }
  }

  /**
   * Durable resource inventory written before `git worktree add`. A crash at
   * any point during creation therefore leaves a cleanup candidate that the
   * next source-host boot can consume instead of an undiscoverable checkout.
   */
  private async persistCreationIntent(projectRoot: string, target: string): Promise<WorktreeLifecycleResult<null>> {
    try {
      if (this.persistence.claimWorktree === undefined) {
        return fail("Persistence cannot atomically reserve a worktree resource.");
      }
      const claimed = await this.persistence.claimWorktree(this.session.id, target, {
        projectRoot,
        continuationPending: true,
        continuationMode: "none",
        worktreeCleanup: { path: target, mode: "auto", ownedByAnyCode: true },
      });
      if (!claimed) return fail(`Worktree resource is already claimed by another session: ${target}`);
      return ok(null);
    } catch (error) {
      return fail(`Could not persist the worktree creation ledger: ${errorMessage(error)}`);
    }
  }

  private async clearCreationIntent(): Promise<void> {
    try {
      await this.persistence.touchSession(this.session.id, {
        continuationPending: false,
        continuationMode: null,
        worktreeCleanup: null,
      });
    } catch {
      // Retaining the ledger is safer than forgetting a possibly-created tree;
      // recovery is idempotent and will clear it on the next host boot.
    }
  }

  private async persistExit(
    projectRoot: string,
    cleanup: WorktreeCleanupIntent,
    continueAfterRehost: boolean,
    transition: WorkspaceTransition,
  ): Promise<WorktreeLifecycleResult<null>> {
    try {
      await this.persistence.touchSession(this.session.id, {
        projectRoot,
        workspace: projectRoot,
        worktree: null,
        continuationPending: true,
        continuationMode: continueAfterRehost ? "model" : "none",
        worktreeCleanup:
          cleanup.kind === "remove_clean"
            ? { path: cleanup.target, mode: "auto", ownedByAnyCode: true }
            : cleanup.kind === "remove_force"
              ? { path: cleanup.target, mode: "remove", ownedByAnyCode: cleanup.ownedByAnyCode }
              : null,
        worktreeTransition: { ...transition, origin: transition.toolCallId === undefined ? "chrome" : "tool" },
      });
      return ok(null);
    } catch (error) {
      return fail(`Could not persist the exit transition: ${errorMessage(error)}`);
    }
  }

  private async finishContinuation(
    removed: boolean,
    message: string,
  ): Promise<WorktreeLifecycleResult<{ removed: boolean; message: string }>> {
    try {
      await this.persistence.touchSession(this.session.id, {
        worktreeCleanup: null,
        worktreeTransition: null,
      });
      return ok({ removed, message });
    } catch (error) {
      return fail(`Cleanup completed but the continuation marker could not be cleared: ${errorMessage(error)}`);
    }
  }
}

function validateWorktreeName(name: string): string | null {
  if (!WORKTREE_NAME_RE.test(name) || name.endsWith(".") || name.includes("..")) {
    return "Worktree name must be 1-64 safe ASCII characters and cannot contain '..'.";
  }
  return null;
}

function validateBaseRef(ref: string): string | null {
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    /[\0-\x20~^:?*\\\[]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{")
  ) {
    return "baseRef is not a safe Git revision name.";
  }
  return null;
}

function defaultWorktreeName(sessionId: string): string {
  const stem = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `session-${stem || "new"}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok<T>(value: T): WorktreeLifecycleResult<T> {
  return { ok: true, value };
}

function fail(reason: string): WorktreeLifecycleResult<never> {
  return { ok: false, reason };
}

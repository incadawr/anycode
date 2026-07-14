import path from "node:path";
import type { GitPort, PersistencePort, SessionMeta } from "@anycode/core";

const OWNED_NAMESPACE = path.join(".anycode", "worktrees");
const OWNED_BRANCH_PREFIX = "anycode-wt/";

type JanitorGitPort = Pick<
  GitPort,
  | "listBranches"
  | "worktreeList"
  | "worktreeRemove"
  | "worktreePrune"
  | "worktreeIsPristine"
  | "deleteBranch"
>;

export interface WorktreeJanitorOptions {
  persistence: Pick<PersistencePort, "listSessions" | "touchSession">;
  gitForWorkspace(workspace: string): JanitorGitPort;
  exists(target: string): Promise<boolean>;
  log?: (message: string) => void;
}

export interface WorktreeJanitorResult {
  examined: number;
  cleaned: number;
  retained: number;
}

/**
 * Main-process singleton cleanup pass. It consumes only exact durable ledgers;
 * namespace/prefix discovery is never authority to remove a user resource.
 */
export async function runWorktreeJanitor(options: WorktreeJanitorOptions): Promise<WorktreeJanitorResult> {
  const sessions = await options.persistence.listSessions();
  const claimedPaths = buildClaims(sessions);
  const result: WorktreeJanitorResult = { examined: 0, cleaned: 0, retained: 0 };

  for (const session of sessions) {
    const cleanup = session.worktreeCleanup;
    if (cleanup === undefined) continue;
    result.examined += 1;

    const projectRoot = session.projectRoot ?? session.workspace;
    const target = path.resolve(cleanup.path);
    const root = path.resolve(projectRoot);
    const namespace = path.resolve(root, OWNED_NAMESPACE);
    const otherClaims = claimedPaths.get(target)?.filter((id) => id !== session.id) ?? [];

    // Explicit force cleanup remains attached to the session that obtained the
    // destructive consent. The global janitor handles only clean AnyCode-owned
    // resources and never races an unresolved terminal transition.
    if (
      cleanup.mode !== "auto" ||
      !cleanup.ownedByAnyCode ||
      session.worktree !== undefined ||
      session.worktreeTransition !== undefined ||
      path.resolve(session.workspace) !== root ||
      !isWithin(namespace, target) ||
      otherClaims.length > 0
    ) {
      retain(result, options, session, "ledger is active, external, forceful, or ambiguously claimed");
      continue;
    }

    let git: JanitorGitPort;
    try {
      git = options.gitForWorkspace(root);
    } catch {
      retain(result, options, session, "Git adapter could not be constructed");
      continue;
    }
    if (!git.worktreeList || !git.worktreeRemove || !git.worktreeIsPristine) {
      retain(result, options, session, "Git adapter cannot prove safe cleanup");
      continue;
    }

    // List before prune: a prunable record may be the only durable source for
    // the exact branch associated with an older path-only cleanup ledger.
    const listed = await git.worktreeList();
    if (!listed.ok) {
      retain(result, options, session, `worktree list failed: ${listed.reason}`);
      continue;
    }
    let registered = listed.value.find((item) => path.resolve(item.path) === target);
    const branch = cleanup.branch ?? registered?.branch ?? undefined;

    if (registered !== undefined) {
      if (registered.isMain || registered.locked) {
        retain(result, options, session, "registered worktree is main or locked");
        continue;
      }
      if (branch === undefined || !branch.startsWith(OWNED_BRANCH_PREFIX)) {
        retain(result, options, session, "registered worktree lacks an exact AnyCode-owned branch");
        continue;
      }
      if (branch !== undefined && registered.branch !== branch) {
        retain(result, options, session, "registered worktree branch disagrees with the durable ledger");
        continue;
      }
      if (registered.prunable) {
        const pruned = await git.worktreePrune?.();
        const afterPrune = await git.worktreeList();
        if (!pruned?.ok || !afterPrune.ok) {
          retain(result, options, session, "prunable worktree could not be reconciled safely");
          continue;
        }
        registered = afterPrune.value.find((item) => path.resolve(item.path) === target);
        if (registered === undefined) {
          if (await options.exists(target)) {
            retain(result, options, session, "pruned registration still has an existing directory");
            continue;
          }
        }
      }
    }

    if (registered !== undefined) {
      let targetGit: JanitorGitPort;
      try {
        targetGit = options.gitForWorkspace(target);
      } catch {
        retain(result, options, session, "cleanup target Git adapter could not be constructed");
        continue;
      }
      const pristine = await targetGit.worktreeIsPristine?.();
      if (!pristine?.ok || !pristine.value) {
        retain(result, options, session, "worktree is dirty or its contents cannot be proven pristine");
        continue;
      }
      const removed = await git.worktreeRemove({ path: target });
      if (!removed.ok) {
        retain(result, options, session, `worktree remove failed: ${removed.reason}`);
        continue;
      }
    } else if (await options.exists(target)) {
      // An unregistered directory may contain user data left by an interrupted
      // add. Never infer that an existing path is disposable.
      retain(result, options, session, "cleanup path exists but is not registered");
      continue;
    }

    await git.worktreePrune?.();
    if (branch === undefined) {
      retain(result, options, session, "legacy cleanup ledger has no exact branch authority");
      continue;
    }
    if (!branch.startsWith(OWNED_BRANCH_PREFIX) || !git.deleteBranch) {
      retain(result, options, session, "owned branch is unsafe or cannot be deleted safely");
      continue;
    }
    const branches = await git.listBranches();
    if (!branches.ok) {
      retain(result, options, session, `branch list failed: ${branches.reason}`);
      continue;
    }
    if (branches.value.some((candidate) => candidate.name === branch)) {
      const deleted = await git.deleteBranch(branch);
      if (!deleted.ok) {
        retain(result, options, session, `merged-only branch delete refused: ${deleted.reason}`);
        continue;
      }
    }

    await options.persistence.touchSession(session.id, {
      continuationPending: false,
      continuationMode: null,
      worktreeCleanup: null,
    });
    result.cleaned += 1;
    options.log?.(`[main] worktree janitor cleaned session ${session.id}: ${target}`);
  }

  return result;
}

function buildClaims(sessions: readonly SessionMeta[]): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const session of sessions) {
    const paths = [
      session.worktree?.path,
      session.worktreeCleanup?.path,
      session.worktreeTransition?.worktree.path,
    ];
    for (const candidate of paths) {
      if (candidate === undefined) continue;
      const key = path.resolve(candidate);
      const owners = claims.get(key) ?? [];
      if (!owners.includes(session.id)) owners.push(session.id);
      claims.set(key, owners);
    }
  }
  return claims;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function retain(
  result: WorktreeJanitorResult,
  options: WorktreeJanitorOptions,
  session: SessionMeta,
  reason: string,
): void {
  result.retained += 1;
  options.log?.(`[main] worktree janitor retained session ${session.id}: ${reason}`);
}

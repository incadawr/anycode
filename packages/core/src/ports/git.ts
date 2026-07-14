/**
 * GitPort: read/safe-write access to the user's real repository (the workspace
 * `.git`). Every operation is machine-format only (`--porcelain=v2 -z`,
 * `for-each-ref --format`, `log --pretty=format`) and never throws across the
 * port boundary — all outcomes surface as `GitOpResult`. This is the frozen
 * wire-contract consumed by later git-cluster slices; the type shapes must not
 * change form.
 */

/** HEAD of the user repo. `sha` is null for an unborn HEAD (fresh init, no commits). */
export interface GitHead {
  /** null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** null for unborn HEAD. */
  sha: string | null;
  /** Commits ahead of upstream; null when there is no upstream. */
  ahead: number | null;
  /** Commits behind upstream; null when there is no upstream. */
  behind: number | null;
}

export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged";

export interface GitFileChange {
  path: string;
  kind: GitChangeKind;
  /** Present only for renamed/copied changes: the original path. */
  renamedFrom?: string;
}

export interface GitStatusSummary {
  head: GitHead;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  /** Untracked paths. A consumer's dirty count is staged+unstaged+untracked. */
  untracked: string[];
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  sha: string;
}

export interface GitCommitInfo {
  sha: string;
  authorName: string;
  /** Author date as epoch milliseconds. */
  authorDate: number;
  subject: string;
}

export type GitDiffTarget = "head" | "staged" | "worktree";

/**
 * Single result contract for the whole port: the port NEVER throws across its
 * boundary (mirror of RewindResult). Failures carry a human-readable reason.
 */
export type GitOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** Unified-diff text + honest truncation flag (slice 5.8, CONCERN-1 fix). */
export interface GitDiffResult {
  text: string;
  /** True when the adapter's output cap cut raw git output (stdoutTruncated). */
  truncated: boolean;
}

/** One worktree of the user repo (`worktree list --porcelain -z`). */
export interface GitWorktreeInfo {
  /** Absolute path of the worktree root. */
  path: string;
  /** HEAD sha; null for a bare worktree. */
  head: string | null;
  /** Short branch name (`refs/heads/` stripped); null when detached or bare. */
  branch: string | null;
  detached: boolean;
  /** True for the main working tree (the first porcelain record). */
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitPort {
  /** read: a single `status --porcelain=v2 --branch -z` spawn yields head + all three lists. */
  status(): Promise<GitOpResult<GitStatusSummary>>;
  listBranches(): Promise<GitOpResult<GitBranchInfo[]>>;
  log(opts?: { limit?: number }): Promise<GitOpResult<GitCommitInfo[]>>;
  /** Unified-diff text. A `path` is ALWAYS passed after `--` (structural flag-injection defense). */
  diff(spec?: { target?: GitDiffTarget; path?: string }): Promise<GitOpResult<string>>;
  /** safe-write v1 minimum: no discard/stash/unstage (those belong to a later consumer). */
  switchBranch(name: string): Promise<GitOpResult<null>>;
  createBranch(name: string, opts?: { switch?: boolean }): Promise<GitOpResult<null>>;
  stageAll(): Promise<GitOpResult<null>>;
  commit(message: string): Promise<GitOpResult<{ sha: string }>>;
  /** 5.4-R1 (non-destructive half): stages exactly `paths` (`git add -- <paths>`).
   *  OPTIONAL (runBinary?/spawnPersistent? precedent): absence = honest fail-closed refuse;
   *  existing implementations and test fakes keep compiling unchanged. */
  stage?(paths: string[]): Promise<GitOpResult<null>>;
  /** Removes exactly `paths` from the index (`git restore --staged -- <paths>`). Fails honestly on an unborn HEAD. */
  unstage?(paths: string[]): Promise<GitOpResult<null>>;
  /** 5.8 (CONCERN-1): diff + honest truncation flag. OPTIONAL (stage?/unstage? precedent);
   *  absence = consumer falls back to diff() with a length-only truncation heuristic. */
  diffDetailed?(spec?: { target?: GitDiffTarget; path?: string }): Promise<GitOpResult<GitDiffResult>>;
  /** 5.8 (destructive half of 5.4-R1): reverts the WORKTREE copy of exactly `paths` to the INDEX
   *  version (`git restore --worktree -- <paths>`). Never touches the index, never deletes untracked. */
  discard?(paths: string[]): Promise<GitOpResult<null>>;
  /** `git stash push [--include-untracked] [-m <message>]`; message rides as its OWN argv element
   *  after -m (commit -m precedent): committed verbatim, never re-interpreted as a flag. */
  stashPush?(opts?: { message?: string; includeUntracked?: boolean }): Promise<GitOpResult<null>>;
  /** `git stash pop`; fails honestly when the stash is empty or the apply conflicts. */
  stashPop?(): Promise<GitOpResult<null>>;
  /** `git reset --mixed|--hard HEAD` — the target is PINNED to the literal "HEAD" argv element:
   *  no commit-ish parameter exists in v1, so no history rewrite and no ref-injection surface. */
  resetHead?(mode: "mixed" | "hard"): Promise<GitOpResult<null>>;
  /** Creates a new branch checked out in a new, workspace-confined worktree. */
  worktreeAdd?(spec: {
    path: string;
    branch: string;
    baseRef?: string;
  }): Promise<GitOpResult<{ path: string }>>;
  /** Lists all registered worktrees using porcelain output. */
  worktreeList?(): Promise<GitOpResult<GitWorktreeInfo[]>>;
  /** Removes a registered worktree. Without `force`, git refuses dirty trees. */
  worktreeRemove?(spec: { path: string; force?: boolean }): Promise<GitOpResult<null>>;
  /** Prunes stale worktree administrative records using git's normal expiry policy. */
  worktreePrune?(): Promise<GitOpResult<null>>;
  /**
   * Deletes a local branch only when git proves it is merged (`git branch -d`).
   * Implementations must reject unsafe ref-shaped input before spawning and
   * must never upgrade this operation to force deletion (`-D`).
   */
  deleteBranch?(name: string): Promise<GitOpResult<null>>;
  /** Ensures AnyCode's project-local worktree namespace stays invisible to the main checkout. */
  ensureWorktreeNamespaceIgnored?(): Promise<GitOpResult<null>>;
  /** True only when tracked, untracked, and ignored content are all absent. */
  worktreeIsPristine?(): Promise<GitOpResult<boolean>>;
}

/**
 * Node implementation of GitPort over ExecutionPort.runBinary (argv spawn, no
 * shell). It operates on the user's REAL repository resolved from `cwd` and is
 * the deliberate env-opposite of shadow-git: it NEVER pins a GIT_DIR-family
 * value (and actively unsets any inherited one — see SAFE_GIT_ENV) and never
 * pins identity — commits are signed by the user's own git config. The only
 * positive protective env is
 * GIT_TERMINAL_PROMPT=0 (no /dev/tty), GIT_OPTIONAL_LOCKS=0 (read methods take
 * no optional lock, so they never rewrite the index) and LC_ALL=C (stable
 * machine output). Every command uses a machine-readable format and is parsed by
 * pure, exported functions. Flag injection is closed structurally: paths reach
 * git only after `--`, and ref names are rejected before spawn if they are empty,
 * start with `-`, or contain a control character. No operation throws across the
 * port boundary — all outcomes are GitOpResult.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { isWithinWorkspace } from "../../permissions/workspace-policy.js";
import type { ExecResult, ExecutionPort } from "../../ports/execution.js";
import type {
  GitBranchInfo,
  GitChangeKind,
  GitCommitInfo,
  GitDiffResult,
  GitDiffTarget,
  GitFileChange,
  GitHead,
  GitOpResult,
  GitPort,
  GitStatusSummary,
  GitWorktreeInfo,
} from "../../ports/git.js";

/** Per-operation timeout; a hung git call is reaped by runBinary's kill discipline. */
export const GIT_OP_TIMEOUT_MS = 30_000;

/**
 * Output cap for diff spawns ONLY (CONCERN-1 fix). The default DEFAULT_MAX_OUTPUT_BYTES
 * (262_144) sits below the wire diff cap GIT_WIRE_DIFF_MAX_CHARS (500_000), so a large
 * diff was silently cut mid-line before it could reach the wire cap. 2 MiB ≥ 4 bytes/char
 * × 500k ⇒ any UTF-8 prefix truncated at 2 MiB still carries ≥ 524_288 chars > the wire
 * cap, making the wire cap reachable while host memory stays bounded (one diff buffer at a

 */
export const GIT_DIFF_MAX_OUTPUT_BYTES = 2_097_152;

/** A full checkout may legitimately take longer than a normal git metadata operation. */
export const GIT_WORKTREE_ADD_TIMEOUT_MS = 120_000;

const DEFAULT_LOG_LIMIT = 20;

/** Max chars of git stderr surfaced in a failure reason. */
const MAX_REASON_DETAIL = 200;

const NO_RUNBINARY_REASON = "git unavailable: execution port has no runBinary";
const UNSAFE_REF_REASON = "unsafe ref name (empty, leading '-', or control character)";

/**
 * Protective env for every git spawn. runBinary merges this over the inherited
 * process.env ({...process.env, ...request.env}), so this table must not only
 * add the positive protective vars but also NEUTRALIZE inherited GIT_* that
 * could relocate the repo or execute arbitrary code — otherwise a "read-only"
 * op would honor an inherited exec driver and break the module invariant (the
 * adapter always resolves the real repo from cwd). A value of `undefined`
 * UNSETS the key in the child (Node drops undefined-valued keys from the
 * spawned env), which is why the type admits `string | undefined`.
 *
 * Note: `GIT_CONFIG_COUNT="0"` kills only the ad-hoc GIT_CONFIG_KEY_n/VALUE_n
 * env-injection channel (e.g. inheriting core.fsmonitor/core.sshCommand as an
 * exec driver); it does NOT touch config FILES, so a user's committed

 * deliberately do NOT set GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL for the same
 * reason.
 *
 * Residual (by design): exec drivers written into a repo-local `.git/config`

 * that is a separate ask-gated surface (the model writes `.git/config` only via
 * an ask-gated Write) and is not removable without breaking honor-user-config.
 */
const SAFE_GIT_ENV: Record<string, string | undefined> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  // Neutralize inherited env that could relocate the repo or execute code.
  GIT_CONFIG_COUNT: "0", // kills GIT_CONFIG_KEY_n/VALUE_n ad-hoc injection (→ fsmonitor/sshCommand)
  GIT_DIR: undefined, // relocation
  GIT_COMMON_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_EXTERNAL_DIFF: undefined, // arbitrary exec on diff
  GIT_SSH_COMMAND: undefined, // inert in v1 (no network) — forward-proof
};

function truncateDetail(text: string): string {
  return text.length <= MAX_REASON_DETAIL ? text : `${text.slice(0, MAX_REASON_DETAIL)}…`;
}

/** Concise failure reason for a non-zero / non-completed git call (mirror of shadow-git). */
function describeGitFailure(args: readonly string[], res: ExecResult): string {
  const cmd = args[0] ?? "git";
  const detail =
    res.stderr.trim() ||
    res.stdout.trim() ||
    `status ${res.status}${res.exitCode !== null ? ` (exit ${res.exitCode})` : ""}`;
  return `git ${cmd} failed: ${truncateDetail(detail)}`;
}

function unavailable(): { ok: false; reason: string } {
  return { ok: false, reason: NO_RUNBINARY_REASON };
}

/** Maps a porcelain XY status char to a change kind. Unknown chars fall back to modified. */
function mapStatusChar(c: string): GitChangeKind {
  switch (c) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

/**
 * Splits the first `metaCount` space-delimited fields of a porcelain record and
 * returns the untouched remainder (the pathname, which may contain spaces) at
 * index `metaCount`. `-z` output is unquoted, so the path is a verbatim byte run.
 */
function splitFields(token: string, metaCount: number): string[] {
  const fields: string[] = [];
  let rest = token;
  for (let k = 0; k < metaCount; k++) {
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      fields.push(rest);
      rest = "";
    } else {
      fields.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }
  }
  fields.push(rest);
  return fields;
}

/** Applies an XY status code to the staged/unstaged lists (X = index, Y = worktree). */
function pushXY(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  xy: string,
  path: string,
  renamedFrom: string | undefined,
): void {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x !== ".") {
    const kind = mapStatusChar(x);
    if (renamedFrom !== undefined && (kind === "renamed" || kind === "copied")) {
      staged.push({ path, kind, renamedFrom });
    } else {
      staged.push({ path, kind });
    }
  }
  if (y !== ".") {
    unstaged.push({ path, kind: mapStatusChar(y) });
  }
}

/** Applies a `# branch.*` porcelain header line (already stripped of the leading "# "). */
function applyHeader(head: GitHead, body: string): void {
  if (body.startsWith("branch.oid ")) {
    const oid = body.slice("branch.oid ".length);
    head.sha = oid === "(initial)" ? null : oid;
  } else if (body.startsWith("branch.head ")) {
    const h = body.slice("branch.head ".length);
    if (h === "(detached)") {
      head.detached = true;
      head.branch = null;
    } else {
      head.detached = false;
      head.branch = h;
    }
  } else if (body.startsWith("branch.ab ")) {
    const ab = body.slice("branch.ab ".length);
    const m = /^\+(-?\d+) -(-?\d+)$/.exec(ab);
    if (m) {
      head.ahead = Number.parseInt(m[1] ?? "0", 10);
      head.behind = Number.parseInt(m[2] ?? "0", 10);
    }
  }
  // branch.upstream is intentionally not surfaced (only ahead/behind numbers are).
}

/**
 * Parses `git status --porcelain=v2 --branch -z` output. Records are NUL-
 * separated; a rename/copy record (type 2) consumes an extra NUL token for the
 * original path. Pure and exported for unit tests without git.
 */
export function parsePorcelainV2Status(raw: string): GitStatusSummary {
  const head: GitHead = { branch: null, detached: false, sha: null, ahead: null, behind: null };
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: string[] = [];

  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.length === 0) {
      continue;
    }
    const type = token[0] ?? "";
    if (type === "#") {
      applyHeader(head, token.slice(2));
    } else if (type === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = splitFields(token, 8);
      pushXY(staged, unstaged, parts[1] ?? "..", parts[8] ?? "", undefined);
    } else if (type === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> \0 <origPath>
      const parts = splitFields(token, 9);
      const origPath = tokens[i + 1] ?? "";
      i += 1;
      pushXY(staged, unstaged, parts[1] ?? "..", parts[9] ?? "", origPath);
    } else if (type === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = splitFields(token, 10);
      unstaged.push({ path: parts[10] ?? "", kind: "unmerged" });
    } else if (type === "?") {
      untracked.push(token.slice(2));
    }
    // '!' ignored entries are never requested; any other prefix is skipped (fail-closed).
  }
  return { head, staged, unstaged, untracked };
}

/**
 * Parses `for-each-ref refs/heads --format=%(HEAD)%00%(refname:short)%00%(objectname)`.
 * Lines are LF-separated; fields are NUL-separated; `%(HEAD)` is `*` for the
 * current branch and a space otherwise. Pure and exported for unit tests.
 */
export function parseBranchList(raw: string): GitBranchInfo[] {
  const result: GitBranchInfo[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const parts = line.split("\0");
    if (parts.length < 3) {
      continue;
    }
    result.push({ name: parts[1] ?? "", current: parts[0] === "*", sha: parts[2] ?? "" });
  }
  return result;
}

/**
 * Parses `log --pretty=format:%H%x00%an%x00%at%x00%s%x1e` output. Records are
 * terminated by RS (0x1e) and glued with a newline by `format:`; fields are NUL-
 * separated; `%at` is epoch seconds (scaled to ms). Pure and exported for units.
 */
export function parseLogRecords(raw: string): GitCommitInfo[] {
  const result: GitCommitInfo[] = [];
  for (const rawRecord of raw.split("\x1e")) {
    const record = rawRecord.replace(/^[\r\n]+/, "");
    if (record.length === 0) {
      continue;
    }
    const fields = record.split("\0");
    if (fields.length < 4) {
      continue;
    }
    const epochSec = Number.parseInt(fields[2] ?? "", 10);
    if (Number.isNaN(epochSec)) {
      continue;
    }
    result.push({
      sha: fields[0] ?? "",
      authorName: fields[1] ?? "",
      authorDate: epochSec * 1000,
      subject: fields.slice(3).join("\0"),
    });
  }
  return result;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LOG_LIMIT;
  }
  const n = Math.floor(limit);
  return n < 0 ? 0 : n;
}

/** Argv prefix for a diff target (before any `-- <path>` suffix). */
function diffArgsForTarget(target: GitDiffTarget): string[] {
  switch (target) {
    case "staged":
      return ["diff", "--cached"];
    case "worktree":
      return ["diff"];
    case "head":
    default:
      return ["diff", "HEAD"];
  }
}

const REFS_HEADS_PREFIX = "refs/heads/";

/** Parses `git worktree list --porcelain -z` without path quoting or locale dependence. */
export function parseWorktreeListZ(raw: string): GitWorktreeInfo[] {
  const result: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> | null = null;

  const flush = (): void => {
    if (current?.path !== undefined) {
      result.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        isMain: result.length === 0,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
      });
    }
    current = null;
  };

  for (const token of raw.split("\0")) {
    if (token.length === 0) {
      flush();
      continue;
    }
    current ??= {};
    if (token.startsWith("worktree ")) {
      current.path = token.slice("worktree ".length);
    } else if (token.startsWith("HEAD ")) {
      current.head = token.slice("HEAD ".length);
    } else if (token.startsWith("branch ")) {
      const ref = token.slice("branch ".length);
      current.branch = ref.startsWith(REFS_HEADS_PREFIX) ? ref.slice(REFS_HEADS_PREFIX.length) : ref;
    } else if (token === "detached") {
      current.detached = true;
    } else if (token === "locked" || token.startsWith("locked ")) {
      current.locked = true;
    } else if (token === "prunable" || token.startsWith("prunable ")) {
      current.prunable = true;
    }
    // `bare` and unknown future attributes have no field in GitWorktreeInfo.
  }
  flush();
  return result;
}

export interface NodeGitAdapterOptions {
  exec: ExecutionPort;
  /** Absolute workspace path; the repo is resolved from here. */
  cwd: string;
  /** Defaults to "git"; overridable for tests (e.g. a hung-spawn shim). */
  gitBinary?: string;
  /** Aborts every in-flight git spawn (host shutdown reap). */
  signal?: AbortSignal;
}

export class NodeGitAdapter implements GitPort {
  private readonly exec: ExecutionPort;
  private readonly cwd: string;
  private readonly gitBinary: string;
  private readonly signal?: AbortSignal;

  constructor(opts: NodeGitAdapterOptions) {
    this.exec = opts.exec;
    this.cwd = opts.cwd;
    this.gitBinary = opts.gitBinary ?? "git";
    this.signal = opts.signal;
  }

  private get hasRunBinary(): boolean {
    return typeof this.exec.runBinary === "function";
  }

  /** Runs one git command via runBinary with SAFE_GIT_ENV (neutralizes the GIT_DIR family). */
  private async runGit(args: string[], opts?: { maxOutputBytes?: number; timeoutMs?: number }): Promise<ExecResult> {
    return this.exec.runBinary!({
      file: this.gitBinary,
      args,
      cwd: this.cwd,
      timeoutMs: opts?.timeoutMs ?? GIT_OP_TIMEOUT_MS,
      // SAFE_GIT_ENV carries `undefined` values (to UNSET inherited GIT_* in the
      // child). The port's env type is Record<string,string>; this local cast
      // accommodates the unset sentinel without changing the port contract.
      env: { ...SAFE_GIT_ENV } as Record<string, string>,
      // Only threaded when a caller overrides the cap (diff), keeping every other

      ...(opts?.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      // Only threaded when a signal was provided, keeping the no-signal spawn
      // byte-identical; reuses runBinary's kill discipline (SIGTERM→SIGKILL, pgid).
      ...(this.signal !== undefined ? { abortSignal: this.signal } : {}),
    });
  }

  private static failed(res: ExecResult): boolean {
    return res.status !== "completed" || res.exitCode !== 0;
  }

  private fail(args: readonly string[], res: ExecResult): { ok: false; reason: string } {
    return { ok: false, reason: describeGitFailure(args, res) };
  }

  async ensureWorktreeNamespaceIgnored(): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) return unavailable();
    const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const resolved = await this.runGit(args);
    if (NodeGitAdapter.failed(resolved) || resolved.stdoutTruncated) return this.fail(args, resolved);
    const commonDir = resolved.stdout.trim();
    if (!path.isAbsolute(commonDir)) {
      return { ok: false, reason: "git rev-parse returned a non-absolute common directory" };
    }
    const pattern = "/.anycode/worktrees/";
    try {
      const commonReal = await realpath(commonDir);
      const infoDir = path.join(commonReal, "info");
      await mkdir(infoDir, { recursive: true });
      const infoStat = await lstat(infoDir);
      if (infoStat.isSymbolicLink() || (await realpath(infoDir)) !== infoDir) {
        return { ok: false, reason: "repository info directory is symlinked" };
      }
      const excludePath = path.join(infoDir, "exclude");
      let existing = "";
      try {
        const handle = await open(excludePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          existing = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return { ok: true, value: null };
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      const handle = await open(
        excludePath,
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(`${prefix}${pattern}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, reason: `could not update repository-local exclude: ${String(error)}` };
    }
  }

  async worktreeIsPristine(): Promise<GitOpResult<boolean>> {
    return this.checkPristineAt(this.cwd);
  }

  private async checkPristineAt(target: string): Promise<GitOpResult<boolean>> {
    if (!this.hasRunBinary) return unavailable();
    const args = ["-C", target, "status", "--porcelain=v2", "--ignored=matching", "--untracked-files=all", "-z"];
    const result = await this.runGit(args);
    if (NodeGitAdapter.failed(result) || result.stdoutTruncated) return this.fail(args, result);
    const dirty = result.stdout
      .split("\0")
      .some((record) => /^(?:1 |2 |u |\? |! )/.test(record));
    if (dirty) return { ok: true, value: false };
    const hiddenArgs = ["-C", target, "ls-files", "-v", "-z"];
    const hidden = await this.runGit(hiddenArgs);
    if (NodeGitAdapter.failed(hidden) || hidden.stdoutTruncated) return this.fail(hiddenArgs, hidden);
    const hiddenIndexBit = hidden.stdout
      .split("\0")
      .some((record) => record.length > 0 && (/^[a-z]/.test(record) || record.startsWith("S ")));
    return { ok: true, value: !hiddenIndexBit };
  }

  /**
   * Rejects ref names that could inject a flag or corrupt the argv position:
   * empty, leading '-', or any control character. Returns true when the name
   * must be refused BEFORE any spawn.
   */
  private rejectsUnsafeRef(name: string): boolean {
    if (name.length === 0) {
      return true;
    }
    if (name.startsWith("-")) {
      return true;
    }
    for (const ch of name) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves a worktree target against cwd and refuses escapes, cwd itself,
   * `.git`, and existing symlink prefixes before spawning git.
   */
  private async resolveConfinedWorktreePath(
    candidate: string,
  ): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
    const root = path.resolve(this.cwd);
    const abs = path.resolve(root, candidate);
    if (!isWithinWorkspace(abs, root)) {
      return { ok: false, reason: "worktree path is outside the workspace" };
    }
    if (abs === root) {
      return { ok: false, reason: "worktree path must not be the workspace root" };
    }
    if (isWithinWorkspace(abs, path.join(root, ".git"))) {
      return { ok: false, reason: "worktree path must not be inside .git" };
    }

    const segments = path
      .relative(root, abs)
      .split(path.sep)
      .filter((segment) => segment.length > 0);
    let cursor = root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) {
          return { ok: false, reason: "worktree path traverses a symlink" };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        return { ok: false, reason: "worktree path could not be verified" };
      }
    }
    return { ok: true, abs };
  }

  /** Removes a just-created worktree that failed post-add confinement verification. */
  private async teardownWorktree(
    abs: string,
    branch: string,
  ): Promise<{ removed: boolean; branchDeleted: boolean }> {
    const pristine = await this.checkPristineAt(abs);
    if (!pristine.ok || !pristine.value) return { removed: false, branchDeleted: false };
    const remove = await this.runGit(["worktree", "remove", "--", abs]);
    if (NodeGitAdapter.failed(remove)) return { removed: false, branchDeleted: false };
    const deleteBranch = await this.runGit(["branch", "-d", "--", branch]);
    return { removed: true, branchDeleted: !NodeGitAdapter.failed(deleteBranch) };
  }

  /**
   * Distinguishes an unborn HEAD (valid repo, no commits) from a non-repo cwd.
   * Only consulted on a log failure, so it never adds spawns to the happy path.
   */
  private async isUnbornHead(): Promise<boolean> {
    const inside = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== "completed" || inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return false;
    }
    const head = await this.runGit(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return head.exitCode !== 0;
  }

  async status(): Promise<GitOpResult<GitStatusSummary>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = ["status", "--porcelain=v2", "--branch", "-z"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: parsePorcelainV2Status(res.stdout) };
  }

  async listBranches(): Promise<GitOpResult<GitBranchInfo[]>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = ["for-each-ref", "refs/heads", "--format=%(HEAD)%00%(refname:short)%00%(objectname)"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: parseBranchList(res.stdout) };
  }

  async log(opts?: { limit?: number }): Promise<GitOpResult<GitCommitInfo[]>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const limit = normalizeLimit(opts?.limit);
    const args = ["log", "-n", String(limit), "--pretty=format:%H%x00%an%x00%at%x00%s%x1e"];
    const res = await this.runGit(args);
    if (!NodeGitAdapter.failed(res)) {
      return { ok: true, value: parseLogRecords(res.stdout) };
    }
    // An unborn HEAD is an empty history, not an error.
    if (await this.isUnbornHead()) {
      return { ok: true, value: [] };
    }
    return this.fail(args, res);
  }

  async diffDetailed(spec?: { target?: GitDiffTarget; path?: string }): Promise<GitOpResult<GitDiffResult>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = diffArgsForTarget(spec?.target ?? "head");
    if (spec?.path !== undefined) {
      // Path ALWAYS after `--`: a value like `--output=<f>` is a pathspec, never a flag.
      args.push("--", spec.path);
    }
    // CONCERN-1: diff (and only diff) raises its output cap to GIT_DIFF_MAX_OUTPUT_BYTES so
    // the wire cap becomes reachable; `stdoutTruncated` is surfaced honestly, not dropped.
    const res = await this.runGit(args, { maxOutputBytes: GIT_DIFF_MAX_OUTPUT_BYTES });
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: { text: res.stdout, truncated: res.stdoutTruncated } };
  }

  async diff(spec?: { target?: GitDiffTarget; path?: string }): Promise<GitOpResult<string>> {
    // Delegate: same result shape (string) so the CLI consumer (cli/main.ts) needs no edits;
    // the truncation flag is dropped here but the 2 MiB cap improvement is inherited.
    const r = await this.diffDetailed(spec);
    return r.ok ? { ok: true, value: r.value.text } : r;
  }

  async switchBranch(name: string): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    if (this.rejectsUnsafeRef(name)) {
      return { ok: false, reason: UNSAFE_REF_REASON };
    }
    const args = ["switch", name];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async createBranch(name: string, opts?: { switch?: boolean }): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    if (this.rejectsUnsafeRef(name)) {
      return { ok: false, reason: UNSAFE_REF_REASON };
    }
    const args = opts?.switch ? ["switch", "-c", name] : ["branch", name];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async stageAll(): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = ["add", "-A"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async commit(message: string): Promise<GitOpResult<{ sha: string }>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    // `message` is a distinct argv element after `-m`: it is committed verbatim
    // (e.g. "--amend" becomes the literal subject), never re-interpreted as a flag.
    const commitArgs = ["commit", "-m", message];
    const commitRes = await this.runGit(commitArgs);
    if (NodeGitAdapter.failed(commitRes)) {
      return this.fail(commitArgs, commitRes);
    }
    const headArgs = ["rev-parse", "HEAD"];
    const headRes = await this.runGit(headArgs);
    if (NodeGitAdapter.failed(headRes)) {
      return this.fail(headArgs, headRes);
    }
    return { ok: true, value: { sha: headRes.stdout.trim() } };
  }

  async stage(paths: string[]): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    if (paths.length === 0) {
      return { ok: false, reason: "stage requires at least one path" };
    }
    // Paths ALWAYS after `--`: a value like `-rf`/`--force` is a pathspec, never a flag.
    const args = ["add", "--", ...paths];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async unstage(paths: string[]): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    if (paths.length === 0) {
      return { ok: false, reason: "unstage requires at least one path" };
    }
    // Paths ALWAYS after `--` (structural flag-injection defense). `restore
    // --staged` fails honestly on an unborn HEAD (no HEAD to restore from).
    const args = ["restore", "--staged", "--", ...paths];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async discard(paths: string[]): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    if (paths.length === 0) {
      return { ok: false, reason: "discard requires at least one path" };
    }
    // Reverts the WORKTREE copy to the INDEX version. Paths ALWAYS after `--`: a
    // value like `-rf`/`--hard` is a pathspec, never a flag. The index is never
    // touched; untracked paths fail the pathspec (git never deletes them).
    const args = ["restore", "--worktree", "--", ...paths];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async stashPush(opts?: { message?: string; includeUntracked?: boolean }): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = ["stash", "push"];
    if (opts?.includeUntracked === true) {
      args.push("--include-untracked");
    }
    if (opts?.message !== undefined) {
      // `message` is a distinct argv element after `-m`: committed verbatim
      // (e.g. "--include-untracked" becomes the literal message), never a flag.
      args.push("-m", opts.message);
    }
    const res = await this.runGit(args);
    // "No local changes to save" is exit 0 => an honest {ok:true}.
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async stashPop(): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    const args = ["stash", "pop"];
    const res = await this.runGit(args);
    // An empty stash or a conflicting apply is a non-zero exit => honest {ok:false}.
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async resetHead(mode: "mixed" | "hard"): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) {
      return unavailable();
    }
    // Target is PINNED to the literal "HEAD": no commit-ish parameter exists, so
    // there is no history rewrite and no ref-injection surface. `--soft` is a
    // deliberate non-option (a no-op against a HEAD target). Exhaustive over the
    // closed union: the two argv shapes are the only ones constructible.
    const args = mode === "hard" ? ["reset", "--hard", "HEAD"] : ["reset", "--mixed", "HEAD"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) {
      return this.fail(args, res);
    }
    return { ok: true, value: null };
  }

  async worktreeAdd(spec: {
    path: string;
    branch: string;
    baseRef?: string;
  }): Promise<GitOpResult<{ path: string }>> {
    if (!this.hasRunBinary) return unavailable();
    if (this.rejectsUnsafeRef(spec.branch)) return { ok: false, reason: UNSAFE_REF_REASON };
    if (spec.baseRef !== undefined && this.rejectsUnsafeRef(spec.baseRef)) {
      return { ok: false, reason: UNSAFE_REF_REASON };
    }
    const confined = await this.resolveConfinedWorktreePath(spec.path);
    if (!confined.ok) return confined;

    const root = path.resolve(this.cwd);
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      return { ok: false, reason: "workspace root could not be verified before worktree add" };
    }

    const args = ["worktree", "add", "-b", spec.branch, "--", confined.abs];
    if (spec.baseRef !== undefined) args.push(spec.baseRef);
    const res = await this.runGit(args, { timeoutMs: GIT_WORKTREE_ADD_TIMEOUT_MS });
    if (NodeGitAdapter.failed(res)) return this.fail(args, res);

    let realWorktree: string;
    try {
      realWorktree = await realpath(confined.abs);
    } catch {
      const cleanup = await this.teardownWorktree(confined.abs, spec.branch);
      return {
        ok: false,
        reason: cleanup.removed
          ? `worktree path could not be verified after add; worktree removed${
              cleanup.branchDeleted ? "" : `; orphan branch ${spec.branch} left behind`
            }`
          : `worktree path could not be verified after add and could not be removed; manual cleanup required: ${confined.abs}`,
      };
    }
    if (!isWithinWorkspace(realWorktree, realRoot)) {
      const cleanup = await this.teardownWorktree(confined.abs, spec.branch);
      return {
        ok: false,
        reason: cleanup.removed
          ? `worktree path escaped the workspace and was removed${
              cleanup.branchDeleted ? "" : `; orphan branch ${spec.branch} left behind`
            }`
          : `worktree path escaped the workspace and could not be removed; manual cleanup required: ${confined.abs}`,
      };
    }
    return { ok: true, value: { path: confined.abs } };
  }

  async worktreeList(): Promise<GitOpResult<GitWorktreeInfo[]>> {
    if (!this.hasRunBinary) return unavailable();
    const args = ["worktree", "list", "--porcelain", "-z"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) return this.fail(args, res);
    if (res.stdoutTruncated) return { ok: false, reason: "git worktree list output truncated" };
    return { ok: true, value: parseWorktreeListZ(res.stdout) };
  }

  async worktreeRemove(spec: { path: string; force?: boolean }): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) return unavailable();
    const confined = await this.resolveConfinedWorktreePath(spec.path);
    if (!confined.ok) return confined;
    if (spec.force !== true) {
      const pristine = await this.checkPristineAt(confined.abs);
      if (!pristine.ok) return pristine;
      if (!pristine.value) {
        return { ok: false, reason: "worktree content is not provably pristine; explicit force is required" };
      }
    }
    const args = ["worktree", "remove", ...(spec.force === true ? ["--force"] : []), "--", confined.abs];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) return this.fail(args, res);
    return { ok: true, value: null };
  }

  async worktreePrune(): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) return unavailable();
    const args = ["worktree", "prune"];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) return this.fail(args, res);
    return { ok: true, value: null };
  }

  async deleteBranch(name: string): Promise<GitOpResult<null>> {
    if (!this.hasRunBinary) return unavailable();
    if (this.rejectsUnsafeRef(name)) return { ok: false, reason: UNSAFE_REF_REASON };
    // `-d` deliberately asks git to prove the branch is merged. Keep `--`
    // even after the pre-spawn guard so the ref can never become an option.
    const args = ["branch", "-d", "--", name];
    const res = await this.runGit(args);
    if (NodeGitAdapter.failed(res)) return this.fail(args, res);
    return { ok: true, value: null };
  }
}

/**
 * shadow-git checkpoint service (design slice-4.7-cut.md §2.2). Snapshots the
 * workspace into an isolated GIT_DIR that lives OUTSIDE the workspace, using
 * ONLY plumbing commands (init/add -A/write-tree/commit-tree/update-ref/
 * read-tree/diff-tree) spawned through ExecutionPort.runBinary (argv, no shell,
 * SIGTERM->SIGKILL kill-discipline inherited from the adapter). It never runs a
 * command against the user's .git, never uses HEAD/branches/porcelain, and


 * throws outward (mirror of HistorySink).
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CheckpointCaptureResult,
  CheckpointCapturer,
  CheckpointMeta,
  CheckpointReason,
  CheckpointStore,
  TurnCheckpointRequest,
} from "../ports/checkpoints.js";
import type { ExecResult, ExecutionPort } from "../ports/execution.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { HistoryItem } from "../types/history.js";

export const CHECKPOINT_GIT_TIMEOUT_MS = 30_000;
export const CHECKPOINTS_KEEP_PER_SESSION = 50;
export const CHECKPOINT_LABEL_MAX_CHARS = 64;

/** Max chars of git stderr surfaced in a failure reason. */
const MAX_REASON_DETAIL = 200;

const NO_RUNBINARY_REASON = "checkpoints unavailable: execution port has no runBinary";

export interface ShadowGitCheckpointsOptions {
  exec: ExecutionPort;
  fs: FileSystemPort; // mkdir/writeFile/exists — init GIT_DIR + info/exclude
  store: CheckpointStore;
  workspace: string;
  checkpointsRoot: string;
  sessionId: string;
  gitBinary?: string;
  now?: () => number;
}

export type RewindScope = "both" | "files" | "conversation";
export type RewindResult =
  | { ok: true; safetyCheckpointId: string; restoredPaths: number | null; historyItems: HistoryItem[] | null }
  | { ok: false; reason: string };

/** sha256 hex digest (node:crypto builtin, no new dep). */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function truncateDetail(text: string): string {
  return text.length <= MAX_REASON_DETAIL ? text : `${text.slice(0, MAX_REASON_DETAIL)}…`;
}

/** Concise failure reason for a non-zero / non-completed git plumbing call. */
function describeGitFailure(args: readonly string[], res: ExecResult): string {
  const cmd = args[0] ?? "git";
  const detail =
    res.stderr.trim() ||
    res.stdout.trim() ||
    `status ${res.status}${res.exitCode !== null ? ` (exit ${res.exitCode})` : ""}`;
  return `git ${cmd} failed: ${truncateDetail(detail)}`;
}

function toReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**


 * CHECKPOINT_LABEL_MAX_CHARS.
 */
export function deriveCheckpointLabel(userInput: string): string {
  const firstLine = userInput.split("\n", 1)[0] ?? "";
  let cleaned = "";
  for (const ch of firstLine) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 control chars (incl. tab/CR) and DEL.
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += ch;
  }
  return cleaned.trim().slice(0, CHECKPOINT_LABEL_MAX_CHARS);
}

export class ShadowGitCheckpoints implements CheckpointCapturer {
  private readonly gitBinary: string;
  private readonly now: () => number;
  private readonly gitDir: string;
  private readonly ref: string;
  private readonly baseEnv: Record<string, string>;

  private disabled = false;
  private initDone = false;
  private lastCommitLoaded = false;
  private lastCommit: string | null = null;

  constructor(private readonly opts: ShadowGitCheckpointsOptions) {
    this.gitBinary = opts.gitBinary ?? "git";
    this.now = opts.now ?? (() => Date.now());
    // Per-workspace GIT_DIR (objects shared across a workspace's sessions);

    this.gitDir = join(opts.checkpointsRoot, sha256Hex(opts.workspace).slice(0, 16));
    const indexPath = join(this.gitDir, `index-${opts.sessionId}`);
    this.ref = `refs/anycode/sessions/${opts.sessionId}`;
    this.baseEnv = {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: opts.workspace,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: join(this.gitDir, "objects"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "anycode",
      GIT_AUTHOR_EMAIL: "checkpoint@anycode.invalid",
      GIT_COMMITTER_NAME: "anycode",
      GIT_COMMITTER_EMAIL: "checkpoint@anycode.invalid",
    };
  }

  private get hasRunBinary(): boolean {
    return typeof this.opts.exec.runBinary === "function";
  }

  /* */
  private async runGit(args: string[]): Promise<ExecResult> {
    return this.opts.exec.runBinary!({
      file: this.gitBinary,
      args,
      cwd: this.opts.workspace,
      timeoutMs: CHECKPOINT_GIT_TIMEOUT_MS,
      env: this.baseEnv,
    });
  }

  /** Runs a plumbing command; throws on status != completed or exitCode != 0. Returns stdout. */
  private async gitOrThrow(args: string[]): Promise<string> {
    const res = await this.runGit(args);
    if (res.status !== "completed" || res.exitCode !== 0) {
      throw new Error(describeGitFailure(args, res));
    }
    return res.stdout;
  }

  /**
   * Lazy, idempotent init: GIT_DIR is initialized via the env (GIT_DIR), so the
   * workspace is never touched — `git init <ws>`/`--separate-git-dir` are
   * FORBIDDEN (they would write a .git into the user tree). info/exclude is
   * seeded with `.git/` + `node_modules/` so add -A never snapshots the user's

   */
  private async ensureInit(): Promise<void> {
    if (this.initDone) {
      return;
    }
    const headPath = join(this.gitDir, "HEAD");
    if (!(await this.opts.fs.exists(headPath))) {
      await this.opts.fs.mkdir(this.gitDir);
      await this.gitOrThrow(["init", "--quiet"]);
      await this.opts.fs.writeFile(join(this.gitDir, "info", "exclude"), ".git/\nnode_modules/\n");
    }
    this.initDone = true;
  }

  /** Seeds the parent chain from the session's newest checkpoint (resume continuity). */
  private async ensureLastCommitLoaded(): Promise<void> {
    if (this.lastCommitLoaded) {
      return;
    }
    const recent = await this.opts.store.listCheckpoints(this.opts.sessionId, { limit: 1 });
    this.lastCommit = recent[0]?.commitHash ?? null;
    this.lastCommitLoaded = true;
  }

  /**
   * Core capture (steps 1-6 of §2.2). Returns the new commit + record id, or
   * throws on any step failure. Does NOT consult/set `disabled` — callers own
   * that policy (auto capture self-disables; safety capture aborts the rewind).
   */
  private async performCapture(
    reason: CheckpointReason,
    label: string,
    historySnapshot: readonly HistoryItem[],
  ): Promise<{ id: string; commitHash: string }> {
    await this.ensureInit();
    await this.ensureLastCommitLoaded();
    await this.gitOrThrow(["add", "-A"]);
    const tree = (await this.gitOrThrow(["write-tree"])).trim();
    const commitArgs = ["commit-tree", tree];
    if (this.lastCommit !== null) {
      commitArgs.push("-p", this.lastCommit);
    }
    commitArgs.push("-m", `anycode checkpoint: ${reason} — ${label}`);
    const commitHash = (await this.gitOrThrow(commitArgs)).trim();
    await this.gitOrThrow(["update-ref", this.ref, commitHash]);
    const id = randomUUID();
    await this.opts.store.saveCheckpoint(
      {
        id,
        sessionId: this.opts.sessionId,
        commitHash,
        createdAt: this.now(),
        reason,
        label,
        historyJson: JSON.stringify(historySnapshot),
      },
      { keepPerSession: CHECKPOINTS_KEEP_PER_SESSION },
    );
    this.lastCommit = commitHash;
    return { id, commitHash };
  }

  /* */
  async capture(req: TurnCheckpointRequest): Promise<CheckpointCaptureResult> {
    if (this.disabled) {
      return { kind: "skipped" };
    }
    if (!this.hasRunBinary) {
      this.disabled = true;
      return { kind: "failed", reason: NO_RUNBINARY_REASON };
    }
    try {
      const label = deriveCheckpointLabel(req.userInput);
      const { id } = await this.performCapture("auto", label, req.historySnapshot);
      return { kind: "created", id, label };
    } catch (err) {
      this.disabled = true;
      return { kind: "failed", reason: toReason(err) };
    }
  }

  async list(opts?: { limit?: number }): Promise<CheckpointMeta[]> {
    return this.opts.store.listCheckpoints(this.opts.sessionId, opts);
  }

  /**

   * getCheckpoint -> mandatory fail-closed safety capture -> two-tree
   * `read-tree -u -m <safety> <target>` (touches ONLY differing tracked paths;
   * ignored + post-safety files are untouched; `git clean` never used) ->
   * diff-tree count. The conversation snapshot is returned for the caller to
   * apply (the service does not touch live history).
   */
  async rewind(
    checkpointId: string,
    opts: { scope: RewindScope; currentHistory: readonly HistoryItem[] },
  ): Promise<RewindResult> {
    if (!this.hasRunBinary) {
      return { ok: false, reason: NO_RUNBINARY_REASON };
    }
    const record = await this.opts.store.getCheckpoint(checkpointId);
    if (record === null) {
      return { ok: false, reason: `no checkpoint ${checkpointId}` };
    }
    // Ownership guard: the checkpoints table is GLOBAL (id-only lookup), so a
    // renderer-controlled id could target another session's/workspace's record
    // and leak its conversation snapshot via scope:"conversation". A session can
    // only ever list() its own checkpoints, so a foreign id is never legitimate.
    // Reject BEFORE the safety capture (no row written for a rejected id).
    if (record.sessionId !== this.opts.sessionId) {
      return { ok: false, reason: `checkpoint ${checkpointId} belongs to another session` };
    }

    // Step 2: mandatory safety checkpoint; fail-closed (no safety -> no rewind).
    let safety: { id: string; commitHash: string };
    try {
      safety = await this.performCapture("pre-rewind", "before /rewind", opts.currentHistory);
    } catch (err) {
      return { ok: false, reason: `safety checkpoint failed: ${toReason(err)}` };
    }

    const wantsFiles = opts.scope === "both" || opts.scope === "files";
    const wantsConversation = opts.scope === "both" || opts.scope === "conversation";

    let restoredPaths: number | null = null;
    if (wantsFiles) {
      try {
        // Two-tree swap: index == safety tree (just captured), so ONLY differing
        // tracked paths are updated/removed. `-u` is mandatory (updates worktree);

        await this.gitOrThrow(["read-tree", "-u", "-m", safety.commitHash, record.commitHash]);
        const diff = await this.gitOrThrow([
          "diff-tree",
          "-r",
          "--name-only",
          safety.commitHash,
          record.commitHash,
        ]);
        restoredPaths = countChangedPaths(diff);
      } catch (err) {
        return { ok: false, reason: toReason(err) };
      }
    }

    let historyItems: HistoryItem[] | null = null;
    if (wantsConversation) {
      historyItems = JSON.parse(record.historyJson) as HistoryItem[];
    }

    return { ok: true, safetyCheckpointId: safety.id, restoredPaths, historyItems };
  }
}

/**
 * Counts changed paths in `diff-tree -r --name-only <a> <b>` output. The
 * two-commit form emits bare path lines, but a stray 40-hex commit header may

 */
function countChangedPaths(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || /^[0-9a-f]{40}$/.test(trimmed)) {
      continue;
    }
    count += 1;
  }
  return count;
}

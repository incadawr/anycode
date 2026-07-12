/**
 * GitBridge (slice 5.7, design slice-5.7-cut.md §2.3-C1): the host-side executor
 * of the renderer's user-initiated git commands over a FROZEN {@link GitPort}.
 * The first desktop consumer of the git cluster (5.4).
 *

 * does NOT pass through the agent permission gate — the security boundary is the
 * zod fail-closed schema (garbage is dropped BEFORE any spawn, in Session.route),
 * the serialized single-child queue here, and the adapter's structural argv
 * defenses (`--`-position, rejectsUnsafeRef, SAFE_GIT_ENV). This bridge only ever
 * serves the renderer; the agent-facing git tool is a different slice (5.4-R5).
 *

 * queue + single-flight status), at most MAX_PENDING_GIT_COMMANDS queued (flood
 * ⇒ immediate refusal), diffs capped at GIT_WIRE_DIFF_MAX_CHARS, status lists
 * capped at GIT_STATUS_MAX_FILES with a TRUE dirtyCount computed before the cap.
 *

 * reload via replay) plus a `sendDirect` snapshot on each `ui_ready` (renderer-
 * proven-ready; slice 5.7-hostfix moved it off physical bind — a bind-time post
 * raced an unmounted renderer); git_result is ALWAYS `sendDirect` (ephemeral
 * request/response — it must
 * never enter the replay ring buffer, so 500k-char diffs can never balloon host

 * the wire means "git is unavailable in this workspace", not "index.lock race".
 */

import type { GitDiffTarget, GitOpResult, GitPort, GitStatusSummary } from "@anycode/core";
import type { GitCommand, GitCommandOutcome, WireGitStatus } from "../shared/protocol.js";
import { GIT_STATUS_MAX_FILES, GIT_WIRE_DIFF_MAX_CHARS } from "../shared/protocol.js";
import type { Outbound } from "./session.js";

/** Narrow seam Session sees (session.ts must not import the class). */
export interface GitUiBridge {
  handleCommand(message: { requestId: string; command: GitCommand }): void;
  /** Fire-and-forget push of a fresh git_status after a turn (must never block/throw into the turn). */
  refreshAfterTurn(): void;
  /** sendDirect snapshot per `ui_ready` (renderer-ready connect; mcp_status-style freshness). */
  pushSnapshot(): void;
}

/** Ceiling on queued (incl. in-flight) git commands; a flood beyond this is refused, not enqueued (§6#5). */
export const MAX_PENDING_GIT_COMMANDS = 8;

const GIT_UNAVAILABLE_REASON = "git is unavailable in this workspace (not a git repository)";
const GIT_QUEUE_FULL_REASON = "git queue full; try again";
const STAGE_UNAVAILABLE_REASON = "stage/unstage unavailable on this git port";
// Slice 5.8: destructive ops are optional GitPort methods; an older port honestly refuses.
const DISCARD_UNAVAILABLE_REASON = "discard unavailable on this git port";
const STASH_UNAVAILABLE_REASON = "stash unavailable on this git port";
const RESET_UNAVAILABLE_REASON = "reset unavailable on this git port";

export interface GitBridgeOptions {
  /** null = non-git workspace / no runBinary (boot-gate mirror) — zero spawns forever. */
  git: GitPort | null;
  outbound: Pick<Outbound, "emit" | "sendDirect">;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**

 * `dirtyCount` is the TRUE total (staged+unstaged+untracked) computed BEFORE the
 * cap; each of the three lists is truncated to {@link GIT_STATUS_MAX_FILES};
 * `filesTruncated` is true iff ANY list exceeded the cap. Pure — exported for
 * unit tests.
 */
export function projectGitStatus(summary: GitStatusSummary): WireGitStatus {
  const dirtyCount = summary.staged.length + summary.unstaged.length + summary.untracked.length;
  const filesTruncated =
    summary.staged.length > GIT_STATUS_MAX_FILES ||
    summary.unstaged.length > GIT_STATUS_MAX_FILES ||
    summary.untracked.length > GIT_STATUS_MAX_FILES;
  return {
    head: summary.head,
    staged: summary.staged.slice(0, GIT_STATUS_MAX_FILES),
    unstaged: summary.unstaged.slice(0, GIT_STATUS_MAX_FILES),
    untracked: summary.untracked.slice(0, GIT_STATUS_MAX_FILES),
    dirtyCount,
    filesTruncated,
  };
}

export class GitBridge implements GitUiBridge {
  private readonly git: GitPort | null;
  private readonly outbound: Pick<Outbound, "emit" | "sendDirect">;

  /** Serializes every command onto a single promise chain (at most one git child at a time). */
  private chain: Promise<void> = Promise.resolve();
  /** Count of enqueued-but-not-yet-completed commands (incl. the running one), for the flood gate. */
  private pending = 0;
  /** Single-flight status() read: concurrent refresh/turn-end callers share ONE spawn (§2.3-C1.2). */
  private statusInFlight: Promise<GitOpResult<GitStatusSummary>> | null = null;

  constructor(options: GitBridgeOptions) {
    this.git = options.git;
    this.outbound = options.outbound;
  }

  handleCommand(message: { requestId: string; command: GitCommand }): void {
    const { requestId, command } = message;
    if (this.git === null) {

      this.reply(requestId, { ok: false, reason: GIT_UNAVAILABLE_REASON });
      return;
    }
    if (this.pending >= MAX_PENDING_GIT_COMMANDS) {
      // Flood-bound (§6#5): refuse immediately WITHOUT enqueuing — the host stays live.
      this.reply(requestId, { ok: false, reason: GIT_QUEUE_FULL_REASON });
      return;
    }
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      try {
        await this.runCommand(requestId, command);
      } catch (error) {
        // runCommand maps every port failure to a git_result and is designed
        // never to throw; this is a defensive net so a rogue command can never
        // wedge the chain (the chain must never reject — the next command runs).
        console.warn(`[host] git command crashed: ${describeError(error)}`);
        this.reply(requestId, { ok: false, reason: describeError(error) });
      } finally {
        this.pending -= 1;
      }
    });
  }

  refreshAfterTurn(): void {
    if (this.git === null) {

      return;
    }
    // Fire-and-forget, single-flight (coalesces with a concurrent refresh command).
    void this.publishFreshStatus();
  }

  pushSnapshot(): void {
    const git = this.git;
    if (git === null) {

      this.outbound.sendDirect({ type: "git_status", status: null });
      return;
    }
    // sendDirect (NOT emit): the per-connect snapshot regenerates per `ui_ready`

    // A failure on connect sends `null` — honest "unknown" (§2.3-C1.5).
    void this.fetchStatus().then((result) => {
      this.outbound.sendDirect({
        type: "git_status",
        status: result.ok ? projectGitStatus(result.value) : null,
      });
    });
  }

  /**
   * Single-flight status() read: while one is in flight, every caller shares it,
   * guaranteeing at most one status child and coalescing concurrent refresh /
   * turn-end into ONE spawn (§2.3-C1.2). Side-effect-free (no wire write); the
   * caller decides emit vs sendDirect. Never throws — a thrown port maps to
   * {ok:false} (the port contract already promises never to throw).
   */
  private fetchStatus(): Promise<GitOpResult<GitStatusSummary>> {
    if (this.statusInFlight) {
      return this.statusInFlight;
    }
    const git = this.git;
    if (git === null) {
      return Promise.resolve({ ok: false, reason: GIT_UNAVAILABLE_REASON });
    }
    const inFlight = git
      .status()
      .catch((error): GitOpResult<GitStatusSummary> => ({ ok: false, reason: describeError(error) }));
    this.statusInFlight = inFlight;
    void inFlight.finally(() => {
      if (this.statusInFlight === inFlight) {
        this.statusInFlight = null;
      }
    });
    return inFlight;
  }

  /**
   * Fetches a fresh status and, on success, emits `git_status` (buffered — a

   * transient index.lock race must not blank the pill with a null).
   */
  private async publishFreshStatus(): Promise<void> {
    const result = await this.fetchStatus();
    if (result.ok) {
      this.outbound.emit({ type: "git_status", status: projectGitStatus(result.value) });
    } else {
      console.warn(`[host] git status refresh failed; keeping last known status: ${result.reason}`);
    }
  }

  private reply(requestId: string, outcome: GitCommandOutcome): void {

    this.outbound.sendDirect({ type: "git_result", requestId, outcome });
  }

  /** Reports a unit mutation (ok ⇒ unit + fresh-status follow; else the reason). */
  private async replyMutation(requestId: string, result: GitOpResult<null>): Promise<void> {
    if (result.ok) {
      this.reply(requestId, { ok: true, kind: "unit" });
      await this.publishFreshStatus();
    } else {
      this.reply(requestId, { ok: false, reason: result.reason });
    }
  }

  private async runCommand(requestId: string, command: GitCommand): Promise<void> {
    const git = this.git;
    if (git === null) {
      // Unreachable: handleCommand refuses git:null before enqueue. Defensive.
      this.reply(requestId, { ok: false, reason: GIT_UNAVAILABLE_REASON });
      return;
    }
    switch (command.op) {
      case "refresh": {
        const result = await this.fetchStatus();
        if (result.ok) {
          this.outbound.emit({ type: "git_status", status: projectGitStatus(result.value) });
          this.reply(requestId, { ok: true, kind: "unit" });
        } else {
          console.warn(`[host] git refresh failed: ${result.reason}`);
          this.reply(requestId, { ok: false, reason: result.reason });
        }
        return;
      }
      case "branches": {
        const result = await git.listBranches();
        this.reply(
          requestId,
          result.ok ? { ok: true, kind: "branches", branches: result.value } : { ok: false, reason: result.reason },
        );
        return;
      }
      case "log": {
        const result = await git.log(command.limit !== undefined ? { limit: command.limit } : undefined);
        this.reply(
          requestId,
          result.ok ? { ok: true, kind: "log", commits: result.value } : { ok: false, reason: result.reason },
        );
        return;
      }
      case "diff": {
        const spec: { target?: GitDiffTarget; path?: string } = {};
        if (command.target !== undefined) {
          spec.target = command.target;
        }
        if (command.path !== undefined) {
          spec.path = command.path;
        }
        // Slice 5.8 (CONCERN-1): prefer diffDetailed — the adapter raises the diff
        // spawn's output cap to 2 MiB and reports honest `truncated` (stdoutTruncated),
        // so the wire cap is finally reachable. Wire truncation = adapter cut OR wire
        // slice. Fall back to diff() (length-only heuristic) for an older port.
        if (typeof git.diffDetailed === "function") {
          const result = await git.diffDetailed(spec);
          if (result.ok) {
            const overCap = result.value.text.length > GIT_WIRE_DIFF_MAX_CHARS;
            const truncated = result.value.truncated || overCap;
            const diff = overCap ? result.value.text.slice(0, GIT_WIRE_DIFF_MAX_CHARS) : result.value.text;
            this.reply(requestId, { ok: true, kind: "diff", diff, truncated });
          } else {
            this.reply(requestId, { ok: false, reason: result.reason });
          }
          return;
        }
        const result = await git.diff(spec);
        if (result.ok) {
          const truncated = result.value.length > GIT_WIRE_DIFF_MAX_CHARS;
          const diff = truncated ? result.value.slice(0, GIT_WIRE_DIFF_MAX_CHARS) : result.value;
          this.reply(requestId, { ok: true, kind: "diff", diff, truncated });
        } else {
          this.reply(requestId, { ok: false, reason: result.reason });
        }
        return;
      }
      case "switch_branch": {
        await this.replyMutation(requestId, await git.switchBranch(command.name));
        return;
      }
      case "create_branch": {
        const result = await git.createBranch(
          command.name,
          command.switch !== undefined ? { switch: command.switch } : undefined,
        );
        await this.replyMutation(requestId, result);
        return;
      }
      case "stage": {
        if (typeof git.stage !== "function") {

          this.reply(requestId, { ok: false, reason: STAGE_UNAVAILABLE_REASON });
          return;
        }
        await this.replyMutation(requestId, await git.stage(command.paths));
        return;
      }
      case "unstage": {
        if (typeof git.unstage !== "function") {
          this.reply(requestId, { ok: false, reason: STAGE_UNAVAILABLE_REASON });
          return;
        }
        await this.replyMutation(requestId, await git.unstage(command.paths));
        return;
      }
      case "stage_all": {
        await this.replyMutation(requestId, await git.stageAll());
        return;
      }
      case "commit": {
        const result = await git.commit(command.message);
        if (result.ok) {
          this.reply(requestId, { ok: true, kind: "commit", sha: result.value.sha });
          await this.publishFreshStatus();
        } else {
          this.reply(requestId, { ok: false, reason: result.reason });
        }
        return;
      }
      // ── destructive tail (slice 5.8). The command TYPE already carries
      // `confirmed: true` (zod is the boundary; the bridge re-checks NOTHING —

      // OPTIONAL port method: fail-closed presence-check (mirror of stage/unstage),
      // then replyMutation inherits queue/flood/single-flight/fresh-status-follow.
      case "discard": {
        if (typeof git.discard !== "function") {
          this.reply(requestId, { ok: false, reason: DISCARD_UNAVAILABLE_REASON });
          return;
        }
        await this.replyMutation(requestId, await git.discard(command.paths));
        return;
      }
      case "stash_push": {
        if (typeof git.stashPush !== "function") {
          this.reply(requestId, { ok: false, reason: STASH_UNAVAILABLE_REASON });
          return;
        }
        const opts: { message?: string; includeUntracked?: boolean } = {};
        if (command.message !== undefined) {
          opts.message = command.message;
        }
        if (command.includeUntracked !== undefined) {
          opts.includeUntracked = command.includeUntracked;
        }
        await this.replyMutation(requestId, await git.stashPush(opts));
        return;
      }
      case "stash_pop": {
        if (typeof git.stashPop !== "function") {
          this.reply(requestId, { ok: false, reason: STASH_UNAVAILABLE_REASON });
          return;
        }
        await this.replyMutation(requestId, await git.stashPop());
        return;
      }
      case "reset": {
        if (typeof git.resetHead !== "function") {
          this.reply(requestId, { ok: false, reason: RESET_UNAVAILABLE_REASON });
          return;
        }
        await this.replyMutation(requestId, await git.resetHead(command.mode));
        return;
      }
      default: {
        // Exhaustiveness guard: a new GitCommand op fails to compile here (matches
        // the codebase's exhaustive-never discipline, lesson 4.4-T).
        const _exhaustive: never = command;
        void _exhaustive;
        return;
      }
    }
  }
}

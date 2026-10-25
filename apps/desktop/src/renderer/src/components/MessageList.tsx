/**

 * mutates only the tail block in practice (rAF-batched flush in store.ts
 * patches an existing block by id/toolCallId rather than reshuffling the
 * array), and every block kind is keyed by its stable `id`/`toolCallId` so
 * React reuses DOM nodes/component state across those in-place updates
 * instead of remounting the whole list on every delta flush.
 *
 * R3 turn liveness (ui-roadmap §4-R3): while a turn runs and the tail block
 * isn't itself a live signal (streaming prose/reasoning, or a proposed/
 * running tool card), a `WorkingRow` shows at the tail — the app's pulse
 * during the post-send/inter-tool dead gaps. Genuine live appends get a
 * one-shot `message-enter`; bulk hydration and tab switches do not (the
 * whole column breathes in as one `fade-in` instead). A `role="status"`
 * region outside the aria-live column announces turn start/end exactly once.
 */
import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type {
  ConnectionPhase,
  ErrorRetryMeta,
  RetryOffer,
  ToolCallBlock,
  ToolCallCardStatus,
  TranscriptBlock,
  TurnState,
} from "../store.js";
import type { WireCheckpointMeta } from "../../../shared/protocol.js";
import { TabContext } from "../tab-context.js";
import { isReplaySurface, replayStore } from "../replay.js";
import { matchCheckpointsToTurns } from "./checkpoint-model.js";
import { ChildReportBlock } from "./ChildReportBlock.js";
import { COMPOSER_INSERT_EVENT } from "./Composer.js";
import { ImageViewer } from "./ImageViewer.js";
import { Markdown } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { TodoPanel } from "./TodoPanel.js";
import {
  TranscriptMinimap,
  activeMarkIndex,
  createUserTurnsSelector,
  rewindUserTurnTexts,
  shouldShowMinimap,
  type UserTurnsSelector,
} from "./TranscriptMinimap.js";
import { PreviewConsoleRow } from "./PreviewConsoleRow.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { ToolCallStack } from "./ToolCallStack.js";
import { WorkingRow, formatElapsed, getTurnStartedAt } from "./WorkingRow.js";
import { formatBlockTime } from "../block-time.js";
import { formatUsageLimitReset } from "../provider-notices.js";

/** ≥ this many new blocks in one render = bulk (hydration/replay), not a live append. */
const BULK_APPEND_THRESHOLD = 3;

/** Tail-liveness predicate (design §3) — exported pure for unit tests. */
export function isTailLive(block: TranscriptBlock | undefined): boolean {
  if (block === undefined) {
    return false;
  }
  return (
    block.kind === "assistant_text" ||
    block.kind === "reasoning" ||
    (block.kind === "tool_call" && (block.status === "proposed" || block.status === "running"))
  );
}

/**
 * TASK.31 — Stack consecutive tool-call cards (design: pure renderer-derived
 * projection over `TranscriptBlock[]`). When the agent explores a project it
 * tends to fire a series of adjacent tool calls (Bash, Read, Grep, often a
 * MIXED run); grouping them into a collapsible stack declutters the feed
 * WITHOUT touching store state, SQLite history, core events or block order —
 * the projection is a view-time transform only, computed each render. A
 * single-tool run is just a special case of this rule.
 *
 * Invariants (TASK.31.md §DoD):
 *  - adjacency, ANY toolName: every neighbouring terminal `tool_call` stacks,
 *    regardless of tool name. Any other kind, or a gap, closes the stack.
 *  - terminal-only: `proposed`/`running` cards never stack (active work must
 *    stay visible). `isTerminalStatus` is the single predicate.
 *  - minimum 2: a lone eligible card is returned as `single`, never wrapped —
 *    the card renders exactly as it does today.
 *  - honest aggregate: `success` iff every member is `success`; otherwise the
 *    badge reports the failed count. No invented duration/token totals
 *    (`ToolCallBlock` carries no timestamps).
 *  - honest label: a mixed-type stack never masquerades as one tool name —
 *    `stackHeaderLabel` shows a compact rundown of the member tool names (or
 *    a neutral "Tool calls" fallback for a very diverse run).
 *
 * All exported for direct unit testing (pure, no DOM) — same posture as
 * `isTailLive`/`isAtBottom` above.
 */

/** Terminal `ToolCallCardStatus` values (settled outcomes only). `proposed`/`running` are live, not terminal. */
export function isTerminalStatus(status: ToolCallCardStatus): boolean {
  return status !== "proposed" && status !== "running";
}

/** Aggregate of a stack: `success` iff every member settled `success`; otherwise `mixed`. */
export type ToolStackStatus = "success" | "mixed";

export function aggregateStackStatus(blocks: ToolCallBlock[]): ToolStackStatus {
  return blocks.every((block) => block.status === "success") ? "success" : "mixed";
}

/** Collapsed-stack badge copy — honest per-status, no invented totals. `success` only if none failed; a fully-failed stack reports `Failed`; a mix reports the failed count. */
export function stackBadgeText(blocks: ToolCallBlock[]): string {
  const failed = blocks.filter((block) => block.status !== "success").length;
  if (failed === 0) {
    return "Success";
  }
  if (failed === blocks.length) {
    return "Failed";
  }
  return `${failed} failed`;
}

/** Count label for the collapsed stack header: "2 calls" / "3 calls". (A stack always has ≥2 members; the singular form exists only for completeness/defense.) */
export function stackLabel(count: number): string {
  return `${count} call${count === 1 ? "" : "s"}`;
}

/**
 * Collapsed-stack header label (TASK.31 §DoD invariant 5 — "never masquerade
 * as one tool name"). For a single-tool run the tool name stands alone
 * (e.g. `Bash`); for a mixed run the header shows a compact rundown of the
 * DISTINCT member tool names in first-appearance order, capped at 2 names with
 * a "+N" tail (e.g. `Bash, Read +1`) and a neutral `Tool calls` fallback once
 * the run spans 4+ distinct tools (so a very diverse run never overflows the
 * collapsed row). The count rides separately in `.tool-call-stack-count`.
 */
export function stackHeaderLabel(blocks: ToolCallBlock[]): string {
  const names: string[] = [];
  for (const block of blocks) {
    if (!names.includes(block.toolName)) {
      names.push(block.toolName);
    }
  }
  if (names.length === 1) {
    return names[0]!;
  }
  if (names.length >= 4) {
    return "Tool calls";
  }
  // 2 or 3 distinct names.
  const head = names.slice(0, 2);
  const extra = names.length - head.length;
  return extra > 0 ? `${head.join(", ")} +${extra}` : head.join(", ");
}

/** CSS class suffix for the stack's aggregate badge — mirrors the single-card `.tool-call-status-*` tint family. */
export function stackStatusClass(blocks: ToolCallBlock[]): string {
  return aggregateStackStatus(blocks) === "success" ? "tool-call-status-success" : "tool-call-status-error";
}

/**
 * One render item produced by `groupTranscriptBlocks`: either a single block
 * of any kind (rendered by the existing per-kind path) or a stack of ≥2
 * adjacent terminal `tool_call` blocks (any mix of tool names — the header
 * label is derived from the members via `stackHeaderLabel`).
 */
export type RenderItem =
  | { kind: "single"; block: TranscriptBlock }
  | { kind: "tool_stack"; blocks: ToolCallBlock[]; status: ToolStackStatus };

/**
 * Linear-time grouping projection (TASK.31 §1). Walks the transcript once with
 * a `buffer` of adjacent terminal tool_calls; flushes a `tool_stack` when the
 * run ends AND the buffer holds ≥2, otherwise emits each buffered card as a
 * standalone `single` (invariant: a lone eligible card is never wrapped).
 * ANY adjacent terminal tool_call joins the run, regardless of toolName — a
 * single-tool run is just the special case where every member matches. Block
 * order and ids are preserved verbatim — the projection never reorders, drops
 * or synthesizes blocks.
 *
 * Single→stack transitions on the same React key are safe: a `single` item
 * carries no component state, so promoting it into a stack (or demoting a
 * stack back to singles after a rewind) loses nothing.
 */
export function groupTranscriptBlocks(blocks: TranscriptBlock[]): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: ToolCallBlock[] = [];

  const flush = (): void => {
    if (buffer.length >= 2 && buffer[0] !== undefined) {
      items.push({
        kind: "tool_stack",
        blocks: buffer,
        status: aggregateStackStatus(buffer),
      });
    } else {
      for (const block of buffer) {
        items.push({ kind: "single", block });
      }
    }
    buffer = [];
  };

  for (const block of blocks) {
    if (block.kind === "tool_call" && isTerminalStatus(block.status)) {
      // Adjacent terminal tool_call — extend the current run (any toolName).
      buffer.push(block);
      continue;
    }
    // Any other kind, or a non-terminal tool_call (proposed/running): the run
    // is broken — flush, then emit this block as a plain single.
    flush();
    items.push({ kind: "single", block });
  }
  flush();
  return items;
}

/** Basename of a workspace path — same rule as Sidebar's/SessionHeader's private twins. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * R11 starter chips (roadmap §4-R11(b)) — STATIC by design: no git-history
 * IPC exists, so these are honest generics, not personalization theater.
 * `label` renders on the chip; `insert` is what lands in the composer draft.
 */
export const STARTER_CHIPS: readonly { label: string; insert: string }[] = [
  {
    label: "Explain this codebase",
    insert: "Give me a tour of this codebase — the architecture, the key modules, and how they fit together.",
  },
  {
    label: "Fix a failing test",
    insert: "Run the test suite, pick one failing test, explain why it fails, and fix it.",
  },
  {
    label: "Review my latest diff",
    insert: "Review my working-tree diff and point out bugs, risks, or cleanups before I commit.",
  },
];

/**
 * The one line a compaction card shows (TASK.227). Kept a pure function of the
 * block so the wording is pinnable without mounting the list, and so the three
 * states read as one decision rather than three nested ternaries in JSX.
 *
 * Running says which compaction it is, because the two have different causes a
 * user needs to tell apart: one they asked for, one the context window forced.
 * Done reports both readings — the point of the row is that the meter fell for
 * a REASON, so the reason carries the numbers. A missing `postTokens` prints
 * "?" rather than a zero: the host declined to say, and inventing a number here
 * would be a worse answer than admitting it.
 *
 * The not-ok branch never says "failed": `compaction_end` carries one `error`
 * string for both outcomes, and the commonest one is a deliberate no-op
 * (context/manager.ts's empty-prefix return, whose own comment reads "nothing
 * to compact. Not a failure."). Calling that a failure would be a claim the
 * wire does not support — the CLI hedges the same ambiguity as "compaction
 * skipped/failed" (cli/render.ts). "Not applied" states the one thing that IS
 * certain of both, and leaves the verb to the host's own reason instead of
 * stuttering over it ("skipped/failed: compaction skipped: …", live 07.09).
 */
export function compactionRowText(block: Extract<TranscriptBlock, { kind: "compaction" }>): string {
  if (block.status === "running") {
    return block.trigger === "auto"
      ? "Context window full — compacting conversation…"
      : "Compacting conversation…";
  }
  if (block.status === "failed") {
    return `Compaction not applied: ${block.error ?? "unknown error"}`;
  }
  const pre = block.preTokens ?? "?";
  const post = block.postTokens ?? "?";
  return `Conversation compacted: ${pre} → ${post} tokens`;
}

/**
 * Empty-state gate: zero blocks, no running turn (a running zero-block turn
 * shows the WorkingRow instead) and NOT a replay surface (TASK.188 S14). On a
 * rewound film an empty list is the opening frame, not an empty session: the
 * "What are we building?" onboarding is an invitation addressed to the author
 * of a blank session, and its chips write into the composer of the session
 * being filmed — neither belongs on a transcript that is about to play itself
 * back. `replaying` is REQUIRED rather than defaulted: a default would be
 * fail-open, letting a future caller draw the onboarding over a replay by
 * forgetting the argument. Read-only surfaces (`readOnly`, e.g. a finished
 * child session's transcript viewed from its parent) are likewise suppressed:
 * the onboarding is an invitation to compose, and a read-only feed has no
 * composer to write into. Exported for unit testing.
 */
export function shouldShowTranscriptEmpty(
  blockCount: number,
  running: boolean,
  replaying: boolean,
  readOnly: boolean = false,
): boolean {
  return blockCount === 0 && !running && !replaying && !readOnly;
}

/** Sticky-follow (F17) distance-from-bottom threshold, px — within this band a scroll position still counts as "at bottom" (a streaming tail block growing by a few px per flush must not read as a manual scroll-up). */
export const FOLLOW_THRESHOLD_PX = 48;

/**
 * Sticky-follow bottom predicate (design §3.1) — exported pure for unit tests
 * and reused verbatim by the automation probe (single source of truth so the
 * probe cannot drift from the product behavior). Clamped so a non-overflowing
 * container (scrollHeight <= clientHeight) always reads as at-bottom.
 */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = FOLLOW_THRESHOLD_PX,
): boolean {
  const distance = Math.max(0, scrollHeight - scrollTop - clientHeight);
  return distance <= threshold;
}

/** Jump-to-latest chip visibility gate (design §3.1) — exported pure for unit tests. */
export function shouldShowJumpButton(follow: boolean, blockCount: number): boolean {
  return !follow && blockCount > 0;
}

/**
 * Snap-dedup helper (codex P7.3-F finding 4) — given the container's current
 * geometry and whether a write was already flushed this frame, returns
 * whether a `scrollTop = scrollHeight` write is actually needed. Reused by
 * both the post-commit effect and the ResizeObserver callback so a single
 * streaming frame that fires both never does the read+write twice: once
 * already-at-bottom (within FOLLOW_THRESHOLD_PX) there is nothing left to
 * snap, and a frame-scoped guard skips the second caller outright. Exported
 * pure for unit tests.
 */
export function needsSnap(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  alreadySnappedThisFrame: boolean,
): boolean {
  if (alreadySnappedThisFrame) {
    return false;
  }
  return !isAtBottom(scrollTop, scrollHeight, clientHeight, 0);
}

/**
 * "(failed after N attempts)" terminal error-card suffix (TASK.33 W8) —
 * mirrors `cli/render.ts`'s error-line wording verbatim (same event.retry
 * shape, same "only surfaced when at least one retry actually happened"
 * gate) so the desktop and CLI report an identical failure the same way.
 * Exported for unit testing.
 */
export function formatErrorRetrySuffix(retry: ErrorRetryMeta | undefined): string {
  return retry && retry.attemptsMade > 0
    ? ` (failed after ${retry.attemptsMade} attempt${retry.attemptsMade === 1 ? "" : "s"})`
    : "";
}

/**
 * One `stream_retry` transcript line's text (TASK.33 W8) — mirrors
 * `cli/render.ts`'s `[retry N/M in Xms: reason]` wording. Exported for unit
 * testing.
 *
 * Taskana 4772 review F5: `waitedMs` (a retry after a recovered network
 * wait) renders as "now (network back after N s)" — the wait duration was
 * already spent, never a pending delay.
 */
export function formatStreamRetryLine(
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  reason: string,
  waitedMs?: number,
): string {
  if (waitedMs !== undefined) {
    return `Retry ${formatRetryAttempt(attempt, maxAttempts)} now (network back after ${formatDelaySeconds(waitedMs)}): ${reason}`;
  }
  return `Retry ${formatRetryAttempt(attempt, maxAttempts)} in ${formatDelaySeconds(delayMs)}: ${reason}`;
}

/** Taskana 4772: a retry delay in seconds, one decimal (`0.8 s`), mirroring cli/render.ts. */
export function formatDelaySeconds(delayMs: number): string {
  return `${(delayMs / 1000).toFixed(1)} s`;
}

/**
 * `N/M`, or just `N` once the attempt is past the announced total: a retry
 * granted by the transient-network budget (Taskana 4705) can outlive maxRetries,
 * and "9/8" would be a lie.
 */
export function formatRetryAttempt(attempt: number, maxAttempts: number): string {
  return attempt > maxAttempts ? `${attempt}` : `${attempt}/${maxAttempts}`;
}

/**
 * Try-again button visibility (TASK.33 W8): shown ONLY on the specific
 * `loop_end` block the armed offer names (`RetryOffer.loopEndBlockId`) — an
 * older failed turn's button (still sitting in transcript history) never
 * reappears once a newer turn supersedes it. The retryable/hadModelOutput
 * gate itself is already baked into whether `retry` is non-null at all (the
 * store's `loop_end` reducer only arms it when both hold) — this predicate
 * just answers "is THIS the block it belongs to". TASK.33 W8-FIX #1: also
 * requires `connection === "ready"` — `setHostExited` (store.ts) preserves
 * the armed offer across a dropped connection, so without this the button
 * would stay clickable while there is no port to send on
 * (`dispatchTryAgain`'s own readiness guard would then just no-op the click,
 * confusingly). Exported for unit testing.
 */
export function showTryAgainButton(retry: RetryOffer | null, blockId: string, connection: ConnectionPhase): boolean {
  return retry !== null && retry.loopEndBlockId === blockId && connection === "ready";
}

/**
 * Taskana 4111: the one-shot Continue offer shows ONLY on its own max_turns
 * loop_end row, only when the connection is live and the prompt queue is
 * empty (a held queue's Resume banner is the continue then).
 */
export function showContinueButton(
  continueOffer: { loopEndBlockId: string } | null,
  blockId: string,
  connection: ConnectionPhase,
  promptQueueLength: number,
): boolean {
  return (
    continueOffer !== null &&
    continueOffer.loopEndBlockId === blockId &&
    connection === "ready" &&
    promptQueueLength === 0
  );
}

/**
 * Standalone fallback Try-again row visibility (TASK.33 FIX-A): a host
 * respawn (`performReset` + hydration, store.ts) wipes the transcript and
 * rebuilds it from persisted history, whose block ids never include the
 * live-minted `loop_end:${turnId}` the armed offer names — so
 * `showTryAgainButton` above can never find its anchor again post-respawn.
 * This predicate is the mirror image: true exactly when the offer is armed,
 * the connection is ready to send, and NO block in the current transcript
 * carries the offer's `loopEndBlockId` (the anchor is genuinely gone, not
 * just off-screen). Mutually exclusive with the anchored button by
 * construction — when the anchor block IS present, this is false and only
 * the anchored button renders. Exported for unit testing.
 */
export function showStandaloneRetry(
  retry: RetryOffer | null,
  blocks: readonly TranscriptBlock[],
  connection: ConnectionPhase,
): boolean {
  return retry !== null && connection === "ready" && !blocks.some((b) => b.id === retry.loopEndBlockId);
}

/**
 * Minimap scroll-spy core (TASK.48 / 4086 follow-up) — exported pure for unit
 * tests. Given the monotone `top`s of the USER BUBBLES (`.message-user
 * [data-block-id]`, one per non-system user turn, DOM order == mark order)
 * and the container's box, returns the index of the last bubble whose top
 * sits above the container's vertical midpoint (null when none exist).
 * Binary search keeps a tick at O(log n) layout reads on a long transcript:
 * `topAt` is called lazily, only for the probed indices, so the caller can
 * pass a live `getBoundingClientRect` reader. The approximation is by design
 * (brief §4.4).
 */
export function topmostVisibleUserIndex(
  count: number,
  topAt: (index: number) => number,
  containerTop: number,
  containerHeight: number,
): number | null {
  const midpoint = containerTop + containerHeight / 2;
  if (count === 0) {
    return null;
  }
  let lo = 0;
  let hi = count - 1;
  let candidate: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) <= midpoint) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate;
}

export function MessageList({
  blocks,
  turn,
  workspace,
  connection,
  retry,
  onTryAgain,
  continueOffer,
  onContinue,
  promptQueueLength,
  readOnly = false,
  rewind,
}: {
  blocks: TranscriptBlock[];
  turn: TurnState;
  workspace: string | null;
  /** TASK.33 W8-FIX #1: gates the rendered Try-again button on connection readiness. */
  connection: ConnectionPhase;
  /** TASK.33 W8 armed one-shot Try-again offer; null when nothing to offer. */
  retry: RetryOffer | null;
  /** TASK.33 W8: consumes `retry` and re-sends its content through the normal send/queue/busy path. */
  onTryAgain: () => void;
  /** Taskana 4111: armed one-shot Continue offer on a max_turns loop_end; null when nothing to offer. */
  continueOffer: { loopEndBlockId: string } | null;
  /** Taskana 4111: consumes `continueOffer` and sends the fixed continuation message. */
  onContinue: () => void;
  /** Taskana 4111: gates the Continue button off while a held queue's Resume banner is the continue. */
  promptQueueLength: number;
  /** Read-only transcript surface (e.g. child history): suppresses the transcript-empty onboarding. */
  readOnly?: boolean;
  /**
   * Taskana 4742 §2.5: optional rewind plumbing for the tick rail's popover
   * action. Absent (child panes, existing tests, engines without
   * supportsRewind) -> no Rewind buttons at all. The checkpoint list is the
   * tab store's on-demand `checkpoints`; `onRewind` sends the existing
   * `rewind_request` (App wires send(buildRewindRequest(...))).
   */
  rewind?: {
    checkpoints: readonly WireCheckpointMeta[];
    onRewind(checkpointId: string): void;
  };
}) {
  // codex P7.3-F2 finding 2: the automation transcript-scroll probe
  // (automation.ts's transcriptScrollState/transcriptScrollTo) must be able to
  // tell THIS tab's `.message-list` apart from a still-mounted previous
  // active tab's node during the store-update-to-React-commit gap (tabs-store
  // flips activeTabId synchronously; this component's own commit for the new
  // tab lands a render tick later). Reading tabId off TabContext (rather than
  // threading a new prop through App.tsx, which is out of scope here) costs
  // nothing extra — MessageList is only ever mounted inside the active tab's
  // `<TabContext.Provider>` (App.tsx's ActiveTabBody). Optional-chained since
  // no render test wraps this component in a provider.
  const tabId = useContext(TabContext)?.tabId ?? null;
  // TASK.188 S14: "is this list a replay surface" is DERIVED here, from the
  // same tab context, rather than passed down by each owner — the root's list
  // and a replayed child's pane are both rendered under the armed tab's
  // provider (the recorded child has no tab of its own), so one question
  // covers both and any list mounted later. Off replay nothing is ever armed,
  // so the selector is a constant `false` and adds no re-renders.
  const replaying = useStore(replayStore, (state) => isReplaySurface(state, tabId));
  // Stream-in bookkeeping (design §1.3): blocks present at first render (tab
  // switch — App keys this component by tabId — or initial mount) and bulk
  // arrivals (session hydration lands many blocks in one render) never get
  // the enter animation; genuine live appends (1–2 per rAF flush) do.
  // enterIds membership is permanent so the class never flips off mid-
  // animation. Render-time ref mutation is idempotent per block id (a
  // re-render with the same blocks mutates nothing).
  const firstRenderRef = useRef(true);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const enterIdsRef = useRef<Set<string>>(new Set());
  const hasRunRef = useRef(false);

  // Sticky-follow (F17, design §3.1): follow lives in a ref so a scroll tick
  // never re-renders by itself; the mirrored useState exists ONLY to flip the
  // jump-button's visibility, and is set exclusively on the boolean edge.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);

  // Taskana 4091 (TASK.84): the internal full-size image viewer. Opened by a
  // thumbnail click; the block id + clicked index are looked up from `blocks`
  // at render time, so a store replacement of the block (or its images)
  // while open is reflected without stale copies. Rendered as a SIBLING of
  // the role="log" column (last child of the root), so the live region never
  // announces viewer content.
  const [viewer, setViewer] = useState<{ blockId: string; index: number } | null>(null);
  const viewed = viewer !== null ? blocks.find((b) => b.id === viewer.blockId) : undefined;
  const viewedImages = viewed !== undefined && viewed.kind === "user_text" ? viewed.images ?? [] : [];

  // Minimap (TASK.48 / Taskana 4086): pure projection over `blocks` — no new
  // store state. 4086 follow-up: the selector is INCREMENTAL — per-turn
  // summaries are memoized by the identity of each turn's blocks, so a
  // streaming delta to the tail reprojects only the turn being streamed
  // instead of the whole transcript (see createUserTurnsSelector). One
  // selector per mounted list, in a ref (never module state: two tabs must
  // not share a cache). The active-mark index is mirrored into state ONLY on
  // edge changes (scroll-spy below), so a scroll tick never re-renders for
  // nothing.
  const turnsSelectorRef = useRef<UserTurnsSelector | null>(null);
  if (turnsSelectorRef.current === null) {
    turnsSelectorRef.current = createUserTurnsSelector();
  }
  const minimapMarks = useMemo(() => turnsSelectorRef.current!(blocks), [blocks]);
  // Taskana 4742: per-mark checkpoint ids for the rail popover's Rewind
  // action (label + chronological matching, checkpoint-model.ts). Memoized on
  // [blocks, rewind?.checkpoints] — the checkpoints array is store-stable
  // between renders (replaced only on checkpoint_list), and blocks identity
  // changes only on real transcript updates. Absent rewind prop -> no ids,
  // no buttons.
  const rewindCheckpoints = rewind?.checkpoints;
  const rewindCheckpointIds = useMemo(
    () => (rewindCheckpoints !== undefined ? matchCheckpointsToTurns(rewindUserTurnTexts(blocks), rewindCheckpoints) : []),
    [rewindCheckpoints, blocks],
  );
  const [minimapActive, setMinimapActive] = useState<number | null>(null);

  // Finding 1 (codex P7.3-F): a jump-to-latest smooth scroll must not get
  // stomped by the very next post-commit snap effect — while a smooth scroll
  // animates, the plain-effect/RO snap below is suppressed until the browser
  // reports "scrollend" (or a fallback timer, since not every environment
  // fires it) so the animation is genuinely visible instead of being
  // instant-cancelled mid-flight on the next re-render/RO tick.
  const suppressSnapRef = useRef(false);

  // Finding 4 (codex P7.3-F): a single streaming frame can commit AND fire
  // the ResizeObserver in the same tick — this per-frame flag lets whichever
  // fires first do the scrollHeight-read + scrollTop-write, and the other
  // skip it via needsSnap rather than repeating identical layout work.
  const snappedThisFrameRef = useRef(false);

  /** Single snap implementation shared by the effect and the ResizeObserver — reads geometry once, writes once, dedups via needsSnap. */
  const snapToBottom = (): void => {
    const el = containerRef.current;
    if (!el || !followRef.current) {
      return;
    }
    if (!needsSnap(el.scrollTop, el.scrollHeight, el.clientHeight, snappedThisFrameRef.current)) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    snappedThisFrameRef.current = true;
    // Cleared at the START of the next frame (not a microtask) so it stays
    // true across BOTH the synchronous layout effect and the browser's own
    // ResizeObserver callback, which the spec runs later in the same
    // rendering opportunity — a microtask could flush between the two and
    // defeat the dedup it exists for.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        snappedThisFrameRef.current = false;
      });
    } else {
      snappedThisFrameRef.current = false;
    }
  };

  /**
   * Minimap scroll-spy tick (shared by the scroll handler, the mount/turn-
   * count effect and post-jump highlight — see topmostVisibleUserIndex for
   * the pure core). Index-only state, written just on the edge.
   */
  const spyActiveMark = (): void => {
    const el = containerRef.current;
    if (!el || minimapMarks.length === 0) {
      return;
    }
    const bubbles = el.querySelectorAll<HTMLElement>(".message-user[data-block-id]");
    const candidate = topmostVisibleUserIndex(
      bubbles.length,
      (i) => bubbles[i]!.getBoundingClientRect().top,
      el.getBoundingClientRect().top,
      el.clientHeight,
    );
    // Above the first bubble still highlights turn 1 (nothing earlier exists).
    const nextActive = activeMarkIndex(minimapMarks, candidate ?? (bubbles.length > 0 ? 0 : null));
    setMinimapActive((prev) => (prev === nextActive ? prev : nextActive));
  };

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const next = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (followRef.current !== next) {
      followRef.current = next;
      setFollow(next);
    }
    spyActiveMark();
  };

  // Snap to bottom after every commit while following (design §3.1): streaming
  // patches the tail block per rAF flush, each flush re-renders, so a no-dep
  // layout effect keeps the transcript pinned without a scroll-position
  // re-implementation. Layout phase = no visible flicker; instant (not smooth)
  // so the snap never lags the next delta.
  useLayoutEffect(() => {
    if (suppressSnapRef.current) {
      return;
    }
    snapToBottom();
  });

  // Async layout (syntax highlighting, image/markdown late sizing) can grow
  // content height WITHOUT a React commit; re-snap on that too, guarded by
  // the same follow ref. Mounted once per component lifetime. Observes BOTH
  // the column (content growth) AND the container itself (finding 2: the
  // container can shrink — composer/terminal expanding, window resize —
  // without the column changing at all, and that must still re-pin the tail).
  useLayoutEffect(() => {
    const column = columnRef.current;
    const container = containerRef.current;
    if (!column || !container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (suppressSnapRef.current) {
        return;
      }
      snapToBottom();
    });
    observer.observe(column);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 4086 follow-up: highlight the active dot from the START, not only after
  // the first scroll. The same spy runs (a) when the minimap first mounts —
  // a hydrated long session opens mid-transcript with the correct dot lit
  // before any user scroll — and (b) whenever the TURN COUNT changes (a new
  // question appends or a rewind drops turns; the count is the cheap edge —
  // identity of the memoized marks array changes on every streaming flush,
  // which is exactly what we do NOT want to re-spy on). rAF so the browser
  // has laid the just-committed DOM out before the rects are read (and the
  // sticky-follow snap for this same commit has settled).
  const minimapTurnCount = minimapMarks.length;
  useLayoutEffect(() => {
    // Runs exactly when the minimap is visible: the 2→3 edge IS its mount
    // (shouldShowMinimap gates the render below), and every later count
    // change re-runs the spy; below 3 there is no pill to highlight.
    if (!shouldShowMinimap(minimapTurnCount)) {
      return;
    }
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => spyActiveMark()) : undefined;
    return () => {
      if (raf !== undefined) {
        cancelAnimationFrame(raf);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spyActiveMark closes over the CURRENT marks; re-running only on the count edge keeps streaming renders cheap (the brief's point) while still catching new turns.
  }, [minimapTurnCount]);

  const jumpToLatest = (): void => {
    const el = containerRef.current;
    // Finding 3 (codex P7.3-F): the chip is about to unmount (follow flips
    // true -> shouldShowJumpButton hides it), which would otherwise drop
    // focus to <body> for a keyboard activation (Enter/Space on the chip).
    // The container is the only other on-screen element that makes sense as
    // a landing spot for "you just jumped the transcript to the tail" —
    // tabIndex=-1 on it makes it programmatically focusable without adding a
    // tab stop, and preventScroll avoids fighting the scrollTo below.
    el?.focus({ preventScroll: true });
    followRef.current = true;
    setFollow(true);
    if (!el) {
      return;
    }
    const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Finding 1 (codex P7.3-F): suppress the post-commit/RO snap while the
    // smooth scroll animates so it isn't instant-cancelled on the very next
    // render (setFollow(true) above triggers one). Cleared on the browser's
    // own "scrollend" signal, with a fallback timer for engines that don't
    // fire it (older WebKit/jsdom) so a stalled clear can't wedge the
    // sticky-follow snap forever.
    suppressSnapRef.current = true;
    let cleared = false;
    const clearSuppress = (): void => {
      if (cleared) {
        return;
      }
      cleared = true;
      suppressSnapRef.current = false;
      el.removeEventListener("scrollend", clearSuppress);
      window.clearTimeout(fallbackTimer);
    };
    el.addEventListener("scrollend", clearSuppress);
    const fallbackTimer = window.setTimeout(clearSuppress, 700);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  /** F1b: scroll a tool_call card into view by its `data-block-id` (TodoPanel row click). */
  const jumpToBlock = (blockId: string): void => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const target = el.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!target) {
      return;
    }
    // TASK.31 regression fix: if the match is a collapsed-stack anchor, the
    // member card is hidden inside a collapsed `ToolCallStack` and
    // scrollIntoView is a no-op on the `display:none` span. Expand the stack
    // first (a real button click on its toggle), then, once React has committed
    // the expanded body and the browser has laid it out, scroll to the now-
    // visible inner card. Two rAFs: the first resolves after the React commit
    // flush from the click's setState, the second after the resulting layout
    // pass — matching MessageList's own post-commit sticky-follow timing.
    const stack = target.closest(".tool-call-stack");
    if (stack instanceof HTMLElement && target.classList.contains("tool-call-stack-anchor")) {
      const toggle = stack.querySelector<HTMLButtonElement>(".tool-call-stack-toggle");
      toggle?.click();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const card = el.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
          card?.scrollIntoView({ block: "center", behavior: "auto" });
          // 4086 follow-up: the jump landed — re-run the scroll-spy so the
          // active dot reflects the destination immediately (the plain
          // scrollIntoView path fires no scrollend we can await portably).
          spyActiveMark();
        });
      });
      return;
    }
    const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      // Instant path: layout settles synchronously, spy right away.
      target.scrollIntoView({ block: "center", behavior: "auto" });
      spyActiveMark();
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    // 4086 follow-up: re-run the scroll-spy once the smooth scroll settles —
    // "scrollend" is not universally fired (older WebKit), so the timer
    // fallback keeps the highlight from wedging; scrollend clears the timer.
    let settled = false;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      el.removeEventListener("scrollend", settle);
      window.clearTimeout(fallbackTimer);
      spyActiveMark();
    };
    el.addEventListener("scrollend", settle);
    const fallbackTimer = window.setTimeout(settle, 700);
  };

  const isFirstRender = firstRenderRef.current;
  firstRenderRef.current = false;
  const seenIds = seenIdsRef.current;
  const enterIds = enterIdsRef.current;
  const newBlocks = blocks.filter((block) => !seenIds.has(block.id));
  const isBulk = isFirstRender || newBlocks.length >= BULK_APPEND_THRESHOLD;
  for (const block of newBlocks) {
    seenIds.add(block.id);
    if (!isBulk) {
      enterIds.add(block.id);
    }
  }
  const enterClass = (id: string): string => (enterIds.has(id) ? " message-enter" : "");

  const running = turn.status === "running";
  if (running) {
    hasRunRef.current = true;
  }
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
  const showWorkingRow = running && !isTailLive(last);
  // Query the clock on EVERY running render (not just when the row shows) so
  // the turn-start stamp anchors before the first suppression gap ends.
  const startedAt = running && turn.turnId !== null ? getTurnStartedAt(turn.turnId) : null;

  return (
    <div
      className={"message-list" + (shouldShowMinimap(minimapMarks.length) ? " message-list-has-rail" : "")}
      ref={containerRef}
      onScroll={handleScroll}
      tabIndex={-1}
      data-tab-id={tabId ?? undefined}
    >
      <TodoPanel transcript={blocks} onJumpToBlock={jumpToBlock} />
      {/* TASK.48 / Taskana 4086 + 4742: LEFT-edge tick rail (evolved from
          the right-edge dot pill). FIRST-child position (beside TodoPanel)
          on purpose: a `top`-sticky box only gets pushed DOWN to its inset,
          so as the last child it sat at the content end — off-screen unless
          scrolled to the bottom, and it grew the scroll height. height:0 +
          pointer-events:none keep it out of .message-column's layout; the
          message-list-has-rail modifier above reserves the left gutter so
          the centred column never slides under the rail. */}
      {shouldShowMinimap(minimapMarks.length) && (
        <div className="minimap-slot">
          <TranscriptMinimap
            marks={minimapMarks}
            activeIndex={minimapActive}
            onJump={jumpToBlock}
            {...(rewind !== undefined
              ? { rewind: { checkpointIds: rewindCheckpointIds, onRewind: rewind.onRewind } }
              : {})}
          />
        </div>
      )}
      {/* Turn announcements (§4-R3(e)) live OUTSIDE the aria-live column: a
          status region nested inside it would double-announce, and the
          ticking working row (aria-hidden) must never reach SR. role=status
          announces text CHANGES only — boot is silent, and hasRunRef keeps
          the idle text empty until a turn has actually run in this tab. */}
      <div className="visually-hidden" role="status">
        {running ? "Assistant is working" : hasRunRef.current ? "Assistant finished" : ""}
      </div>
      {shouldShowTranscriptEmpty(blocks.length, running, replaying, readOnly) && (
        <div className="transcript-empty">
          {workspace && (
            <div className="transcript-empty-workspace" title={workspace}>
              {basename(workspace)}
            </div>
          )}
          <div className="transcript-empty-title">What are we building?</div>
          <div className="transcript-empty-chips">
            {STARTER_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="transcript-empty-chip"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent(COMPOSER_INSERT_EVENT, { detail: chip.insert }))
                }
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Centered measure column (design §2.1/§2.4): shares its horizontal
          center with the composer card below, both centered within the same
          main-pane, so conversation and composer read as one visual column.
          role="log" (R17 a11y): announces each newly appended block. The
          turn-boundary role="status" region above is a SIBLING (not nested), so
          the two live regions announce different things without double-speak. */}
      <div className="message-column" role="log" aria-live="polite" ref={columnRef}>
        {groupTranscriptBlocks(blocks).map((item) => {
          // TASK.31: a `tool_stack` item renders the collapsible stack
          // (≥2 adjacent terminal cards, regardless of toolName). Everything else
          // (including a lone eligible card, or a proposed/running card) flows
          // through the per-kind switch below unchanged. The render-item key
          // is the first member's id for a stack (stable across live appends
          // that grow the run) and the block id for a single — matching the
          // pre-grouping keys so React reuses nodes.
          if (item.kind === "tool_stack") {
            // `tool_stack` always holds ≥2 members (groupTranscriptBlocks
            // invariant); the head id is the stable React key. `!` is safe —
            // the projection guarantees length ≥2, and `return` here narrows
            // `item` to the `single` variant for the switch below.
            const head = item.blocks[0]!;
            return (
              <ToolCallStack
                key={head.id}
                blocks={item.blocks}
                enter={enterIds.has(head.id)}
              />
            );
          }
          const block = item.block;
          switch (block.kind) {
            case "user_text":
              // TASK.145 срез 2 (spec §4 point 3): a host-injected ("system"-
              // origin) turn renders as a compact system card, never the
              // ordinary user bubble — the model still sees this as a
              // `role:"user"` turn (owner decision, unchanged), only the
              // TRANSCRIPT view differs.
              if (block.origin === "system") {
                return <ChildReportBlock key={block.id} block={block} enter={enterIds.has(block.id)} />;
              }
              const userTime = formatBlockTime(block.at, Date.now());
              return (
                <div
                  key={block.id}
                  data-block-id={block.id}
                  className={`message message-user${enterClass(block.id)}`}
                >
                  <div className="message-label">
                    You
                    {userTime && (
                      <time className="block-time" title={userTime.title}>
                        {userTime.label}
                      </time>
                    )}
                  </div>
                  {block.text.length > 0 && <div className="message-text">{block.text}</div>}
                  {block.images?.length ? (
                    <div className="message-images">
                      {block.images.map((image, index) => (
                        <button
                          key={`${image.mediaType}:${index}`}
                          type="button"
                          className="message-image-button"
                          onClick={() => setViewer({ blockId: block.id, index })}
                          aria-label={`View attached image ${index + 1}`}
                        >
                          <img
                            className="message-image"
                            src={`data:${image.mediaType};base64,${image.data}`}
                            alt={`Attached image ${index + 1}`}
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            case "assistant_text":
              return (
                <div key={block.id} className={`message message-assistant${enterClass(block.id)}`}>
                  <div className="message-markdown">
                    <Markdown text={block.text} />
                  </div>
                </div>
              );
            case "reasoning":
              return (
                <ReasoningBlock
                  key={block.id}
                  block={block}
                  live={running && block.id === last?.id}
                  enter={enterIds.has(block.id)}
                />
              );
            case "tool_call":
              return (
                <div key={block.id} data-block-id={block.id}>
                  <ToolCallCard block={block} enter={enterIds.has(block.id)} />
                </div>
              );
            case "error":

              // so the failure detail (name/message) is legible in the transcript.
              return (
                <div key={block.id} className={`message message-error${enterClass(block.id)}`} role="alert">
                  <div className="message-label">Error</div>
                  <div className="message-text">
                    <span className="message-error-name">{block.error.name}</span>
                    {block.error.message ? `: ${block.error.message}` : ""}
                    {formatErrorRetrySuffix(block.retry)}
                  </div>
                </div>
              );
            case "usage_limit":
              return (
                <div key={block.id} className={`message message-error${enterClass(block.id)}`} role="alert">
                  <div className="message-label">Usage limit reached</div>
                  <div className="message-text">
                    Provider quota is exhausted. Resets at {formatUsageLimitReset(block.notice.resetAt)} (local time).
                  </div>
                </div>
              );
            case "stream_retry":
              return (
                <div key={block.id} className={`message message-retry${enterClass(block.id)}`}>
                  {formatStreamRetryLine(block.attempt, block.maxAttempts, block.delayMs, block.reason, block.waitedMs)}
                </div>
              );
            case "loop_end": {
              const endTime = formatBlockTime(block.at, Date.now());
              return (
                <div
                  key={block.id}
                  data-block-id={block.id}
                  title={endTime?.title}
                  className={`message message-loop-end${enterClass(block.id)}`}
                >
                  {block.reason === "max_turns"
                    // TASK.124: the turn cap is a decision point, not a setting
                    // — the ladder already granted (ceiling_grant rows above)
                    // or refused. Pointing at Settings would name an action
                    // that is no longer the one that happened.
                    ? `Stopped: turn limit reached (${block.turns} turns).`
                    : `Turn ended: ${block.reason} (${block.turns} turn${block.turns === 1 ? "" : "s"}${
                        block.durationMs !== undefined ? ` · ${formatElapsed(Math.round(block.durationMs / 1000))}` : ""
                      }${endTime ? ` · ${endTime.label}` : ""})`}
                  {showTryAgainButton(retry, block.id, connection) && (
                    <button type="button" className="retry-try-again-button" onClick={onTryAgain}>
                      Try again
                    </button>
                  )}
                  {showContinueButton(continueOffer, block.id, connection, promptQueueLength) && (
                    <button type="button" className="continue-button" onClick={onContinue}>
                      Continue
                    </button>
                  )}
                </div>
              );
            }
            // TASK.106 cut-2 §D5: the provider switch reads as what it is — a
            // session boundary (the host really was respawned), so it borrows
            // the loop-end divider's register rather than an error tint.
            case "connection_changed":
              return (
                <div
                  key={block.id}
                  data-block-id={block.id}
                  className={`message message-loop-end${enterClass(block.id)}`}
                >
                  {`Provider switched: ${block.fromLabel} → ${block.toLabel} · ${block.model}`}
                  {block.effortResetTo !== undefined ? ` · effort reset to ${block.effortResetTo}` : ""}
                </div>
              );
            // TASK.227: a compaction is a thing that HAPPENED to this
            // conversation, so it leaves a row where it happened instead of
            // only a toast that the next notice overwrites. Appended running
            // and patched in place when it ends — a tool_call's pending->result
            // shape, in the register the other system rows already use.
            case "compaction":
              return (
                <div
                  key={block.id}
                  data-block-id={block.id}
                  data-compaction-status={block.status}
                  className={`message ${block.status === "failed" ? "message-error" : "message-loop-end"}${enterClass(block.id)}`}
                  {...(block.status === "failed" ? { role: "alert" as const } : {})}
                >
                  {compactionRowText(block)}
                </div>
              );
            case "output_truncated":
              return (
                <div key={block.id} className="message message-error" role="alert">
                  Output truncated at the model token limit. Raise "Max output tokens" on this connection in Settings — reasoning
                  models spend part of that budget just thinking before they write anything.
                </div>
              );
            case "preview_console":
              return <PreviewConsoleRow key={block.id} block={block} enter={enterIds.has(block.id)} />;
            // Turn-ceiling grant (TASK.124 cut-1): minimal visibility row —
            // every extension of the turn cap must be visible, never silent.
            // The interactive "continue" affordance is cut-2.
            case "ceiling_grant":
              return (
                <div key={block.id} className={`message message-loop-end${enterClass(block.id)}`}>
                  Turn limit reached — extended by {block.granted} turn{block.granted === 1 ? "" : "s"}
                  {" "}(round {block.round}, total +{block.totalGranted}). Remaining:{" "}
                  {block.remaining.join("; ")}
                </div>
              );
            // Degenerate-generation guard (TASK.210): same "must be visible,
            // never silent" posture as ceiling_grant above — the model's own
            // output looped and this turn's stream was cut before it could
            // run the provider's output ceiling.
            case "degeneration":
              return (
                <div key={block.id} className="message message-error" role="alert">
                  Output loop detected ({block.channel} — a ~{block.period}-char phrase repeated {block.repeats}
                  {"×"}) — the turn was cut short.
                </div>
              );
            default: {
              const _exhaustive: never = block;
              return _exhaustive;
            }
          }
        })}
        {showWorkingRow && startedAt !== null && <WorkingRow startedAt={startedAt} />}
        {retry !== null && showStandaloneRetry(retry, blocks, connection) && (
          <div
            className="message message-loop-end message-retry-standalone"
            data-block-id={retry.loopEndBlockId}
          >
            The last message failed before any response.
            <button type="button" className="retry-try-again-button" onClick={onTryAgain}>
              Try again
            </button>
          </div>
        )}
      </div>
      {/* Sibling of the role="log" column (not nested): SR never announces
          this chip as transcript content (design §3.1 spec c). */}
      {shouldShowJumpButton(follow, blocks.length) && (
        <button
          type="button"
          className="jump-to-latest"
          aria-label="Scroll to latest"
          onClick={jumpToLatest}
        >
          ↓
        </button>
      )}
      {/* Taskana 4091 (TASK.84): the full-size internal viewer — last child of
          the root, a SIBLING of the role="log" column. Taskana 4091 follow-up:
          a real modal <dialog> (showModal) — App.tsx's global keydown ignores
          both Esc and mod-combos while any dialog[open] exists, so the shell's
          Esc-to-interrupt never fires while the viewer is open. */}
      {viewer !== null && viewedImages.length > 0 && (
        <ImageViewer
          images={viewedImages}
          startIndex={Math.min(viewer.index, viewedImages.length - 1)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

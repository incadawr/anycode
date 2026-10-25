/**
 * Transcript tick rail (TASK.48 / Taskana 4086 + 4742): a bare vertical
 * strip of short horizontal ticks at the LEFT edge of the conversation, one
 * per user turn, marking the turn structure of a long session like Codex's
 * message rail. Hover/focus opens a popover with the user's query (plain
 * text, CSS-clamped to 3 lines); click/Enter scrolls the transcript to that
 * turn via the same `data-block-id` jump path TodoPanel uses. A turn with a
 * matched checkpoint (see checkpoint-model.ts's matchCheckpointsToTurns)
 * additionally offers "Rewind to before this message" with an inline
 * confirm, sending the same rewind_request the old Timeline dock panel
 * (removed by 4742) used to send. Pure renderer projection over
 * `TranscriptBlock[]` — no new store state (same posture as TodoPanel), so
 * resumed/hydrated sessions get it for free. System-origin `user_text`
 * blocks are host-injected reports, not user moves, and never open a turn.
 *
 * 4086 follow-up — cheap on long sessions. The projection never builds the
 * full answer text of any turn (4742 dropped the answer/files/tool preview
 * from the popover entirely, so `summarizeTurn` now folds ONLY the turn's
 * question), and `createUserTurnsSelector` memoizes per-turn summaries by
 * the identity of the turn's block objects (the store updates immutably),
 * so a streaming update to the LAST turn reuses every earlier turn's cached
 * summary and only the turn being streamed is recomputed. The per-call scan
 * itself stays a light O(N) index walk — same cost class as MessageList's
 * own `groupTranscriptBlocks`.
 *
 * 4742 — evolved from the right-edge dot pill into the left-edge tick rail
 * (same file, same selector/memoization, same scroll-spy/jump wiring in
 * MessageList). Visual language: one short horizontal tick per turn (10px),
 * the active tick longer (18px) and accent-colored; no pill chrome. The
 * popover keeps `role="tooltip"` for the query text; when a rewind action
 * exists the popover container is a `role="group"` with an accessible name
 * so the buttons live in a real labeled container.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import type { TranscriptBlock } from "../store.js";
import { railActionsFor } from "./checkpoint-model.js";

export interface UserTurnMark {
  /** `user_text` block id — the jump target. */
  id: string;
  /** Index of the user block in the source array (for ordering/counting). */
  index: number;
  /** First ~240 chars of the question, whitespace-collapsed (popover text + aria-label source). */
  questionExcerpt: string;
}

export const PREVIEW_QUESTION_MAX = 240;
/** aria-label budget: a screen-reader label stays short even when the popover shows 3 lines. */
export const ARIA_LABEL_MAX = 80;

/**
 * Collapse whitespace to single spaces and trim to <= `max` chars, cutting on
 * a word boundary when one falls inside the budget; append "…" when truncated
 * (the ellipsis itself fits inside `max`, so the result length never exceeds it).
 */
export function excerpt(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (max <= 0) {
    return "";
  }
  if (collapsed.length <= max) {
    return collapsed;
  }
  // Reserve one char of the budget for the ellipsis.
  let cut = collapsed.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary > 0) {
    cut = cut.slice(0, boundary);
  }
  return `${cut.replace(/\s+$/, "")}…`;
}

/**
 * Summarize ONE turn: just the eligible `user_text` block's question excerpt
 * (4742 dropped the answer/files/tool preview — the popover shows the query
 * only, so the fold stops at the question and the answer-side scanning cost
 * of the 4086-era preview is gone outright).
 */
export function summarizeTurn(blocks: TranscriptBlock[], userIndex: number, endExclusive: number): UserTurnMark {
  const userBlock = blocks[userIndex] as Extract<TranscriptBlock, { kind: "user_text" }>;
  return {
    id: userBlock.id,
    index: userIndex,
    questionExcerpt: excerpt(userBlock.text, PREVIEW_QUESTION_MAX),
  };
}

/** Indices of blocks that OPEN a turn: `user_text` without system origin, in order. */
function userTurnStarts(blocks: TranscriptBlock[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.kind === "user_text" && block.origin !== "system") {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Project the flat transcript into user turns (unmemoized reference path).
 * A turn starts at each `user_text` block whose `origin !== "system"` and
 * stays open until the next eligible `user_text` or the end of the array.
 */
export function selectUserTurns(blocks: TranscriptBlock[]): UserTurnMark[] {
  const starts = userTurnStarts(blocks);
  const marks: UserTurnMark[] = [];
  for (let t = 0; t < starts.length; t += 1) {
    const start = starts[t]!;
    const end = t + 1 < starts.length ? starts[t + 1]! : blocks.length;
    marks.push(summarizeTurn(blocks, start, end));
  }
  return marks;
}

export interface UserTurnsSelector {
  /** Incremental projection: earlier unchanged turns are served from the memo. */
  (blocks: TranscriptBlock[]): UserTurnMark[];
  /** Indices whose summary the LAST call actually recomputed (test hook, 4086 brief §1). */
  readonly recomputed: readonly number[];
}

/**
 * Taskana 4742: the raw user-turn texts in mark order (the SAME turn split
 * `selectUserTurns` uses — system-origin blocks excluded) for
 * `matchCheckpointsToTurns`, which derives each turn's checkpoint label
 * from its full prompt text (checkpoint-model.ts mirrors core's
 * `deriveCheckpointLabel`, which slices the label out of the first line of
 * the RAW prompt — an excerpt would truncate differently and break the
 * match). Order-aligned with the marks array by construction.
 */
export function rewindUserTurnTexts(blocks: TranscriptBlock[]): string[] {
  const starts = userTurnStarts(blocks);
  const texts: string[] = [];
  for (let t = 0; t < starts.length; t += 1) {
    const start = starts[t]!;
    const block = blocks[start] as Extract<TranscriptBlock, { kind: "user_text" }>;
    texts.push(block.text);
  }
  return texts;
}

interface CachedTurn {
  /** The exact block objects of the turn's range when `mark` was built. */
  range: TranscriptBlock[];
  mark: UserTurnMark;
}

/**
 * Hit test for a cached turn: same start index and the SAME block objects
 * across the whole range. The store updates blocks immutably (a streaming
 * delta, a tool status change, an edit or a hydration replacement each yield
 * a new object), so reference equality is exact — no content-derived
 * fingerprint can miss an in-place edit of an earlier block or a same-length
 * replacement. Cost: pointer compares only, O(turn length), no string work.
 */
function sameRange(cached: CachedTurn, blocks: TranscriptBlock[], start: number, end: number): boolean {
  if (cached.mark.index !== start || cached.range.length !== end - start) {
    return false;
  }
  for (let i = start; i < end; i += 1) {
    if (blocks[i] !== cached.range[i - start]) {
      return false;
    }
  }
  return true;
}

/**
 * Factory for the memoized selector (one per mounted MessageList, held in a
 * ref — never module state, two tabs must not share a cache). Each call does
 * a light O(N) scan for turn starts, then per turn compares the turn's block
 * objects (by reference, see `sameRange`) against the cached entry: a hit reuses the cached summary
 * verbatim, a miss reprojects ONLY that turn (`summarizeTurn` walks just its
 * range). In practice a streaming delta invalidates exactly the turn being
 * streamed; a rewind/hydration reshuffle invalidates from the first shifted
 * turn on — which is simply the old full-recompute behavior.
 */
export function createUserTurnsSelector(): UserTurnsSelector {
  let cache: CachedTurn[] = [];
  let recomputed: number[] = [];
  const selector = (blocks: TranscriptBlock[]): UserTurnMark[] => {
    const starts = userTurnStarts(blocks);
    const marks: UserTurnMark[] = [];
    const nextCache: CachedTurn[] = [];
    recomputed = [];
    for (let t = 0; t < starts.length; t += 1) {
      const start = starts[t]!;
      const end = t + 1 < starts.length ? starts[t + 1]! : blocks.length;
      const cached = cache[t];
      if (cached !== undefined && sameRange(cached, blocks, start, end)) {
        nextCache.push(cached);
        marks.push(cached.mark);
        continue;
      }
      const mark = summarizeTurn(blocks, start, end);
      recomputed.push(t);
      nextCache.push({ range: blocks.slice(start, end), mark });
      marks.push(mark);
    }
    cache = nextCache;
    return marks;
  };
  const withHook = selector as UserTurnsSelector;
  Object.defineProperty(withHook, "recomputed", {
    get: (): readonly number[] => recomputed,
  });
  return withHook;
}

/**
 * The rail earns its gutter from the second user turn on (Taskana 4742: a
 * single-question session is still "the conversation so far" — the first
 * jump target is the top of the feed, so no rail is drawn and no gutter is
 * reserved).
 */
export function shouldShowMinimap(turnCount: number): boolean {
  return turnCount >= 2;
}

/**
 * Taskana 4742: number of eligible user turns (same rule as
 * `selectUserTurns` — system-origin `user_text` blocks excluded). A cheap
 * counting variant for owners that only need the rail's visibility gate /
 * refresh trigger, without building mark objects.
 */
export function countUserTurns(blocks: TranscriptBlock[]): number {
  return userTurnStarts(blocks).length;
}

/** Clamp a candidate mark index into range; `null` (nothing visible yet) stays `null`. */
export function activeMarkIndex(marks: UserTurnMark[], topmostVisibleUserIndex: number | null): number | null {
  if (topmostVisibleUserIndex === null) {
    return null;
  }
  const last = marks.length - 1;
  if (last < 0) {
    return null;
  }
  return Math.min(Math.max(topmostVisibleUserIndex, 0), last);
}

/**
 * Tick length class (Taskana 4742 §2.2): the ACTIVE tick renders longer and
 * brighter than its neighbors — `"active"` vs `"normal"` class suffix for
 * the CSS width/color pair. Pure so the rail's visual contract is pinnable
 * without a DOM.
 */
export function tickLengthFor(index: number, activeIndex: number | null): "active" | "normal" {
  return index === activeIndex ? "active" : "normal";
}

/**
 * Popover open-state reducer (Taskana 4742 §2.2) — pure, testable without a
 * DOM. The popover must stay open while the pointer moves from the tick into
 * the popover itself (the Rewind button lives there), so "open" is
 * "hovered tick OR pointer inside popover OR focus within the rail/popover"
 * with a short close delay that a re-enter cancels. Inputs:
 *  - `enterTick(i)` / `leaveTick` — pointer over a tick button;
 *  - `enterPopover` / `leavePopover` — pointer inside the popover card;
 *  - `focusTick(i)` / `blurTick` — keyboard focus moves (focus also opens
 *    its own popover);
 *  - `closeNow` — Esc: immediate close, no delay.
 */
export type PopoverEvent =
  | { kind: "enterTick"; index: number }
  | { kind: "leaveTick" }
  | { kind: "enterPopover" }
  | { kind: "leavePopover" }
  | { kind: "focusTick"; index: number }
  | { kind: "blurTick" }
  | { kind: "closeNow" };

export interface PopoverState {
  /** Index of the tick whose popover is open, or null (closed). */
  openIndex: number | null;
  /** True when the pending-close timer is armed and a re-enter must cancel it. */
  closing: boolean;
}

export function nextOpenState(state: PopoverState, event: PopoverEvent, markCount: number): PopoverState {
  const inRange = (index: number): boolean => index >= 0 && index < markCount;
  switch (event.kind) {
    case "enterTick":
      return { openIndex: inRange(event.index) ? event.index : state.openIndex, closing: false };
    case "focusTick":
      return { openIndex: inRange(event.index) ? event.index : state.openIndex, closing: false };
    case "enterPopover":
      return { openIndex: state.openIndex, closing: false };
    case "leaveTick":
      // Arm the close delay: the pointer may be headed for the popover.
      return { openIndex: state.openIndex, closing: true };
    case "leavePopover":
      return { openIndex: state.openIndex, closing: true };
    case "blurTick":
      // Focus left the tick — if it moved into the popover the subsequent
      // focus event keeps it open; otherwise the delay closes it.
      return { openIndex: state.openIndex, closing: true };
    case "closeNow":
      return { openIndex: null, closing: false };
  }
}

/**
 * Roving-tabindex key handler (4086 brief §3, unchanged by 4742) — pure for
 * unit tests. Up/Down move the rail's single tab stop between ticks
 * (clamped at the edges), Home/End jump to the first/last tick; every other
 * key (Tab included) is a no-op so the browser keeps ownership of focus
 * traversal into/out of the rail (Tab from a tick lands on the popover's
 * buttons when a popover with actions is open — DOM order below guarantees
 * that). Returns the next roving index.
 */
export function rovingIndexFromKey(key: string, current: number, count: number): number {
  if (count <= 1) {
    return 0;
  }
  switch (key) {
    case "ArrowUp":
      return Math.max(0, current - 1);
    case "ArrowDown":
      return Math.min(count - 1, current + 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}

/**
 * `aria-describedby` value linking a tick to the popover's query text
 * (4086 §3): the hovered/focused tick references the live popover, every
 * other tick gets `undefined` (React omits the attribute). Pure so the link
 * is pinnable without a DOM.
 */
export function markDescribedBy(hovered: number | null, index: number, previewId: string): string | undefined {
  return hovered === index ? previewId : undefined;
}

/** The popover's "Message N of M" small-label text (4742 §2.2). */
export function popoverCounterText(index: number, total: number): string {
  return `Message ${index + 1} of ${total}`;
}

export interface RailRewindProps {
  /** Matched checkpoint id per mark index (null = no checkpoint for that turn). */
  checkpointIds: readonly (string | null)[];
  /** Sends the rewind_request (App wires send(buildRewindRequest(...))). */
  onRewind(checkpointId: string): void;
}

export function TranscriptMinimap({
  marks,
  activeIndex,
  onJump,
  rewind,
}: {
  marks: UserTurnMark[];
  activeIndex: number | null;
  onJump: (blockId: string) => void;
  /**
   * Taskana 4742 §2.5: optional rewind plumbing. Absent (child panes,
   * existing tests, engines without supportsRewind) -> no Rewind buttons at
   * all, popover stays a pure tooltip.
   */
  rewind?: RailRewindProps;
}): ReactElement | null {
  // App gates visibility with shouldShowMinimap; stay defensive anyway.
  const [popover, setPopover] = useState<PopoverState>({ openIndex: null, closing: false });
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  // Roving tabindex (4086 §3): exactly ONE tab stop for the whole rail.
  // The tick holding the stop moves with Up/Down/Home/End (see
  // handleRailKeys); ticks off the stop keep tabIndex={-1} but stay clickable
  // and focusable by script. Clamped defensively — marks only grow in
  // practice, but a rewind can shrink the list under a stale roving index.
  const [roving, setRoving] = useState(0);
  const rovingIndex = Math.min(roving, marks.length - 1);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Popover-text id for the aria-describedby link. useId (not the mark
  // index) so the link is stable across reordering/compaction of marks.
  const previewId = `minimap-preview-${useId()}`;
  const openIndex = popover.openIndex !== null && marks[popover.openIndex] !== undefined ? popover.openIndex : null;
  const openMark = openIndex !== null ? marks[openIndex]! : null;
  // railActionsFor (checkpoint-model.ts) gates the Rewind button: engine
  // capability + matched checkpoint + non-read-only list.
  const openCheckpointId = rewind !== undefined && openIndex !== null ? rewind.checkpointIds[openIndex] ?? null : null;
  const actions = railActionsFor(openCheckpointId, rewind !== undefined);
  const canRewind = actions.canRewind;

  const clearCloseTimer = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const applyPopoverEvent = useCallback(
    (event: PopoverEvent): void => {
      setPopover((prev) => {
        const next = nextOpenState(prev, event, marks.length);
        if (next.closing && !prev.closing) {
          // Arm the close delay: a re-enter (tick or popover) cancels it; if
          // it fires, the popover closes.
          clearCloseTimer();
          closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            setPopover((still) => (still.closing ? { openIndex: null, closing: false } : still));
          }, POPOVER_CLOSE_DELAY_MS);
        } else if (!next.closing && prev.closing) {
          clearCloseTimer();
        }
        return next;
      });
    },
    [clearCloseTimer, marks.length],
  );

  // Reset a half-confirmed rewind when the popover closes or the marks list
  // shrinks under it (a rewind truncates the transcript) — a stale confirm
  // must never resurrect onto a different turn's popover (4742 §2.4).
  useEffect(() => {
    if (openIndex === null) {
      setPendingConfirm(false);
    }
  }, [openIndex]);
  useEffect(() => {
    if (popover.openIndex !== null && popover.openIndex >= marks.length) {
      setPendingConfirm(false);
    }
  }, [marks.length, popover.openIndex]);
  // Unmount: clear the pending close timer so it can never fire into a
  // dead component.
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const focusMark = useCallback((index: number): void => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    list.querySelector<HTMLButtonElement>(`[data-mark-index="${index}"]`)?.focus();
  }, []);

  const handleRailKeys = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape" && openIndex !== null) {
        // Esc closes the popover and returns focus to its tick.
        event.preventDefault();
        applyPopoverEvent({ kind: "closeNow" });
        if (openIndex !== null) {
          focusMark(openIndex);
        }
        return;
      }
      const next = rovingIndexFromKey(event.key, rovingIndex, marks.length);
      // Home/End are claimed even when they'd be a no-move, so their default
      // (page scroll) never fires while the roving stop is held; a no-move
      // arrow and every other key pass through untouched.
      if (next === rovingIndex && event.key !== "Home" && event.key !== "End") {
        return;
      }
      event.preventDefault();
      setRoving(next);
      focusMark(next);
    },
    [applyPopoverEvent, focusMark, marks.length, openIndex, rovingIndex],
  );

  const handleRewindConfirm = useCallback((): void => {
    if (openCheckpointId === null) {
      return;
    }
    rewind?.onRewind(openCheckpointId);
    setPendingConfirm(false);
    applyPopoverEvent({ kind: "closeNow" });
  }, [applyPopoverEvent, openCheckpointId, rewind]);

  if (marks.length === 0) {
    return null;
  }

  // The popover renders as the NEXT DOM sibling AFTER the tick column's
  // buttons (4742 §2.2 keyboard): Tab from the focused tick lands on the
  // Rewind button first, then leaves the rail — no explicit focus
  // management needed for the common order.
  let popoverNode: ReactNode = null;
  if (openMark !== null) {
    popoverNode = (
      <div
        className="minimap-preview"
        // 4742 §2.2: role=tooltip ONLY for the query text; when actions
        // exist the popover container is a labeled group so its buttons sit
        // in a real named container. A tooltip role must not own focusable
        // buttons.
        {...(canRewind ? { role: "group" as const, "aria-label": popoverCounterText(openIndex!, marks.length) + " actions" } : { role: "tooltip" as const, id: previewId })}
        onMouseEnter={() => applyPopoverEvent({ kind: "enterPopover" })}
        onMouseLeave={() => applyPopoverEvent({ kind: "leavePopover" })}
      >
        <div className="minimap-preview-counter">{popoverCounterText(openIndex!, marks.length)}</div>
        {/* The query text: plain text node only (no markup from user text).
            aria-describedby points here — via the outer tooltip's id in the
            no-action case, or this element's own id when actions exist and
            the outer container is a labeled group. */}
        <div className="minimap-preview-question" id={canRewind ? previewId : undefined}>
          {openMark.questionExcerpt === "" ? "…" : openMark.questionExcerpt}
        </div>
        {canRewind && (
          <div className="minimap-preview-actions">
            {pendingConfirm ? (
              <>
                <span className="minimap-preview-confirm-text">
                  Rewind to this checkpoint? Files and conversation after it are discarded.
                </span>
                <div className="minimap-preview-confirm-buttons">
                  <button type="button" className="minimap-preview-confirm-cancel" onClick={() => setPendingConfirm(false)}>
                    Cancel
                  </button>
                  <button type="button" className="minimap-preview-confirm-confirm" onClick={handleRewindConfirm}>
                    Rewind
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="minimap-preview-rewind" onClick={() => setPendingConfirm(true)}>
                Rewind to before this message
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="minimap"
      role="navigation"
      aria-label="Conversation turns"
      ref={listRef}
      onKeyDown={handleRailKeys}
    >
      {/* Two layers on purpose: the outer rail never clips (the popover is an
          absolutely-positioned child and an overflow box would hide it), and
          only this inner tick list scrolls once it hits its max-height. */}
      <div className="minimap-marks">
      {marks.map((mark, i) => (
        <button
          type="button"
          key={mark.id}
          className={"minimap-mark" + (tickLengthFor(i, activeIndex) === "active" ? " minimap-mark-active" : "")}
          data-mark-index={i}
          data-mark-block-id={mark.id}
          aria-label={`Turn ${i + 1}: ${excerpt(mark.questionExcerpt, ARIA_LABEL_MAX)}`}
          aria-describedby={markDescribedBy(openIndex, i, previewId)}
          tabIndex={i === rovingIndex ? 0 : -1}
          onMouseEnter={() => applyPopoverEvent({ kind: "enterTick", index: i })}
          onMouseLeave={() => applyPopoverEvent({ kind: "leaveTick" })}
          onFocus={() => {
            applyPopoverEvent({ kind: "focusTick", index: i });
            // Keep the roving stop in sync with script/causal focus (a click
            // focuses the clicked tick; Tab re-entry resumes from it).
            setRoving((prev) => (prev === i ? prev : i));
          }}
          onBlur={() => applyPopoverEvent({ kind: "blurTick" })}
          onClick={() => onJump(mark.id)}
        >
          <span className="minimap-mark-dot" aria-hidden="true" />
        </button>
      ))}
      </div>
      {popoverNode}
    </div>
  );
}

/** Close delay for the popover (4742 §2.2): long enough to cross the gap into the popover, short enough to feel snappy. */
export const POPOVER_CLOSE_DELAY_MS = 120;

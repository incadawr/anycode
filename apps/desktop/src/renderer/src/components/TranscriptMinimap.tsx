/**
 * Transcript history minimap (TASK.48 / Taskana 4086): a vertical scrubber
 * marking the USER turns of a long session. Hover shows a preview card
 * (question excerpt, short answer, touched files, tool-call count); click
 * scrolls the transcript to that turn via the same `data-block-id` jump path
 * TodoPanel uses. Pure renderer projection over `TranscriptBlock[]` — no new
 * store state (same posture as TodoPanel), so resumed/hydrated sessions get
 * it for free. System-origin `user_text` blocks are host-injected reports,
 * not user moves, and never open a turn.
 *
 * 4086 follow-up — cheap on long sessions. The projection used to rebuild
 * the FULL answer text of every turn (uncapped concatenation) on every block
 * change, and every streaming delta is a block change: O(total transcript
 * chars) of string work per rAF flush. Two fixes, both pure so they stay
 * testable without a DOM:
 *  - `summarizeTurn` walks with a length cap (ANSWER_SCAN_CHARS): once a
 *    turn's answer holds that many raw chars the remaining `assistant_text`
 *    bodies of the turn are skipped, so the full answer string is never
 *    built (ids, files and tool counts still accrue — the cap bounds only
 *    the string).
 *  - `createUserTurnsSelector` memoizes per-turn summaries by turn id plus a
 *    fingerprint of the block that closes the turn (last block id + a cheap
 *    version stand-in), so a streaming update to the LAST turn reuses every
 *    earlier turn's cached summary and only the turn being streamed is
 *    recomputed. The per-call scan itself stays a light O(N) index walk —
 *    same cost class as MessageList's own `groupTranscriptBlocks`, and the
 *    expensive part (per-turn folding) touches one turn.
 */
import { useCallback, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import type { TranscriptBlock } from "../store.js";

export interface UserTurnMark {
  /** `user_text` block id — the jump target. */
  id: string;
  /** Index of the user block in the source array (for ordering/counting). */
  index: number;
  /** First ~120 chars of the question, whitespace-collapsed (preview card + aria-label). */
  questionExcerpt: string;
  /** Answer excerpt (<= PREVIEW_ANSWER_MAX chars, whitespace-collapsed) — built capped, see ANSWER_SCAN_CHARS. */
  answerExcerpt: string;
  /** Distinct basename(file_path) of Read/Write/Edit tool_calls inside the turn, first-appearance order, cap 6. */
  files: string[];
  /** tool_call count inside the turn (any tool). */
  toolCallCount: number;
}

export const PREVIEW_QUESTION_MAX = 120;
export const PREVIEW_ANSWER_MAX = 200;
export const PREVIEW_FILES_MAX = 6;

/**
 * Raw per-turn budget the answer walk may examine while building the excerpt
 * — the length cap demanded by the 4086 brief. 4× the 200-char excerpt
 * budget: generous headroom for whitespace collapse, multi-block joins and
 * the word-boundary cut, while bounding per-turn string work to a constant
 * no matter how long the answer grows. (Only a turn whose first 200
 * COLLAPSED chars span more than this many raw chars — i.e. hundreds of
 * chars of pure whitespace inside the visible window — could excerpt
 * differently than an uncapped walk; that is pathological by construction.)
 */
export const ANSWER_SCAN_CHARS = 4 * PREVIEW_ANSWER_MAX;

/** Basename of a workspace path — same rule as MessageList's private twin. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

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
 * Summarize ONE turn: the eligible `user_text` block at `userIndex` plus
 * every block after it up to `endExclusive` (the next eligible user block's
 * index, or blocks.length for the open tail turn). Answer text accrues into
 * `answerExcerpt` with the ANSWER_SCAN_CHARS cap applied DURING the walk —
 * once the budget is spent the turn's remaining `assistant_text` bodies are
 * skipped (a `slice` of at most the remaining budget is taken from a block
 * that would overflow it) — then the accumulator is excerpted once at the
 * end. Tool calls keep counting past the cap: the cap bounds the string,
 * not the turn's metadata.
 */
export function summarizeTurn(blocks: TranscriptBlock[], userIndex: number, endExclusive: number): UserTurnMark {
  const userBlock = blocks[userIndex] as Extract<TranscriptBlock, { kind: "user_text" }>;
  const mark: UserTurnMark = {
    id: userBlock.id,
    index: userIndex,
    questionExcerpt: excerpt(userBlock.text, PREVIEW_QUESTION_MAX),
    answerExcerpt: "",
    files: [],
    toolCallCount: 0,
  };
  let scanRemaining = ANSWER_SCAN_CHARS;
  for (let i = userIndex + 1; i < endExclusive; i += 1) {
    const block = blocks[i]!;
    switch (block.kind) {
      case "assistant_text": {
        if (scanRemaining <= 0) {
          break; // Cap spent — this turn's excerpt is final; skip the body.
        }
        // Take at most the remaining budget, even from one huge block (a
        // hydrated history part can hold a whole message in one block).
        const piece = block.text.length > scanRemaining ? block.text.slice(0, scanRemaining) : block.text;
        mark.answerExcerpt = mark.answerExcerpt === "" ? piece : `${mark.answerExcerpt}\n${piece}`;
        scanRemaining -= piece.length;
        break;
      }
      case "tool_call": {
        mark.toolCallCount += 1;
        if (
          (block.toolName === "Read" || block.toolName === "Write" || block.toolName === "Edit") &&
          mark.files.length < PREVIEW_FILES_MAX
        ) {
          const input =
            block.input !== null && typeof block.input === "object" ? (block.input as Record<string, unknown>) : null;
          const path = input !== null && typeof input.file_path === "string" ? input.file_path : null;
          if (path !== null) {
            const base = basenameOf(path);
            if (!mark.files.includes(base)) {
              mark.files.push(base);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  mark.answerExcerpt = excerpt(mark.answerExcerpt, PREVIEW_ANSWER_MAX);
  return mark;
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
 * Cheap version stand-in for a block (no `version` field exists on
 * TranscriptBlock): the mutable-in-place fields that can affect a turn
 * summary are streaming text length and tool status, both O(1) to read.
 */
function versionTagOf(block: TranscriptBlock): string {
  switch (block.kind) {
    case "assistant_text":
    case "reasoning":
      return `t${block.text.length}`;
    case "tool_call":
      return `s${block.status}`;
    default:
      return block.kind;
  }
}

/**
 * Memo key companion to the turn id (4086 brief: "turn id plus the last
 * block id or version"): id + version tag of the block that CLOSES the turn's
 * range. The store's append-only + patch-in-place discipline makes this sound
 * — a streaming delta patches the open tail block (its length changes), an
 * append changes the closing block id, and a rewind/reshuffle shifts the
 * user block's index, which the selector also compares.
 */
export function turnFingerprint(blocks: TranscriptBlock[], mark: UserTurnMark, endExclusive: number): string {
  const closing = blocks[Math.max(mark.index, endExclusive - 1)]!;
  return `${mark.id}|${closing.id}|${versionTagOf(closing)}`;
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

interface CachedTurn {
  fingerprint: string;
  mark: UserTurnMark;
}

/**
 * Factory for the memoized selector (one per mounted MessageList, held in a
 * ref — never module state, two tabs must not share a cache). Each call does
 * a light O(N) scan for turn starts, then per turn compares `turn id +
 * fingerprint` against the cached entry: a hit reuses the cached summary
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
      // Identity probe before building anything: the cached user block must
      // still sit at this index (append-only discipline keeps it there).
      const userBlock = blocks[start] as Extract<TranscriptBlock, { kind: "user_text" }>;
      const cached = cache[t];
      if (
        cached !== undefined &&
        cached.mark.id === userBlock.id &&
        cached.mark.index === start &&
        cached.fingerprint === turnFingerprint(blocks, cached.mark, end)
      ) {
        nextCache.push(cached);
        marks.push(cached.mark);
        continue;
      }
      const mark = summarizeTurn(blocks, start, end);
      recomputed.push(t);
      nextCache.push({ fingerprint: turnFingerprint(blocks, mark, end), mark });
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

/** The minimap only earns its chrome on real conversations: 3+ user turns. */
export function shouldShowMinimap(turnCount: number): boolean {
  return turnCount >= 3;
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
 * Roving-tabindex key handler (4086 brief §3) — pure for unit tests. Up/Down
 * move the minimap's single tab stop between dots (clamped at the edges),
 * Home/End jump to the first/last dot; every other key (Tab included) is a
 * no-op so the browser keeps ownership of focus traversal into/out of the
 * minimap. Returns the next roving index.
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
 * `aria-describedby` value linking a dot to the preview card (4086 §3): the
 * hovered/focused dot references the live preview, every other dot gets
 * `undefined` (React omits the attribute). Pure so the link is pinnable
 * without a DOM.
 */
export function markDescribedBy(hovered: number | null, index: number, previewId: string): string | undefined {
  return hovered === index ? previewId : undefined;
}

export function TranscriptMinimap({
  marks,
  activeIndex,
  onJump,
}: {
  marks: UserTurnMark[];
  activeIndex: number | null;
  onJump: (blockId: string) => void;
}): ReactElement | null {
  // App gates visibility with shouldShowMinimap; stay defensive anyway.
  const [hovered, setHovered] = useState<number | null>(null);
  // Roving tabindex (4086 §3): exactly ONE tab stop for the whole minimap
  // (the pill is one navigation landmark, not a dot-per-Tab ladder). The dot
  // holding the stop moves with Up/Down/Home/End (see handleMinimapKeys);
  // dots off the stop keep tabIndex={-1} but stay clickable and focusable by
  // script. Clamped defensively — marks only grow in practice, but a rewind
  // can shrink the list under a stale roving index.
  const [roving, setRoving] = useState(0);
  const rovingIndex = Math.min(roving, marks.length - 1);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Preview-card id for the aria-describedby link. useId (not the mark index)
  // so the link is stable across reordering/compaction of marks.
  const previewId = `minimap-preview-${useId()}`;

  const focusMark = useCallback((index: number): void => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    list.querySelector<HTMLButtonElement>(`[data-mark-index="${index}"]`)?.focus();
  }, []);

  const handleMinimapKeys = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
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
    [focusMark, marks.length, rovingIndex],
  );

  if (marks.length === 0) {
    return null;
  }
  return (
    <div
      className="minimap"
      role="navigation"
      aria-label="Conversation turns"
      ref={listRef}
      onKeyDown={handleMinimapKeys}
    >
      {marks.map((mark, i) => (
        <button
          type="button"
          key={mark.id}
          className={"minimap-mark" + (i === activeIndex ? " minimap-mark-active" : "")}
          data-mark-index={i}
          data-mark-block-id={mark.id}
          aria-label={`Turn ${i + 1}: ${mark.questionExcerpt}`}
          aria-describedby={markDescribedBy(hovered, i, previewId)}
          tabIndex={i === rovingIndex ? 0 : -1}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => {
            setHovered(i);
            // Keep the roving stop in sync with script/causal focus (a click
            // focuses the clicked dot; Tab re-entry resumes from it).
            setRoving((prev) => (prev === i ? prev : i));
          }}
          onBlur={() => setHovered(null)}
          onClick={() => onJump(mark.id)}
        >
          <span className="minimap-mark-dot" aria-hidden="true" />
        </button>
      ))}
      {hovered !== null && marks[hovered] !== undefined && (
        <div className="minimap-preview" role="tooltip" id={previewId}>
          <div className="minimap-preview-question">
            {marks[hovered]!.questionExcerpt === "" ? "…" : marks[hovered]!.questionExcerpt}
          </div>
          <div className="minimap-preview-answer">
            {marks[hovered]!.answerExcerpt === "" ? "No answer yet" : marks[hovered]!.answerExcerpt}
          </div>
          {marks[hovered]!.files.length > 0 && (
            <div className="minimap-preview-files">{`Files: ${marks[hovered]!.files.join(" · ")}`}</div>
          )}
          <div className="minimap-preview-meta">{`${marks[hovered]!.toolCallCount} tool call${
            marks[hovered]!.toolCallCount === 1 ? "" : "s"
          }`}</div>
        </div>
      )}
    </div>
  );
}

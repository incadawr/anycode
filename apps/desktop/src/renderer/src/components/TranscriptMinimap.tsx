/**
 * Transcript history minimap (TASK.48 / Taskana 4086): a vertical scrubber
 * marking the USER turns of a long session. Hover shows a preview card
 * (question excerpt, short answer, touched files, tool-call count); click
 * scrolls the transcript to that turn via the same `data-block-id` jump path
 * TodoPanel uses. Pure renderer projection over `TranscriptBlock[]` — no new
 * store state (same posture as TodoPanel), so resumed/hydrated sessions get
 * it for free. System-origin `user_text` blocks are host-injected reports,
 * not user moves, and never open a turn.
 */
import { useState } from "react";
import type { ReactElement } from "react";
import type { TranscriptBlock } from "../store.js";

export interface UserTurnMark {
  /** `user_text` block id — the jump target. */
  id: string;
  /** Index of the user block in the source array (for ordering/counting). */
  index: number;
  /** First ~120 chars of the question, whitespace-collapsed (preview card + aria-label). */
  questionExcerpt: string;
  /** Concatenated assistant_text following the question, before the next user block ("" when none yet). */
  answerText: string;
  /** Distinct basename(file_path) of Read/Write/Edit tool_calls inside the turn, first-appearance order, cap 6. */
  files: string[];
  /** tool_call count inside the turn (any tool). */
  toolCallCount: number;
}

export const PREVIEW_QUESTION_MAX = 120;
export const PREVIEW_ANSWER_MAX = 200;
export const PREVIEW_FILES_MAX = 6;

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
 * Project the flat transcript into user turns. A turn starts at each
 * `user_text` block whose `origin !== "system"` and stays open until the next
 * eligible `user_text` or the end of the array; while open, assistant text
 * accrues to `answerText` (joined with "\n", stored raw — the component
 * renders the excerpt), every tool_call counts, and Read/Write/Edit calls
 * contribute distinct `file_path` basenames (first-appearance order, capped).
 */
export function selectUserTurns(blocks: TranscriptBlock[]): UserTurnMark[] {
  const marks: UserTurnMark[] = [];
  let open: UserTurnMark | null = null;

  const close = (): void => {
    if (open !== null) {
      marks.push(open);
      open = null;
    }
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.kind === "user_text" && block.origin !== "system") {
      close();
      open = {
        id: block.id,
        index,
        questionExcerpt: excerpt(block.text, PREVIEW_QUESTION_MAX),
        answerText: "",
        files: [],
        toolCallCount: 0,
      };
      continue;
    }
    if (open === null) {
      continue;
    }
    switch (block.kind) {
      case "assistant_text":
        open.answerText = open.answerText === "" ? block.text : `${open.answerText}\n${block.text}`;
        break;
      case "tool_call": {
        open.toolCallCount += 1;
        if (
          (block.toolName === "Read" || block.toolName === "Write" || block.toolName === "Edit") &&
          open.files.length < PREVIEW_FILES_MAX
        ) {
          const input =
            block.input !== null && typeof block.input === "object" ? (block.input as Record<string, unknown>) : null;
          const path = input !== null && typeof input.file_path === "string" ? input.file_path : null;
          if (path !== null) {
            const base = basenameOf(path);
            if (!open.files.includes(base)) {
              open.files.push(base);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  close();
  return marks;
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
  if (marks.length === 0) {
    return null;
  }
  return (
    <div className="minimap" role="navigation" aria-label="Conversation turns">
      {marks.map((mark, i) => (
        <button
          type="button"
          key={mark.id}
          className={"minimap-mark" + (i === activeIndex ? " minimap-mark-active" : "")}
          data-mark-index={i}
          data-mark-block-id={mark.id}
          aria-label={`Turn ${i + 1}: ${mark.questionExcerpt}`}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(i)}
          onBlur={() => setHovered(null)}
          onClick={() => onJump(mark.id)}
        >
          <span className="minimap-mark-dot" aria-hidden="true" />
        </button>
      ))}
      {hovered !== null && marks[hovered] !== undefined && (
        <div className="minimap-preview" role="tooltip">
          <div className="minimap-preview-question">
            {marks[hovered]!.questionExcerpt === "" ? "…" : marks[hovered]!.questionExcerpt}
          </div>
          <div className="minimap-preview-answer">
            {excerpt(marks[hovered]!.answerText, PREVIEW_ANSWER_MAX) || "No answer yet"}
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

/**
 * Collapsible stack of consecutive terminal tool-call cards (TASK.31, design
 * §2). Pure presentation — the grouping projection lives in
 * `MessageList.groupTranscriptBlocks`; this component renders its `tool_stack`
 * items.
 *
 * A collapsed stack is one honest header row (caret · type rundown · call
 * count · aggregate badge) that summarizes a run of adjacent terminal cards
 * (ANY mix of tool names — a single-tool run is the special case). Expanding
 * reveals every original `ToolCallCard` in order, each with its own
 * diffs/results/disclosure intact — `ToolCallCard` is reused as-is.
 *
 * Automation/`data-block-id` discipline (TASK.31 §4b): `automation.ts`'s
 * `rewindState` counts rendered `[data-block-id]` nodes as a deterministic
 * transcript-truncation proof, and `TodoPanel`/`jumpToBlock` locate cards by
 * the same attribute. A collapsed stack shows only its header, so without
 * compensation the count would drop by (N−1) and block-jump would miss every
 * non-head member. To keep both honest, a collapsed stack carries one
 * `aria-hidden` anchor span per member (the head's `data-block-id` lives on
 * the root); an expanded stack drops the anchors because the inner cards
 * carry their own `data-block-id` via their standard wrapper.
 *
 * The disclosure state is local `useState(false)` — stacks are collapsed by
 * default (TASK.31 §DoD invariant 6). React keys are stable: `MessageList`
 * keys the stack by its first member's id (see `groupTranscriptBlocks`), so
 * a live append that grows a 2-stack into a 3-stack reuses the same node and
 * preserves the user's expand choice.
 *
 * The aggregate badge reuses the single-card `.tool-call-status-badge` atom
 * and its `.tool-call-status-success`/`.tool-call-status-error` tints — no new
 * badge CSS. The caret reuses the shared `Chevron` icon and the existing
 * `[aria-expanded="false"] .tool-call-caret svg` rotate rule (extended to this
 * toggle in tool-call-stack.css).
 */
import { useId, useState } from "react";
import type { ToolCallBlock } from "../store.js";
import { Chevron } from "./icons.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { stackBadgeText, stackHeaderLabel, stackLabel, stackStatusClass } from "./MessageList.js";

/**
 * Exactly one rendered `data-block-id` per original block in either disclosure
 * state. Collapsed: root=head plus hidden anchors for the tail. Expanded:
 * the inner card wrappers own every id, so the root must not duplicate head.
 * Exported as a pure seam for the automation/rewind-count regression test.
 */
export function stackBlockIdLayout(blocks: ToolCallBlock[], expanded: boolean): {
  rootId: string | undefined;
  anchorIds: string[];
  bodyIds: string[];
} {
  return expanded
    ? { rootId: undefined, anchorIds: [], bodyIds: blocks.map((block) => block.id) }
    : { rootId: blocks[0]?.id, anchorIds: blocks.slice(1).map((block) => block.id), bodyIds: [] };
}

export function ToolCallStack({
  blocks,
  enter = false,
}: {
  blocks: ToolCallBlock[];
  enter?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const statusClass = stackStatusClass(blocks);
  const badgeText = stackBadgeText(blocks);
  const headerLabel = stackHeaderLabel(blocks);
  const blockIds = stackBlockIdLayout(blocks, expanded);

  return (
    <div
      className={`tool-call-stack${enter ? " message-enter" : ""}`}
      data-block-id={blockIds.rootId}
    >
      <button
        type="button"
        className="tool-call-stack-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-call-caret" aria-hidden="true">
          <Chevron />
        </span>
        <span className="tool-call-stack-name">{headerLabel}</span>
        <span className="tool-call-stack-count">{stackLabel(blocks.length)}</span>
        <span className={`tool-call-status-badge ${statusClass}`}>{badgeText}</span>
      </button>
      {/* Collapsed anchors: keep `[data-block-id]` count honest for
          automation's rewind proof and `jumpToBlock`, without polluting the
          SR announcement queue (the toggle is the only announced control).
          `blocks[0]` is already tagged on the root above. Hidden from layout
          via `.tool-call-stack-anchor { display: none }`. */}
      {!expanded &&
        blockIds.anchorIds.map((blockId) => (
          <span key={blockId} className="tool-call-stack-anchor" data-block-id={blockId} aria-hidden="true" />
        ))}
      {expanded && (
        <div id={bodyId} className="tool-call-stack-body">
          {blocks.map((block) => (
            <div key={block.id} data-block-id={block.id}>
              <ToolCallCard block={block} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

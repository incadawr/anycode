/**
 * GitHub #19: a collapsible block of consecutive authenticated agent messages.
 *
 * Before this, a run of agent deliveries (all `user_text` blocks flagged
 * `agentMessage`) rendered as N separate collapsed headers — after a reload
 * that was a wall of "Agent message · acknowledged" rows with no content, and
 * the real conversation was pushed far down. Two or more ADJACENT deliveries
 * now collapse into one header with the newest payload's one-line preview;
 * opening it reveals every original card in order, each with its own state,
 * payload and detail.
 *
 * Presentation only. The grouping projection lives in
 * `MessageList.groupTranscriptBlocks` and the minimap/rewind projections keep
 * working on the ORIGINAL blocks, so:
 *
 * - every member keeps exactly one rendered `data-block-id` in either
 *   disclosure state (see `agentMessageStackLayout`), the same discipline
 *   `ToolCallStack` follows for `automation.ts`'s rewind-count proof and
 *   `jumpToBlock`;
 * - a collapsed stack's tail members are represented by ZERO-HEIGHT in-flow
 *   anchors (not `display:none`) so the scroll-spy reads nondecreasing real
 *   positions for every mark, and clicking such a mark can expand the stack
 *   and scroll to the exact member;
 * - the minimap still draws one mark per agent message, and agent marks still
 *   offer no rewind checkpoint (`selectUserTurns`/`rewindUserTurnTexts` are
 *   untouched).
 */
import { useId, useState } from "react";
import type { AgentMessageBlock } from "./MessageList.js";
import { Chevron } from "./icons.js";
import { ChildReportBlock } from "./ChildReportBlock.js";
import { agentMessagePreview } from "../agent-message-format.js";

/** Header count text — the group's only label, e.g. `12 agent messages`. */
export function agentMessageStackLabel(count: number): string {
  return `${count} agent messages`;
}

/**
 * Exactly one rendered `data-block-id` per original block in either disclosure
 * state. Collapsed: the root owns the head id plus a zero-height anchor per
 * tail id. Expanded: the inner `ChildReportBlock`s own every id, so the root
 * must not duplicate the head (and the anchors disappear). Exported as a pure
 * seam for the automation/rewind-count and DOM-anchor regressions.
 */
export function agentMessageStackLayout(
  blocks: AgentMessageBlock[],
  expanded: boolean,
): { rootId: string | undefined; anchorIds: string[]; bodyIds: string[] } {
  return expanded
    ? { rootId: undefined, anchorIds: [], bodyIds: blocks.map((block) => block.id) }
    : { rootId: blocks[0]?.id, anchorIds: blocks.slice(1).map((block) => block.id), bodyIds: [] };
}

export function AgentMessageStack({
  blocks,
  enter = false,
}: {
  blocks: AgentMessageBlock[];
  enter?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const blockIds = agentMessageStackLayout(blocks, expanded);
  const newest = blocks[blocks.length - 1]!;

  return (
    <div
      className={`agent-message-stack${expanded ? "" : " minimap-turn"}${enter ? " message-enter" : ""}`}
      data-block-id={blockIds.rootId}
    >
      <button
        type="button"
        className="agent-message-stack-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="reasoning-caret" aria-hidden="true">
          <Chevron />
        </span>
        <span className="agent-message-stack-name">{agentMessageStackLabel(blocks.length)}</span>
      </button>
      {/* The newest member's one-line payload — outside the expanded body, so
          the collapsed group still says what the run is about. */}
      <div className="agent-message-preview">{agentMessagePreview(newest)}</div>
      {/* Collapsed: keep one `data-block-id` (and one minimap mark) per
          original message. Zero-height, in-flow, inert. */}
      {!expanded &&
        blockIds.anchorIds.map((blockId) => (
          <span
            key={blockId}
            className="agent-message-stack-anchor minimap-turn"
            data-block-id={blockId}
            aria-hidden="true"
          />
        ))}
      {expanded && (
        <div id={bodyId} className="agent-message-stack-body">
          {blocks.map((block) => (
            <ChildReportBlock key={block.id} block={block} defaultExpanded />
          ))}
        </div>
      )}
    </div>
  );
}

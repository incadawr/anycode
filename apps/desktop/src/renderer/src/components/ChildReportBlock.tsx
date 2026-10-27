/**
 * TASK.145 срез 2 (spec §4 point 3): renders a detached child's terminal
 * report as a compact, collapsed-by-default system card instead of the
 * normal user-message bubble — MessageList.tsx routes here whenever a
 * `user_text` block carries `origin === "system"`. The MODEL-facing role of
 * this turn is still "user" (owner decision, spec §4bis п.1); only the
 * TRANSCRIPT presentation differs, and only here.
 *
 * Disclosure pattern mirrors ReasoningBlock.tsx (collapsible plate, chevron,
 * aria-expanded/aria-controls) but without that component's live-streaming
 * machinery — a report's text is static from the moment it lands, never a
 * growing stream.
 */
import { useId, useState } from "react";
import type { TranscriptBlock } from "../store.js";
import { Chevron } from "./icons.js";
import { formatBlockTime } from "../block-time.js";
import { parseChildReportText, childReportCardLabel } from "../child-report-format.js";
import { agentMessagePreview, agentMessageStatusLabel, isAuthenticatedAgentMessage } from "../agent-message-format.js";

type UserTextBlock = Extract<TranscriptBlock, { kind: "user_text" }>;

/**
 * GitHub #19: an authenticated agent delivery keeps a ONE-LINE, always-visible
 * preview of its payload, even while collapsed. Before this, a run of agent
 * messages collapsed into a stack of identical `Agent message · acknowledged`
 * headers with no content — after a renderer reload the real conversation was
 * pushed below a wall of empty rows. Ordinary detached-child reports keep
 * their existing presentation (the summary only in the expanded body).
 *
 * `defaultExpanded` lets a grouped stack open every member at once while a
 * single card still starts collapsed.
 */
export function ChildReportBlock({ block, enter = false, defaultExpanded = false }: { block: UserTextBlock; enter?: boolean; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const textId = useId();
  const parsed = parseChildReportText(block.text);
  const time = formatBlockTime(block.at, Date.now());
  const isAgentMessage = isAuthenticatedAgentMessage(block);

  return (
    <div data-block-id={block.id} className={`message message-child-report${block.agentMessage ? " minimap-turn" : ""}${enter ? " message-enter" : ""}`}>
      <button
        type="button"
        className="child-report-toggle"
        aria-expanded={expanded}
        aria-controls={textId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="reasoning-caret" aria-hidden="true">
          <Chevron />
        </span>
        <span className={`child-report-status child-report-status-${parsed.status}`} aria-hidden="true" />
        {isAgentMessage ? `Agent message · ${agentMessageStatusLabel(block)}` : childReportCardLabel(parsed)}
        {time && (
          <time className="block-time" title={time.title}>
            {time.label}
          </time>
        )}
      </button>
      {/* Outside the expanded body on purpose: the preview is what makes the
          collapsed transcript readable after a reload. Plain text, never
          Markdown/HTML — an agent payload is untrusted content. */}
      {isAgentMessage && <div className="agent-message-preview">{agentMessagePreview(block)}</div>}
      {expanded && (
        <pre id={textId} className="child-report-text" aria-live="off">
          {isAgentMessage ? block.text : parsed.summary}
        </pre>
      )}
    </div>
  );
}

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
import { parseChildReportText, childReportCardLabel } from "../child-report-format.js";

type UserTextBlock = Extract<TranscriptBlock, { kind: "user_text" }>;

export function ChildReportBlock({ block, enter = false }: { block: UserTextBlock; enter?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const parsed = parseChildReportText(block.text);

  return (
    <div className={`message message-child-report${enter ? " message-enter" : ""}`}>
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
        {childReportCardLabel(parsed)}
      </button>
      {expanded && (
        <pre id={textId} className="child-report-text" aria-live="off">
          {parsed.summary}
        </pre>
      )}
    </div>
  );
}

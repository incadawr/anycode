/**
 * slice 2 (spec §4 point 3): renders a detached child's terminal
 * report as a compact, collapsed-by-default system card instead of the
 * normal user-message bubble — MessageList.tsx routes here whenever a
 * `user_text` block carries `origin === "system"`. The MODEL-facing role of
 * this turn is still "user" (owner decision, spec §4bis item 1); only the
 * TRANSCRIPT presentation differs, and only here.
 *
 * Disclosure pattern mirrors ReasoningBlock.tsx (collapsible plate, chevron,
 * aria-expanded/aria-controls) but without that component's live-streaming
 * machinery — a report's text is static from the moment it lands, never a
 * growing stream.
 */
import { useContext, useEffect, useId, useState } from "react";
import { Button } from "../ui/index.js";
import { TabContext } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import type { AgentMessageLinkTarget } from "../../../shared/agent-message-links.js";
import type { TranscriptBlock } from "../store.js";
import { Chevron } from "./icons.js";
import { formatBlockTime } from "../block-time.js";
import { parseChildReportText, childReportCardLabel } from "../child-report-format.js";
import { agentMessageDirection, agentMessageTitle, agentMessageBody, agentMessagePreview, agentMessageStatusLabel, isAuthenticatedAgentMessage } from "../agent-message-format.js";

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

  const tab = useContext(TabContext);
  const card = block.agentMessageCard;
  const [target, setTarget] = useState<AgentMessageLinkTarget | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const messageId = card?.envelope.messageId;
  const side = card?.direction;
  const tabId = tab?.tabId;
  useEffect(() => {
    let active = true;
    setTarget(null); setUnavailable(false);
    if (messageId && side && tabId && card?.envelope.principal?.kind === "session") {
      void window.anycode?.agentMessageLinks.lookup({ messageId, side, tabId })
        .then(value => { if (active) setTarget(value); }).catch(() => {});
    }
    return () => { active = false; };
  }, [messageId, side, tabId, card?.envelope.principal?.kind]);
  async function focusPeer() {
    if (!messageId || !side || !tabId) return;
    try {
      const live = await window.anycode.agentMessageLinks.focus({ messageId, side, tabId });
      if (live) { useTabsStore.getState().setActiveTab(live.tabId); return; }
    } catch { /* An unavailable peer stays a plain label. */ }
    setUnavailable(true);
  }

  return (
    <div data-block-id={block.id} className={`message message-child-report${block.agentMessage ? " minimap-turn" : ""}${enter ? " message-enter" : ""}`}>
      <Button variant="ghost"
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
        {isAgentMessage ? `${agentMessageDirection(block) ? `${agentMessageDirection(block)} · ` : ""}Agent message · ${agentMessageStatusLabel(block)}` : childReportCardLabel(parsed)}
        {time && (
          <time className="block-time" title={time.title}>
            {time.label}
          </time>
        )}
      </Button>
      {card && <div className="agent-message-identity">
        {target && !unavailable ? <Button variant="ghost" size="sm" onClick={() => void focusPeer()}>{agentMessageTitle(target.title) || "Session"}</Button>
          : <span>{agentMessageTitle(target?.title ?? (card.direction === "incoming" ? card.envelope.principal?.sessionId ?? "Session" : card.envelope.recipientSessionId)) || "Session"}{unavailable && <span role="status"> · Session unavailable</span>}</span>}
      </div>}
      {/* Outside the expanded body on purpose: the preview is what makes the
          collapsed transcript readable after a reload. Plain text, never
          Markdown/HTML — an agent payload is untrusted content. Hidden while
          expanded, where the full body below already shows the same text. */}
      {isAgentMessage && !expanded && <div className="agent-message-preview">{agentMessagePreview(block)}</div>}
      {expanded && (
        <pre id={textId} className="child-report-text" aria-live="off">
          {/* A delivery is shown through the SAME unwrapping in both shapes: the
              live block's raw `text` is `<envelope header>\n<payload>\nDelivery: …`
              while a hydrated one is `<envelope header>\n<payload>`, so rendering
              `text` verbatim leaked the envelope (and the delivery line) into the
              transcript of a freshly expanded group and nowhere else. */}
          {isAgentMessage ? agentMessageBody(block) : parsed.summary}
        </pre>
      )}
    </div>
  );
}

/**
 * GitHub #19: readable one-line presentation for an authenticated agent
 * delivery.
 *
 * An agent delivery reaches the transcript in two shapes, and BOTH must render
 * the same readable card:
 *
 * - LIVE (`store.ts`'s `agent_message` branch): the block carries the
 *   structured `agentMessagePayload` / `agentMessageState` /
 *   `agentMessageDetail` fields, and `text` is the model-facing wrapper with a
 *   `Delivery: <state>` suffix appended.
 * - HYDRATED (`session_history` -> `projectHistoryToBlocks`): a system-origin
 *   `user_text` block whose `text` is the authenticated wrapper
 *   (`[AnyCode authenticated agent message {...}]\n<payload>`); the delivery
 *   state is not available in that history representation.
 *
 * This module stays a pure, component-free projection so a single card and a
 * grouped stack of cards share exactly one preview/status rule, and so the
 * rules are pinnable without mounting React. Nothing here interprets the
 * payload as Markdown or HTML: it is plain text, collapsed and truncated.
 */
import type { AgentDelivery } from "../../shared/communication.js";
import type { TranscriptBlock } from "./store.js";

type UserTextBlock = Extract<TranscriptBlock, { kind: "user_text" }>;

/** First line of the model-facing wrapper `agentMessageText()` writes. */
const AUTHENTICATED_HEADER = /^\[AnyCode authenticated agent message [^\n]*\]\n/;

/** Most Unicode code points a collapsed preview shows before the ellipsis. */
export const AGENT_MESSAGE_PREVIEW_MAX = 160;
/** What a whitespace-only payload previews as — never an empty row. */
export const EMPTY_AGENT_MESSAGE_PREVIEW = "(empty message)";

/**
 * An authenticated agent delivery, as opposed to a detached-child report that
 * also arrives as a system-origin turn. The flag is authoritative when set;
 * the wrapper prefix is the legacy hydrated form (pre-#19 history blocks).
 */
export function isAuthenticatedAgentMessage(block: UserTextBlock): boolean {
  return block.agentMessage === true || block.text.startsWith("[AnyCode authenticated agent message ");
}

/**
 * The bare message body — THE one unwrapping rule, shared by the collapsed
 * preview and the expanded card so a live delivery and its reloaded twin read
 * the same. The structured payload wins when present (the live shape carries
 * it verbatim); otherwise it is the wrapper text minus its envelope header
 * line. History payloads can end in delivery-like text, so that text cannot
 * safely be treated as metadata — only the header line is stripped there.
 */
export function agentMessageBody(block: UserTextBlock): string {
  if (block.agentMessagePayload !== undefined) {
    return block.agentMessagePayload;
  }
  return block.text.replace(AUTHENTICATED_HEADER, "");
}

/**
 * One text line for the collapsed card. Whitespace (including newlines) is
 * collapsed, and the result is cut to {@link AGENT_MESSAGE_PREVIEW_MAX}
 * Unicode code points plus an ellipsis — never by UTF-16 unit, so a surrogate
 * pair is never split.
 */
export function agentMessagePreview(block: UserTextBlock): string {
  const collapsed = agentMessageBody(block).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return EMPTY_AGENT_MESSAGE_PREVIEW;
  }
  const points = Array.from(collapsed);
  return points.length <= AGENT_MESSAGE_PREVIEW_MAX ? collapsed : `${points.slice(0, AGENT_MESSAGE_PREVIEW_MAX).join("")}…`;
}

/** Only structured delivery metadata can establish a delivery state. */
export function agentMessageStatusLabel(block: UserTextBlock): AgentDelivery["state"] | "received" {
  return block.agentMessageState ?? "received";
}

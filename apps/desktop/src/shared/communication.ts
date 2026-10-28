/** No client-supplied role or identity: main stamps the authenticated principal. */
export interface AgentEnvelope {
  messageId: string;
  sender: string;
  recipientSessionId: string;
  correlationId?: string;
  replyTo?: string;
  kind: "agent_message" | "task_result";
  payload: string;
  mode: "next_turn" | "steer";
  createdAt: string;
}
export interface AgentDelivery {
  envelope: AgentEnvelope;
  state: "queued" | "acknowledged" | "rejected" | "unknown";
  detail?: string;
}
/**
 * The delivery wrapper's first line prefix: the only title text that is never
 * user-chosen, so a stored title that starts with it can be repaired back to
 * the session's handle without guessing. Shared so the writer and the repair
 * cannot drift apart.
 */
export const AGENT_MESSAGE_HEADER_PREFIX = "[AnyCode authenticated agent message ";
export function agentMessageText(e: AgentEnvelope): string {
  return `${AGENT_MESSAGE_HEADER_PREFIX}${JSON.stringify({ messageId: e.messageId, sender: e.sender, recipientSessionId: e.recipientSessionId, kind: e.kind, correlationId: e.correlationId, replyTo: e.replyTo })}]\n${e.payload}`;
}

/** Public assistant text only; no reasoning, tool payloads, or transcript export. */
export interface SessionPublicResult {
  source: "live_turn" | "history_recovery";
  turnId: string | null;
  requestId: string | null;
  nativeTurnId: string | null;
  historyItemId?: string;
  terminalReason: "completed" | "max_turns" | "cancelled" | "error" | "workspace_transition" | "unknown";
  publicAnswer: string | null;
  truncated: boolean;
  completedAt: number | null;
}

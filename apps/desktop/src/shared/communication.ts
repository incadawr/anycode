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
export function agentMessageText(e: AgentEnvelope): string {
  return `[AnyCode authenticated agent message ${JSON.stringify({ messageId: e.messageId, sender: e.sender, recipientSessionId: e.recipientSessionId, kind: e.kind, correlationId: e.correlationId, replyTo: e.replyTo })}]\n${e.payload}`;
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

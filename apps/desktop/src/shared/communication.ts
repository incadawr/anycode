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
/**
 * What `get_session_status` answers (Sessions API). The model/effort block is
 * additive to the pre-existing state/steering fields and describes TWO things
 * explicitly, because a native engine applies a pick on its next turn:
 *
 *  - `model`/`effort` — the pair SELECTED for the next turn;
 *  - `appliedEffort` — the effort the current applied snapshot carries;
 *  - `effortPending` — true while those two disagree;
 *  - `supportedEfforts` — the selected model's own advertised vocabulary
 *    (native strings preserved verbatim, `[]` when it advertises none).
 *
 * `null` means the effective effort is unknown or absent — a model default is
 * never invented here.
 */
export interface SessionStatus {
  sessionId: string;
  engine: string;
  state: string;
  steering: { supported: boolean; ready: boolean; nativeTurnId?: string };
  model: string;
  effort: string | null;
  supportedEfforts: string[];
  appliedEffort: string | null;
  effortPending: boolean;
}

/** Internal main→host operation name (never a public MCP tool). */
export const SET_SESSION_EFFORT_OPERATION = "set_session_effort";

/** Payload of `set_session_effort`. `effort` stays `unknown` until the shared validator classifies it. */
export interface SetSessionEffortPayload {
  effort: unknown;
}

/**
 * Discriminated result of `set_session_effort`. `ok:false` is a STRUCTURED
 * value (not a thrown error) so the refusal survives IPC with its code intact:
 * a validation failure is `invalid_effort` with the validator's own detail, and
 * anything the host could not safely perform (busy, shutting down, a control
 * request the engine refused or timed out) is `not_ready` — never an invented
 * unsupported-value verdict.
 */
export type SetSessionEffortOutcome =
  | { ok: true; status: SessionStatus }
  | { ok: false; reason: "invalid_effort"; detail: string }
  | { ok: false; reason: "not_ready"; detail?: string };

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

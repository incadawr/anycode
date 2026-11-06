
/** Main-authored boot capability, consumed before host subprocesses start. */
export const NATIVE_SESSIONS_ENV = "ANYCODE_NATIVE_SESSIONS_ENABLED";

export function takeNativeSessionsCarrier(env: Record<string, string | undefined>): boolean {
  const enabled = env[NATIVE_SESSIONS_ENV] === "1";
  delete env[NATIVE_SESSIONS_ENV];
  return enabled;
}

const id = z.string().min(1).max(200);
const payload = z.string().min(1).max(32000);
const reply = z.enum(["explicit", "on_turn_end"]);

/** Tool data only. Identity, generation and causal authority belong to main. */
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    requestId: id,
    operation: z.literal("list"),
    input: z.strictObject({
      cursor: id.optional(), limit: z.number().int().min(1).max(50).optional(),
      scope: z.enum(["workspace", "granted"]).optional(), ownMessageId: id.optional(),
    }),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("open"),
    input: z.strictObject({
      workspace: z.string().min(1).max(4096).optional(),
      engine: z.enum(["core", "claude", "codex"]).optional(),
      model: id.optional(), effort: id.optional(), handle: id.optional(),
      firstMessage: payload.optional(), reply: reply.optional(),
    }),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("send"),
    input: z.strictObject({
      sessionId: id.optional(), payload,
      mode: z.enum(["next_turn", "steer"]).optional(),
      idempotencyKey: id.optional(), correlationId: id.optional(), replyTo: id.optional(),
      reply: reply.optional(),
    }).refine(input => input.sessionId !== undefined || input.replyTo !== undefined),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("who_edits"),
    input: z.strictObject({ path: z.string().min(1).max(4096) }),
  }),
]);

export type SessionPeerRequest = z.infer<typeof requestSchema>;

/** Parsing is structural only; it never grants workspace or reply access. */
export function parseSessionPeerRequest(value: unknown): SessionPeerRequest | null {
  const parsed = requestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const peerSummary = z.strictObject({
  sessionId: id, tabId: id, workspace: z.string().max(4096),
  engine: z.enum(["core", "claude", "codex"]),
  activity: z.enum(["idle", "running", "waiting_approval", "closing"]),
  addressable: z.boolean(), title: z.string().max(200).optional(),
  model: z.string().max(200).optional(), effort: z.string().max(200).optional(),
});
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("sent"), messageId: id, state: z.enum(["queued", "acknowledged", "rejected", "unknown"]) }),
  z.strictObject({ status: z.literal("ok"), sessions: z.array(peerSummary).max(50) }),
  z.strictObject({ status: z.literal("refused"), reason: z.literal("loop_limited").optional() }),
  z.strictObject({ status: z.enum(["unavailable", "unknown"]) }),
]);
export type SessionPeerResponse = z.infer<typeof responseSchema>;
export type SessionPeerCall = SessionPeerRequest extends infer R
  ? R extends SessionPeerRequest ? Omit<R, "requestId"> : never : never;
export function parseSessionPeerResponse(value: unknown): SessionPeerResponse {
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "unknown" };
}


const turnContext = { sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), turnId: id, requestId: id, deliveredMessageIds: z.array(id).max(32) };
const publicResult = z.strictObject({
  source: z.literal("live_turn"), turnId: id, requestId: id,
  nativeTurnId: id.nullable(), terminalReason: z.enum(["completed", "max_turns", "cancelled", "error", "workspace_transition", "unknown"]),
  publicAnswer: z.string().max(32000).nullable(), truncated: z.boolean(), completedAt: z.number().finite(),
});
const turnEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session_peer_turn"), generation: z.number().int().positive(), ...turnContext }),
  z.strictObject({ type: z.literal("session_peer_terminal"), generation: z.number().int().positive(), ...turnContext, result: publicResult }),
]);
export type SessionPeerTurnEvent = z.infer<typeof turnEvent>;
export type SessionPeerTurnContext = Pick<SessionPeerTurnEvent, "sequence" | "turnId" | "requestId" | "deliveredMessageIds">;
export type SessionPeerTurnPublication = SessionPeerTurnEvent extends infer E
  ? E extends SessionPeerTurnEvent ? Omit<E, "generation"> : never : never;
export function parseSessionPeerTurnEvent(value: unknown): SessionPeerTurnEvent | null {
  const parsed = turnEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}

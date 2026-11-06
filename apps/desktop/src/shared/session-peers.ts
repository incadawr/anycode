import { z } from "zod";

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

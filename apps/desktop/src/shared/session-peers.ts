
/** Main-authored boot capability, consumed before host subprocesses start. */
export const NATIVE_SESSIONS_ENV = "ANYCODE_NATIVE_SESSIONS_ENABLED";

export function takeNativeSessionsCarrier(env: Record<string, string | undefined>): boolean {
  const enabled = env[NATIVE_SESSIONS_ENV] === "1";
  delete env[NATIVE_SESSIONS_ENV];
  return enabled;
}

import { z } from "zod";
export { parseSessionPeerRequest, parseSessionPeerResponse } from "@anycode/core";
export type { SessionPeerRequest, SessionPeerCall, SessionPeerResponse } from "@anycode/core";

const id = z.string().min(1).max(200);
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

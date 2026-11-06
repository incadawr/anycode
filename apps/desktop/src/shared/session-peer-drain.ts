import { z } from "zod";
const id = z.string().min(1).max(200);
const identity = { messageId: id, nonce: id, recipientSessionId: id, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
const request = z.strictObject({ type: z.literal("session_peer_drain_request"), ...identity });
const release = z.strictObject({ type: z.literal("session_peer_drain_release"), ...identity });
const permit = z.strictObject({ type: z.literal("session_peer_drain_permit"), ...identity });
export type SessionPeerDrainRequest = z.infer<typeof request>;
export type SessionPeerDrainPermit = z.infer<typeof permit>;
export function parseSessionPeerDrainRequest(raw: unknown): SessionPeerDrainRequest | null {
  const result = request.safeParse(raw); return result.success ? result.data : null;
}
export function parseSessionPeerDrainPermit(raw: unknown): SessionPeerDrainPermit | null {
  const result = permit.safeParse(raw); return result.success ? result.data : null;
}
export function parseSessionPeerDrainRelease(raw: unknown) {
  const result = release.safeParse(raw); return result.success ? result.data : null;
}

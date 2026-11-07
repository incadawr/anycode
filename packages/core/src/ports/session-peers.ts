import type { SessionPeerCall, SessionPeerResponse } from "../tools/session-peers.js";

/** Optional root capability. Never copied to inline child configs. */
export interface SessionPeersPort {
  request(call: SessionPeerCall, signal?: AbortSignal): Promise<SessionPeerResponse>;
}

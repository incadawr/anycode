export const SESSION_PEER_VIEW_CHANNEL = "anycode:session-peer-view";
export const SESSION_PEER_SET_CHANNEL = "anycode:session-peer-set";
export interface NativeProjectView { key: string; name: string; enabled: boolean; trusted: boolean; granted: boolean }
export interface SessionPeerView { available: boolean; project: NativeProjectView; peers: NativeProjectView[] }
export type SessionPeerViewResult = { ok: true; view: SessionPeerView } | { ok: false; reason: "invalid" | "unavailable" | "io_error" };
export type SessionPeerChange = { tabId: string; projectKey: string; enabled: boolean; peerKey?: string };
export interface SessionPeerBridge {
  get(tabId: string): Promise<SessionPeerViewResult>;
  set(change: SessionPeerChange): Promise<SessionPeerViewResult>;
}

import { randomUUID } from "node:crypto";
import { parseSessionPeerDrainRequest, parseSessionPeerDrainPermit, type SessionPeerDrainPermit } from "../shared/session-peer-drain.js";

/** Only the authenticated main channel may call handle. No listeners are installed here. */
export function createSessionPeerDrainTransport(post: (message: unknown) => void,
  host: { recipientSessionId: string; generation: number; timeoutMs?: number }) {
  host = { ...host };
  const timeoutMs = Number.isFinite(host.timeoutMs) ? Math.max(1, Math.min(host.timeoutMs!, 20_000)) : 20_000;
  type Pending = { messageId: string; permit?: SessionPeerDrainPermit; finish(value: SessionPeerDrainPermit | null): void; close(): void };
  const pending = new Map<string, Pending>();
  let disposed = false;
  const dispose = () => { disposed = true; for (const entry of pending.values()) entry.close(); };
  return {
    request(messageId: string): Promise<SessionPeerDrainPermit | null> {
      if (disposed || pending.size >= 64 || [...pending.values()].some(p => p.messageId === messageId)) return Promise.resolve(null);
      const request = parseSessionPeerDrainRequest({ type: "session_peer_drain_request", messageId, nonce: randomUUID(),
        recipientSessionId: host.recipientSessionId, generation: host.generation });
      if (!request) return Promise.resolve(null);
      return new Promise(resolve => {
        const close = () => { clearTimeout(timer); pending.delete(request.nonce); resolve(null); };
        const timer = setTimeout(close, timeoutMs); timer.unref();
        pending.set(request.nonce, { messageId, finish: resolve, close });
        try { post(request); } catch { close(); }
      });
    },
    handle(raw: unknown): boolean {
      const permit = parseSessionPeerDrainPermit(raw), entry = permit && pending.get(permit.nonce);
      if (!permit || !entry || entry.permit || permit.messageId !== entry.messageId ||
          permit.recipientSessionId !== host.recipientSessionId || permit.generation !== host.generation) return false;
      Object.freeze(permit); entry.permit = permit; entry.finish(permit); return true;
    },
    consume(permit: SessionPeerDrainPermit): boolean {
      const entry = pending.get(permit.nonce);
      if (!entry || entry.permit !== permit) return false;
      entry.close(); return true;
    },
    discard(permit: SessionPeerDrainPermit): boolean {
      const entry = pending.get(permit.nonce);
      if (!entry || entry.permit !== permit) return false;
      entry.close();
      try { post({ ...permit, type: "session_peer_drain_release" }); } catch { /* Remains refused in main. */ }
      return true;
    },
    disconnect: dispose,
    dispose,
  };
}

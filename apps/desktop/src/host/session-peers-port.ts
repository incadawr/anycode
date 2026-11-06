import { randomUUID } from "node:crypto";
import { parseSessionPeerRequest, parseSessionPeerResponse, type SessionPeerCall, type SessionPeerResponse } from "../shared/session-peers.js";

/** One host generation owns these calls. Aborting a wait never retries a mutation. */
export function createSessionPeersPort(post: (message: unknown) => void,
  options: { maxPending?: number; timeoutMs?: number } = {}) {
  const pending = new Map<string, (response: SessionPeerResponse) => void>();
  let disposed = false;
  return {
    get pendingCount() { return pending.size; },
    request(call: SessionPeerCall, signal?: AbortSignal): Promise<SessionPeerResponse> {
      if (disposed || pending.size >= (options.maxPending ?? 64)) return Promise.resolve({ status: "unavailable" });
      if (signal?.aborted) return Promise.resolve({ status: "unknown" });
      const request = parseSessionPeerRequest({ ...call, requestId: randomUUID() });
      if (!request) return Promise.resolve({ status: "refused" });
      return new Promise(resolve => {
        const finish = (response: SessionPeerResponse) => {
          if (!pending.delete(request.requestId)) return;
          clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(response);
        };
        const abort = () => finish({ status: "unknown" });
        const timer = setTimeout(abort, options.timeoutMs ?? 20_000);
        timer.unref(); pending.set(request.requestId, finish);
        signal?.addEventListener("abort", abort, { once: true });
        try { post({ type: "session_peers_request", request }); } catch { abort(); }
      });
    },
    handle(message: unknown): boolean {
      if (!message || typeof message !== "object") return false;
      const data = message as Record<string, unknown>;
      if (data.type !== "session_peers_response") return false;
      if (typeof data.requestId === "string") pending.get(data.requestId)?.(parseSessionPeerResponse(data.result));
      return true;
    },
    dispose() {
      disposed = true;
      for (const finish of pending.values()) finish({ status: "unknown" });
    },
  };
}

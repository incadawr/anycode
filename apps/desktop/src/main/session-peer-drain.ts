import { parseSessionPeerDrainRelease, parseSessionPeerDrainRequest, type SessionPeerDrainPermit } from "../shared/session-peer-drain.js";
import type { CommunicationRecord } from "./communication-ledger.js";
import type { PeerHost } from "./session-peers.js";
import type { createSessionPeerAccess } from "./session-peer-access.js";

/** Registration belongs to the durable broker post boundary, before host delivery. */
export function createSessionPeerDrain(deps: {
  lookup(messageId: string): CommunicationRecord | undefined;
  current(sessionId: string): PeerHost | undefined;
  prepare(): Promise<void>;
  access: Pick<ReturnType<typeof createSessionPeerAccess>, "canAccess">;
}) {
  type Entry = { record: CommunicationRecord; sender: PeerHost; recipient: PeerHost; identity: string; nonces: Set<string>; nonce?: string; state: "ready" | "pending" | "issued" };
  let disposed = false;
  const entries = new Map<string, Entry>();
  const identity = (r: CommunicationRecord) => JSON.stringify([r.envelope, r.principal, r.workspace, r.peer]);
  const current = (pinned: PeerHost) => {
    const host = deps.current(pinned.sessionId);
    return host?.live && host.proc && host.proc === pinned.proc && host.tabId === pinned.tabId &&
      host.generation === pinned.generation && host.workspace === pinned.workspace && host.workspaceKey === pinned.workspaceKey ? host : null;
  };
  return {
    register(record: CommunicationRecord, sender: PeerHost, recipient: PeerHost): boolean {
      const id = record.envelope.messageId;
      if (disposed || entries.has(id) || deps.lookup(id) !== record || !record.peer ||
          record.principal?.kind !== "session" || record.principal.sessionId !== sender.sessionId || record.principal.tabId !== sender.tabId ||
          record.envelope.sender !== `session:${sender.sessionId}` || record.envelope.recipientSessionId !== recipient.sessionId ||
          record.envelope.mode !== "next_turn" || record.peer.senderWorkspace !== sender.workspaceKey || record.workspace !== recipient.workspaceKey ||
          !current(sender) || !current(recipient)) return false;
      if (entries.size >= 10000) {
        // A pending authorization and queued/dispatch-pending deliveries stay pinned.
        const terminal = [...entries].filter(([, entry]) => entry.state !== "pending" &&
          entry.record.state !== "queued" && entry.record.detail !== "Dispatch pending")
          .sort((a, b) => a[1].record.peer!.acceptedAt - b[1].record.peer!.acceptedAt);
        if (!terminal.length) return false;
        entries.delete(terminal[0]![0]);
      }
      entries.set(id, { record, sender: { ...sender }, recipient: { ...recipient }, identity: identity(record), nonces: new Set(), state: "ready" });
      return true;
    },
    async request(proc: object, raw: unknown): Promise<SessionPeerDrainPermit | null> {
      const request = parseSessionPeerDrainRequest(raw);
      const entry = request && entries.get(request.messageId);
      if (!request || !entry || entry.state !== "ready" || entry.nonces.has(request.nonce) || entry.nonces.size >= 64 || proc !== entry.recipient.proc ||
          request.recipientSessionId !== entry.recipient.sessionId || request.generation !== entry.recipient.generation) return null;
      entry.state = "pending"; entry.nonce = request.nonce; entry.nonces.add(request.nonce);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([deps.prepare(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Drain deadline")), 20_000); timer.unref();
        })]);
        const sender = current(entry.sender), recipient = current(entry.recipient);
        if (entries.get(request.messageId) !== entry || !sender || !recipient || deps.lookup(request.messageId) !== entry.record ||
            identity(entry.record) !== entry.identity || entry.record.state === "rejected" ||
            (entry.record.state === "unknown" && entry.record.detail !== "Dispatch pending") ||
            Date.now() - entry.record.peer!.startedAt >= 30 * 60_000 ||
            !deps.access.canAccess(sender, recipient, "send")) return null;
        entry.state = "issued";
        return { ...request, type: "session_peer_drain_permit" };
      } catch { return null; }
      finally { clearTimeout(timer); if (entry.state === "pending") entry.state = "issued"; }
    },
    release(proc: object, raw: unknown): boolean {
      const release = parseSessionPeerDrainRelease(raw), entry = release && entries.get(release.messageId);
      if (!release || !entry || entry.state !== "issued" || entry.nonce !== release.nonce || proc !== entry.recipient.proc ||
          release.recipientSessionId !== entry.recipient.sessionId || release.generation !== entry.recipient.generation || !current(entry.recipient)) return false;
      entry.state = "ready"; return true;
    },
    dispose() { disposed = true; entries.clear(); },
  };
}

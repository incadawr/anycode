import type { CommunicationBroker } from "./communication-broker.js";
import type { CommunicationRecord } from "./communication-ledger.js";
import type { PeerHost } from "./session-peers.js";
import { parseSessionPeerTurnEvent, type SessionPeerTurnEvent } from "../shared/session-peers.js";

/** Runtime custody is never reconstructed from disk. Only authenticated terminal pushes enter here. */
export function createSessionPeerReplyCoordinator(broker: CommunicationBroker, deps: {
  current(id: string): PeerHost | undefined;
  sendAuto(caller: PeerHost, source: CommunicationRecord, payload: string): Promise<CommunicationRecord>;
}) {
  type Entry = { source: CommunicationRecord; host: PeerHost; sender: PeerHost; terminal?: SessionPeerTurnEvent; sending?: boolean };
  const entries = new Map<string, Entry>();
  const live = (e: Entry) => [e.host, e.sender].every(host => {
    const now = deps.current(host.sessionId);
    return now?.live && now.proc === host.proc && now.tabId === host.tabId && now.generation === host.generation &&
      now.workspaceKey === host.workspaceKey && now.workspace === host.workspace;
  });
  const unknown = (e: Entry) => {
    if (e.source.subscription?.state === "pending") e.source.subscription.state = "unknown";
    entries.delete(e.source.envelope.messageId);
  };
  const deliver = (e: Entry) => {
    if (!e.terminal || e.terminal.type !== "session_peer_terminal" || e.sending || e.source.subscription?.state !== "pending") return;
    if (!live(e)) { unknown(e); void broker.ledger.persist().catch(() => {}); return; }
    const r = e.terminal.result;
    // Leave ample JSON escaping overhead below the broker's payload boundary.
    const answer = r.publicAnswer?.slice(0, 4000) ?? null;
    const payload = JSON.stringify({ source: r.source, turnId: r.turnId, requestId: r.requestId,
      nativeTurnId: r.nativeTurnId, terminalReason: r.terminalReason, publicAnswer: answer,
      truncated: r.truncated || answer !== r.publicAnswer, completedAt: r.completedAt });
    e.sending = true;
    void deps.sendAuto({ ...e.host, turnContext: undefined }, e.source, payload).catch(() => {
      unknown(e); return broker.ledger.persist();
    }).catch(() => {}).finally(() => { entries.delete(e.source.envelope.messageId); });
  };
  const stopDelivery = broker.onPeerDelivery();
  const unsubscribe = broker.onPeerTerminal((id, raw) => {
    const event = parseSessionPeerTurnEvent(raw);
    if (event?.type !== "session_peer_terminal") return;
    for (const messageId of event.deliveredMessageIds) {
      const e = entries.get(messageId);
      if (!e || e.host.sessionId !== id || e.host.generation !== event.generation || !live(e)) continue;
      e.terminal = event; deliver(e);
    }
  });
  broker.lifecycle({
    async reconcile() {
      let changed = false;
      for (const e of entries.values()) if (!live(e)) { unknown(e); changed = true; }
      if (changed) await broker.ledger.persist();
    },
    dispose() {
      unsubscribe(); stopDelivery(); for (const e of entries.values()) unknown(e);
      return broker.ledger.persist();
    },
  });
  return {
    subscribe(record: CommunicationRecord, target: string) {
      const host = deps.current(target);
      const sender = record.principal?.kind === "session" ? deps.current(record.principal.sessionId) : undefined;
      if (!host?.live || !host.proc || !sender?.live || !sender.proc) throw new Error("Reply recipient unavailable");
      record.subscription = { state: "pending" };
      entries.set(record.envelope.messageId, { source: record, host: { ...host }, sender: { ...sender } });
    },
    reserve(source: CommunicationRecord, record: CommunicationRecord, automatic: boolean) {
      if (!source.subscription) return;
      const entry = entries.get(source.envelope.messageId);
      if (!entry || !live(entry) || source.subscription.state !== "pending") throw new Error("Reply already reserved");
      source.subscription = { state: automatic ? "auto" : "explicit", messageId: record.envelope.messageId };
    },
    failed(record: CommunicationRecord | undefined, source?: CommunicationRecord) {
      if (record && !broker.ledger.messages.has(record.envelope.messageId)) {
        entries.delete(record.envelope.messageId);
        if (source?.subscription?.messageId === record.envelope.messageId) {
          source.subscription = { state: "pending" };
          const e = entries.get(source.envelope.messageId); if (e) deliver(e);
        }
      }
    },
  };
}
export type SessionPeerReplyCoordinator = ReturnType<typeof createSessionPeerReplyCoordinator>;

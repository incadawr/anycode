import type { CommunicationBroker } from "./communication-broker.js";
import type { CommunicationRecord, PeerMessageBudget } from "./communication-ledger.js";
import type { SessionPeerRequest } from "../shared/session-peers.js";
import type { PeerHost } from "./session-peers.js";
type Input = Extract<SessionPeerRequest, { operation: "send" }>["input"];
type Authorize = Parameters<CommunicationBroker["send"]>[2];

/** Authority and budgets are main-owned; records reserve slots before the writer await. */
export function createSessionPeerReplies(broker: CommunicationBroker, clock = Date.now) {
  const sourceFor = (caller: PeerHost, input: Input): CommunicationRecord | undefined => {
    if (!input.replyTo) return;
    const source = broker.ledger.messages.get(input.replyTo);
    if (!source?.peer || source.principal?.kind !== "session" ||
        source.envelope.recipientSessionId !== caller.sessionId || source.state === "rejected" ||
        source.envelope.sender !== `session:${source.principal.sessionId}`) throw new Error("Reply membership refused");
    return source;
  };
  return {
    send(caller: PeerHost, input: Input, authorize: Authorize, revalidate?: (id: string) => void, accepted?: (record: CommunicationRecord) => void) {
      if (!caller.live || !caller.root || caller.restricted || caller.readOnly) throw new Error("Peer send refused");
      if (input.reply === "on_turn_end" || input.mode === "steer") throw new Error("Reply mode unavailable");
      const source = sourceFor(caller, input);
      const inherited = caller.turnContext?.deliveredMessageIds.map(id => broker.ledger.messages.get(id))
        .find(record => record?.peer && record.principal?.kind === "session" && record.envelope.recipientSessionId === caller.sessionId);
      // The active turn's causal authority takes precedence over tool correlation.
      const causalSource = inherited ?? source;
      const target = source?.principal?.kind === "session" ? source.principal.sessionId : input.sessionId;
      if (!target || target === caller.sessionId || (input.sessionId && input.sessionId !== target)) throw new Error("Peer target refused");
      if (source && input.correlationId && input.correlationId !== source.envelope.correlationId) throw new Error("Reply correlation refused");
      return broker.send({ kind: "session", sessionId: caller.sessionId, tabId: caller.tabId }, {
        sessionId: target, payload: input.payload, mode: "next_turn", kind: "agent_message",
        idempotencyKey: input.idempotencyKey, replyTo: input.replyTo,
        correlationId: source ? source.envelope.correlationId : input.correlationId,
      }, authorize, undefined, record => {
        revalidate?.(target);
        const at = clock();
        sourceFor(caller, input);
        const prior = causalSource?.peer;
        const peer: PeerMessageBudget = { chainId: prior?.chainId ?? record.envelope.messageId,
          startedAt: prior?.startedAt ?? at, hop: prior ? prior.hop + 1 : 0,
          acceptedAt: at, senderWorkspace: caller.workspaceKey };
        const records = [...broker.ledger.messages.values()];
        if (peer.hop > 8 || at - peer.startedAt >= 30 * 60_000 ||
            records.filter(r => r.peer?.chainId === peer.chainId).length >= 32) throw new Error("loop_limited");
        const recent = records.filter(r => r.peer && at - r.peer.acceptedAt < 60_000);
        if (recent.filter(r => r.principal?.kind === "session" && r.principal.sessionId === caller.sessionId).length >= 20 ||
            recent.filter(r => r.peer?.senderWorkspace === caller.workspaceKey).length >= 60) throw new Error("Peer rate limited");
        record.peer = peer;
        accepted?.(record);
      });
    },
  };
}

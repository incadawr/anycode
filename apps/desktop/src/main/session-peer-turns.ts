import { parseSessionPeerTurnEvent, type SessionPeerTurnContext } from "../shared/session-peers.js";

/** Custody belongs to the main listener's process reference, never a wire identity. */
export function createSessionPeerTurns() {
  const processes = new WeakMap<object, { expected: Set<string>; sequence: number; active?: SessionPeerTurnContext }>();
  const state = (proc: object) => {
    let value = processes.get(proc);
    if (!value) { value = { expected: new Set(), sequence: 0 }; processes.set(proc, value); }
    return value;
  };
  return {
    expectMessage(proc: object, messageId: string) {
      const s = state(proc);
      if (s.expected.size < 10000) s.expected.add(messageId);
    },
    active(proc: object): SessionPeerTurnContext | undefined {
      const active = processes.get(proc)?.active;
      return active ? { ...active, deliveredMessageIds: [...active.deliveredMessageIds] } : undefined;
    },
    accept(host: { proc: object | null; generation: number }, proc: object, raw: unknown) {
      if (host.proc !== proc) return null;
      const event = parseSessionPeerTurnEvent(raw);
      if (!event || event.generation !== host.generation) return null;
      const s = state(proc);
      if (event.type === "session_peer_turn") {
        if (s.active || event.sequence <= s.sequence || new Set(event.deliveredMessageIds).size !== event.deliveredMessageIds.length ||
            event.deliveredMessageIds.some(id => !s.expected.has(id)) ||
            (event.deliveredMessageIds.length > 0 && !event.deliveredMessageIds.includes(event.requestId))) return null;
        s.active = { sequence: event.sequence, turnId: event.turnId, requestId: event.requestId, deliveredMessageIds: event.deliveredMessageIds };
        for (const id of event.deliveredMessageIds) s.expected.delete(id);
        s.sequence = event.sequence;
      } else {
        const active = s.active;
        if (!active || active.sequence !== event.sequence || active.turnId !== event.turnId || active.requestId !== event.requestId ||
            event.result.turnId !== event.turnId || event.result.requestId !== event.requestId ||
            JSON.stringify(active.deliveredMessageIds) !== JSON.stringify(event.deliveredMessageIds)) return null;
        s.active = undefined;
      }
      return event;
    },
  };
}

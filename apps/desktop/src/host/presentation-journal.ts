import type { HistoryItem, ImageAttachment } from "@anycode/core";
import type { HostToUiMessage, PresentationTurn, WireAgentEvent } from "../shared/protocol.js";

/** Renderer-only transcript events retained independently of the replay ring. */
export class PresentationJournal {
  private readonly turns: PresentationTurn[] = [];
  private readonly durableTurns = new Set<string>();
  private readonly discardedTurns = new Set<string>();
  private readonly deltas = new Map<string, { event: WireAgentEvent; step?: number; attempt?: number; at?: number }>();

  constructor(private readonly limit = 500, private readonly replayLimit = 5000) {}

  private discard(index: number): void {
    const [turn] = this.turns.splice(index, 1);
    if (!turn) return;
    this.durableTurns.delete(turn.turnId);
    this.discardedTurns.add(turn.turnId);
    while (this.discardedTurns.size > this.replayLimit) this.discardedTurns.delete(this.discardedTurns.values().next().value!);
    for (const key of this.deltas.keys()) if (key.startsWith(`${turn.turnId}:`)) this.deltas.delete(key);
  }

  start(turnId: string, requestId: string, startedAt: number, text?: string, images?: ImageAttachment[], origin?: "system"): void {
    this.turns.push({ turnId, requestId, startedAt, ...(text !== undefined ? { text } : {}), ...(images?.length ? { images } : {}), ...(origin ? { origin } : {}), events: [] });
    while (this.turns.length > this.limit) this.discard(0);
  }

  record(turnId: string, event: WireAgentEvent, step?: number, attempt?: number, at?: number): void {
    const turn = this.turns.findLast((entry) => entry.turnId === turnId);
    if (!turn) return;
    const events = turn.events;
    if (event.type === "tool_input_delta") return; // Input is captured by the completed tool call.
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const key = `${turnId}:${step ?? "_"}:${attempt ?? "_"}:${event.type}:${event.id}`;
      const previous = this.deltas.get(key);
      if (previous && previous.event.type === event.type) {
        previous.event.text += event.text;
        return;
      }
      const entry = { event: { ...event }, ...(step !== undefined ? { step } : {}), ...(attempt !== undefined ? { attempt } : {}) };
      // A start may already have aged out before the first delta arrived.
      const startType = event.type === "text_delta" ? "text_start" : "reasoning_start";
      if (!events.some((item) => item.step === step && item.attempt === attempt && item.event.type === startType && item.event.id === event.id)) {
        events.push({ event: { type: startType, id: event.id }, ...(step !== undefined ? { step } : {}), ...(attempt !== undefined ? { attempt } : {}) });
      }
      events.push(entry);
      this.deltas.set(key, entry);
      this.trimEvents(turn);
      return;
    }
    if (event.type === "text_start" || event.type === "reasoning_start") {
      const kind = event.type === "text_start" ? "text_delta" : "reasoning_delta";
      this.deltas.delete(`${turnId}:${step ?? "_"}:${attempt ?? "_"}:${kind}:${event.id}`);
    }
    events.push({ event: { ...event }, ...(step !== undefined ? { step } : {}), ...(attempt !== undefined ? { attempt } : {}), ...(at !== undefined ? { at } : {}) });
    this.trimEvents(turn);
  }

  private trimEvents(turn: PresentationTurn): void {
    while (turn.events.length > this.replayLimit) {
      // Remove the oldest event, together with its paired stream event if any.
      // This keeps retained deltas renderable without sacrificing newer events.
      const starts = new Map<string, number>();
      const pairs = new Map<number, number>();
      turn.events.forEach((entry, index) => {
        const event = entry.event;
        if (event.type !== "text_start" && event.type !== "reasoning_start" && event.type !== "text_delta" && event.type !== "reasoning_delta") return;
        const kind = event.type.startsWith("text_") ? "text" : "reasoning";
        const key = JSON.stringify([entry.step, entry.attempt, kind, event.id]);
        if (event.type === "text_start" || event.type === "reasoning_start") starts.set(key, index);
        else {
          const start = starts.get(key);
          if (start !== undefined) { pairs.set(start, index); pairs.set(index, start); }
        }
      });
      const partner = pairs.get(0);
      const indices = partner === undefined ? [0] : [partner, 0];
      for (const index of indices) {
        const [removed] = turn.events.splice(index, 1);
        for (const [key, entry] of this.deltas) if (entry === removed) this.deltas.delete(key);
      }
    }
  }

  recordFileSnapshot(turnId: string, snapshot: Extract<HostToUiMessage, { type: "file_snapshot" }>): void {
    const turn = this.turns.findLast((entry) => entry.turnId === turnId);
    if (!turn) return;
    const snapshots = turn.fileSnapshots ??= [];
    const index = snapshots.findIndex((entry) => entry.toolCallId === snapshot.toolCallId && entry.phase === snapshot.phase);
    if (index < 0) snapshots.push(snapshot);
    else snapshots[index] = snapshot;
    if (snapshots.length > this.limit) snapshots.shift();
  }

  observeHistory(history: readonly HistoryItem[], liveTurnId?: string): void {
    const present = new Set(history.slice(-this.limit).flatMap((item) => item.turnId === undefined ? [] : [item.turnId]));
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      if (this.durableTurns.has(turn.turnId) && !present.has(turn.turnId) && turn.turnId !== liveTurnId) this.discard(i);
    }
    for (const turn of this.turns) if (present.has(turn.turnId)) this.durableTurns.add(turn.turnId);
  }

  snapshot(history?: readonly HistoryItem[], liveTurnId?: string): { turns: PresentationTurn[]; coveredTurnIds: string[] } {
    if (history) this.observeHistory(history, liveTurnId);
    return { turns: structuredClone(this.turns), coveredTurnIds: [...this.discardedTurns, ...this.turns.map((turn) => turn.turnId)] };
  }

  clear(): void { this.turns.length = 0; this.deltas.clear(); this.durableTurns.clear(); this.discardedTurns.clear(); }
}

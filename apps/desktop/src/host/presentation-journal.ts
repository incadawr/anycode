import type { HistoryItem, ImageAttachment } from "@anycode/core";
import type { HostToUiMessage, PresentationTurn, WireAgentEvent } from "../shared/protocol.js";

/** Renderer-only transcript events retained independently of the replay ring. */
export class PresentationJournal {
  private readonly turns: PresentationTurn[] = [];
  private readonly durableTurns = new Set<string>();
  private readonly discardedTurns = new Set<string>();
  private readonly deltas = new Map<string, { event: WireAgentEvent; step?: number; attempt?: number; at?: number }>();

  start(turnId: string, requestId: string, startedAt: number, text?: string, images?: ImageAttachment[], origin?: "system"): void {
    this.turns.push({ turnId, requestId, startedAt, ...(text !== undefined ? { text } : {}), ...(images?.length ? { images } : {}), ...(origin ? { origin } : {}), events: [] });
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
      events.push(entry);
      this.deltas.set(key, entry);
      return;
    }
    if (event.type === "text_start" || event.type === "reasoning_start") {
      const kind = event.type === "text_start" ? "text_delta" : "reasoning_delta";
      this.deltas.delete(`${turnId}:${step ?? "_"}:${attempt ?? "_"}:${kind}:${event.id}`);
    }
    events.push({ event: { ...event }, ...(step !== undefined ? { step } : {}), ...(attempt !== undefined ? { attempt } : {}), ...(at !== undefined ? { at } : {}) });
  }

  recordFileSnapshot(turnId: string, snapshot: Extract<HostToUiMessage, { type: "file_snapshot" }>): void {
    const turn = this.turns.findLast((entry) => entry.turnId === turnId);
    if (!turn) return;
    const snapshots = turn.fileSnapshots ??= [];
    const index = snapshots.findIndex((entry) => entry.toolCallId === snapshot.toolCallId && entry.phase === snapshot.phase);
    if (index < 0) snapshots.push(snapshot);
    else snapshots[index] = snapshot;
  }

  observeHistory(history: readonly HistoryItem[]): void {
    for (const item of history) if (item.turnId !== undefined) this.durableTurns.add(item.turnId);
  }

  snapshot(history?: readonly HistoryItem[], liveTurnId?: string): { turns: PresentationTurn[]; coveredTurnIds: string[] } {
    if (history) {
      const present = new Set(history.flatMap((item) => item.turnId === undefined ? [] : [item.turnId]));
      for (let i = this.turns.length - 1; i >= 0; i--) {
        const turn = this.turns[i]!;
        if (this.durableTurns.has(turn.turnId) && !present.has(turn.turnId) && turn.turnId !== liveTurnId) {
          this.discardedTurns.add(turn.turnId);
          this.turns.splice(i, 1);
          for (const key of this.deltas.keys()) if (key.startsWith(`${turn.turnId}:`)) this.deltas.delete(key);
        }
      }
      this.observeHistory(history);
    }
    return { turns: structuredClone(this.turns), coveredTurnIds: [...this.discardedTurns, ...this.turns.map((turn) => turn.turnId)] };
  }

  clear(): void { this.turns.length = 0; this.deltas.clear(); this.durableTurns.clear(); this.discardedTurns.clear(); }
}

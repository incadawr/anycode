/**
 * Host-owned fire-and-forget sink of a Claude turn's already-translated
 * `AgentEvent` stream into the additive `claude_transcript_items` SQLite
 * mirror (SLICE-CC D-min, cut §1.5). This is the ONLY source resume can read
 * a transcript from: `--resume` never re-emits history on the wire (W0 probe
 * #4, `w0-04-resume-part2.jsonl`), and the on-disk `.jsonl` Claude Code itself
 * writes is deliberately never parsed (cut invariant §0.2-4).
 *
 * `record()` mirrors `SqliteCodexShadowLog`'s posture (host/engines/codex/
 * shadow-log.ts): a write must never block or fail a live turn, so a failure
 * is logged and swallowed, never thrown into `runTurn()`.
 *
 * Custody (cut §0.2 invariant 2, DoD-5): `projectClaudeTurn` below builds
 * items ONLY from the translated `AgentEvent` stream (text/tool_call/
 * tool_result) — the same stream already sent to the UI. It never touches
 * `initialize`'s `account` (email/tokens) or `get_context_usage.memoryFiles[]`
 * (the 0-token home-path metadata, C2) — those never reach `AgentEvent` at
 * all, so the mirror cannot carry either sentinel class by construction.
 */

import type { AgentEvent, HistoryItem, PermissionMode, ReasoningEffort } from "@anycode/core";
import type { ClaudeTranscriptItem, SqlitePersistenceAdapter } from "@anycode/core";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";

export interface ClaudeShadowTranscriptPort {
  /** Fire-and-forget: called synchronously after a turn finishes, never awaited by the caller. */
  record(sessionRef: string, items: readonly ClaudeTranscriptItem[]): void;
  /** Full mirror for one native session, in write order — the resume-projection's only input. */
  list(sessionRef: string): Promise<ClaudeTranscriptItem[]>;
}

export class SqliteClaudeShadowTranscript implements ClaudeShadowTranscriptPort {
  constructor(private readonly persistence: SqlitePersistenceAdapter) {}

  record(sessionRef: string, items: readonly ClaudeTranscriptItem[]): void {
    for (const item of items) {
      void this.persistence.recordClaudeTranscriptItem(sessionRef, item).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[claude] shadow transcript write failed for session ${sessionRef} item ${item.itemId}: ${message}`);
      });
    }
  }

  list(sessionRef: string): Promise<ClaudeTranscriptItem[]> {
    return this.persistence.listClaudeTranscriptItems(sessionRef);
  }
}

/**
 * Pure projection of one turn's user input + translated `AgentEvent` stream
 * into ordered, ready `HistoryItem` forms (cut §1.5: "writes PROJECTIONS, not
 * raw bytes — raw carries thinking/truncated deltas"). `reasoning_*` events
 * are deliberately skipped: core's `ChatMessage` union has no assistant
 * content slot for thinking at all, so there is nothing stable to persist.
 * `text_delta`s are accumulated per streamed-text id and flushed as one
 * assistant text item on `text_end`, mirroring exactly what the live UI
 * showed (the translator has already deduplicated the streamed-vs-fallback
 * text pair, cut §1.4 hazard (з)) — never the raw partial deltas.
 */
export function projectClaudeTurn(
  input: string,
  events: readonly AgentEvent[],
  now: () => number = Date.now,
  turnOrdinal = 0,
): HistoryItem[] {
  const items: HistoryItem[] = [];
  const base = now();
  let cursor = 0;
  const nextCreatedAt = (): number => base + cursor++;

  // The turn ordinal is part of the id because a HistoryItem id must be unique
  // across the WHOLE hydrated transcript, not just within one turn. Every other
  // id here is derived from a wire id that is already turn-unique (a message id,
  // a tool_use id); the user item has no such wire id of its own, so a bare
  // "user" would repeat on every turn — and a two-turn resume would hydrate two
  // items with the same id, colliding as React keys and making dedup ambiguous.
  items.push({ id: `user:${turnOrdinal}`, createdAt: nextCreatedAt(), message: { role: "user", content: input } });

  const openText = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "text_start":
        openText.set(event.id, "");
        break;
      case "text_delta": {
        const buffered = openText.get(event.id);
        if (buffered !== undefined) openText.set(event.id, buffered + event.text);
        break;
      }
      case "text_end": {
        const text = openText.get(event.id);
        openText.delete(event.id);
        if (text !== undefined && text.length > 0) {
          items.push({
            id: `assistant:${event.id}`,
            createdAt: nextCreatedAt(),
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
        }
        break;
      }
      case "tool_call":
        items.push({
          id: `tool_call:${event.toolCall.id}`,
          createdAt: nextCreatedAt(),
          message: {
            role: "assistant",
            content: [{ type: "tool_call", toolCallId: event.toolCall.id, toolName: event.toolCall.name, input: event.toolCall.input }],
          },
        });
        break;
      case "tool_result":
        items.push({
          id: `tool_result:${event.outcome.toolCallId}`,
          createdAt: nextCreatedAt(),
          message: {
            role: "tool",
            content: [{
              type: "tool_result",
              toolCallId: event.outcome.toolCallId,
              toolName: event.outcome.toolName,
              text: event.outcome.modelText,
              status: event.outcome.status,
            }],
          },
        });
        break;
      default:
        break;
    }
  }
  return items;
}

/**
 * Decorator over a live `ClaudeEngine`-shaped `SessionEngine`: forwards every
 * `runTurn` event unchanged (tee, never alters what the UI sees), then
 * fire-and-forget projects+records the finished turn into the mirror.
 * `historyItems()` is overridden to return the BOOT-time mirror read (the
 * transcript from BEFORE this process started) — the underlying engine's own
 * `historyItems()` is always `[]` by construction (CC-C). Kept as a wrapper
 * rather than a `claude-engine.ts` change: every method it needs
 * (`models`/`presets`/`snapshot`/`selectModel`/`selectPreset`/`selectEffort`)
 * is already public there.
 */
export class ClaudeShadowTranscriptEngine implements SessionEngine {
  readonly id = "claude" as const;
  private nextTurnOrdinal: number;

  constructor(
    private readonly engine: SessionEngine,
    private readonly sink: ClaudeShadowTranscriptPort,
    private readonly sessionRef: string,
    private readonly bootHistory: readonly HistoryItem[],
    startingTurnOrdinal = 0,
    private readonly now: () => number = Date.now,
  ) {
    this.nextTurnOrdinal = startingTurnOrdinal;
  }

  get capabilities(): EngineCapabilities {
    return this.engine.capabilities;
  }

  mode(): PermissionMode {
    return this.engine.mode();
  }

  reasoningEffort(): ReasoningEffort | undefined {
    return this.engine.reasoningEffort();
  }

  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.engine.setReasoningEffort(effort);
  }

  historyItems(): readonly HistoryItem[] {
    return this.bootHistory;
  }

  async *runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent> {
    const turn = this.nextTurnOrdinal++;
    const events: AgentEvent[] = [];
    try {
      for await (const event of this.engine.runTurn(input, options)) {
        events.push(event);
        yield event;
      }
    } finally {
      // The resume settle-patch that used to fire here is gone: the session row
      // is materialized and patched from `ClaudeEngine.onFirstSystemInit`
      // instead (host/index.ts), which is both earlier — the init, not the end
      // of the turn that carried it — and reads the engine's reconciled
      // snapshot rather than raw wire values.
      try {
        const projected = projectClaudeTurn(input, events, this.now, turn);
        this.sink.record(
          this.sessionRef,
          projected.map((data, index) => ({ turnOrdinal: turn, positionInTurn: index, itemId: `${turn}:${index}`, data })),
        );
      } catch (error) {
        console.error(`[claude] shadow transcript projection failed for turn ${turn}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  dispose(reason: "session-close" | "host-shutdown"): Promise<void> {
    return this.engine.dispose(reason);
  }
}

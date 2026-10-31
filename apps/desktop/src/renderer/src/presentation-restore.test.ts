import { describe, expect, it } from "vitest";
import { createDesktopStore } from "./store.js";
import type { HostToUiMessage, WireHistoryItem, PresentationTurn } from "../../shared/protocol.js";
import type { CompactionRecord } from "@anycode/core";

const turn: PresentationTurn = { turnId: "t", requestId: "r", startedAt: 1, text: "prompt", events: [{ event: { type: "loop_end" as const, reason: "cancelled" as const, turns: 0 }, step: 0, at: 2 }] };
function restore(items: WireHistoryItem[], truncated: boolean, restoredTurn = turn) {
  const store = createDesktopStore({ schedule: (fn) => fn() });
  const message: HostToUiMessage = { type: "presentation_snapshot", turns: [restoredTurn], coveredTurnIds: ["t"], items, truncated, historyTracksTurns: true };
  store.getState().applyHostMessage(message);
  return store;
}

describe("presentation reload", () => {
  it.each([false, true])("keeps a completed prompt and footer without durable history (truncated=%s)", (truncated) => {
    const items: WireHistoryItem[] = truncated ? [{ id: "old", createdAt: 1, turnId: "old-turn", step: 1, message: { role: "user", content: "retained history" } }] : [];
    const store = restore(items, truncated);
    expect(store.getState().transcript.filter((b) => b.kind === "user_text" && b.text === "prompt")).toHaveLength(1);
    expect(store.getState().transcript.filter((b) => b.kind === "loop_end")).toHaveLength(1);
  });

  it("renders a step-zero injected steer once", () => {
    const items: WireHistoryItem[] = ["prompt", "steer"].map((content, i) => ({ id: `i${i}`, createdAt: i, turnId: "t", step: 0, message: { role: "user", content } }));
    const store = restore(items, false, { ...turn, events: [{ event: { type: "user_injected", step: 0, text: "steer" }, step: 0 }, ...turn.events] });
    expect(store.getState().transcript.filter((b) => b.kind === "user_text").map((b) => b.kind === "user_text" && b.text)).toEqual(["prompt", "steer"]);
  });

  it("retains a later steer that repeats the original prompt", () => {
    const items: WireHistoryItem[] = [{ id: "prompt", createdAt: 1, turnId: "t", step: 0, message: { role: "user", content: "prompt" } }];
    const store = restore(items, false, { ...turn, events: [{ event: { type: "user_injected", step: 1, text: "prompt" }, step: 2 }, ...turn.events] });
    expect(store.getState().transcript.filter((b) => b.kind === "user_text").map((b) => b.kind === "user_text" && b.text)).toEqual(["prompt", "prompt"]);
  });

  it("matches each projected step-zero steer only once, excluding the prompt", () => {
    const items: WireHistoryItem[] = [0, 1].map((i) => ({ id: `i${i}`, createdAt: i, turnId: "t", step: 0, message: { role: "user", content: "prompt" } }));
    const injected = { event: { type: "user_injected" as const, step: 0, text: "prompt" }, step: 1 };
    const store = restore(items, false, { ...turn, events: [injected, injected, ...turn.events] });
    expect(store.getState().transcript.filter((b) => b.kind === "user_text").map((b) => b.kind === "user_text" && b.text)).toEqual(["prompt", "prompt", "prompt"]);
  });

  it("restores the Continue offer on a turn-limit footer", () => {
    const store = restore([], false, { ...turn, events: [{ event: { type: "loop_end", reason: "max_turns", turns: 3 }, step: 0, at: 2 }] });
    store.getState().applyHostMessage({ type: "presentation_replay_start" });
    store.getState().applyHostMessage({ type: "turn_started", turnId: "t", requestId: "r" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "t", event: { type: "loop_end", reason: "max_turns", turns: 3 } });
    store.getState().applyHostMessage({ type: "presentation_replay_end" });
    const footer = store.getState().transcript.find((b) => b.kind === "loop_end");
    expect(store.getState().continueOffer).toEqual({ loopEndBlockId: footer?.id });
  });
});

describe("presentation reload — durable compaction rows keep their place (GitHub #36 review)", () => {
  const record = (id: string, createdAt: number, extra: Partial<CompactionRecord> = {}): CompactionRecord => ({
    id,
    createdAt,
    ok: true,
    summary: `summary ${id}`,
    ...extra,
  });

  /**
   * The layout a snapshot rebuilds: one durable item that belongs to NO covered
   * turn (`before`, createdAt 100), then a replayed turn `t` that starts at
   * 200. A compaction at 150 happened between them; one at 300 happened after
   * the turn.
   */
  const items: WireHistoryItem[] = [
    { id: "before", createdAt: 100, turnId: "older-turn", step: 1, message: { role: "user", content: "earlier" } },
  ];
  const replayedTurn: PresentationTurn = {
    turnId: "t",
    requestId: "r",
    startedAt: 200,
    text: "prompt",
    events: [{ event: { type: "loop_end" as const, reason: "cancelled" as const, turns: 0 }, step: 0, at: 250 }],
  };

  function restoreWith(records: CompactionRecord[], turns = [replayedTurn], history = items) {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({
      type: "presentation_snapshot",
      turns,
      coveredTurnIds: turns.map((turn) => turn.turnId),
      items: history,
      truncated: false,
      historyTracksTurns: true,
      compactions: records,
    });
    return store;
  }

  const shape = (store: ReturnType<typeof createDesktopStore>): string[] =>
    store
      .getState()
      .transcript.map((block) =>
        block.kind === "compaction" ? `compaction:${block.recordId ?? block.summaryItemId ?? "?"}` : block.kind,
      );

  it("places each row by its own instant — between and after the replayed turns, not bunched into the prefix", () => {
    const store = restoreWith([record("mid", 150), record("after", 300)]);

    // before-item, then the 150 compaction, then the turn, then the 300 one.
    expect(shape(store)).toEqual([
      "user_text",
      "compaction:mid",
      "user_text",
      "loop_end",
      "compaction:after",
    ]);
  });

  it("a SUCCESSFUL compaction the replayed journal already rebuilt shows exactly once — with the real payload, where the event and the record both carry the summary item id", () => {
    // GitHub #36 review 3: the real wire payload of a successful core
    // compaction carries recordId AND summaryItemId, and so does its durable
    // record. That is what used to make the row vanish: the legacy-duplicate
    // filter removed the replayed row (its summaryItemId matched a record) and
    // the "already rendered" set had already claimed its recordId, so nothing
    // reinserted it.
    const turnWithCompaction: PresentationTurn = {
      ...replayedTurn,
      events: [
        { event: { type: "compaction_start" as const, trigger: "manual" as const }, step: 0 },
        {
          event: {
            type: "compaction_end" as const,
            ok: true,
            preTokens: 900,
            postTokens: 90,
            durationMs: 5,
            summary: "summary during the turn",
            summaryItemId: "summary-during",
            prompt: "the instruction that was sent",
            model: "glm-5.3",
            recordId: "during",
          },
          step: 0,
        },
        ...replayedTurn.events,
      ],
    };

    const store = restoreWith(
      [record("during", 220, { summaryItemId: "summary-during", prompt: "the instruction that was sent", model: "glm-5.3" })],
      [turnWithCompaction],
      [
        ...items,
        {
          id: "summary-during",
          createdAt: 221,
          kind: "compact_summary",
          message: { role: "user", content: "summary during the turn" },
        },
      ],
    );

    // Exactly one row for it, and it sits where the replay put it (inside the
    // turn), not at the tail where a fresh insertion would land.
    const cards = store.getState().transcript.filter((block) => block.kind === "compaction");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ recordId: "during", preTokens: 900 });
    // It is the REPLAYED row (live readings), not a reinserted record copy.
    expect(cards[0]).toMatchObject({ summaryItemId: "summary-during" });
    // (the durable item outside the covered turns, the turn's own bubble, the
    // compaction the replay rebuilt inside that turn, then its footer)
    expect(shape(store)).toEqual(["user_text", "user_text", "compaction:during", "loop_end"]);
  });

  it("a compaction recorded on an EMPTY session still renders after a snapshot restore", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({
      type: "presentation_snapshot",
      turns: [],
      coveredTurnIds: [],
      items: [],
      truncated: false,
      historyTracksTurns: true,
      compactions: [record("skipped", 10, { ok: false, error: "compaction skipped: no prefix", summary: undefined })],
    });

    expect(shape(store)).toEqual(["compaction:skipped"]);
  });

  it("a recorded structural no-op stays a no-op after reopen — plain sentence, no failure framing", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({
      type: "presentation_snapshot",
      turns: [],
      coveredTurnIds: [],
      items: [],
      truncated: false,
      historyTracksTurns: true,
      compactions: [
        record("short", 10, {
          ok: false,
          skipped: true,
          error: "Nothing to compact yet — the conversation is too short",
          summary: undefined,
        }),
      ],
    });

    const row = store.getState().transcript.find((block) => block.kind === "compaction");
    // The flag survives the round trip through the durable record, so the row
    // does not come back reading as a refusal (UI audit v0.0.49 §C3).
    expect(row).toMatchObject({
      status: "failed",
      skipped: true,
      error: "Nothing to compact yet — the conversation is too short",
    });
  });
});

import { describe, expect, it } from "vitest";
import { PresentationJournal } from "./presentation-journal.js";
import { createDesktopStore } from "../renderer/src/store.js";

describe("presentation journal retention", () => {
  it("bounds long sessions and restores their visible tail for all engine modes", () => {
    for (const historyTracksTurns of [true, false]) {
      const journal = new PresentationJournal(5, 10);
      for (let i = 0; i < 100; i++) {
        journal.start(`t${i}`, `r${i}`, i, `prompt ${i}`);
        journal.record(`t${i}`, { type: "loop_end", reason: "completed", turns: 0 }, 0, 0, i + 1);
      }
      const snapshot = journal.snapshot();
      expect(snapshot.turns).toHaveLength(5);
      expect(snapshot.coveredTurnIds).toHaveLength(15);
      const store = createDesktopStore({ schedule: (fn) => fn() });
      store.getState().applyHostMessage({ type: "presentation_snapshot", ...snapshot, items: [], truncated: false, historyTracksTurns });
      expect(store.getState().transcript.filter((b) => b.kind === "user_text").map((b) => b.kind === "user_text" && b.text)).toEqual(["prompt 95", "prompt 96", "prompt 97", "prompt 98", "prompt 99"]);
      expect(store.getState().transcript.filter((b) => b.kind === "loop_end")).toHaveLength(5);
    }
  });

  it("bounds events and prunes history as it advances", () => {
    const journal = new PresentationJournal(2, 3);
    const item = (i: number) => ({ id: `i${i}`, createdAt: i, tokenEstimate: 1, turnId: `t${i}`, step: 0, message: { role: "user" as const, content: `p${i}` } });
    for (let i = 0; i < 4; i++) {
      journal.start(`t${i}`, `r${i}`, i, `p${i}`);
      journal.observeHistory(Array.from({ length: i + 1 }, (_, n) => item(n)));
    }
    for (let i = 0; i < 10; i++) journal.record("t3", { type: "text_start", id: `${i}` });
    const snapshot = journal.snapshot();
    expect(snapshot.turns.map((turn) => turn.turnId)).toEqual(["t2", "t3"]);
    expect(snapshot.turns[1]!.events).toHaveLength(3);
    expect(snapshot.coveredTurnIds.length).toBeLessThanOrEqual(5);
  });

  it("keeps retained reasoning and text renderable at the event limit", () => {
    const journal = new PresentationJournal(1, 5);
    journal.start("t", "r", 1, "prompt");
    for (let i = 0; i < 3; i++) journal.record("t", { type: "text_end", id: `filler${i}` }, 1, 1);
    journal.record("t", { type: "reasoning_start", id: "reason" }, 1, 1);
    journal.record("t", { type: "reasoning_delta", id: "reason", text: "thinking" }, 1, 1);
    journal.record("t", { type: "text_start", id: "text" }, 1, 1);
    journal.record("t", { type: "text_delta", id: "text", text: "answer" }, 1, 1);
    const snapshot = journal.snapshot();
    expect(snapshot.turns[0]!.events).toHaveLength(5);
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({ type: "presentation_snapshot", ...snapshot, items: [], truncated: false, historyTracksTurns: true });
    expect(store.getState().transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reasoning", text: "thinking" }),
      expect.objectContaining({ kind: "assistant_text", text: "answer" }),
    ]));
  });

  it("retains and renders a steer and footer after old streams fill the limit", () => {
    const journal = new PresentationJournal(1, 4);
    journal.start("t", "r", 1, "prompt");
    for (const id of ["old1", "old2"]) {
      journal.record("t", { type: "text_start", id }, 1, 1);
      journal.record("t", { type: "text_delta", id, text: id }, 1, 1);
    }
    journal.record("t", { type: "user_injected", step: 1, text: "steer" }, 1, 1);
    journal.record("t", { type: "loop_end", reason: "completed", turns: 1 }, 1, 1);
    const snapshot = journal.snapshot();
    expect(snapshot.turns[0]!.events.map(({ event }) => event.type)).toEqual(["text_start", "text_delta", "user_injected", "loop_end"]);
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({ type: "presentation_snapshot", ...snapshot, items: [], truncated: false, historyTracksTurns: true });
    expect(store.getState().transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_text", text: "old2" }),
      expect.objectContaining({ kind: "user_text", text: "steer" }),
      expect.objectContaining({ kind: "loop_end" }),
    ]));
  });

  it("recreates a start trimmed before its first delta arrives", () => {
    const journal = new PresentationJournal(1, 3);
    journal.start("t", "r", 1);
    journal.record("t", { type: "text_start", id: "s" });
    for (let i = 0; i < 3; i++) journal.record("t", { type: "text_end", id: `${i}` });
    journal.record("t", { type: "text_delta", id: "s", text: "late" });
    const snapshot = journal.snapshot();
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({ type: "presentation_snapshot", ...snapshot, items: [], truncated: false, historyTracksTurns: true });
    expect(store.getState().transcript).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant_text", text: "late" })]));
  });
});

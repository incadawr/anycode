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
});

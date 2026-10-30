import { describe, expect, it } from "vitest";
import { createDesktopStore } from "./store.js";
import type { HostToUiMessage, WireHistoryItem, PresentationTurn } from "../../shared/protocol.js";

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

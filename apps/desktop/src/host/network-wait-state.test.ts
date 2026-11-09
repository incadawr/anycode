import { describe, expect, it } from "vitest";
import { NetworkWaitState } from "./network-wait-state.js";

describe("network wait episodes", () => {
  it("retains overlapping waits and ignores duplicate and out-of-order ends", () => {
    const state = new NetworkWaitState();
    expect(state.observe({ type: "network_wait_end", waitId: "missing", outcome: "failed" })).toBe(false);
    state.observe({ type: "waiting_for_network", waitId: "p", startedAt: 20, deadlineAt: 40, failureCode: "network" });
    state.observe({ type: "waiting_for_network", waitId: "a", startedAt: 10, waitSource: "subagent" });
    state.observe({ type: "waiting_for_network", waitId: "b", startedAt: 30, waitSource: "subagent" });
    expect(state.summary).toEqual({ source: "subagent", startedAt: 10 });
    expect(state.observe({ type: "waiting_for_network", waitId: "a" })).toBe(false);
    state.observe({ type: "network_wait_end", waitId: "a", waitSource: "parent", outcome: "recovered" });
    expect(state.summary).toEqual({ source: "parent", startedAt: 20, deadlineAt: 40, failureCode: "network" });
    expect(state.observe({ type: "network_wait_end", waitId: "a", outcome: "cancelled" })).toBe(false);
    expect(state.observe({ type: "waiting_for_network", waitId: "a" })).toBe(false);
    state.observe({ type: "network_wait_end", waitId: "p", outcome: "failed" });
    expect(state.summary?.startedAt).toBe(30);
    state.observe({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(state.summary).toBeUndefined();
  });
  it("preserves legacy uncertainty and only exposes safe codes", () => {
    const state = new NetworkWaitState();
    state.observe({ type: "waiting_for_network", failureCode: "secret" });
    expect(state.summary).toEqual({ source: "parent" });
    state.clear();
    expect(state.summary).toBeUndefined();
  });
});

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
  it("ends a live episode on cancelled or failed and sorts episodes without a start last", () => {
    const state = new NetworkWaitState();
    state.observe({ type: "waiting_for_network", waitId: "x" });
    state.observe({ type: "waiting_for_network", waitId: "y", startedAt: 50, waitSource: "subagent" });
    expect(state.summary).toEqual({ source: "subagent", startedAt: 50 });
    expect(state.observe({ type: "network_wait_end", waitId: "y", outcome: "cancelled" })).toBe(true);
    expect(state.observe({ type: "network_wait_end", waitId: "x", outcome: "failed" })).toBe(true);
    expect(state.summary).toBeUndefined();
  });
  it("tracks only the first start that carries no wait id", () => {
    const state = new NetworkWaitState();
    state.observe({ type: "waiting_for_network", waitSource: "parent" });
    expect(state.observe({ type: "waiting_for_network", waitSource: "subagent" })).toBe(false);
    expect(state.summary).toEqual({ source: "parent" });
  });
});

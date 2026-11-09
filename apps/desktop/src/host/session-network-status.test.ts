import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { createHarness } from "./test-harness.js";
import { CORE_ENGINE_CAPABILITIES, type SessionEngine } from "./engines/session-engine.js";

function fixture(id: "core" | "codex" = "core") {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finish = false;
  const engine: SessionEngine = {
    id, capabilities: CORE_ENGINE_CAPABILITIES, mode: () => "build", reasoningEffort: () => undefined,
    setReasoningEffort: () => {}, historyItems: () => [], dispose: async () => {},
    async *runTurn() {
      finish = false;
      while (!finish) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      yield { type: "loop_end", reason: "completed", turns: 1 };
    },
  };
  const h = createHarness({ steps: [], engine });
  const push = (event: AgentEvent) => { queue.push(event); wake?.(); wake = undefined; };
  const stop = () => { finish = true; wake?.(); };
  return { h, push, stop };
}

describe("session network status", () => {
  it("tracks overlapping events and clears them on terminal teardown", async () => {
    const { h, push, stop } = fixture();
    const listener = vi.fn();
    h.session.observeActivity(listener);
    try {
      expect(h.session.communicationStatus()).toMatchObject({ state: "idle", turnStartedAt: null, lastProviderActivityAt: null });
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      push({ type: "waiting_for_network", waitId: "p", startedAt: 20, deadlineAt: 90, failureCode: "network" });
      push({ type: "waiting_for_network", waitId: "a", startedAt: 10, waitSource: "subagent" });
      push({ type: "waiting_for_network", waitId: "b", startedAt: 30, waitSource: "subagent" });
      await h.waitUntil(() => h.session.communicationStatus().networkWait?.startedAt === 10);
      expect(h.session.communicationStatus()).toMatchObject({ state: "waiting_network", networkWait: { source: "subagent", startedAt: 10 }, lastProviderActivityAt: null });
      const approval = vi.spyOn(h.broker, "isAwaitingApproval", "get").mockReturnValue(true);
      expect(h.session.communicationStatus()).toMatchObject({ state: "waiting_approval", networkWait: { startedAt: 10 } });
      approval.mockRestore();
      push({ type: "network_wait_end", waitId: "a", outcome: "recovered" });
      await h.waitUntil(() => h.session.communicationStatus().networkWait?.startedAt === 20);
      expect(listener.mock.lastCall?.[1]).toMatchObject({ state: "waiting_network", networkWait: { startedAt: 20 } });
      stop();
      await h.waitUntil(() => h.session.communicationStatus().state === "idle");
      expect(h.session.communicationStatus()).toMatchObject({ turnStartedAt: null, lastProviderActivityAt: null });
      expect(h.session.communicationStatus().networkWait).toBeUndefined();
      h.send({ type: "user_message", requestId: "two", text: "again" });
      await h.waitUntil(() => h.session.communicationStatus().state === "running");
      expect(h.session.communicationStatus()).toMatchObject({ lastProviderActivityAt: null });
      expect(h.session.communicationStatus().networkWait).toBeUndefined();
    } finally { stop(); h.close(); }
  });
  it("updates provider activity for output, but not tool execution or network status", async () => {
    const { h, push, stop } = fixture();
    try {
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      push({ type: "text_delta", id: "t", text: "x" });
      await h.waitUntil(() => h.session.communicationStatus().lastProviderActivityAt != null);
      const timestamp = h.session.communicationStatus().lastProviderActivityAt;
      push({ type: "tool_execution_start", toolCallId: "x", toolName: "Bash", input: {} });
      push({ type: "waiting_for_network", waitId: "p" });
      await h.waitUntil(() => h.session.communicationStatus().state === "waiting_network");
      expect(h.session.communicationStatus().lastProviderActivityAt).toBe(timestamp);
    } finally { stop(); h.close(); }
  });
  it("keeps native activity unknown", () => {
    const { h } = fixture("codex");
    try { expect(h.session.communicationStatus().lastProviderActivityAt).toBeNull(); } finally { h.close(); }
  });
});

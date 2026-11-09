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
  it("publishes a real turn start as soon as the turn begins", async () => {
    const { h, stop } = fixture();
    const listener = vi.fn();
    h.session.observeActivity(listener);
    try {
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      const snapshot = listener.mock.lastCall?.[1];
      expect(snapshot).toMatchObject({ state: "running", lastProviderActivityAt: null });
      expect(typeof snapshot?.turnStartedAt).toBe("number");
      expect(snapshot?.networkWait).toBeUndefined();
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
  it("does not advance provider activity on forwarded child output or elapsed time", async () => {
    const { h, push, stop } = fixture();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      push({ type: "text_delta", id: "t", text: "x" });
      await h.waitUntil(() => h.session.communicationStatus().lastProviderActivityAt === 1_000);
      now.mockReturnValue(600_000);
      push({ type: "subagent_progress", toolCallId: "c", turns: 1, toolCalls: 1 });
      push({ type: "subagent_activity", toolCallId: "c", toolName: "Read", summary: "reading" });
      push({ type: "tool_execution_start", toolCallId: "x", toolName: "Bash", input: {} });
      push({ type: "waiting_for_network", waitId: "p" });
      await h.waitUntil(() => h.session.communicationStatus().state === "waiting_network");
      expect(h.session.communicationStatus().lastProviderActivityAt).toBe(1_000);
      push({ type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as AgentEvent);
      await h.waitUntil(() => h.session.communicationStatus().lastProviderActivityAt === 600_000);
    } finally { now.mockRestore(); stop(); h.close(); }
  });
  it.each(["cancelled", "failed"] as const)("clears a live wait when its episode ends as %s", async outcome => {
    const { h, push, stop } = fixture();
    try {
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      push({ type: "waiting_for_network", waitId: "p", startedAt: 5 });
      await h.waitUntil(() => h.session.communicationStatus().state === "waiting_network");
      push({ type: "network_wait_end", waitId: "p", outcome });
      await h.waitUntil(() => h.session.communicationStatus().state === "running");
      expect(h.session.communicationStatus().networkWait).toBeUndefined();
    } finally { stop(); h.close(); }
  });
  it("publishes an idle snapshot when admissions close during a wait", async () => {
    const { h, push, stop } = fixture();
    const listener = vi.fn();
    h.session.observeActivity(listener);
    try {
      h.send({ type: "user_message", requestId: "one", text: "hello" });
      await h.waitUntil(() => h.session.communicationStatus().turnStartedAt != null);
      push({ type: "waiting_for_network", waitId: "p", startedAt: 5 });
      await h.waitUntil(() => h.session.communicationStatus().state === "waiting_network");
      h.session.closeAdmissions();
      expect(h.session.communicationStatus().networkWait).toBeUndefined();
      expect(h.session.communicationStatus().turnStartedAt).toBeNull();
      expect(listener.mock.lastCall?.[1]).not.toHaveProperty("networkWait");
      expect(listener.mock.lastCall?.[1]).toMatchObject({ state: "closing" });
    } finally { stop(); h.close(); }
  });
  it("keeps native activity unknown", () => {
    const { h } = fixture("codex");
    try { expect(h.session.communicationStatus().lastProviderActivityAt).toBeNull(); } finally { h.close(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { createHarness, textStep } from "./test-harness.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { CORE_ENGINE_CAPABILITIES } from "./engines/session-engine.js";
import type { AgentEnvelope } from "../shared/communication.js";
const envelope = (messageId: string, mode: "next_turn" | "steer" = "next_turn"): AgentEnvelope => ({ messageId, sender: "test-supervisor", recipientSessionId: "test-session", payload: "Follow this clarification", mode, kind: "agent_message", createdAt: new Date().toISOString() });
function fixture() {
  const inputs: string[] = []; const signals: AbortSignal[] = []; const finishes: Array<() => void> = [];
  const engine: SessionEngine = {
    id: "codex", capabilities: CORE_ENGINE_CAPABILITIES, mode: () => "build", reasoningEffort: () => undefined, setReasoningEffort: () => {}, historyItems: () => [], dispose: async () => {},
    steer: vi.fn(async () => ({ turnId: "native-turn" })),
    async *runTurn(input, options) { inputs.push(input); signals.push(options.signal); yield { type: "turn_start", turn: inputs.length }; await new Promise<void>((resolve) => { finishes.push(resolve); }); yield { type: "loop_end", reason: "completed", turns: 1 }; },
  };
  const h = createHarness({ steps: [], engine });
  // Harness uses fixed session ID; retrieve it rather than guessing.
  const make = (id: string, mode: "next_turn" | "steer" = "next_turn") => ({ ...envelope(id, mode), recipientSessionId: h.session.communicationStatus().sessionId });
  return { h, engine, inputs, signals, finishes, make };
}
describe("authenticated session inbox", () => {
  it("starts idle next-turn exactly once and drains a busy queue only after settlement", async () => {
    const { h, inputs, finishes, make } = fixture();
    try {
      expect((await h.session.receiveAgentMessage(make("one"))).state).toBe("acknowledged");
      expect((await h.session.receiveAgentMessage(make("two"))).state).toBe("queued");
      await h.session.receiveAgentMessage(make("two"));
      expect(inputs).toHaveLength(1);
      finishes.shift()!();
      await h.waitUntil(() => inputs.length === 2);
      expect(h.session.agentMessageStatus("two")?.state).toBe("acknowledged");
      expect(inputs[1]).toContain('"sender":"test-supervisor"');
      finishes.shift()!(); await h.flush();
      expect(inputs).toHaveLength(2);
    } finally { h.close(); }
  });
  it("steers without aborting the active turn, reports refusal, and does not retry as next-turn", async () => {
    const { h, engine, inputs, signals, finishes, make } = fixture();
    try {
      expect((await h.session.receiveAgentMessage(make("idle", "steer"))).state).toBe("rejected");
      await h.session.receiveAgentMessage(make("one"));
      expect((await h.session.receiveAgentMessage(make("steer", "steer"))).state).toBe("acknowledged");
      expect(signals[0]?.aborted).toBe(false);
      expect(inputs).toHaveLength(1);
      vi.mocked(engine.steer!).mockRejectedValueOnce(Object.assign(new Error("stale expectedTurnId"), { code: -32600 }));
      expect((await h.session.receiveAgentMessage(make("stale", "steer"))).state).toBe("rejected");
      expect(inputs).toHaveLength(1);
      finishes.shift()!(); await h.flush();
    } finally { h.close(); }
  });
  it("Stop rejects pending agent messages rather than opening another turn", async () => {
    const { h, inputs, finishes, signals, make } = fixture();
    try {
      await h.session.receiveAgentMessage(make("one")); await h.session.receiveAgentMessage(make("pending"));
      h.send({ type: "cancel_turn" }); await h.flush();
      expect(signals[0]?.aborted).toBe(true);
      expect(h.session.agentMessageStatus("pending")?.state).toBe("rejected");
      finishes.shift()!(); await h.flush(); expect(inputs).toHaveLength(1);
    } finally { h.close(); }
  });
  it("rejects foreign session and closing inbox; restored envelopes never open model turns", async () => {
    const { h, inputs, finishes, make } = fixture();
    try {
      expect((await h.session.receiveAgentMessage({ ...envelope("foreign"), recipientSessionId: "another-session" })).state).toBe("rejected");
      h.session.restoreAgentMessages([{ envelope: make("old"), state: "unknown" }]);
      expect(inputs).toHaveLength(0);
      await h.session.receiveAgentMessage(make("one")); await h.session.receiveAgentMessage(make("queued"));
      h.session.closeAdmissions(); expect(h.session.agentMessageStatus("queued")?.state).toBe("rejected");
      finishes.shift()!(); await h.flush(); expect(inputs).toHaveLength(1);
    } finally { h.close(); }
  });

  // Taskana 4153 / TASK.216 wire regression pin: main's ChildRunSend delivery
  // addresses the child with sender "parent-session:<id>" — that principal must
  // behave EXACTLY like the MCP supervisor principal above (queue while busy,
  // drain into a new turn on settle, agent_message envelope in the input).
  it("a parent-session sender behaves exactly like the supervisor principal: acknowledged when idle, queued while busy, drained on settle", async () => {
    const { h, inputs, finishes, make } = fixture();
    try {
      const fromParent = (id: string): AgentEnvelope => ({ ...make(id), sender: "parent-session:parent-session-1" });
      expect((await h.session.receiveAgentMessage(fromParent("p-one"))).state).toBe("acknowledged");
      expect((await h.session.receiveAgentMessage(fromParent("p-two"))).state).toBe("queued");
      expect(inputs).toHaveLength(1);
      finishes.shift()!();
      await h.waitUntil(() => inputs.length === 2);
      expect(h.session.agentMessageStatus("p-two")?.state).toBe("acknowledged");
      expect(inputs[1]).toContain('"sender":"parent-session:parent-session-1"');
      finishes.shift()!(); await h.flush();
      expect(inputs).toHaveLength(2);
    } finally { h.close(); }
  });
});


const settle = async (h: { flush(): Promise<void> }) => { for (let i = 0; i < 20; i++) await h.flush(); };
/** Waits until the scripted engine has opened a turn, then returns its finish trigger. */
const nextFinish = async (h: { flush(): Promise<void> }, finishes: Array<() => void>) => { for (let i = 0; i < 200 && finishes.length === 0; i++) await h.flush(); return finishes.shift()!; };
describe("public result retrieval", () => {
  it("returns only latest completed public assistant text with delivered-message correlation", async () => {
    const h = createHarness({ steps: [[
      { type: "reasoning_start", id: "private" }, { type: "reasoning_delta", id: "private", text: "PRIVATE_REASONING_SENTINEL" }, { type: "reasoning_end", id: "private" },
      { type: "text_start", id: "commentary" }, { type: "text_delta", id: "commentary", text: "OLDER_PUBLIC_COMMENTARY" }, { type: "text_end", id: "commentary" },
      ...textStep("PUBLIC_FINAL_ANSWER"),
    ]] });
    try {
      expect(h.session.communicationResult().availability).toBe("unavailable");
      await h.session.receiveAgentMessage({ ...envelope("result-request"), recipientSessionId: h.session.communicationStatus().sessionId });
      await h.waitUntil(() => h.session.communicationResult().latestResult?.terminalReason === "completed"); await h.flush();
      const result = h.session.communicationResult();
      expect(result.availability).toBe("available");
      expect(result.activeTurnId).toBeNull();
      expect(result.latestResult).toMatchObject({ publicAnswer: "PUBLIC_FINAL_ANSWER", source: "live_turn", requestId: "result-request", terminalReason: "completed", deliveredMessageIds: ["result-request"], correlationMeaning: "transport_delivery_only" });
      expect(result.latestResult?.turnId).toEqual(expect.any(String));
      expect(JSON.stringify(result)).not.toContain("PRIVATE_REASONING_SENTINEL");
      expect(JSON.stringify(result)).not.toContain("OLDER_PUBLIC_COMMENTARY");
    } finally { h.close(); }
  });
  it("does not publish an unfinished text stream while running", async () => {
    const f = fixture();
    f.engine.runTurn = async function* () {
      yield { type: "text_start", id: "answer" }; yield { type: "text_delta", id: "answer", text: "UNFINISHED_TEXT" };
      await new Promise<void>((resolve) => { f.finishes.push(resolve); });
      yield { type: "text_end", id: "answer" }; yield { type: "loop_end", reason: "completed", turns: 1 };
    };
    try {
      await f.h.session.receiveAgentMessage(f.make("pending-result"));
      await f.h.waitUntil(() => f.finishes.length > 0);
      expect(f.h.session.communicationResult()).toMatchObject({ availability: "pending", latestResult: null });
      f.finishes.shift()!(); await f.h.waitUntil(() => f.h.session.communicationResult().latestResult !== null);
      expect(f.h.session.communicationResult().latestResult?.publicAnswer).toBe("UNFINISHED_TEXT");
    } finally { f.h.close(); }
  });
  it("keeps the prior result while another turn runs and carries live native identity without private data", async () => {
    const f = fixture();
    f.engine.steeringStatus = () => ({ supported: true, ready: true, nativeTurnId: "native-observed" });
    f.engine.runTurn = async function* () {
      yield { type: "text_start", id: "answer" }; yield { type: "text_delta", id: "answer", text: "FIRST_PUBLIC_RESULT" }; yield { type: "text_end", id: "answer" }; yield { type: "loop_end", reason: "completed", turns: 1 };
    };
    try {
      await f.h.session.receiveAgentMessage(f.make("first"));
      await f.h.waitUntil(() => f.h.session.communicationResult().latestResult !== null); await f.h.flush();
      expect(f.h.session.communicationResult().latestResult?.nativeTurnId).toBe("native-observed");
      f.engine.runTurn = async function* () {
        yield { type: "text_delta", id: "next", text: "NEXT_INCOMPLETE_TEXT" };
        await new Promise<void>((resolve) => { f.finishes.push(resolve); });
        yield { type: "text_end", id: "next" }; yield { type: "loop_end", reason: "cancelled", turns: 1 };
      };
      await f.h.session.receiveAgentMessage(f.make("second")); await f.h.waitUntil(() => f.finishes.length > 0);
      const pending = f.h.session.communicationResult();
      expect(pending.availability).toBe("pending"); expect(pending.activeTurnId).toEqual(expect.any(String));
      expect(pending.latestResult?.publicAnswer).toBe("FIRST_PUBLIC_RESULT");
      expect(JSON.stringify(pending)).not.toContain("NEXT_INCOMPLETE_TEXT");
      f.finishes.shift()!(); await f.h.waitUntil(() => f.h.session.communicationResult().latestResult?.terminalReason === "cancelled"); await f.h.flush();
      expect(f.h.session.communicationResult().activeTurnId).toBeNull();
      expect(f.h.session.communicationResult().latestResult?.terminalReason).toBe("cancelled");
    } finally { f.h.close(); }
  });
  it("recovers only public assistant text from history and does not invent terminal status or correlation", () => {
    const h = createHarness({ steps: [], bootHistory: [
      { id: "human", createdAt: 0, message: { role: "user", content: "PRIVATE_HUMAN_INPUT" } },
      { id: "answer", createdAt: 1, message: { role: "assistant", content: [{ type: "tool_call", toolCallId: "call", toolName: "Bash", input: { command: "PRIVATE_TOOL_INPUT" } }, { type: "text", text: "RECOVERED_PUBLIC_ANSWER" }] } },
      { id: "tool", createdAt: 2, message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call", toolName: "Bash", text: "PRIVATE_TOOL_OUTPUT", status: "success" }] } },
      { id: "internal-summary", createdAt: 3, kind: "compact_summary", message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_INTERNAL_COMPACT_SUMMARY" }] } },
    ] });
    try {
      const result = h.session.communicationResult();
      expect(result.availability).toBe("recovered_unverified");
      expect(result.latestResult).toMatchObject({ source: "history_recovery", terminalReason: "unknown", publicAnswer: "RECOVERED_PUBLIC_ANSWER", turnId: null, nativeTurnId: null, requestId: null, deliveredMessageIds: [] });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    } finally { h.close(); }
  });
  it("communicationMessageResult queued then running then done", async () => {
    const { h, finishes, make } = fixture();
    try {
      await h.session.receiveAgentMessage(make("one"));
      await h.session.receiveAgentMessage(make("two"));
      expect(h.session.communicationMessageResult("two")).toEqual({ state: "queued" });
      expect(h.session.communicationMessageResult("one")).toMatchObject({ state: "running" });
      finishes.shift()!(); await settle(h);
      expect(h.session.communicationMessageResult("one")).toMatchObject({ state: "done", latestResult: { terminalReason: "completed", correlationMeaning: "transport_delivery_only" } });
      expect(h.session.communicationMessageResult("two")).toMatchObject({ state: "running" });
      (await nextFinish(h, finishes))(); await settle(h);
      expect(h.session.communicationMessageResult("two")).toMatchObject({ state: "done" });
    } finally { h.close(); }
  });
  it("turnResults keeps the result of the first turn after a second turn completes", async () => {
    const { h, finishes, make } = fixture();
    try {
      await h.session.receiveAgentMessage(make("first"));
      (await nextFinish(h, finishes))(); await settle(h);
      await h.session.receiveAgentMessage(make("second"));
      (await nextFinish(h, finishes))(); await settle(h);
      const first = h.session.communicationMessageResult("first");
      const second = h.session.communicationMessageResult("second");
      expect(first.state).toBe("done"); expect(second.state).toBe("done");
      if (first.state === "done" && second.state === "done") expect(first.latestResult.turnId).not.toBe(second.latestResult.turnId);
      expect(h.session.communicationResult().latestResult?.turnId).toBe(second.state === "done" ? second.latestResult.turnId : null);
    } finally { h.close(); }
  });
  it("communicationMessageResult reports unknown and rejected messages", async () => {
    const { h, make } = fixture();
    try {
      expect(h.session.communicationMessageResult("never-seen")).toEqual({ state: "unknown_message" });
      expect(h.session.communicationMessageResult("idle-steer")).toEqual({ state: "unknown_message" });
      await h.session.receiveAgentMessage(make("idle-steer", "steer"));
      expect(h.session.communicationMessageResult("idle-steer")).toMatchObject({ state: "rejected" });
    } finally { h.close(); }
  });
  it("turnResults is bounded: the oldest turn result is evicted after 32 turns", async () => {
    const { h, finishes, make } = fixture();
    try {
      for (let i = 0; i < 33; i++) {
        await h.session.receiveAgentMessage(make(`m${i}`));
        (await nextFinish(h, finishes))(); await settle(h);
      }
      expect(h.session.communicationMessageResult("m32")).toMatchObject({ state: "done" });
      expect(h.session.communicationMessageResult("m0")).toMatchObject({ state: "unknown", detail: "Turn ended without a recorded result" });
    } finally { h.close(); }
  });
});

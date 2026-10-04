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
});


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
});

import { describe, expect, it, vi } from "vitest";
import { createHarness, textStep } from "./test-harness.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { CORE_ENGINE_CAPABILITIES } from "./engines/session-engine.js";
import type { AgentEnvelope } from "../shared/communication.js";
import type { PermissionRequest } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
const isHostReady = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "host_ready" }> => m.type === "host_ready";
const isAgentDelivery = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "agent_message" }> => m.type === "agent_message";
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
  // GitHub #19: a renderer reload re-delivers the host's visible deliveries;
  // restoration must preserve each settled state/detail verbatim and never open
  // a model turn (no replay), no matter how many handshakes arrive.
  it("restored acknowledged, rejected and unknown deliveries keep their state across two ui_ready handshakes with zero model turns", async () => {
    const { h, inputs, make } = fixture();
    const agentDeliveries = (messageId: string) =>
      h.received
        .filter(isAgentDelivery)
        .filter((m) => m.delivery.envelope.messageId === messageId)
        .map((m) => m.delivery.state);
    try {
      h.session.restoreAgentMessages([
        { envelope: make("restored-acked"), state: "acknowledged", detail: "app-server accepted input for turn native-1; model application unverified" },
        { envelope: make("restored-rejected"), state: "rejected", detail: "Steering requires an active supported Codex turn; use next_turn" },
        { envelope: make("restored-unknown"), state: "unknown", detail: "Runtime restarted; no automatic replay to model" },
      ]);
      const expected = {
        "restored-acked": { state: "acknowledged", detail: "app-server accepted input for turn native-1; model application unverified" },
        "restored-rejected": { state: "rejected", detail: "Steering requires an active supported Codex turn; use next_turn" },
        "restored-unknown": { state: "unknown", detail: "Runtime restarted; no automatic replay to model" },
      } as const;
      for (let handshake = 1; handshake <= 2; handshake++) {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        await h.waitUntil(() => agentDeliveries("restored-unknown").length >= handshake);
        for (const [messageId, delivery] of Object.entries(expected)) {
          expect(h.session.agentMessageStatus(messageId)).toMatchObject(delivery);
          expect(agentDeliveries(messageId)).toHaveLength(handshake);
          expect(agentDeliveries(messageId).every((state) => state === delivery.state)).toBe(true);
        }
      }
      // Restoring visible history never starts a turn and never touches the model.
      expect(inputs).toHaveLength(0);
    } finally { h.close(); }
  });
  it("a newer live acknowledged state is not replaced by an older queued restoration", async () => {
    const { h, inputs, finishes, make } = fixture();
    try {
      // The live delivery lands first (server observer), then a stale queued
      // restoration arrives from the ledger: the live state must win.
      expect((await h.session.receiveAgentMessage(make("racing"))).state).toBe("acknowledged");
      h.session.restoreAgentMessages([{ envelope: make("racing"), state: "queued" }]);
      expect(h.session.agentMessageStatus("racing")?.state).toBe("acknowledged");
      expect(inputs).toHaveLength(1);
      (await nextFinish(h, finishes))(); await settle(h);
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
  it("get_session_status and get_session_result report the same state at one moment", async () => {
    const f = fixture();
    f.engine.runTurn = async function* () {
      yield { type: "text_start", id: "answer" }; yield { type: "text_delta", id: "answer", text: "DONE_TEXT" };
      await new Promise<void>((resolve) => { f.finishes.push(resolve); });
      yield { type: "text_end", id: "answer" }; yield { type: "loop_end", reason: "completed", turns: 1 };
    };
    try {
      await f.h.session.receiveAgentMessage(f.make("state-agree"));
      await f.h.waitUntil(() => f.finishes.length > 0);
      expect(f.h.session.communicationStatus().state).toBe("running");
      expect(f.h.session.communicationResult()).toMatchObject({ state: "running", availability: "pending" });
      f.finishes.shift()!(); await f.h.waitUntil(() => f.h.session.communicationResult().latestResult !== null); await f.h.flush();
      expect(f.h.session.communicationStatus().state).toBe("idle");
      expect(f.h.session.communicationResult()).toMatchObject({ state: "idle", availability: "available" });
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

describe("Sessions API cancel_turn (Taskana 4763)", () => {
  it("T1 cancel_turn while a turn runs aborts it, rejects queued inbox messages, and the running message ends done/cancelled", async () => {
    const { h, engine, signals, finishes, make } = fixture();
    engine.runTurn = async function* (_input, options) {
      signals.push(options.signal);
      yield { type: "turn_start", turn: 1 };
      await new Promise<void>((resolve) => { finishes.push(resolve); });
      yield { type: "loop_end", reason: options.signal.aborted ? "cancelled" : "completed", turns: 1 };
    };
    try {
      await h.session.receiveAgentMessage(make("one"));
      await h.session.receiveAgentMessage(make("queued"));
      expect(h.session.communicationCancelTurn()).toEqual({ cancelled: true, turnId: expect.any(String) });
      expect(signals[0]?.aborted).toBe(true);
      expect(h.session.agentMessageStatus("queued")).toMatchObject({ state: "rejected", detail: "Cancelled by Stop before queued delivery" });
      (await nextFinish(h, finishes))(); await settle(h);
      expect(h.session.communicationMessageResult("one")).toMatchObject({ state: "done", latestResult: { terminalReason: "cancelled" } });
    } finally { h.close(); }
  });
  it("T2 cancel_turn on an idle session reports idle, and a repeated call during one turn never throws", async () => {
    const { h, finishes, make } = fixture();
    try {
      expect(h.session.communicationCancelTurn()).toEqual({ cancelled: false, reason: "idle" });
      await h.session.receiveAgentMessage(make("one"));
      expect(h.session.communicationCancelTurn()).toMatchObject({ cancelled: true });
      let second: ReturnType<typeof h.session.communicationCancelTurn> | undefined;
      expect(() => { second = h.session.communicationCancelTurn(); }).not.toThrow();
      expect(second?.cancelled === true || second?.reason === "idle").toBe(true);
      (await nextFinish(h, finishes))(); await settle(h);
      expect(h.session.communicationCancelTurn()).toEqual({ cancelled: false, reason: "idle" });
    } finally { h.close(); }
  });
  it("T3 cancel_turn while shutting down reports closing, and while relocating reports relocating", async () => {
    const { h, make } = fixture();
    try {
      await h.session.receiveAgentMessage(make("one"));
      (h.session as unknown as { relocating: boolean }).relocating = true;
      expect(h.session.communicationCancelTurn()).toEqual({ cancelled: false, reason: "relocating" });
      (h.session as unknown as { relocating: boolean }).relocating = false;
      h.session.closeAdmissions();
      expect(h.session.communicationCancelTurn()).toEqual({ cancelled: false, reason: "closing" });
    } finally { h.close(); }
  });
  it("T4 cancel_turn denies a parked approval with origin turn_cancelled", async () => {
    const { h, finishes, make } = fixture();
    try {
      await h.session.receiveAgentMessage(make("one"));
      const decision = h.broker.requestPermission({
        toolName: "Bash", input: { command: "ls" }, mode: "build",
        metadata: { name: "Bash", description: "", readOnly: false, destructive: false, riskLevel: "high", sideEffectScope: "workspace" },
      } as unknown as Parameters<typeof h.broker.requestPermission>[0]);
      await settle(h);
      expect(h.received.some((m) => m.type === "permission_request")).toBe(true);
      h.session.communicationCancelTurn();
      await expect(decision).resolves.toMatchObject({ behavior: "deny" });
      await settle(h);
      expect(h.received).toContainEqual(expect.objectContaining({ type: "permission_settled", behavior: "deny", origin: "turn_cancelled" }));
      (await nextFinish(h, finishes))(); await settle(h);
    } finally { h.close(); }
  });
});

describe("Sessions API approvals (Taskana 4763)", () => {
  const askOf = (toolName: string, input: unknown): PermissionRequest => ({
    toolName, input, mode: "build",
    metadata: { name: toolName, description: "", readOnly: false, destructive: false, riskLevel: "high", sideEffectScope: "workspace" } as unknown as PermissionRequest["metadata"],
  });

  it("T12 communicationPendingApprovals shows a description and never the input; ExitPlanMode and AskUserQuestion are not answerable; an inline child's ask is listed under the parent", () => {
    const { h } = fixture();
    void h.broker.requestPermission(askOf("Write", { file_path: "/workspace/big.txt", content: "X".repeat(100_000) }));
    void h.broker.requestPermission(askOf("ExitPlanMode", { plan: "step one" }));
    void h.broker.requestPermission(askOf("AskUserQuestion", { questions: [] }));
    void h.broker.requestPermission(askOf("Bash", { command: "echo from-inline-child" }));
    const list = h.session.communicationPendingApprovals();
    expect(list.map((a) => a.tool)).toEqual(["Write", "ExitPlanMode", "AskUserQuestion", "Bash"]);
    expect(list[0]).toEqual({ approvalId: expect.any(String), tool: "Write", description: "/workspace/big.txt", presented: true, expiresInMs: expect.any(Number), answerable: true });
    expect(list[0]).not.toHaveProperty("input");
    expect(JSON.stringify(list)).not.toContain("XXXXXXXX");
    expect(list[1]).toMatchObject({ presented: false, expiresInMs: null, answerable: false });
    expect(list[2]!.answerable).toBe(false);
    expect(list[3]).toMatchObject({ tool: "Bash", description: "echo from-inline-child", answerable: true });
  });

  it("T13 communicationAnswerApproval allow and deny settle the ask; not_answerable does NOT settle it", async () => {
    const { h } = fixture();
    const allowed = h.broker.requestPermission(askOf("Bash", { command: "ls" }));
    const allowId = h.session.communicationPendingApprovals()[0]!.approvalId;
    expect(h.session.communicationAnswerApproval({ approvalId: allowId, decision: "allow" })).toEqual({ result: "answered" });
    await expect(allowed).resolves.toEqual({ behavior: "allow" });

    const denied = h.broker.requestPermission(askOf("Bash", { command: "rm -rf x" }));
    const denyId = h.session.communicationPendingApprovals()[0]!.approvalId;
    expect(h.session.communicationAnswerApproval({ approvalId: denyId, decision: "deny" })).toEqual({ result: "answered" });
    await expect(denied).resolves.toEqual({ behavior: "deny", reason: "denied from the Sessions API" });

    const plan = h.broker.requestPermission(askOf("ExitPlanMode", { plan: "p" }));
    const planId = h.session.communicationPendingApprovals()[0]!.approvalId;
    expect(h.session.communicationAnswerApproval({ approvalId: planId, decision: "allow" })).toEqual({ result: "not_answerable" });
    expect(h.broker.pendingCount).toBe(1);
    expect(h.session.communicationPendingApprovals()).toEqual([expect.objectContaining({ approvalId: planId, answerable: false })]);
    h.broker.denyAll("test cleanup", "shutdown");
    await expect(plan).resolves.toMatchObject({ behavior: "deny" });
  });

  it("T14 communicationAnswerApproval rejects a malformed payload at the host boundary and settles nothing", () => {
    const { h } = fixture();
    void h.broker.requestPermission(askOf("Bash", { command: "ls" }));
    const approvalId = h.session.communicationPendingApprovals()[0]!.approvalId;
    expect(() => h.session.communicationAnswerApproval({ approvalId, decision: "always" })).toThrow();
    expect(() => h.session.communicationAnswerApproval({ decision: "allow" })).toThrow();
    expect(() => h.session.communicationAnswerApproval({ approvalId, decision: "allow", updatedInput: {} })).toThrow();
    expect(() => h.session.communicationAnswerApproval(null)).toThrow();
    expect(h.broker.pendingCount).toBe(1);
  });
});


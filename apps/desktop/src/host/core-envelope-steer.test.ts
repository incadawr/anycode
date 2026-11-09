/**
 * Mid-turn delivery into a CORE session.
 *
 * A `steer` envelope addressed to a running Core session is injected into
 * the RUNNING turn at the loop's legal seam (right before the next provider
 * request). The turn is never aborted or restarted, the answer comes back
 * at once (`queued`), and the eventual delivery is published on the
 * observer/ledger channel: `acknowledged`/`core_seam` once the frame is in
 * the model's input, `rejected` when the turn ended before the seam.
 *
 * These tests drive the REAL CoreEngine + AgentLoop (no stubbed steer
 * promise): the model port, the tool call, the permission ask and the
 * seam are the production ones.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentLoop, SessionPermissionRules, type AgentLoopConfig, type ModelStreamEvent } from "@anycode/core";
import { createHarness, GatedModelPort, MemFs, ScriptedModelPort, finishStep, toolStep } from "./test-harness.js";
import { CORE_ENGINE_CAPABILITIES, type SessionEngine } from "./engines/session-engine.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import type { AgentEnvelope } from "../shared/communication.js";
import type { HostToUiMessage } from "../shared/protocol.js";

const isPermissionRequest = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "permission_request" }> => m.type === "permission_request";
const isUserInjected = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
  m.type === "agent_event" && m.event.type === "user_injected";

const BODY = "MID_TURN_BODY";

/** A core harness whose engine is the REAL CoreEngine over a REAL AgentLoop. */
function coreFixture(steps: ModelStreamEvent[][]) {
  const h = createHarness({ steps });
  const port = h.config.modelPort as ScriptedModelPort;
  const sessionId = h.session.communicationStatus().sessionId;
  const envelope = (messageId: string, mode: "next_turn" | "steer" = "steer", payload = BODY): AgentEnvelope => ({
    messageId,
    sender: "test-supervisor",
    recipientSessionId: sessionId,
    kind: "agent_message",
    payload,
    mode,
    createdAt: new Date().toISOString(),
  });
  return { h, port, envelope, sessionId };
}

/** The frames the loop appended to the transcript for the given marker. */
function durableFrames(h: { engine: SessionEngine }, marker: string): number {
  return h.engine
    .historyItems()
    .filter((item) => item.message.role === "user" && JSON.stringify(item.message.content).includes(marker)).length;
}

describe("core envelope steer", () => {
  it("queues a core steer at once and injects it at the seam after the blocked tool", async () => {
    const { h, port, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      const ask = await h.waitFor(isPermissionRequest);
      expect(ask.toolName).toBe("Write");

      // The tool is blocked: the steer answers IMMEDIATELY, without waiting
      // for the seam (a long tool must never hold the caller's request).
      const receipt = await h.session.receiveAgentMessage(envelope("m1"));
      expect(receipt.state).toBe("queued");
      expect(port.requests).toHaveLength(1);

      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("acknowledged"));

      expect(h.session.agentMessageStatus("m1")).toMatchObject({
        state: "acknowledged",
        deliveryKind: "core_seam",
        detail: "Inserted at Core loop boundary; model application unverified",
      });
      // The frame was in the model's input for the NEXT provider request.
      expect(port.requests).toHaveLength(2);
      expect(port.requests[1]!.messages.filter((m) => JSON.stringify(m).includes(BODY))).toHaveLength(1);
      // Exactly ONE durable frame, and exactly one injection on the wire.
      expect(durableFrames(h, BODY)).toBe(1);
      expect(h.received.filter(isUserInjected)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("keeps FIFO order for two core steers queued in the same step", async () => {
    const { h, port, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      const ask = await h.waitFor(isPermissionRequest);
      expect((await h.session.receiveAgentMessage(envelope("first", "steer", "FIRST_BODY"))).state).toBe("queued");
      expect((await h.session.receiveAgentMessage(envelope("second", "steer", "SECOND_BODY"))).state).toBe("queued");

      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await vi.waitFor(() => {
        expect(h.session.agentMessageStatus("first")?.state).toBe("acknowledged");
        expect(h.session.agentMessageStatus("second")?.state).toBe("acknowledged");
      });

      const messages = port.requests[1]!.messages;
      const first = messages.findIndex((m) => JSON.stringify(m).includes("FIRST_BODY"));
      const second = messages.findIndex((m) => JSON.stringify(m).includes("SECOND_BODY"));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(durableFrames(h, "FIRST_BODY")).toBe(1);
      expect(durableFrames(h, "SECOND_BODY")).toBe(1);
    } finally {
      h.close();
    }
  });

  it("deduplicates a core steer by message id while its injection is in flight", async () => {
    const { h, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      const ask = await h.waitFor(isPermissionRequest);
      const first = await h.session.receiveAgentMessage(envelope("m1"));
      expect(first.state).toBe("queued");
      // The SAME id again: the in-flight injection is not started twice.
      const duplicate = await h.session.receiveAgentMessage(envelope("m1"));
      expect(duplicate.state).toBe("queued");
      expect(duplicate.envelope.messageId).toBe("m1");
      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("acknowledged"));
      expect(h.received.filter(isUserInjected)).toHaveLength(1);
      expect(durableFrames(h, BODY)).toBe(1);
    } finally {
      h.close();
    }
  });

  it("rejects a core steer when no turn is running", async () => {
    const { h, envelope } = coreFixture([finishStep()]);
    try {
      const receipt = await h.session.receiveAgentMessage(envelope("m1"));
      expect(receipt.state).toBe("rejected");
      expect(receipt.detail).toContain("next_turn");
      expect(h.session.communicationMessageResult("m1")).toMatchObject({ state: "rejected" });
      expect(h.received.filter(isUserInjected)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("rejects a core steer whose turn ends before the seam", async () => {
    // The model parks mid-step and then finishes: the turn has NO further
    // step, so the seam never comes and the queued frame dies with the turn.
    const h = createHarness({ steps: [finishStep()], gated: { parkAfterIndex: 0 } });
    const port = h.config.modelPort as ScriptedModelPort;
    const sessionId = h.session.communicationStatus().sessionId;
    const envelope = (messageId: string, mode: "next_turn" | "steer" = "steer", payload = BODY): AgentEnvelope => ({
      messageId, sender: "test-supervisor", recipientSessionId: sessionId, kind: "agent_message", payload, mode,
      createdAt: new Date().toISOString(),
    });
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      // The first provider request is in flight: the first seam is behind us.
      await vi.waitFor(() => expect(port.requests).toHaveLength(1));
      const receipt = await h.session.receiveAgentMessage(envelope("m1"));
      expect(receipt.state).toBe("queued");
      h.gated!.release();
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("rejected"));
      expect(h.session.agentMessageStatus("m1")?.detail).toContain("before injection");
      // No silent next-turn fallback: the envelope did not start a turn.
      expect(durableFrames(h, BODY)).toBe(0);
      expect(h.session.communicationMessageResult("m1")).toMatchObject({ state: "rejected" });
    } finally {
      h.close();
    }
  });

  it("rejects an in-flight core injection when Stop ends the turn before the seam", async () => {
    const { h, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      await h.waitFor(isPermissionRequest);
      expect((await h.session.receiveAgentMessage(envelope("m1"))).state).toBe("queued");

      h.send({ type: "cancel_turn" });
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("rejected"));
      expect(h.session.agentMessageStatus("m1")?.detail).toContain("Stop");
      expect(h.session.communicationMessageResult("m1")).toMatchObject({ state: "rejected" });
      // Stop does NOT silently run the message as another turn.
      expect(durableFrames(h, BODY)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("rejects an in-flight core injection when the session closes", async () => {
    const { h, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      await h.waitFor(isPermissionRequest);
      expect((await h.session.receiveAgentMessage(envelope("m1"))).state).toBe("queued");

      await h.session.shutdown();
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("rejected"));
      expect(durableFrames(h, BODY)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("binds the injected message to the turn that was running when it arrived", async () => {
    const { h, envelope } = coreFixture([
      toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }),
      finishStep(),
    ]);
    try {
      await h.session.receiveAgentMessage(envelope("start", "next_turn", "START_TURN"));
      const ask = await h.waitFor(isPermissionRequest);
      const runningTurnId = h.session.communicationResult().activeTurnId;
      expect(runningTurnId).toEqual(expect.any(String));
      expect((await h.session.receiveAgentMessage(envelope("m1"))).state).toBe("queued");
      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await vi.waitFor(() => expect(h.session.agentMessageStatus("m1")?.state).toBe("acknowledged"));
      await vi.waitFor(() => expect(h.session.communicationStatus().state).toBe("idle"));

      // The correlation belongs to the RECEIVING turn, not to a later one.
      const result = h.session.communicationMessageResult("m1");
      expect(result).toMatchObject({
        state: "done",
        latestResult: { turnId: runningTurnId, correlationMeaning: "transport_delivery_only" },
      });
      if (result.state === "done") expect(result.latestResult.deliveredMessageIds).toContain("m1");
    } finally {
      h.close();
    }
  });

  it("injects a core steer into a running CHILD session", async () => {
    // The child runs the REAL core loop over its OWN model port: the model
    // parks mid-step, so the steer lands while the child's turn is alive.
    const donor = createHarness({ steps: [] });
    const port = new GatedModelPort([toolStep("r1", "Read", { file_path: "/workspace/a.txt" }), finishStep()], 1);
    const broker = new IpcPermissionBroker(() => {});
    const config: AgentLoopConfig = { ...donor.config, modelPort: port, permissionBroker: broker };
    const engine = new CoreEngine({ loop: new AgentLoop(config), config });
    const terminal = vi.fn();
    const child = new Session({
      outbound: new Outbound(),
      engine,
      broker,
      fs: donor.toolFs,
      workspace: "/workspace",
      projectRoot: "/workspace",
      model: "fixture",
      sessionId: "child-session",
      bootHistory: [],
      rules: new SessionPermissionRules(),
      child: { onReady: () => {}, onProgress: () => {}, flushHistory: async () => {}, onTerminal: terminal },
    });
    const envelope = (messageId: string, mode: "next_turn" | "steer" = "steer", payload = BODY): AgentEnvelope => ({
      messageId, sender: "test-supervisor", recipientSessionId: "child-session", kind: "agent_message", payload, mode,
      createdAt: new Date().toISOString(),
    });
    try {
      expect(child.startProgrammaticTurn("child work")).toEqual({ ok: true });
      await vi.waitFor(() => expect(port.requests).toHaveLength(1));

      const receipt = await child.receiveAgentMessage(envelope("m1"));
      expect(receipt.state).toBe("queued");
      port.release();
      await vi.waitFor(() => expect(child.agentMessageStatus("m1")?.state).toBe("acknowledged"));
      expect(child.agentMessageStatus("m1")).toMatchObject({ state: "acknowledged", deliveryKind: "core_seam" });
      expect(port.requests[1]!.messages.filter((m) => JSON.stringify(m).includes(BODY))).toHaveLength(1);
    } finally {
      await child.shutdown();
      donor.close();
    }
  });

  it("keeps the Codex steer path unchanged", async () => {
    const inputs: string[] = [];
    const finishes: Array<() => void> = [];
    const engine: SessionEngine = {
      id: "codex", capabilities: CORE_ENGINE_CAPABILITIES, mode: () => "build", reasoningEffort: () => undefined,
      setReasoningEffort: () => {}, historyItems: () => [], dispose: async () => {},
      steer: vi.fn(async () => ({ turnId: "native-turn" })),
      async *runTurn(input) {
        inputs.push(input);
        yield { type: "turn_start", turn: inputs.length };
        await new Promise<void>((resolve) => { finishes.push(resolve); });
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    };
    const h = createHarness({ steps: [], engine });
    const sessionId = h.session.communicationStatus().sessionId;
    const envelope = (messageId: string, mode: "next_turn" | "steer" = "steer"): AgentEnvelope => ({
      messageId, sender: "test-supervisor", recipientSessionId: sessionId, kind: "agent_message",
      payload: "codex body", mode, createdAt: new Date().toISOString(),
    });
    try {
      // Idle: refused exactly as before.
      expect((await h.session.receiveAgentMessage(envelope("idle"))).state).toBe("rejected");
      await h.session.receiveAgentMessage(envelope("start", "next_turn"));
      await vi.waitFor(() => expect(inputs).toHaveLength(1));
      // Running: the native app-server takes the input on its own channel.
      const steered = await h.session.receiveAgentMessage(envelope("m1"));
      expect(steered.state).toBe("acknowledged");
      expect(steered.detail).toContain("app-server accepted input");
      expect(steered.deliveryKind).toBeUndefined();
      // A native refusal stays a refusal and never becomes a next turn.
      vi.mocked(engine.steer!).mockRejectedValueOnce(new Error("stale expectedTurnId"));
      expect((await h.session.receiveAgentMessage(envelope("m2"))).state).toBe("rejected");
      expect(inputs).toHaveLength(1);
      finishes.shift()!();
      await h.flush();
    } finally {
      h.close();
    }
  });
});

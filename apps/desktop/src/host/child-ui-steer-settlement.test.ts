/**
 * A child session's UI steers are host-owned work that gates the child
 * terminal.
 *
 * A UI steer that cannot flush into the running Core turn (the turn ends on a
 * text-only step, Stop, the turn cap, the host closing) rejects AFTER the
 * loop ended, while the child may already be settling. The host must then
 * keep the text in the child's own steer queue (exactly once, announced with
 * `hostQueued`) and run it as the next turn BEFORE the child terminal is
 * published; the terminal itself must wait for every steer promise.
 *
 * These tests drive the real CoreEngine/AgentLoop; where the ORDER of the
 * steer promise against the loop finalization matters the steer promise is
 * settled by hand.
 */
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  AgentLoop,
  SessionPermissionRules,
  type AgentLoopConfig,
  type ModelStreamEvent,
} from "@anycode/core";
import { GatedModelPort, createHarness, finishStep, nodeWirePort, textStep, toolStep } from "./test-harness.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session, type ChildTerminalReport } from "./session.js";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";
import { CHILD_STEER_QUEUE_MAX } from "../shared/child-sessions.js";
import type { HostToUiMessage } from "../shared/protocol.js";

type Requeued = Extract<HostToUiMessage, { type: "steer_requeued" }>;
type Rejected = Extract<HostToUiMessage, { type: "turn_rejected" }>;
const isRequeued = (m: HostToUiMessage): m is Requeued => m.type === "steer_requeued";
const isRejected = (m: HostToUiMessage): m is Rejected => m.type === "turn_rejected";
const isTurnStarted = (m: HostToUiMessage): boolean => m.type === "turn_started";
const isHostReady = (m: HostToUiMessage): boolean => m.type === "host_ready";

interface Deferred {
  resolve: (value: { turnId: string }) => void;
  reject: (error: Error) => void;
}

interface Fixture {
  session: Session;
  port: GatedModelPort;
  terminal: ReturnType<typeof vi.fn<(report: ChildTerminalReport) => void>>;
  flushHistory: ReturnType<typeof vi.fn<() => Promise<void>>>;
  received: HostToUiMessage[];
  manual: Deferred[];
  send: (message: unknown) => void;
  waitUntil: (predicate: () => boolean) => Promise<void>;
  close: () => void;
}

/**
 * A CHILD session over a real core loop. `manualSteer` replaces the engine's
 * steer with promises the test settles itself; otherwise the real steer runs.
 */
async function childFixture(
  steps: ModelStreamEvent[][],
  options: { parkAfterIndex?: number; manualSteer?: boolean; maxTurns?: number; seamNotReady?: boolean } = {},
): Promise<Fixture> {
  const donor = createHarness({ steps: [] });
  const port = new GatedModelPort(steps, options.parkAfterIndex ?? 0);
  const broker = new IpcPermissionBroker(() => {});
  const config: AgentLoopConfig = {
    ...donor.config,
    modelPort: port,
    permissionBroker: broker,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };
  const real = new CoreEngine({ loop: new AgentLoop(config), config });
  const manual: Deferred[] = [];
  const manualEngine = options.manualSteer
    ? Object.assign(Object.create(real) as CoreEngine, {
        steer: (): Promise<{ turnId: string }> =>
          new Promise((resolve, reject) => {
            manual.push({ resolve, reject });
          }),
      })
    : real;
  const engine = options.seamNotReady
    ? Object.assign(Object.create(manualEngine) as CoreEngine, {
        steeringStatus: (): { supported: boolean; ready: boolean } => ({ supported: true, ready: false }),
      })
    : manualEngine;

  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  channel.port1.on("message", (value: unknown) => {
    received.push(value as HostToUiMessage);
  });
  const terminal = vi.fn<(report: ChildTerminalReport) => void>();
  const flushHistory = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const session = new Session({
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
    child: { parentSessionId: PARENT_SESSION_ID, onReady: () => {}, onProgress: () => {}, flushHistory, onTerminal: terminal },
  });
  session.bindPort(nodeWirePort(channel.port2));
  channel.port1.postMessage({ type: "ui_ready" });
  await vi.waitFor(() => expect(received.some(isHostReady)).toBe(true));
  return {
    session,
    port,
    terminal,
    flushHistory,
    received,
    manual,
    send: (message) => channel.port1.postMessage(message),
    waitUntil: (predicate) => vi.waitFor(() => expect(predicate()).toBe(true)),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const PARENT_SESSION_ID = "parent-session-1";
const requestText = (port: GatedModelPort, index: number): string => JSON.stringify(port.requests[index]?.messages ?? []);
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const steer = (requestId: string, text: string) => ({ type: "steer_message", requestId, text });
/** Lets the host drain every settled promise / port hop it can. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("child UI steer settlement", () => {
  it("queues a rejected steer host-side and runs it as the next turn before the terminal", async () => {
    // The first step is text-only: the steer never meets a seam, so the real
    // engine rejects it when the loop ends.
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")]);
    try {
      expect(f.session.startProgrammaticTurn("INITIAL_PROMPT")).toEqual({ ok: true });
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await settle();
      expect(f.terminal).not.toHaveBeenCalled();
      f.port.release();

      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      // The steer text became exactly one next turn after the first one.
      expect(f.port.requests).toHaveLength(2);
      expect(occurrences(requestText(f.port, 1), "STEER_ONE")).toBe(1);
      // The initial prompt is never sent a second time as its own turn.
      expect(occurrences(requestText(f.port, 1), "INITIAL_PROMPT")).toBe(1);
      expect(f.terminal.mock.calls[0]![0]).toMatchObject({ status: "completed", finalText: expect.stringContaining("SECOND_ANSWER") });
      // One host-queued announcement; the renderer must not resend it.
      const requeued = f.received.filter(isRequeued);
      expect(requeued).toHaveLength(1);
      expect(requeued[0]).toMatchObject({ requestId: "s1", text: "STEER_ONE", hostQueued: true });
      expect(f.received.filter(isTurnStarted)).toHaveLength(2);
      expect(f.session.startProgrammaticTurn("INITIAL_PROMPT")).toMatchObject({ ok: false });
    } finally {
      f.close();
    }
  });

  it("holds the terminal while the loop is finalized and the steer promise is still pending, then drains it", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")], { manualSteer: true });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await f.waitUntil(() => f.manual.length === 1);
      f.port.release();
      // The loop finished; the steer promise has not settled yet.
      await f.waitUntil(() => f.received.some((m) => m.type === "agent_event" && m.event.type === "loop_end"));
      await settle();
      expect(f.terminal).not.toHaveBeenCalled();
      expect(f.port.requests).toHaveLength(1);

      f.manual[0]!.reject(new Error("core turn ended before injection"));
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(2);
      expect(occurrences(requestText(f.port, 1), "STEER_ONE")).toBe(1);
      expect(f.terminal.mock.calls[0]![0].finalText).toContain("SECOND_ANSWER");
      expect(f.received.filter(isRequeued)).toEqual([expect.objectContaining({ requestId: "s1", hostQueued: true })]);
    } finally {
      f.close();
    }
  });

  it("queues a steer rejected before the loop finalizes and drains it at the seam of the turn end", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")], { manualSteer: true });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await f.waitUntil(() => f.manual.length === 1);
      // The rejection arrives while the turn is still running.
      f.manual[0]!.reject(new Error("core turn ended before injection"));
      await f.waitUntil(() => f.received.some(isRequeued));
      expect(f.port.requests).toHaveLength(1);
      f.port.release();

      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(2);
      expect(occurrences(requestText(f.port, 1), "STEER_ONE")).toBe(1);
      expect(f.received.filter(isRequeued)).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("completes the terminal once a pending steer is delivered after the loop ended", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER")], { manualSteer: true });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await f.waitUntil(() => f.manual.length === 1);
      f.port.release();
      await settle();
      expect(f.terminal).not.toHaveBeenCalled();
      f.manual[0]!.resolve({ turnId: "core:step:1" });
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(1);
      expect(f.received.filter(isRequeued)).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("runs an accepted steer after Stop through the child steer queue", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")]);
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await settle();
      f.send({ type: "cancel_turn" });
      await f.waitUntil(() => f.port.requests.length === 2);
      // The steer runs as its own turn; unpark it.
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(2);
      expect(occurrences(requestText(f.port, 1), "STEER_ONE")).toBe(1);
      expect(f.received.filter(isRequeued)).toEqual([expect.objectContaining({ requestId: "s1", hostQueued: true })]);
    } finally {
      f.close();
    }
  });

  it("runs a steer whose turn exits on the turn limit before the seam", async () => {
    const f = await childFixture(
      [toolStep("r1", "Read", { file_path: "/workspace/a.txt" }), textStep("LIMIT_ANSWER"), textStep("STEER_ANSWER")],
      { maxTurns: 1 },
    );
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await settle();
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      // The steer text reached the model exactly once, in a turn that ran
      // before the terminal was published.
      const all = f.port.requests.map((_, index) => requestText(f.port, index));
      expect(all.filter((text) => text.includes("STEER_ONE")).length).toBeGreaterThan(0);
      expect(occurrences(all[all.length - 1]!, "STEER_ONE")).toBe(1);
      expect(f.received.filter(isRejected).filter((m) => m.requestId === "s1")).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("rejects a pending steer on host close without starting new work", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")]);
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await settle();

      let shutdownDone = false;
      const shutdown = f.session.shutdown().then(() => {
        shutdownDone = true;
      });
      await shutdown;
      // The close waits for the terminal: it is published before it resolves.
      expect(shutdownDone).toBe(true);
      expect(f.terminal).toHaveBeenCalledTimes(1);
      await settle();
      expect(f.port.requests).toHaveLength(1);
      expect(f.received.filter(isRequeued)).toHaveLength(0);
      expect(f.received.filter(isRejected)).toContainEqual(expect.objectContaining({ requestId: "s1", reason: "not_ready" }));
    } finally {
      f.close();
    }
  });

  it("waits for a steer promise that settles after the close began, then rejects it without new work", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")], { manualSteer: true });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await f.waitUntil(() => f.manual.length === 1);

      let shutdownDone = false;
      const shutdown = f.session.shutdown().then(() => {
        shutdownDone = true;
      });
      // The turn is aborted but its steer promise is still open: neither a
      // terminal nor the end of the close may overtake it.
      await settle();
      expect(shutdownDone).toBe(false);
      expect(f.terminal).not.toHaveBeenCalled();

      f.manual[0]!.reject(new Error("core turn ended before injection"));
      await shutdown;
      expect(f.terminal).toHaveBeenCalledTimes(1);
      await settle();
      expect(f.port.requests).toHaveLength(1);
      expect(f.received.filter(isRequeued)).toHaveLength(0);
      expect(f.received.filter(isRejected)).toContainEqual(expect.objectContaining({ requestId: "s1", reason: "not_ready" }));
    } finally {
      f.close();
    }
  });

  it("keeps several steers in order, one next turn each, with one terminal at the end", async () => {
    const f = await childFixture([textStep("A0"), textStep("A1"), textStep("A2"), textStep("A3")]);
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      f.send(steer("s2", "STEER_TWO"));
      f.send(steer("s3", "STEER_THREE"));
      await settle();
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(4);
      const last = requestText(f.port, 3);
      expect(last.indexOf("STEER_ONE")).toBeGreaterThan(-1);
      expect(last.indexOf("STEER_TWO")).toBeGreaterThan(last.indexOf("STEER_ONE"));
      expect(last.indexOf("STEER_THREE")).toBeGreaterThan(last.indexOf("STEER_TWO"));
      for (const text of ["STEER_ONE", "STEER_TWO", "STEER_THREE", "INITIAL_PROMPT"]) expect(occurrences(last, text)).toBe(1);
      expect(f.received.filter(isRequeued).map((m) => m.requestId)).toEqual(["s1", "s2", "s3"]);
      expect(f.received.filter(isTurnStarted)).toHaveLength(4);
      expect(f.terminal.mock.calls[0]![0].finalText).toContain("A3");
    } finally {
      f.close();
    }
  });

  it("does not publish a terminal for a child that finished with a delivered steer in the same step", async () => {
    // A steer that lands at the seam of a tool step is delivered into the
    // running turn: nothing is requeued and exactly one turn runs.
    const f = await childFixture([toolStep("r1", "Read", { file_path: "/workspace/a.txt" }), finishStep()], { parkAfterIndex: 1 });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.send(steer("s1", "STEER_ONE"));
      await settle();
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.port.requests).toHaveLength(2);
      expect(occurrences(requestText(f.port, 1), "STEER_ONE")).toBe(1);
      expect(f.received.filter(isRequeued)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
});

describe("child UI steer fallback with a full child steer queue", () => {
  it("rejects the text as busy, emits no steer_requeued, and still publishes the terminal once", async () => {
    // One initial turn plus one turn per queued steer.
    const steps = Array.from({ length: CHILD_STEER_QUEUE_MAX + 1 }, (_, index) => textStep(`ANSWER_${index}`));
    const f = await childFixture(steps, { manualSteer: true });
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      // The UI steer is accepted into the running turn first (its promise stays pending).
      f.send(steer("ui-steer", "UI_STEER_TEXT"));
      await f.waitUntil(() => f.manual.length === 1);
      // Fill the child steer queue to its bound with busy-time messages.
      for (let i = 0; i < CHILD_STEER_QUEUE_MAX; i++) f.send({ type: "user_message", requestId: `fill-${i}`, text: `FILL_${i}` });
      await settle();
      expect(f.received.filter(isRejected)).toHaveLength(0);

      // The engine refuses the steer: the fallback finds the queue full.
      f.manual[0]!.reject(new Error("core turn ended before injection"));
      await f.waitUntil(() => f.received.some((m) => isRejected(m) && m.requestId === "ui-steer"));
      expect(f.received.filter(isRejected).filter((m) => m.requestId === "ui-steer")).toEqual([
        expect.objectContaining({ requestId: "ui-steer", reason: "busy" }),
      ]);
      expect(f.received.filter(isRequeued)).toHaveLength(0);

      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      expect(f.terminal).toHaveBeenCalledTimes(1);
      // The rejected text was reported, never run as a hidden turn.
      expect(f.port.requests.map((_, index) => requestText(f.port, index)).some((text) => text.includes("UI_STEER_TEXT"))).toBe(false);
      expect(f.received.filter(isRequeued)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
});

describe("owning-parent steer while the Core seam is not active", () => {
  const parentEnvelope = (messageId: string, sender = `parent-session:${PARENT_SESSION_ID}`): AgentEnvelope => ({
    messageId, sender, recipientSessionId: "child-session", kind: "agent_message", payload: "PARENT_BODY", mode: "steer",
    createdAt: new Date().toISOString(),
  });
  const observe = (f: Fixture): AgentDelivery[] => {
    const seen: AgentDelivery[] = [];
    f.session.observeAgentDeliveries((delivery) => seen.push(delivery));
    return seen;
  };

  it("downgrades to next_turn under the same id with one ledger record and no rejected publish", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER"), textStep("SECOND_ANSWER")], { seamNotReady: true });
    try {
      const seen = observe(f);
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      const receipt = await f.session.receiveAgentMessage(parentEnvelope("p1"));
      expect(receipt).toMatchObject({ state: "queued", deliveryKind: "next_turn" });
      expect(receipt.reasonCode).toBeUndefined();
      expect(receipt.envelope.messageId).toBe("p1");
      expect(seen.map((d) => d.state)).toEqual(["queued"]);
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      await settle();
      // Same id throughout: queued then acknowledged as the next turn; never rejected.
      expect(seen.every((d) => d.envelope.messageId === "p1")).toBe(true);
      expect(seen.map((d) => d.state)).toEqual(["queued", "acknowledged"]);
      expect(seen[1]).toMatchObject({ deliveryKind: "next_turn" });
      expect(f.session.agentMessageStatus("p1")).toMatchObject({ state: "acknowledged", deliveryKind: "next_turn" });
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(occurrences(requestText(f.port, f.port.requests.length - 1), "PARENT_BODY")).toBe(1);
      // A duplicate id never creates a second record.
      await f.session.receiveAgentMessage(parentEnvelope("p1"));
      expect(seen).toHaveLength(2);
    } finally {
      f.close();
    }
  });

  it("starts the next turn at once on an idle child and reports it as next_turn", async () => {
    const f = await childFixture([textStep("PARENT_ANSWER")]);
    try {
      const seen = observe(f);
      const receipt = await f.session.receiveAgentMessage(parentEnvelope("p2"));
      expect(receipt).toMatchObject({ state: "acknowledged", deliveryKind: "next_turn" });
      expect(seen.map((d) => d.state)).toEqual(["queued", "acknowledged"]);
    } finally {
      f.close();
    }
  });

  it("does not downgrade a peer or another session's steer", async () => {
    const f = await childFixture([textStep("FIRST_ANSWER")]);
    try {
      const seen = observe(f);
      for (const [id, sender] of [["x1", "session:peer-1"], ["x2", "parent-session:someone-else"], ["x3", "test-supervisor"]] as const) {
        const receipt = await f.session.receiveAgentMessage(parentEnvelope(id, sender));
        expect(receipt).toMatchObject({ state: "rejected", reasonCode: "core_seam_inactive" });
        expect(receipt.deliveryKind).toBeUndefined();
      }
      expect(f.port.requests).toHaveLength(0);
      expect(seen.every((d) => d.state !== "acknowledged")).toBe(true);
    } finally {
      f.close();
    }
  });

  it("does not downgrade a terminal refusal of the owning parent's steer", async () => {
    const f = await childFixture([textStep("DONE")]);
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      const receipt = await f.session.receiveAgentMessage(parentEnvelope("p3"));
      expect(receipt.state).toBe("rejected");
      expect(receipt.reasonCode).toBeUndefined();
      expect(receipt.deliveryKind).toBeUndefined();
      expect(f.port.requests).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});

describe("core seam refusal reason code", () => {
  const envelope = (sessionId: string, mode: "next_turn" | "steer"): AgentEnvelope => ({
    messageId: "m1", sender: "test-supervisor", recipientSessionId: sessionId, kind: "agent_message", payload: "BODY", mode,
    createdAt: new Date().toISOString(),
  });

  it("marks a steer refused because no core turn runs as core_seam_inactive", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      const delivery = await h.session.receiveAgentMessage(envelope(h.session.communicationStatus().sessionId, "steer"));
      expect(delivery).toMatchObject({ state: "rejected", reasonCode: "core_seam_inactive" });
      expect(delivery.detail).toContain("next_turn");
      expect(h.session.agentMessageStatus("m1")).toMatchObject({ state: "rejected", reasonCode: "core_seam_inactive" });
    } finally {
      h.close();
    }
  });

  it("carries no reason code on a refusal of a closed child", async () => {
    const f = await childFixture([textStep("DONE")]);
    try {
      f.session.startProgrammaticTurn("INITIAL_PROMPT");
      await f.waitUntil(() => f.port.requests.length === 1);
      f.port.release();
      await f.waitUntil(() => f.terminal.mock.calls.length > 0);
      const delivery = await f.session.receiveAgentMessage(envelope("child-session", "steer"));
      expect(delivery.state).toBe("rejected");
      expect(delivery.reasonCode).toBeUndefined();
    } finally {
      f.close();
    }
  });
});

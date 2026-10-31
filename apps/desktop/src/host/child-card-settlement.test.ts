/**
 * Production-path settlement test for a finished child's card.
 *
 * The individual mappings of the exact tool-call count are unit-covered in
 * isolation (the child port's end progress, the core agent bridge's
 * `subagent_end`, the renderer store's settle). This test runs ONE child
 * through the real chain instead, so a break in the *connections* between
 * those pieces fails here too:
 *
 *   real child Session (own AgentLoop + dispatcher, two real tool calls)
 *     → its terminal report (`ChildTerminalReport.toolCalls`)
 *     → the wire main reads (the production `parseChildRunEvent` gate)
 *     → the real `createChildSessionPort` on the parent host
 *     → a real parent `AgentLoop` running the session-tier Agent tool
 *     → the `subagent_*` AgentEvents
 *     → the real renderer store, which settles the card
 *
 * Only two hops are mirrors rather than imports, both of them transport:
 * `host/index.ts` cannot be imported (it touches `process.parentPort` at
 * module scope — the established host-test idiom), so the child-terminal
 * message is built here with the same field passthrough and validated by the
 * real parser; and main's `agent_event` forwarding is the one `turnId`
 * wrapper the store consumes. The child's progress throttle is REAL: the two
 * tool results land inside one leading-edge 1000 ms window, so the last
 * progress frame main can relay says one call while the terminal says two —
 * exactly the shape that settled a card one short.
 */
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  AgentLoop,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeHttpAdapter,
  RuleAwarePermissionEngine,
  SessionPermissionRules,
  createDefaultToolRegistry,
} from "@anycode/core";
import type {
  AgentEvent,
  AgentLoopConfig,
  HistoryItem,
  MediaCapabilityPort,
  ModelStreamEvent,
  SessionSubagentPort,
} from "@anycode/core";
import { CHILD_RUN_EVENT_TYPE, CHILD_SPAWN_REQUEST_TYPE, parseChildRunEvent, type ChildRunEvent } from "../shared/child-sessions.js";
import { createDesktopStore } from "../renderer/src/store.js";
import { createChildSessionPort } from "./child-session-port.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { sanitizeAgentEvent } from "./serialize.js";
import { Outbound, Session } from "./session.js";
import type { ChildProgressReport, ChildTerminalReport } from "./session.js";
import { MemFs, ScriptedModelPort, finishStep, nodeWirePort, toolStep } from "./test-harness.js";

/** One model step proposing several parallel tool calls (same shape core's runner tests use). */
function multiToolStep(calls: ReadonlyArray<{ id: string; name: string; input: unknown }>): ModelStreamEvent[] {
  return [
    { type: "start" },
    ...calls.map((c) => ({ type: "tool_call" as const, toolCall: { id: c.id, name: c.name, input: c.input } })),
    { type: "finish", finishReason: "tool_calls" as const, usage: {} },
  ];
}

function childConfig(steps: ModelStreamEvent[][]): AgentLoopConfig {
  const media: MediaCapabilityPort = { imageInputEnabled: () => true };
  return {
    modelPort: new ScriptedModelPort(steps),
    registry: createDefaultToolRegistry(),
    hooks: new InMemoryHookRunner(),
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
    permissionBroker: new IpcPermissionBroker(() => {}),
    mode: "build",
    ports: {
      fs: new MemFs(),
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: "/workspace",
    media,
  };
}

/**
 * Drives a REAL child session (real Session + real AgentLoop + real
 * dispatcher, two real tool calls) and returns its terminal report plus the
 * progress reports it raised.
 */
async function runRealChild(
  steps: ModelStreamEvent[][],
): Promise<{ report: ChildTerminalReport; progress: ChildProgressReport[] }> {
  const config = childConfig(steps);
  const loop = new AgentLoop(config);
  const engine = new CoreEngine({ loop, config });
  const channel = new MessageChannel();
  const uiPort = channel.port1;
  const hostPort = channel.port2;
  uiPort.on("message", () => {});
  uiPort.start();

  const progress: ChildProgressReport[] = [];
  let report: ChildTerminalReport | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const broker = new IpcPermissionBroker(() => {});
  const history: HistoryItem[] = [];
  const session = new Session({
    outbound: new Outbound(),
    engine,
    broker,
    fs: new MemFs(),
    workspace: "/workspace",
    projectRoot: "/workspace",
    model: "scripted-model",
    sessionId: "child-settlement",
    bootHistory: history,
    rules: new SessionPermissionRules(),
    child: {
      onReady: () => markReady(),
      flushHistory: async () => {},
      onTerminal: (terminal) => {
        report = terminal;
      },
      onProgress: (entry) => {
        progress.push(entry);
      },
      // A frozen clock keeps both tool_result boundaries inside the REAL
      // leading-edge 1000 ms throttle window: the first crosses, the second
      // is withheld — the stale-progress shape this regression came from.
      now: () => 0,
    },
  });
  session.bindPort(nodeWirePort(hostPort));
  uiPort.postMessage({ type: "ui_ready" });
  await ready;
  expect(session.startProgrammaticTurn("run two reads")).toEqual({ ok: true });
  await vi.waitFor(() => expect(report).toBeDefined(), { timeout: 10_000, interval: 10 });

  uiPort.close();
  hostPort.close();
  return { report: report!, progress };
}

/** The `ChildRunEvent`-shaped progress/terminal messages main relays to the parent host. */
function relay(childSessionId: string, requestId: string, terminal: ChildTerminalReport, progress: ChildProgressReport[]): ChildRunEvent[] {
  const events: unknown[] = [
    { type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId, childTabId: "child-tab-1", model: "scripted-model" },
    ...progress
      .filter((entry) => entry.kind === "progress")
      .map((entry) => ({
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "progress",
        turns: entry.turns,
        toolCalls: entry.toolCalls,
        ...(entry.lastTool !== undefined ? { lastTool: entry.lastTool } : {}),
      })),
    {
      type: CHILD_RUN_EVENT_TYPE,
      requestId,
      kind: "terminal",
      status: terminal.status,
      finalText: terminal.finalText,
      truncated: terminal.truncated,
      turns: terminal.turns,
      toolCalls: terminal.toolCalls,
      durationMs: terminal.durationMs,
      childSessionId,
      ...(terminal.activitySuppressed !== undefined ? { activitySuppressed: terminal.activitySuppressed } : {}),
      ...(terminal.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: terminal.finalTurnFinishReason } : {}),
      ...(terminal.model !== undefined ? { model: terminal.model } : {}),
      ...(terminal.responseModel !== undefined ? { responseModel: terminal.responseModel } : {}),
      ...(terminal.declaredDoneAtCeiling === true ? { declaredDoneAtCeiling: true } : {}),
      ...(terminal.ceiling !== undefined ? { ceiling: terminal.ceiling } : {}),
      ...(terminal.errorDescriptor !== undefined ? { errorDescriptor: terminal.errorDescriptor } : {}),
    },
  ];
  // The production fail-closed parser is the gate: a message main could not
  // decode never reaches the port, so this test cannot smuggle one either.
  return events.map((raw) => {
    const parsed = parseChildRunEvent(raw);
    expect(parsed, JSON.stringify(raw)).not.toBeNull();
    return parsed!;
  });
}

function parentConfig(port: SessionSubagentPort): AgentLoopConfig {
  const media: MediaCapabilityPort = { imageInputEnabled: () => true };
  return {
    modelPort: new ScriptedModelPort([
      toolStep("spawn-settlement-1", "Agent", { description: "run two reads", prompt: "run two reads", tier: "session", detach: false }),
      finishStep(),
    ]),
    registry: createDefaultToolRegistry({ agent: { sessionTier: true } }),
    hooks: new InMemoryHookRunner(),
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
    permissionBroker: new IpcPermissionBroker(() => {}),
    mode: "build",
    ports: {
      fs: new MemFs(),
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: "/workspace",
    media,
    sessionSubagents: port,
  };
}

describe("a settled child card carries the child's exact tool-call count through the real chain", () => {
  it("two real child tool calls inside one throttled progress window settle the card on two, not on the last relayed progress frame's one", async () => {
    const { report, progress } = await runRealChild([
      multiToolStep([
        { id: "read-1", name: "TodoRead", input: {} },
        { id: "read-2", name: "TodoRead", input: {} },
      ]),
      finishStep(),
    ]);

    // The child's own terminal is authoritative and exact.
    expect(report.toolCalls).toBe(2);
    // The real throttle withheld every later boundary (the window never
    // advances): the last progress report main could relay is short of the
    // terminal's count. That stale number is what the card used to keep.
    const progressCounts = progress.filter((entry) => entry.kind === "progress").map((entry) => entry.toolCalls);
    expect(progressCounts.at(-1)).toBeDefined();
    expect(progressCounts.at(-1)).toBeLessThan(report.toolCalls);

    // ── parent host: real port, real AgentLoop session-tier Agent tool ──
    const listeners = new Set<(event: ChildRunEvent) => void>();
    let requestId = "";
    const port = createChildSessionPort({
      parentSessionId: "parent-settlement",
      getPermissionMode: () => "build",
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      send: (message) => {
        if (message.type !== CHILD_SPAWN_REQUEST_TYPE) {
          return;
        }
        requestId = message.requestId;
        // Main's relay: the accepted ack, every progress frame, then the
        // terminal — all through the production parser (see `relay`).
        for (const event of relay("child-settlement", message.requestId, report, progress)) {
          for (const listener of listeners) listener(event);
        }
      },
    });

    const parent = new AgentLoop(parentConfig(port));
    const events: AgentEvent[] = [];
    for await (const event of parent.runTurn("delegate")) {
      events.push(event);
    }
    expect(requestId).not.toBe("");

    const progressEvents = events.filter((event) => event.type === "subagent_progress");
    expect(progressEvents.at(-1)).toMatchObject({ toolCallId: "spawn-settlement-1", toolCalls: progressCounts.at(-1) });
    const end = events.find((event) => event.type === "subagent_end");
    expect(end).toMatchObject({ type: "subagent_end", toolCallId: "spawn-settlement-1", status: "completed", toolCalls: 2 });

    // ── renderer: the real store settles the card from those events ──
    const store = createDesktopStore({ schedule: (callback) => callback() });
    const turnId = "turn-settlement";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/workspace", mode: "build", model: "scripted-model", sessionId: "parent-settlement" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "turn-request-1", turnId });
    const findCard = () => store.getState().transcript.find((block) => block.kind === "tool_call" && block.toolCallId === "spawn-settlement-1");
    let settledAtEnd: ReturnType<typeof findCard> = undefined;
    for (const event of events) {
      // The host's own wire boundary (the exact call Session makes).
      store.getState().applyHostMessage({ type: "agent_event", turnId, event: sanitizeAgentEvent(event) });
      if (event.type === "subagent_end") {
        // The card settles HERE on the real wire: the Agent tool's
        // tool_result (which also carries the S1 snapshot) arrives later, so
        // a settle that dropped the terminal count would show the stale
        // progress number for that whole window.
        settledAtEnd = findCard();
      }
    }
    expect(settledAtEnd).toMatchObject({ subagent: { toolCalls: 2, final: { status: "completed" } } });

    const card = findCard();
    expect(card).toMatchObject({
      kind: "tool_call",
      subagent: { toolCalls: 2, final: { status: "completed" } },
    });
  }, 20_000);
});

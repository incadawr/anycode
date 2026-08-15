/**
 * child-session-wire (TASK.102 CUT-S2 §3 slice S2b B5): the "полупровод"
 * contract test for the parent-host <-> main half of the session-tier `Agent`
 * wire. `host/index.ts` itself is NOT importable here — it touches
 * `process.parentPort` at module scope (the established host-test idiom, see
 * `index.test.ts`'s own header comment and `checkpoints-wire.test.ts`'s).
 * This file instead:
 *
 *  - builds a `fakeParentPort()` double with two ends, reproducing the SHAPE
 *    of index.ts's own dispatch table (its `childRunEventListeners` Set +
 *    `subscribeChildRunEvents`/`sendChildSessionMessage` functions, and the
 *    `parseChildRunEvent`-gated branch inside `process.parentPort.on
 *    ("message", ...)`) against a real in-memory channel instead of the real
 *    Electron transport;
 *  - wires that fake channel to the REAL `createChildSessionPort` RPC client
 *    (`./child-session-port.js`, unmodified, already unit-tested on its own
 *    in `child-session-port.test.ts`);
 *  - drives a REAL `AgentLoop` (real dispatcher, real `tools/agent.ts`
 *    session-tier branch, real `createDefaultToolRegistry`) against a
 *    scripted `ScriptedModelPort` step proposing `Agent(tier:"session")`;
 *  - answers as a scripted "main" using the REAL fail-closed parsers
 *    (`parseChildSpawnRequest`/`parseChildRunCancel`) so the script only ever
 *    reacts to a message main would actually be able to decode.
 *
 * Everything downstream of the fake channel is production code, unmodified.
 *
 * Registry/config construction (`buildConfig` below) touches the two
 * host/index.ts wiring points this slice added — non-recursion locks #1
 * and #2 — under the trek's zеркало law (TASK.102 CUT-S2 §10.9.3 A3, first
 * applied right here): a mirror may reproduce TRANSPORT shape, but a
 * DECISION belongs to production code, imported, never re-typed as a copy:
 *   - lock #1 (the registry ternary) stays a BY-DESIGN mirror of a single
 *     field check on the imported `HostArgs` type (`args.child ===
 *     undefined`, index.ts's own "non-recursion lock #1" comment) — CUT-S2
 *     §10.9.2 p.4 keeps lock #1 argv-only on purpose, so there is no
 *     production predicate to import here; a reviewer diffing this ternary
 *     against index.ts's can still verify the shapes agree (the same
 *     discipline `index.test.ts`'s `handleShutdownShape` helper
 *     established for this codebase);
 *   - lock #2 (the `config.sessionSubagents` mutate-in-place block) is NO
 *     LONGER a hand-copied ternary: `buildConfig` calls the REAL, imported
 *     `isChildSessionBoot` (`./boot.js`) over fixture `args`/`meta`, byte-
 *     identical to index.ts's own `!isChildSessionBoot(args, sessionMeta)`
 *     condition — a divergent-args/meta case below (root argv + child meta)
 *     is provable ONLY because this is a real import, not a copy: the old
 *     single-boolean `sessionTier` flag had no "meta" input to diverge from
 *     "args" at all.
 */
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  AgentLoop,
  DenyPermissionBroker,
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
  SessionMeta,
  SessionSubagentOutcome,
  SessionSubagentPort,
} from "@anycode/core";
import {
  CHILD_RUN_EVENT_TYPE,
  parseChildRunCancel,
  parseChildSpawnRequest,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";
import { isChildSessionBoot, type HostArgs } from "./boot.js";
import { createChildSessionPort } from "./child-session-port.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { MemFs, ScriptedModelPort, finishStep, nodeWirePort, toolStep } from "./test-harness.js";

type Of<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;
const isToolResult = (id: string) => (e: AgentEvent): e is Of<"tool_result"> =>
  e.type === "tool_result" && e.outcome.toolCallId === id;

// ── fake parentPort (two ends), mirroring index.ts's dispatch-table shape ──

interface FakeParentPort {
  /** host-side DI for createChildSessionPort (mirrors index.ts's sendChildSessionMessage). */
  hostSend(message: ChildSpawnRequest | ChildRunCancel): void;
  /** host-side DI for createChildSessionPort (mirrors index.ts's subscribeChildRunEvents). */
  hostSubscribe(listener: (event: ChildRunEvent) => void): () => void;
  /** main-side: registers the scripted responder over whatever the host sent. */
  onFromHost(listener: (message: unknown) => void): void;
  /** main-side: delivers a ChildRunEvent back to the host (mirrors index.ts's parseChildRunEvent branch). */
  sendToHost(event: ChildRunEvent): void;
}

function fakeParentPort(): FakeParentPort {
  const hostListeners = new Set<(event: ChildRunEvent) => void>();
  const mainListeners = new Set<(message: unknown) => void>();
  return {
    hostSend: (message) => {
      for (const listener of mainListeners) listener(message);
    },
    hostSubscribe: (listener) => {
      hostListeners.add(listener);
      return () => {
        hostListeners.delete(listener);
      };
    },
    onFromHost: (listener) => {
      mainListeners.add(listener);
    },
    sendToHost: (event) => {
      for (const listener of hostListeners) listener(event);
    },
  };
}

/** Scripted "main": decodes inbound messages with the REAL fail-closed parsers, records everything. */
function wireScriptedMain(channel: FakeParentPort, onSpawn: (spawn: ChildSpawnRequest) => void) {
  const spawns: ChildSpawnRequest[] = [];
  const cancels: ChildRunCancel[] = [];
  channel.onFromHost((raw) => {
    const spawn = parseChildSpawnRequest(raw);
    if (spawn) {
      spawns.push(spawn);
      onSpawn(spawn);
      return;
    }
    const cancel = parseChildRunCancel(raw);
    if (cancel) {
      cancels.push(cancel);
    }
  });
  return { spawns, cancels };
}

// ── fixture args/meta, feeding buildConfig's two locks (CUT-S2 §10.9.2) ──

/** Non-child boot argv: `args.child` absent. */
const ROOT_ARGS: HostArgs = { resume: false };
/** Child-mode boot argv: the full `--child-*` triple present. */
const CHILD_ARGS: HostArgs = {
  resume: false,
  child: { parentSessionId: "argv-parent", spawnToolCallId: "argv-call", initialMode: "build" },
};

/** A root session's persisted meta: no `parentSessionId`. */
function rootMeta(id = "root-session"): SessionMeta {
  return { id, workspace: "/workspace", model: "m", mode: "build", createdAt: 0, updatedAt: 0 };
}
/** A child session's persisted meta: `parentSessionId` set (durable authority). */
function childMeta(id = "child-session", parentSessionId = "meta-parent"): SessionMeta {
  return { ...rootMeta(id), parentSessionId };
}

// ── minimal AgentLoopConfig, byte-shape-mirroring host boot's own minimal set ──

function buildConfig(opts: {
  /** Boot argv — feeds lock #1 (registry ternary, argv-only mirror, CUT-S2 §10.9.2 p.4) directly. */
  args: HostArgs;
  /** This session's persisted meta — together with `args`, feeds lock #2 via the REAL `isChildSessionBoot`. */
  meta: SessionMeta;
  sessionSubagentsPort?: SessionSubagentPort;
  steps: ModelStreamEvent[][];
}): AgentLoopConfig {
  const registry =
    opts.args.child === undefined
      ? createDefaultToolRegistry({ agent: { sessionTier: true } })
      : createDefaultToolRegistry();
  const media: MediaCapabilityPort = { imageInputEnabled: () => true };
  // Lock #2: byte-identical to index.ts's `!isChildSessionBoot(args, sessionMeta)`
  // gate on `config.sessionSubagents` — imported, not re-typed.
  const sessionSubagents =
    !isChildSessionBoot(opts.args, opts.meta) && opts.sessionSubagentsPort !== undefined
      ? opts.sessionSubagentsPort
      : undefined;
  return {
    modelPort: new ScriptedModelPort(opts.steps),
    registry,
    hooks: new InMemoryHookRunner(),
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
    permissionBroker: new DenyPermissionBroker(),
    mode: "build",
    ports: {
      fs: new MemFs(),
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: "/workspace",
    media,
    ...(sessionSubagents !== undefined ? { sessionSubagents } : {}),
  };
}

function terminalEvent(
  requestId: string,
  overrides: Partial<Extract<ChildRunEvent, { kind: "terminal" }>> = {},
): ChildRunEvent {
  return {
    type: CHILD_RUN_EVENT_TYPE,
    requestId,
    kind: "terminal",
    status: "completed",
    finalText: "",
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    childSessionId: "child-default",
    ...overrides,
  };
}

describe("session-tier Agent call over a fake parentPort (TASK.102 CUT-S2 §3 slice S2b B5)", () => {
  it("real dispatcher + real RPC client round-trip a full lifecycle through a scripted main: tool_result carries the final text and an S1 snapshot with a session target carrying all three ids", async () => {
    const channel = fakeParentPort();
    const port = createChildSessionPort({
      parentSessionId: "parent-1",
      getPermissionMode: () => "build",
      send: channel.hostSend,
      subscribe: channel.hostSubscribe,
    });
    const main = wireScriptedMain(channel, (spawn) => {
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "accepted",
        childSessionId: "child-1",
        childTabId: "tab-1",
        model: "claude-x",
      });
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "activity",
        toolName: "Read",
        summary: "read foo.ts",
      });
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "progress",
        turns: 1,
        toolCalls: 1,
      });
      channel.sendToHost(
        terminalEvent(spawn.requestId, {
          finalText: "the child finished",
          turns: 2,
          toolCalls: 1,
          durationMs: 500,
          childSessionId: "child-1",
        }),
      );
    });

    const config = buildConfig({
      args: ROOT_ARGS,
      meta: rootMeta(),
      sessionSubagentsPort: port,
      steps: [toolStep("call-1", "Agent", { description: "delegate build", prompt: "build X", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("please delegate")) {
      events.push(event);
    }

    expect(main.spawns).toHaveLength(1);
    // core's own fact (CUT-S2 §10.5), not a client-minted uuid: the request's
    // spawnToolCallId IS this Agent tool_call's id.
    expect(main.spawns[0]!.spawnToolCallId).toBe("call-1");

    const toolResult = events.find(isToolResult("call-1"));
    expect(toolResult).toBeDefined();
    expect(toolResult!.outcome.status).toBe("success");
    expect(toolResult!.outcome.result?.ok).toBe(true);
    expect((toolResult!.outcome.result?.output as { finalText: string }).finalText).toBe("the child finished");

    const snapshot = toolResult!.outcome.result?.presentation?.subagent;
    expect(snapshot?.target).toEqual({
      kind: "session",
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      spawnToolCallId: "call-1",
    });

    // §10.7 п.6e (partial — the full activitySuppressed variant is its own test below):
    // activity/progress reach the PARENT's own AgentEvent wire, not just the RPC client.
    expect(events.some((e) => e.type === "subagent_activity" && e.toolName === "Read")).toBe(true);
    expect(events.some((e) => e.type === "subagent_progress" && e.turns === 1)).toBe(true);
  });

  it("§10.7 п.6e: activity + progress + a terminal carrying activitySuppressed all reach the parent AgentEvent wire, and the S1 snapshot's activity ленту carries the entries plus a dropped count that includes the suppressed count", async () => {
    const channel = fakeParentPort();
    const port = createChildSessionPort({
      parentSessionId: "parent-2",
      getPermissionMode: () => "build",
      send: channel.hostSend,
      subscribe: channel.hostSubscribe,
    });
    wireScriptedMain(channel, (spawn) => {
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "accepted",
        childSessionId: "child-3",
        childTabId: "tab-3",
        model: "m",
      });
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "activity",
        toolName: "Bash",
        summary: "ran tests",
      });
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "progress",
        turns: 3,
        toolCalls: 5,
      });
      channel.sendToHost(
        terminalEvent(spawn.requestId, {
          finalText: "done, some activity was suppressed",
          turns: 3,
          toolCalls: 5,
          durationMs: 999,
          childSessionId: "child-3",
          activitySuppressed: 7,
        }),
      );
    });

    const config = buildConfig({
      args: ROOT_ARGS,
      meta: rootMeta(),
      sessionSubagentsPort: port,
      steps: [toolStep("call-2", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("delegate")) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "subagent_activity" && e.toolName === "Bash")).toBe(true);
    expect(events.some((e) => e.type === "subagent_progress" && e.turns === 3 && e.toolCalls === 5)).toBe(true);
    expect(events.some((e) => e.type === "subagent_end" && e.activitySuppressed === 7)).toBe(true);

    const toolResult = events.find(isToolResult("call-2"))!;
    const snapshot = toolResult.outcome.result?.presentation?.subagent;
    expect(snapshot?.activity.entries).toEqual([{ toolName: "Bash", summary: "ran tests" }]);
    // dropped = ring/byte-cap evictions (0 here — one entry, nowhere near the
    // cap) + the terminal's own activitySuppressed (card-snapshot.ts).
    expect(snapshot?.activity.dropped).toBe(7);
  });

  it("aborting the master's turn sends exactly ONE ChildRunCancel over the fake parentPort; the run stays pending (sync-join, cut §0.5) until the scripted main answers with a cancelled terminal", async () => {
    const channel = fakeParentPort();
    const port = createChildSessionPort({
      parentSessionId: "parent-3",
      getPermissionMode: () => "build",
      send: channel.hostSend,
      subscribe: channel.hostSubscribe,
    });
    let requestId: string | undefined;
    const main = wireScriptedMain(channel, (spawn) => {
      requestId = spawn.requestId;
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "accepted",
        childSessionId: "child-4",
        childTabId: "tab-4",
        model: "m",
      });
    });

    const config = buildConfig({
      args: ROOT_ARGS,
      meta: rootMeta(),
      sessionSubagentsPort: port,
      steps: [toolStep("call-3", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);
    const controller = new AbortController();
    const events: AgentEvent[] = [];

    const iterator = loop.runTurn("delegate", { signal: controller.signal })[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      if (next.value.type === "subagent_start") {
        break;
      }
      next = await iterator.next();
    }
    expect(requestId).toBeDefined();

    controller.abort();
    // AbortController listeners run synchronously in Node, but a microtask
    // hop is cheap insurance against any future indirection in the chain.
    await Promise.resolve();

    expect(main.cancels).toHaveLength(1);
    expect(main.cancels[0]!.requestId).toBe(requestId);

    let settledBeforeTerminal = false;
    const resultPromise = (async () => {
      let n = next;
      while (!n.done) {
        events.push(n.value);
        n = await iterator.next();
      }
      settledBeforeTerminal = true;
    })();
    // Yield a couple of microtasks: the tool call's own promise (blocked
    // inside createChildSessionPort's sync-join) must NOT have resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(settledBeforeTerminal).toBe(false);

    channel.sendToHost(
      terminalEvent(requestId!, { status: "cancelled", turns: 1, durationMs: 10, childSessionId: "child-4" }),
    );
    await resultPromise;

    const toolResult = events.find(isToolResult("call-3"))!;
    expect(toolResult.outcome.status).toBe("cancelled");
    expect(main.cancels).toHaveLength(1);
  });
});

describe("non-recursion locks #1/#2 (CUT-S2 §2.6.1/§2.6.2) — discriminating ONLY from slice B5 onward", () => {
  function fakeSessionPort(): { port: SessionSubagentPort; run: ReturnType<typeof vi.fn> } {
    const run = vi.fn(
      async (): Promise<SessionSubagentOutcome> => ({
        status: "completed",
        finalText: "should never be reached",
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
        childSessionId: "x",
        parentSessionId: "p",
        spawnToolCallId: "s",
      }),
    );
    return { port: { run }, run };
  }

  it("lock #1 (registry): the RESTRICTED registry (mirrors index.ts's child-mode branch — createDefaultToolRegistry() with no {agent:{sessionTier:true}}) makes tier:\"session\" schema-invalid BEFORE the handler ever runs — even with a working sessionSubagents port wired, the port is never called", async () => {
    const { port, run } = fakeSessionPort();
    const config = buildConfig({
      args: CHILD_ARGS,
      meta: childMeta(),
      sessionSubagentsPort: port,
      steps: [toolStep("call-r", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("go")) {
      events.push(event);
    }

    const toolResult = events.find(isToolResult("call-r"))!;
    expect(toolResult.outcome.status).toBe("invalid_input");
    expect(run).not.toHaveBeenCalled();
  });

  it("lock #2 (wiring): the FULL (root argv/meta) registry with sessionSubagents ABSENT (mirrors an accidentally-unwired root host) reaches the real handler, which fails closed with its own \"unavailable in this host\" message — proves lock #2 holds independently of lock #1", async () => {
    const config = buildConfig({
      args: ROOT_ARGS,
      meta: rootMeta(),
      steps: [toolStep("call-w", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("go")) {
      events.push(event);
    }

    const toolResult = events.find(isToolResult("call-w"))!;
    expect(toolResult.outcome.status).toBe("error");
    expect(toolResult.outcome.result?.error).toBe("Agent: session-tier subagents are unavailable in this host.");
  });

  it("CUT-S2 §10.9.2 divergent-boot: argv says root (lock #1 opens the FULL schema) but the durable meta says child (`parentSessionId` set) — the real imported `isChildSessionBoot` withholds sessionSubagents anyway, even with a WORKING port available to wire; the handler fails closed with the exact \"unavailable in this host\" string and the port is never called. Unexpressible by the old single-boolean `sessionTier` mirror, which had no `meta` input to diverge from `args` at all.", async () => {
    const { port, run } = fakeSessionPort();
    const config = buildConfig({
      args: ROOT_ARGS,
      meta: childMeta("session-x", "meta-parent-x"),
      sessionSubagentsPort: port,
      steps: [toolStep("call-div", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("go")) {
      events.push(event);
    }

    const toolResult = events.find(isToolResult("call-div"))!;
    expect(toolResult.outcome.status).toBe("error");
    expect(toolResult.outcome.result?.error).toBe("Agent: session-tier subagents are unavailable in this host.");
    expect(run).not.toHaveBeenCalled();
  });

  it("both locks open together (mirrors a real non-child root boot): tier:\"session\" reaches a wired port and succeeds — the positive control for the two negative locks above", async () => {
    const channel = fakeParentPort();
    const port = createChildSessionPort({
      parentSessionId: "parent-4",
      getPermissionMode: () => "build",
      send: channel.hostSend,
      subscribe: channel.hostSubscribe,
    });
    wireScriptedMain(channel, (spawn) => {
      channel.sendToHost({
        type: CHILD_RUN_EVENT_TYPE,
        requestId: spawn.requestId,
        kind: "accepted",
        childSessionId: "child-5",
        childTabId: "tab-5",
        model: "m",
      });
      channel.sendToHost(terminalEvent(spawn.requestId, { finalText: "ok", childSessionId: "child-5" }));
    });
    const config = buildConfig({
      args: ROOT_ARGS,
      meta: rootMeta(),
      sessionSubagentsPort: port,
      steps: [toolStep("call-both", "Agent", { description: "d", prompt: "p", tier: "session" }), finishStep()],
    });
    const loop = new AgentLoop(config);

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("go")) {
      events.push(event);
    }

    const toolResult = events.find(isToolResult("call-both"))!;
    expect(toolResult.outcome.status).toBe("success");
  });
});

describe("one handshake, one session_history (CUT-S1 §9.2 / CUT-S2 §10.4, B5's share of the invariant)", () => {
  it("a single ui_ready on a freshly bound child-mode Session port yields exactly ONE session_history message", async () => {
    const config = buildConfig({ args: CHILD_ARGS, meta: childMeta(), steps: [] });
    const loop = new AgentLoop(config);
    const engine = new CoreEngine({ loop, config });

    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message));
    const bootHistory: HistoryItem[] = [
      { id: "h1", createdAt: Date.now(), message: { role: "user", content: "hello from before the crash" } },
    ];

    let readyCalls = 0;
    let terminalCalls = 0;
    const session = new Session({
      outbound,
      engine,
      broker,
      fs: new MemFs(),
      workspace: "/workspace",
      model: "scripted-model",
      sessionId: "child-session-1",
      bootHistory,
      rules: new SessionPermissionRules(),
      child: {
        onReady: () => {
          readyCalls += 1;
        },
        flushHistory: async () => {},
        onTerminal: () => {
          terminalCalls += 1;
        },
        onProgress: () => {},
      },
    });

    const channel = new MessageChannel();
    const uiPort = channel.port1;
    const hostPort = channel.port2;
    const received: { type: string }[] = [];
    const sawSessionHistory = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for session_history")), 1_000);
      uiPort.on("message", (value: unknown) => {
        const message = value as { type: string };
        received.push(message);
        if (message.type === "session_history") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    uiPort.start();

    session.bindPort(nodeWirePort(hostPort));
    uiPort.postMessage({ type: "ui_ready" });
    await sawSessionHistory;
    // A second macrotask hop: proves the FIRST session_history wasn't merely
    // the first of two back-to-back emissions racing this assertion.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const historyMessages = received.filter((m) => m.type === "session_history");
    expect(historyMessages).toHaveLength(1);
    // child-ready fires on the SAME first handshake, exactly once — the
    // sibling half of the "one handshake" invariant for the child branch.
    expect(readyCalls).toBe(1);
    expect(terminalCalls).toBe(0);

    uiPort.close();
    hostPort.close();
  });
});

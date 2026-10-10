/**
 * ToolScheduler tests (design §2.7). Planning: proposal order is preserved;
 * destructive/non-concurrentSafe/unknown tools run solo; adjacent parallel-safe
 * calls merge up to the concurrency cap. Execution: events surface in completion
 * order while the returned outcomes stay in proposal order, with exactly one
 * outcome per call — including cancellation, where in-flight calls are cancelled
 * and queued calls flow through the dispatcher's instant cancel.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { planToolBatches, runToolBatches, type ToolBatchEvent } from "./scheduler.js";
import type { DispatchContext } from "./dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  AnyToolDefinition,
  ToolCallOutcome,
  ToolContext,
  ToolEmittedEvent,
  ToolMetadata,
  ToolResult,
} from "../types/tools.js";
import type { ProposedToolCall } from "../types/events.js";
import type { HookRunner } from "../types/hooks.js";
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionEngine,
  PermissionRuling,
} from "../types/permissions.js";
import type { CorePorts } from "../ports/index.js";
import { DEFAULT_TOOL_CONCURRENCY } from "../types/config.js";
import type { WorkspaceTransition } from "../ports/worktrees.js";

// ---------------------------------------------------------------------------
// Mock builders

const baseMetadata: ToolMetadata = {
  name: "tool",
  description: "mock",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 30_000,
};

interface ToolKind {
  destructive?: boolean;
  concurrentSafe?: boolean;
  handler?: AnyToolDefinition["handler"];
}

function makeTool(name: string, kind: ToolKind = {}): AnyToolDefinition {
  return {
    metadata: {
      ...baseMetadata,
      name,
      destructive: kind.destructive ?? false,
      concurrentSafe: kind.concurrentSafe ?? true,
    },
    inputSchema: z.any(),
    handler: kind.handler ?? (async () => ({ ok: true, output: { name } })),
  };
}

function makeRegistry(tools: AnyToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool, { silentDuplicateWarning: true });
  }
  return registry;
}

const allowEngine: PermissionEngine = { check: () => ({ decision: "allow" }) };

function makeEngine(ruling: PermissionRuling): PermissionEngine {
  return { check: () => ruling };
}

const allowHooks = {
  register: () => {},
  runPreToolUse: async () => ({}),
  runUserPromptSubmit: async () => ({}),
  runObservers: async () => {},
} as unknown as HookRunner;

const allowBroker: PermissionBroker = {
  requestPermission: async () => ({ behavior: "allow" }),
};

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    registry: makeRegistry([]),
    hooks: allowHooks,
    permissionEngine: allowEngine,
    permissionBroker: allowBroker,
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
    ...overrides,
  };
}

function call(name: string, id = name): ProposedToolCall {
  return { id, name, input: {} };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hangUntilAbort(): AnyToolDefinition["handler"] {
  return (_input: unknown, ctx: ToolContext) =>
    new Promise<ToolResult>((_, reject) => {
      if (ctx.abortSignal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
}

interface GatedToolHandler {
  handler: AnyToolDefinition["handler"];
  /** Handlers currently running. */
  active: () => number;
  /** Highest number of handlers running at once (the observed admission width). */
  maxActive: () => number;
  /** Releases every parked handler AND unblocks future ones — cleanup-safe. */
  drain: () => void;
}

/**
 * A tool handler that parks on its own gate, tracking how many run at once.
 * `drain()` flips the pool into an auto-release mode so a test can settle the
 * whole run from a `finally` without polling. This makes an execution test
 * observe REAL admission (not just the plan the scheduler happens to flatten).
 */
function makeGatedHandler(): GatedToolHandler {
  let active = 0;
  let maxActive = 0;
  let draining = false;
  const gates: Array<() => void> = [];
  const handler: AnyToolDefinition["handler"] = () => {
    active += 1;
    if (active > maxActive) {
      maxActive = active;
    }
    if (draining) {
      active -= 1;
      return Promise.resolve<ToolResult>({ ok: true, output: "gated" });
    }
    return new Promise<ToolResult>((resolve) => {
      gates.push(() => {
        active -= 1;
        resolve({ ok: true, output: "gated" });
      });
    });
  };
  return {
    handler,
    active: () => active,
    maxActive: () => maxActive,
    drain: () => {
      draining = true;
      const pending = gates.splice(0);
      for (const release of pending) {
        release();
      }
    },
  };
}

async function collect(
  gen: AsyncGenerator<ToolBatchEvent, ToolCallOutcome[], unknown>,
): Promise<{ events: ToolBatchEvent[]; outcomes: ToolCallOutcome[] }> {
  const events: ToolBatchEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      return { events, outcomes: step.value };
    }
    events.push(step.value);
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// planToolBatches

describe("planToolBatches", () => {
  const config = { maxConcurrency: DEFAULT_TOOL_CONCURRENCY };

  it("merges adjacent parallel-safe (concurrentSafe) calls into one batch", () => {
    const registry = makeRegistry([makeTool("Read"), makeTool("Grep"), makeTool("Glob")]);
    const batches = planToolBatches(
      [call("Read"), call("Grep"), call("Glob")],
      registry,
      config,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((c) => c.name)).toEqual(["Read", "Grep", "Glob"]);
  });

  it("puts a destructive tool in a solo batch, splitting the surrounding reads", () => {
    const registry = makeRegistry([
      makeTool("Read"),
      makeTool("Bash", { destructive: true, concurrentSafe: false }),
      makeTool("Grep"),
    ]);
    const batches = planToolBatches(
      [call("Read"), call("Bash"), call("Grep")],
      registry,
      config,
    );
    expect(batches.map((b) => b.map((c) => c.name))).toEqual([["Read"], ["Bash"], ["Grep"]]);
  });

  it("runs a non-concurrentSafe tool solo (e.g. TodoWrite)", () => {
    const registry = makeRegistry([
      makeTool("Read"),
      makeTool("TodoWrite", { destructive: false, concurrentSafe: false }),
      makeTool("Grep"),
    ]);
    const batches = planToolBatches(
      [call("Read"), call("TodoWrite"), call("Grep")],
      registry,
      config,
    );
    expect(batches.map((b) => b.map((c) => c.name))).toEqual([["Read"], ["TodoWrite"], ["Grep"]]);
  });

  it("runs an unknown tool solo (fail-safe)", () => {
    const registry = makeRegistry([makeTool("Read")]);
    const batches = planToolBatches([call("Read"), call("Ghost"), call("Read", "Read2")], registry, config);
    expect(batches.map((b) => b.map((c) => c.name))).toEqual([["Read"], ["Ghost"], ["Read"]]);
  });

  it("caps a run of parallel-safe calls at maxConcurrency, splitting into consecutive batches", () => {
    const registry = makeRegistry([makeTool("Read")]);
    const calls = Array.from({ length: 5 }, (_, i) => call("Read", `r${i}`));
    const batches = planToolBatches(calls, registry, { maxConcurrency: 2 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    // Order across the split is still the proposal order.
    expect(batches.flat().map((c) => c.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("returns no batches for an empty proposal list", () => {
    expect(planToolBatches([], makeRegistry([]), config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runToolBatches

describe("runToolBatches", () => {
  const config = { maxConcurrency: DEFAULT_TOOL_CONCURRENCY };

  it("yields events in completion order but returns outcomes in proposal order", async () => {
    const defA = deferred<ToolResult>();
    const defB = deferred<ToolResult>();
    const registry = makeRegistry([
      makeTool("A", { handler: () => defA.promise }),
      makeTool("B", { handler: () => defB.promise }),
    ]);
    const ctx = makeCtx({ registry });

    const gen = runToolBatches(ctx, [call("A", "a"), call("B", "b")], config);

    const s1 = await gen.next(); // start a (proposal order)
    const s2 = await gen.next(); // start b
    expect(s1.value).toMatchObject({ type: "tool_execution_start", toolCallId: "a" });
    expect(s2.value).toMatchObject({ type: "tool_execution_start", toolCallId: "b" });

    // B finishes first -> its result event surfaces first (completion order).
    defB.resolve({ ok: true, output: "B" });
    const r1 = await gen.next();
    expect(r1.value).toMatchObject({ type: "tool_result" });
    expect((r1.value as { outcome: { toolCallId: string } }).outcome.toolCallId).toBe("b");

    defA.resolve({ ok: true, output: "A" });
    const r2 = await gen.next();
    expect((r2.value as { outcome: { toolCallId: string } }).outcome.toolCallId).toBe("a");

    const done = await gen.next();
    expect(done.done).toBe(true);
    // Outcomes are strictly in proposal order regardless of completion order.
    if (done.done) {
      expect(done.value.map((o) => o.toolCallId)).toEqual(["a", "b"]);
    }
  });

  it("produces exactly one outcome per call across sequential batches", async () => {
    const registry = makeRegistry([
      makeTool("Read"),
      makeTool("Bash", { destructive: true, concurrentSafe: false }),
    ]);
    const ctx = makeCtx({ registry });
    const calls = [call("Read", "r1"), call("Read", "r2"), call("Bash", "b1"), call("Read", "r3")];

    const { events, outcomes } = await collect(runToolBatches(ctx, calls, config));

    expect(outcomes.map((o) => o.toolCallId)).toEqual(["r1", "r2", "b1", "r3"]);
    expect(outcomes.every((o) => o.status === "success")).toBe(true);
    const resultEvents = events.filter((e) => e.type === "tool_result");
    expect(resultEvents).toHaveLength(calls.length);
    const startEvents = events.filter((e) => e.type === "tool_execution_start");
    expect(startEvents).toHaveLength(calls.length);
  });

  it("cancels in-flight calls and insta-cancels queued batches on abort, one outcome per call", async () => {
    const registry = makeRegistry([
      makeTool("ReadA", { handler: hangUntilAbort() }),
      makeTool("ReadB", { handler: hangUntilAbort() }),
      // A later solo batch that never starts before the abort.
      makeTool("Bash", { destructive: true, concurrentSafe: false, handler: hangUntilAbort() }),
    ]);
    const ctx = makeCtx({ registry });
    const controller = new AbortController();
    const calls = [call("ReadA", "a"), call("ReadB", "b"), call("Bash", "c")];

    const gen = runToolBatches(ctx, calls, config, controller.signal);

    // Pull the first start event so batch 1 is launched, then let both handlers
    // register before cancelling the turn.
    await gen.next();
    await tick();
    controller.abort("user stop");

    const events: ToolBatchEvent[] = [];
    let outcomes: ToolCallOutcome[] | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcomes = step.value;
        break;
      }
      events.push(step.value);
    }

    // Every call gets exactly one outcome, all cancelled (in-flight + queued).
    expect(outcomes?.map((o) => o.toolCallId)).toEqual(["a", "b", "c"]);
    expect(outcomes?.every((o) => o.status === "cancelled")).toBe(true);
    const resultEvents = events.filter((e) => e.type === "tool_result");
    // First start (a) was already consumed before the loop; the remaining
    // result events still total one per call.
    expect(resultEvents).toHaveLength(calls.length);
  });

  it("lets a parallel batch reach the broker with concurrent asks (design §2.7/§2.8)", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const broker: PermissionBroker = {
      requestPermission: async (_request, options): Promise<PermissionDecision> => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        signals.push(options?.signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { behavior: "allow" };
      },
    };
    const registry = makeRegistry([makeTool("Read"), makeTool("Grep")]);
    const controller = new AbortController();
    const ctx = makeCtx({
      registry,
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: broker,
    });

    const { outcomes } = await collect(
      runToolBatches(ctx, [call("Read", "r"), call("Grep", "g")], config, controller.signal),
    );

    expect(calls).toBe(2);
    // Both asks were in flight simultaneously — the broker must tolerate that.
    expect(maxActive).toBe(2);
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "success"]);
  });

  it("surfaces ctx.emit events from a handler in emission order, between start and result (design §3.2 seam)", async () => {
    // The "long-tool progress" seam: a handler pushes coarse ToolEmittedEvents
    // through ctx.emit; they flow through the same completion-order channel with
    // no timers, so the yield order is deterministic.
    const emitted: ToolEmittedEvent[] = [
      { type: "subagent_start", toolCallId: "s", agentType: "explore", description: "look" },
      { type: "subagent_progress", toolCallId: "s", turns: 1, toolCalls: 0 },
      { type: "subagent_progress", toolCallId: "s", turns: 1, toolCalls: 1, lastTool: "Read" },
      { type: "subagent_end", toolCallId: "s", status: "completed", turns: 2, durationMs: 5 },
    ];
    const registry = makeRegistry([
      makeTool("Spawner", {
        handler: async (_input, ctx: ToolContext) => {
          for (const event of emitted) {
            ctx.emit?.(event);
          }
          return { ok: true, output: { name: "Spawner" } };
        },
      }),
    ]);
    const ctx = makeCtx({ registry });

    const { events, outcomes } = await collect(runToolBatches(ctx, [call("Spawner", "s")], config));

    expect(events.map((e) => e.type)).toEqual([
      "tool_execution_start",
      "subagent_start",
      "subagent_progress",
      "subagent_progress",
      "subagent_end",
      "tool_result",
    ]);
    // The two progress events keep their emission order (the second carries lastTool).
    expect(events.filter((e) => e.type === "subagent_progress")).toEqual([
      { type: "subagent_progress", toolCallId: "s", turns: 1, toolCalls: 0 },
      { type: "subagent_progress", toolCallId: "s", turns: 1, toolCalls: 1, lastTool: "Read" },
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("success");
  });

  it("never throws even if a call's handler rejects", async () => {
    const registry = makeRegistry([
      makeTool("Boom", {
        handler: async () => {
          throw new Error("kaboom");
        },
      }),
    ]);
    const ctx = makeCtx({ registry });
    const { outcomes } = await collect(runToolBatches(ctx, [call("Boom", "x")], config));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("error");
  });

  it("stops after a successful terminal transition and pairs every later proposal as cancelled", async () => {
    let laterRuns = 0;
    const transition: WorkspaceTransition = {
      kind: "enter_worktree",
      projectRoot: "/work",
      fromWorkspace: "/work",
      toWorkspace: "/work/.anycode/worktrees/task-5",
      worktree: {
        id: "task-5",
        path: "/work/.anycode/worktrees/task-5",
        branch: "anycode-wt/task-5",
        baseRef: "HEAD",
        ownedByAnyCode: true,
      },
    };
    const terminal = makeTool("EnterWorktree", {
      concurrentSafe: false,
      handler: async () => ({
        ok: true,
        output: transition,
        control: { type: "workspace_transition", transition },
      }),
    });
    terminal.metadata.terminalControl = true;
    const later = makeTool("Later", {
      handler: async () => {
        laterRuns += 1;
        return { ok: true };
      },
    });
    const ctx = makeCtx({ registry: makeRegistry([terminal, later]) });

    const { events, outcomes } = await collect(
      runToolBatches(ctx, [call("EnterWorktree", "enter"), call("Later", "later")], config),
    );

    expect(laterRuns).toBe(0);
    expect(outcomes.map(({ toolCallId, status }) => ({ toolCallId, status }))).toEqual([
      { toolCallId: "enter", status: "success" },
      { toolCallId: "later", status: "cancelled" },
    ]);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(2);
    expect(events.some((event) => event.type === "tool_execution_start" && event.toolCallId === "later")).toBe(false);
  });

  it("continues with later proposals when a terminal-control handler fails", async () => {
    let laterRuns = 0;
    const terminal = makeTool("EnterWorktree", {
      concurrentSafe: false,
      handler: async () => ({ ok: false, error: "collision" }),
    });
    terminal.metadata.terminalControl = true;
    const later = makeTool("Later", {
      concurrentSafe: false,
      handler: async () => {
        laterRuns += 1;
        return { ok: true };
      },
    });
    const ctx = makeCtx({ registry: makeRegistry([terminal, later]) });

    const { outcomes } = await collect(
      runToolBatches(ctx, [call("EnterWorktree", "enter"), call("Later", "later")], config),
    );

    expect(laterRuns).toBe(1);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "success"]);
  });
});

// ---------------------------------------------------------------------------
// TASK.229: rolling bounded execution within safe runs, solo barriers, width
// normalization. A real AbortController whose removeEventListener flips
// `aborted` when the pool hands a slot over induces the handoff race.

function handoffAbortSignal(): AbortSignal {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
    originalRemove(...args);
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }) as typeof signal.removeEventListener;
  return signal;
}

describe("runToolBatches rolling admission (TASK.229)", () => {
  it("S1: cap 2 starts the next safe call as soon as one finishes, one result each", async () => {
    const gateA = deferred<ToolResult>();
    const gateB = deferred<ToolResult>();
    const gateC = deferred<ToolResult>();
    const started = new Set<string>();
    const registry = makeRegistry([
      makeTool("A", { handler: () => { started.add("A"); return gateA.promise; } }),
      makeTool("B", { handler: () => { started.add("B"); return gateB.promise; } }),
      makeTool("C", { handler: () => { started.add("C"); return gateC.promise; } }),
    ]);
    const ctx = makeCtx({ registry });
    const gen = runToolBatches(
      ctx,
      [call("A", "a"), call("B", "b"), call("C", "c")],
      { maxConcurrency: 2 },
    );

    const events: ToolBatchEvent[] = [];
    events.push((await gen.next()).value as ToolBatchEvent);
    events.push((await gen.next()).value as ToolBatchEvent);
    expect(events.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_start"]);
    expect((events[0] as { toolCallId: string }).toolCallId).toBe("a");
    expect((events[1] as { toolCallId: string }).toolCallId).toBe("b");
    await tick();
    expect(started.has("C")).toBe(false); // C has no slot

    gateA.resolve({ ok: true, output: "A" });
    let outcomes: ToolCallOutcome[] = [];
    let cStartedWhileBGated = false;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcomes = step.value;
        break;
      }
      events.push(step.value);
      if (step.value.type === "tool_execution_start" && step.value.toolCallId === "c") {
        // C was admitted while B's handler was still in flight.
        cStartedWhileBGated = true;
        gateB.resolve({ ok: true, output: "B" });
        gateC.resolve({ ok: true, output: "C" });
      }
    }

    expect(cStartedWhileBGated).toBe(true);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["a", "b", "c"]);
    expect(outcomes.every((o) => o.status === "success")).toBe(true);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(3);
  });

  it("S2: cap 1 admits in FIFO order; a queued call emits no start until admitted", async () => {
    const gateA = deferred<ToolResult>();
    const order: string[] = [];
    const registry = makeRegistry([
      makeTool("A", { handler: () => { order.push("A"); return gateA.promise; } }),
      makeTool("B", { handler: async () => { order.push("B"); return { ok: true, output: "B" }; } }),
    ]);
    const ctx = makeCtx({ registry });
    const gen = runToolBatches(ctx, [call("A", "a"), call("B", "b")], { maxConcurrency: 1 });

    const s1 = await gen.next();
    expect(s1.value).toMatchObject({ type: "tool_execution_start", toolCallId: "a" });
    await tick();
    expect(order).toEqual(["A"]); // B not handed to the dispatcher while A holds the slot

    gateA.resolve({ ok: true, output: "A" });
    const r1 = await gen.next();
    expect((r1.value as { outcome: { toolCallId: string } }).outcome.toolCallId).toBe("a");
    const s2 = await gen.next();
    expect(s2.value).toMatchObject({ type: "tool_execution_start", toolCallId: "b" });
    const r2 = await gen.next();
    expect((r2.value as { outcome: { toolCallId: string } }).outcome.toolCallId).toBe("b");
    expect((await gen.next()).done).toBe(true);
    expect(order).toEqual(["A", "B"]);
  });

  it("S3: parent abort cancels the active and the queued call, never starting the queued one", async () => {
    let bRuns = 0;
    const registry = makeRegistry([
      makeTool("A", { handler: hangUntilAbort() }),
      makeTool("B", { handler: () => { bRuns += 1; return Promise.resolve<ToolResult>({ ok: true }); } }),
    ]);
    const ctx = makeCtx({ registry });
    const controller = new AbortController();
    const gen = runToolBatches(
      ctx,
      [call("A", "a"), call("B", "b")],
      { maxConcurrency: 1 },
      controller.signal,
    );

    await gen.next(); // start a
    await tick();
    controller.abort("user stop");

    const events: ToolBatchEvent[] = [];
    let outcomes: ToolCallOutcome[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcomes = step.value;
        break;
      }
      events.push(step.value);
    }

    expect(bRuns).toBe(0);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["a", "b"]);
    expect(outcomes.every((o) => o.status === "cancelled")).toBe(true);
    expect(
      events.some((e) => e.type === "tool_execution_start" && e.toolCallId === "b"),
    ).toBe(false);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
  });

  it("S4: a pre-aborted parent dispatches nothing", async () => {
    let runs = 0;
    const registry = makeRegistry([
      makeTool("A", { handler: () => { runs += 1; return Promise.resolve<ToolResult>({ ok: true }); } }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const { events, outcomes } = await collect(
      runToolBatches(
        makeCtx({ registry }),
        [call("A", "a")],
        { maxConcurrency: DEFAULT_TOOL_CONCURRENCY },
        controller.signal,
      ),
    );
    expect(runs).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("cancelled");
    expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
  });

  it("S4: a slot handed at the handoff is cancelled before dispatch, no leak or hang", async () => {
    const gateA = deferred<ToolResult>();
    let bRuns = 0;
    let cRuns = 0;
    const registry = makeRegistry([
      makeTool("A", { handler: () => gateA.promise }),
      makeTool("B", { handler: () => { bRuns += 1; return Promise.resolve<ToolResult>({ ok: true }); } }),
      makeTool("C", { handler: () => { cRuns += 1; return Promise.resolve<ToolResult>({ ok: true }); } }),
    ]);
    const ctx = makeCtx({ registry });
    const signal = handoffAbortSignal();
    const gen = runToolBatches(
      ctx,
      [call("A", "a"), call("B", "b"), call("C", "c")],
      { maxConcurrency: 1 },
      signal,
    );

    const s1 = await gen.next();
    expect(s1.value).toMatchObject({ type: "tool_execution_start", toolCallId: "a" });
    gateA.resolve({ ok: true, output: "A" }); // hands the slot to B, which aborts at the handoff

    const events: ToolBatchEvent[] = [];
    let outcomes: ToolCallOutcome[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcomes = step.value;
        break;
      }
      events.push(step.value);
    }

    expect(bRuns).toBe(0);
    expect(cRuns).toBe(0);
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["a", "b", "c"]);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "cancelled", "cancelled"]);
    expect(
      events.some(
        (e) => e.type === "tool_execution_start" && (e.toolCallId === "b" || e.toolCallId === "c"),
      ),
    ).toBe(false);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(3);
  });

  it.each(["destructive", "non-concurrentSafe", "unknown"] as const)(
    "S5: a %s tool is an execution barrier between rolling safe calls",
    async (kind) => {
      const gateA = deferred<ToolResult>();
      const gateB = deferred<ToolResult>();
      const gateX = deferred<ToolResult>();
      const dispatched: string[] = [];
      const gatedBarrier = (): AnyToolDefinition =>
        makeTool("X", {
          destructive: kind === "destructive",
          concurrentSafe: false,
          handler: () => {
            dispatched.push("X");
            return gateX.promise;
          },
        });
      // An unknown barrier is simply not registered: the dispatcher owns its error.
      const tools: AnyToolDefinition[] = [
        makeTool("A", { handler: () => { dispatched.push("A"); return gateA.promise; } }),
        makeTool("B", { handler: () => { dispatched.push("B"); return gateB.promise; } }),
        ...(kind === "unknown" ? [] : [gatedBarrier()]),
        makeTool("C", { handler: () => { dispatched.push("C"); return Promise.resolve<ToolResult>({ ok: true, output: "C" }); } }),
        makeTool("D", { handler: () => { dispatched.push("D"); return Promise.resolve<ToolResult>({ ok: true, output: "D" }); } }),
      ];
      const registry = makeRegistry(tools);
      const calls = [call("A", "a"), call("B", "b"), call("X", "x"), call("C", "c"), call("D", "d")];

      // Planning still keeps the unknown/unsafe tool solo between safe runs.
      expect(
        planToolBatches(calls, registry, { maxConcurrency: 4 }).map((b) => b.map((c) => c.id)),
      ).toEqual([
        ["a", "b"],
        ["x"],
        ["c", "d"],
      ]);

      const events: ToolBatchEvent[] = [];
      let outcomes: ToolCallOutcome[] | null = null;
      const gen = runToolBatches(makeCtx({ registry }), calls, { maxConcurrency: 4 });
      const hasStart = (id: string): boolean =>
        events.some((e) => e.type === "tool_execution_start" && e.toolCallId === id);
      const hasResult = (id: string): boolean =>
        events.some((e) => e.type === "tool_result" && e.outcome.toolCallId === id);
      const pump = async (predicate: () => boolean): Promise<void> => {
        while (!predicate()) {
          const step = await gen.next();
          if (step.done) {
            outcomes = step.value;
            return;
          }
          events.push(step.value);
        }
      };
      try {
        await pump(() => hasStart("a") && hasStart("b"));
        expect(dispatched).toEqual(["A", "B"]); // only the safe run has been entered

        gateA.resolve({ ok: true, output: "A" }); // release A ONLY
        await pump(() => hasResult("a"));
        // B still holds its gate, so the barrier must stay unstarted.
        expect(hasStart("x")).toBe(false);

        gateB.resolve({ ok: true, output: "B" });
        await pump(() => hasStart("x"));
        gateX.resolve({ ok: true, output: "X" }); // no-op for the unknown barrier

        await pump(() => outcomes !== null);

        const outcomeOf = (id: string): ToolCallOutcome | undefined =>
          outcomes?.find((o) => o.toolCallId === id);
        // Read through a function so control-flow narrowing (which cannot see
        // the assignment made inside `pump`) does not collapse this to `null`.
        const allOutcomes = (): ToolCallOutcome[] | null => outcomes;
        // Ordering: a/b results land before the barrier start; the barrier
        // result lands before the later safe calls start.
        const indexOf = (predicate: (e: ToolBatchEvent) => boolean): number =>
          events.findIndex(predicate);
        const aResultAt = indexOf((e) => e.type === "tool_result" && e.outcome.toolCallId === "a");
        const bResultAt = indexOf((e) => e.type === "tool_result" && e.outcome.toolCallId === "b");
        const xStartAt = indexOf((e) => e.type === "tool_execution_start" && e.toolCallId === "x");
        const xResultAt = indexOf((e) => e.type === "tool_result" && e.outcome.toolCallId === "x");
        const cStartAt = indexOf((e) => e.type === "tool_execution_start" && e.toolCallId === "c");
        const dStartAt = indexOf((e) => e.type === "tool_execution_start" && e.toolCallId === "d");
        expect(aResultAt).toBeGreaterThanOrEqual(0);
        expect(bResultAt).toBeGreaterThan(aResultAt);
        expect(xStartAt).toBeGreaterThan(bResultAt);
        expect(xResultAt).toBeGreaterThan(xStartAt);
        expect(cStartAt).toBeGreaterThan(xResultAt);
        expect(dStartAt).toBeGreaterThan(cStartAt);

        expect(allOutcomes()?.map((o) => o.toolCallId)).toEqual(["a", "b", "x", "c", "d"]);
        expect(outcomeOf("a")?.status).toBe("success");
        expect(outcomeOf("b")?.status).toBe("success");
        expect(outcomeOf("c")?.status).toBe("success");
        expect(outcomeOf("d")?.status).toBe("success");
        // An unregistered barrier keeps the dispatcher's unknown-tool error.
        expect(outcomeOf("x")?.status).toBe(kind === "unknown" ? "error" : "success");
        // The known barrier's handler ran strictly between the two safe runs.
        if (kind !== "unknown") {
          expect(dispatched).toEqual(["A", "B", "X", "C", "D"]);
        }
      } finally {
        gateA.resolve({ ok: true, output: "A" });
        gateB.resolve({ ok: true, output: "B" });
        gateX.resolve({ ok: true, output: "X" });
        await pump(() => outcomes !== null);
      }
    },
  );

  it("S5: a terminal transition cancels safe calls planned after it, without start or dispatch", async () => {
    let laterRuns = 0;
    const transition: WorkspaceTransition = {
      kind: "enter_worktree",
      projectRoot: "/work",
      fromWorkspace: "/work",
      toWorkspace: "/work/.anycode/worktrees/task-9",
      worktree: {
        id: "task-9",
        path: "/work/.anycode/worktrees/task-9",
        branch: "anycode-wt/task-9",
        baseRef: "HEAD",
        ownedByAnyCode: true,
      },
    };
    const terminal = makeTool("EnterWorktree", {
      concurrentSafe: false,
      handler: async () => ({
        ok: true,
        output: transition,
        control: { type: "workspace_transition", transition },
      }),
    });
    terminal.metadata.terminalControl = true;
    const later = makeTool("Later", {
      handler: async () => { laterRuns += 1; return { ok: true }; },
    });
    const ctx = makeCtx({ registry: makeRegistry([terminal, later]) });
    const { events, outcomes } = await collect(
      runToolBatches(
        ctx,
        [call("EnterWorktree", "enter"), call("Later", "l1"), call("Later", "l2")],
        { maxConcurrency: 4 },
      ),
    );
    expect(laterRuns).toBe(0);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "cancelled", "cancelled"]);
    expect(
      events.some((e) => e.type === "tool_execution_start" && e.toolCallId.startsWith("l")),
    ).toBe(false);
  });

  it("S5: an error outcome releases the slot and admits the waiting call", async () => {
    const registry = makeRegistry([
      makeTool("A", { handler: async () => { throw new Error("boom"); } }),
      makeTool("B", { handler: async () => ({ ok: true, output: "B" }) }),
    ]);
    const { outcomes } = await collect(
      runToolBatches(
        makeCtx({ registry }),
        [call("A", "a"), call("B", "b")],
        { maxConcurrency: 1 },
      ),
    );
    expect(outcomes.map((o) => ({ id: o.toolCallId, status: o.status }))).toEqual([
      { id: "a", status: "error" },
      { id: "b", status: "success" },
    ]);
  });
});

describe("concurrency width normalization (TASK.229)", () => {
  const registry = makeRegistry([makeTool("Read")]);
  const fiveReads = Array.from({ length: 5 }, (_unused, i) => call("Read", `r${i}`));

  it("S6: planning normalizes fractional/zero/negative/nonfinite/unsafe widths", () => {
    const lens = (width: number): number[] =>
      planToolBatches(fiveReads, registry, { maxConcurrency: width }).map((b) => b.length);
    expect(lens(2.5)).toEqual([2, 2, 1]);
    expect(lens(0)).toEqual([1, 1, 1, 1, 1]);
    expect(lens(-3)).toEqual([1, 1, 1, 1, 1]);
    expect(lens(Number.NaN)).toEqual([4, 1]);
    expect(lens(Number.POSITIVE_INFINITY)).toEqual([4, 1]);
    expect(lens(1e300)).toEqual([4, 1]); // unsafe -> default
    expect(lens(10)).toEqual([5]); // width above the call count
    expect(planToolBatches([], registry, { maxConcurrency: 0 })).toEqual([]);
  });

  it.each([
    ["fractional 2.5", 2.5, 2],
    ["zero", 0, 1],
    ["negative", -2, 1],
    ["NaN", Number.NaN, DEFAULT_TOOL_CONCURRENCY],
    ["Infinity", Number.POSITIVE_INFINITY, DEFAULT_TOOL_CONCURRENCY],
    ["unsafe huge", 1e300, DEFAULT_TOOL_CONCURRENCY],
  ])(
    "S6: execution admits exactly the normalized width at %s, then drains in proposal order",
    async (_label, width, expected) => {
      const gated = makeGatedHandler();
      const gatedRegistry = makeRegistry([makeTool("Read", { handler: gated.handler })]);
      const reads = Array.from({ length: 5 }, (_unused, i) => call("Read", `r${i}`));

      // Planning and execution agree on the normalized width (see the helper).
      expect(
        planToolBatches(reads, gatedRegistry, { maxConcurrency: width })[0]?.length,
      ).toBe(expected);

      const gen = runToolBatches(makeCtx({ registry: gatedRegistry }), reads, {
        maxConcurrency: width,
      });
      try {
        const first = await gen.next();
        expect(first.value).toMatchObject({ type: "tool_execution_start" });
        // Nothing is released yet, so the observed ceiling IS the admission width.
        await vi.waitFor(() => expect(gated.active()).toBe(expected));
        expect(gated.maxActive()).toBe(expected);

        gated.drain();
        const { outcomes } = await collect(gen);
        expect(outcomes.map((o) => o.toolCallId)).toEqual(reads.map((c) => c.id));
        expect(outcomes.every((o) => o.status === "success")).toBe(true);
      } finally {
        gated.drain();
        try {
          await collect(gen);
        } catch {
          // Generator already drained — nothing left to settle.
        }
      }
    },
  );

  it("S6: a width above the call count runs every call", async () => {
    const { outcomes } = await collect(
      runToolBatches(makeCtx({ registry }), [call("Read", "r1"), call("Read", "r2")], {
        maxConcurrency: 10,
      }),
    );
    expect(outcomes.map((o) => o.toolCallId)).toEqual(["r1", "r2"]);
    expect(outcomes.every((o) => o.status === "success")).toBe(true);
  });
});

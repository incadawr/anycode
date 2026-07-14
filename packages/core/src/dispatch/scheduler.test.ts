/**
 * ToolScheduler tests (design §2.7). Planning: proposal order is preserved;
 * destructive/non-concurrentSafe/unknown tools run solo; adjacent parallel-safe
 * calls merge up to the concurrency cap. Execution: events surface in completion
 * order while the returned outcomes stay in proposal order, with exactly one
 * outcome per call — including cancellation, where in-flight calls are cancelled
 * and queued calls flow through the dispatcher's instant cancel.
 */

import { describe, expect, it } from "vitest";
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

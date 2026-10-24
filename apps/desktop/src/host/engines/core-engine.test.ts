import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop, type CorePorts, type ToolRegistry } from "@anycode/core";
import type {
  AgentEvent,
  AgentLoopConfig,
  AnyToolDefinition,
  HistoryItem,
  HookRunner,
  ModelStreamEvent,
} from "@anycode/core";
import { CoreEngine } from "./core-engine.js";
import { ScriptedModelPort } from "../test-harness.js";

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("CoreEngine", () => {
  it("delegates to the same retained loop and config objects", async () => {
    const config = { mode: "build", reasoningEffort: undefined } as AgentLoopConfig;
    const historyItems: HistoryItem[] = [{
      id: "h1",
      createdAt: 1,
      message: { role: "user", content: "hello" },
    }];
    const replacement: HistoryItem[] = [{
      id: "h2",
      createdAt: 2,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }];
    const emitted: AgentEvent[] = [{ type: "loop_end", reason: "completed", turns: 1 }];
    const runTurn = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      yield* emitted;
    });
    const replaceAll = vi.fn((items: HistoryItem[]) => {
      historyItems.splice(0, historyItems.length, ...items);
    });
    const contextBreakdown = vi.fn(() => ({
      messagesTokens: 1,
      systemToolsTokens: 2,
      mcpToolsTokens: 3,
      skillsTokens: 4,
      systemPromptTokens: 5,
      metaTokens: 6,
      totalEstimatedTokens: 21,
    }));
    // TASK.37: CoreEngine.setMode now delegates to loop.setMode (D-S3-3) rather
    // than writing config directly, so the fake must reproduce the real loop's
    // documented contract (always mutates the shared config object) for the
    // config-mutation assertion below to mean anything.
    const setMode = vi.fn((mode: AgentLoopConfig["mode"]) => {
      config.mode = mode;
    });
    const loop = {
      runTurn,
      history: { items: historyItems, replaceAll },
      contextBreakdown,
      setMode,
    } as unknown as AgentLoop;
    const switchModel = vi.fn(() => ({ model: "next", reasoningEffort: "high" as const }));
    const engine = new CoreEngine({ loop, config, switchModelImpl: switchModel });

    engine.setMode("plan");
    engine.setReasoningEffort("high");
    expect(config).toMatchObject({ mode: "plan", reasoningEffort: "high" });
    expect(engine.historyItems()).toBe(historyItems);
    expect(await collect(engine.runTurn("work", { signal: new AbortController().signal }))).toEqual(emitted);
    expect(runTurn).toHaveBeenCalledWith("work", { signal: expect.any(AbortSignal) });

    engine.replaceHistory?.(replacement);
    expect(replaceAll).toHaveBeenCalledWith(replacement);
    expect(historyItems).toEqual(replacement);
    expect(engine.contextBreakdown?.()).toEqual(contextBreakdown.mock.results[0]?.value);
    expect(engine.switchModel?.("next", "high")).toEqual({ model: "next", reasoningEffort: "high" });
    expect(switchModel).toHaveBeenCalledWith("next", "high");
  });

  it("keeps model switching absent when the existing host supplied no switcher", () => {
    const engine = new CoreEngine({
      loop: {} as AgentLoop,
      config: { mode: "build" } as AgentLoopConfig,
    });

    expect(engine.switchModel).toBeUndefined();
  });

  describe("onBeforeTurn (subagent-model: live extensions rescan before a new user turn)", () => {
    it("is awaited before the loop's runTurn is invoked", async () => {
      const order: string[] = [];
      const runTurn = vi.fn(async function* (): AsyncIterable<AgentEvent> {
        order.push("loop.runTurn");
        yield { type: "loop_end", reason: "completed", turns: 1 };
      });
      const loop = { runTurn } as unknown as AgentLoop;
      const onBeforeTurn = vi.fn(async () => {
        order.push("onBeforeTurn");
      });
      const engine = new CoreEngine({
        loop,
        config: { mode: "build" } as AgentLoopConfig,
        onBeforeTurn,
      });

      const events = await collect(engine.runTurn("work", { signal: new AbortController().signal }));

      expect(order).toEqual(["onBeforeTurn", "loop.runTurn"]);
      expect(events).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
    });

    it("is fail-soft: a throwing hook is logged and the turn proceeds unchanged", async () => {
      const emitted: AgentEvent[] = [{ type: "loop_end", reason: "completed", turns: 1 }];
      const runTurn = vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield* emitted;
      });
      const loop = { runTurn } as unknown as AgentLoop;
      const onBeforeTurn = vi.fn(async () => {
        throw new Error("rescan boom");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = new CoreEngine({
        loop,
        config: { mode: "build" } as AgentLoopConfig,
        onBeforeTurn,
      });

      const events = await collect(engine.runTurn("work", { signal: new AbortController().signal }));

      expect(events).toEqual(emitted);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rescan boom"));
      warnSpy.mockRestore();
    });

    it("absent onBeforeTurn: runTurn delegates straight to the loop (unchanged pre-existing behavior)", async () => {
      const emitted: AgentEvent[] = [{ type: "loop_end", reason: "completed", turns: 1 }];
      const runTurn = vi.fn(async function* (): AsyncIterable<AgentEvent> {
        yield* emitted;
      });
      const loop = { runTurn } as unknown as AgentLoop;
      const engine = new CoreEngine({ loop, config: { mode: "build" } as AgentLoopConfig });

      const events = await collect(engine.runTurn("work", { signal: new AbortController().signal }));

      expect(events).toEqual(emitted);
    });
  });
});

// ---------------------------------------------------------------------------
// TASK.123 (Taskana 4110): CoreEngine.steer over the loop's deferred-injection
// slot — the REAL CoreEngine over a REAL AgentLoop with the desktop harness's
// ScriptedModelPort and a parking tool (a handler gated on a deferred).

describe("CoreEngine.steer (Taskana 4110)", () => {
  /** Minimal AgentLoopConfig-shaped wiring with a parking tool at "Mock". */
  function makeEngineFixture(steps: ModelStreamEvent[][]) {
    const port = new ScriptedModelPort(steps);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parkingTool: AnyToolDefinition = {
      metadata: {
        name: "Mock",
        description: "parking tool",
        readOnly: false,
        destructive: false,
        concurrentSafe: false,
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        timeoutMs: 60_000,
      },
      inputSchema: z.object({ value: z.string() }),
      handler: async () => {
        await gate;
        return { ok: true, output: { result: "ok" } };
      },
    };
    const loop = new AgentLoop({
      modelPort: port,
      registry: { get: () => parkingTool, all: () => [parkingTool] } as unknown as ToolRegistry,
      hooks: {
        register: () => {},
        runPreToolUse: async () => ({}),
        runUserPromptSubmit: async () => ({}),
        runObservers: async () => {},
      } as unknown as HookRunner,
      permissionEngine: { check: () => ({ decision: "allow" }) },
      permissionBroker: { requestPermission: async () => ({ behavior: "deny", reason: "no client" }) },
      mode: "build",
      ports: {} as CorePorts,
      cwd: "/work",
    });
    const engine = new CoreEngine({ loop, config: { mode: "build" } as AgentLoopConfig });
    return { engine, loop, port, release: () => release() };
  }

  const steerScript: ModelStreamEvent[][] = [
    [
      { type: "start" },
      { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
      { type: "finish", finishReason: "tool_calls", usage: {} },
    ],
    [
      { type: "start" },
      { type: "text_delta", id: "t2", text: "done" },
      { type: "finish", finishReason: "stop", usage: {} },
    ],
  ];

  /** Starts a runTurn and resolves once its first tool_execution_start landed. */
  function startParkedRun(fx: { engine: CoreEngine }, signal: AbortSignal): {
    done: Promise<AgentEvent[]>;
    events: AgentEvent[];
  } {
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const event of fx.engine.runTurn("go", { signal })) {
        events.push(event);
      }
      return events;
    })();
    const parked = (async () => {
      while (!events.some((e) => e.type === "tool_execution_start")) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    return { done: Promise.race([done, parked.then(() => done)]), events };
  }

  it("steer resolves with core:step:N once the loop delivers", async () => {
    const fx = makeEngineFixture(steerScript);
    expect(fx.engine.steeringStatus()).toEqual({ supported: true, ready: false });

    const run = startParkedRun(fx, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Wait for the park (tool_execution_start observed) before steering.
    while (!run.events.some((e) => e.type === "tool_execution_start")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fx.engine.steeringStatus()).toEqual({ supported: true, ready: true });

    const steerPromise = fx.engine.steer("turn left");
    fx.release();
    await run.done;
    await expect(steerPromise).resolves.toEqual({ turnId: "core:step:1" });
    const second = fx.port.requests[1];
    expect(second?.messages.at(-1)).toEqual({ role: "user", content: "turn left" });
  });

  it("a steer that misses the turn rejects", async () => {
    const fx = makeEngineFixture(steerScript);
    const controller = new AbortController();
    const run = startParkedRun(fx, controller.signal);
    while (!run.events.some((e) => e.type === "tool_execution_start")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const steerPromise = fx.engine.steer("late");
    controller.abort();
    fx.release();
    await run.done;
    await expect(steerPromise).rejects.toThrow("core turn ended before injection");
  });

  it("FIFO: concurrent steers ALL resolve, in send order, each with its own frame (4110 rework)", async () => {
    const fx = makeEngineFixture(steerScript);
    const run = startParkedRun(fx, new AbortController().signal);
    while (!run.events.some((e) => e.type === "tool_execution_start")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const first = fx.engine.steer("first");
    const second = fx.engine.steer("second");
    fx.release();
    await run.done;
    await expect(first).resolves.toEqual({ turnId: "core:step:1" });
    await expect(second).resolves.toEqual({ turnId: "core:step:1" });
    const secondRequest = fx.port.requests[1];
    expect(secondRequest?.messages.at(-2)).toEqual({ role: "user", content: "first" });
    expect(secondRequest?.messages.at(-1)).toEqual({ role: "user", content: "second" });
  });
});

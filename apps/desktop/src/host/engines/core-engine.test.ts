import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentLoop, AgentLoopConfig, HistoryItem } from "@anycode/core";
import { CoreEngine } from "./core-engine.js";

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

import { describe, expect, it, vi } from "vitest";
import { writeTool } from "@anycode/core";
import type { AgentEvent, HistoryItem } from "@anycode/core";
import type { EngineId } from "../shared/engines.js";
import { ENGINE_SWITCH_CONTROL, type EngineSwitchControl } from "../shared/engine-switch-control.js";
import { EngineSwitchCoordinator } from "../main/engine-switch-coordinator.js";
import { createEngineSwitchClient } from "./engine-switch-client.js";
import { CORE_ENGINE_CAPABILITIES } from "./engines/session-engine.js";
import type { RunTurnOptions, SessionEngine } from "./engines/session-engine.js";
import type { SessionOptions, SwitchRuntime } from "./session.js";
import { createHarness } from "./test-harness.js";

const engines = ["core", "codex", "claude"] as const;
const pairs = engines.flatMap(source => engines.filter(target => source !== target).map(target => ({ source, target })));
class Runtime implements SessionEngine {
  readonly capabilities = { ...CORE_ENGINE_CAPABILITIES, supportsCorePermissions: false };
  readonly inputs: string[] = [];
  readonly dispose = vi.fn(async () => {});
  park?: Promise<void>;
  constructor(readonly id: EngineId) {}
  mode() { return "plan" as const; }
  reasoningEffort() { return undefined; }
  setReasoningEffort() {}
  historyItems(): readonly HistoryItem[] { return [{ id: "old-text", createdAt: 1, message: { role: "user", content: "original conversation" } }]; }
  async *runTurn(input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    yield { type: "turn_start", turn: 1 };
    await this.park;
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }
}

function transaction(source: EngineId, target: EngineId, stage?: "resolve" | "factory" | "commit" | "projection" | "children" | "cleanup", admission?: "busy" | "approval" | "child") {
  const old = new Runtime(source), next = new Runtime(target);
  const durableCommit = vi.fn(() => { if (stage === "commit") throw new Error("disk full"); });
  let factory: NonNullable<SessionOptions["switchEngineFactory"]> = async () => {
    if (stage === "factory") throw new Error("native initialization failed");
    const runtime: SwitchRuntime = { engine: next, identity: { model: "chosen", mode: "plan", ...(target !== "core" ? { externalSessionRef: "native-id" } : {}) } };
    if (stage === "projection") runtime.presentation = { imageInputEnabled: () => { throw new Error("projection failed"); } };
    if (stage === "children") runtime.backgroundChildren = { list: () => [], cancel: () => false, cancelAll: () => {}, onChange: () => { throw new Error("subscription failed"); } };
    return runtime;
  };
  let main!: EngineSwitchCoordinator;
  const controls: EngineSwitchControl[] = [];
  const client = createEngineSwitchClient(7, message => { controls.push(message); void main.handle(message); }, 1000);
  main = new EngineSwitchCoordinator({ generation: 7, current: () => true, admissible: () => true,
    prepare: async selection => { if (stage === "resolve") throw new Error("not ready"); return { launch: { target: selection, env: {} } }; },
    commit: durableCommit, abort: vi.fn(), retire: vi.fn(), send: response => { client.handle(response); },
  });
  const coordinator: NonNullable<SessionOptions["engineSwitchCoordinator"]> = { generation: 7,
    prepare: async request => {
      const selection = target === "core" ? { engine: target, model: request.model, connectionId: "connection" } : { engine: target, model: request.model };
      const result = await client.request({ phase: "prepare", requestId: request.requestId, target: selection });
      if (!result.ok) throw new Error(result.reason);
      return factory;
    },
    commit: async (requestId, identity) => { const result = await client.request({ phase: "commit", requestId, identity }); if (!result.ok) throw new Error(result.reason); },
    abort: async requestId => { await client.request({ phase: "abort", requestId }); },
    retire: async requestId => { await client.request({ phase: "retire", requestId }); },
  };
  let childLive = admission === "child";
  const h = createHarness({ steps: [], backgroundChildren: { list: () => childLive ? [{ childSessionId: "child", agentType: "executor", description: "work", startedAt: 1 }] : [], cancel: () => false, cancelAll: () => {}, onChange: () => () => { if (stage === "cleanup") throw new Error("old listener cleanup failed"); } }, engine: old, switchEngineFactory: (...args) => factory(...args), engineSwitchCoordinator: coordinator });
  return { ...h, old, next, controls, durableCommit, main, client, clearChildren() { childLive = false; }, setFactory(value: typeof factory) { factory = value; } };
}

describe("engine-switch refusal and rollback acceptance", () => {
  it.each(pairs)("$source → $target commits once and imports text for only the first turn", async ({ source, target }) => {
    const h = transaction(source, target);
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(message => message.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "switch", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(h.durableCommit).toHaveBeenCalledTimes(1);
      expect(h.old.dispose).toHaveBeenCalledTimes(1);
      expect(h.main.pending).toBe(false);
      h.send({ type: "user_message", requestId: "first", text: "first turn" });
      await h.waitUntil(() => h.next.inputs.length === 1);
      await h.waitUntil(() => h.received.some(message => message.type === "agent_event" && message.event.type === "loop_end"));
      h.send({ type: "user_message", requestId: "second", text: "second turn" });
      await h.waitUntil(() => h.next.inputs.length === 2);
      expect(h.next.inputs[0]).toContain("original conversation");
      expect(h.next.inputs[1]).toBe("second turn");
      expect(h.received.filter(message => message.type === "agent_event" && message.boundaryId === "switch")).toHaveLength(1);
    } finally { await h.session.shutdown(); h.client.close(); h.close(); }
  });

  it.each(pairs.flatMap(pair => (["resolve", "factory", "commit", "projection", "children"] as const).map(stage => ({ ...pair, stage }))))("$source → $target, $stage failure leaves the old runtime serving the next turn", async ({ source, target, stage }) => {
    const h = transaction(source, target, stage);
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(message => message.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "failure", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switch_failed"));
      await h.waitUntil(() => !h.main.pending);
      expect(h.old.dispose).not.toHaveBeenCalled();
      expect(h.received.some(message => message.type === "engine_switched" || (message.type === "agent_event" && message.boundaryId))).toBe(false);
      h.send({ type: "user_message", requestId: "continue", text: "source still serving" });
      await h.waitUntil(() => h.old.inputs.length === 1);
      expect(h.old.inputs).toEqual(["source still serving"]);
      expect(h.next.dispose).toHaveBeenCalledTimes(stage === "commit" || stage === "projection" || stage === "children" ? 1 : 0);
    } finally { await h.session.shutdown(); h.client.close(); h.close(); }
  });

  it.each(pairs)("$source → $target publishes success and serves the candidate despite source cleanup errors", async ({ source, target }) => {
    const h = transaction(source, target, "cleanup");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.old.dispose.mockImplementation(() => { throw new Error("old dispose failed"); });
    try {
      h.send({ type: "engine_switch_request", requestId: "cleanup", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(h.durableCommit).toHaveBeenCalledTimes(1);
      expect(h.next.dispose).not.toHaveBeenCalled();
      expect(h.main.pending).toBe(false);
      expect(h.received.some(message => message.type === "engine_switch_failed")).toBe(false);
      h.send({ type: "user_message", requestId: "continue", text: "candidate serving" });
      await h.waitUntil(() => h.next.inputs.length === 1);
      expect(h.next.inputs[0]).toContain("candidate serving");
    } finally { await h.session.shutdown(); h.client.close(); h.close(); log.mockRestore(); }
  });

  it.each(pairs.flatMap(pair => (["busy", "approval", "child"] as const).map(admission => ({ ...pair, admission }))))("$source → $target refuses $admission without starting preparation", async ({ source, target, admission }) => {
    const h = transaction(source, target, undefined, admission);
    let unpark!: () => void;
    let approval: Promise<unknown> | undefined;
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(message => message.type === "host_ready"));
      if (admission === "busy") {
        h.old.park = new Promise(resolve => { unpark = resolve; });
        h.send({ type: "user_message", requestId: "running", text: "running turn" });
        await h.waitUntil(() => h.received.some(message => message.type === "turn_started"));
      }
      if (admission === "approval") approval = h.broker.requestPermission({ toolName: "Write", input: { file_path: "/workspace/file", content: "text" }, metadata: writeTool.metadata, mode: "build" });
      h.send({ type: "engine_switch_request", requestId: "refused", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switch_failed"));
      expect(h.controls).toEqual([]);
      expect(h.durableCommit).not.toHaveBeenCalled();
      expect(h.old.dispose).not.toHaveBeenCalled();
      if (unpark) { unpark(); await (h.session as unknown as { currentTurn: Promise<void> | null }).currentTurn; }
      h.old.park = undefined;
      h.broker.denyAll("test settled", "turn_cancelled");
      await approval;
      h.clearChildren();
      h.send({ type: "user_message", requestId: "next", text: "next turn" });
      await h.waitUntil(() => h.old.inputs.at(-1) === "next turn");
    } finally { unpark?.(); await h.session.shutdown(); h.client.close(); h.close(); }
  });

  it.each(pairs)("$source → $target rejects stale and duplicate requests without preparing another runtime", async ({ source, target }) => {
    const h = transaction(source, target);
    try {
      h.send({ type: "engine_switch_request", requestId: "stale", generation: 6, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switch_failed"));
      expect(h.controls).toEqual([]);
      const request = { type: "engine_switch_request" as const, requestId: "duplicate", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) };
      h.send(request); h.send(request);
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(h.controls.filter(message => message.phase === "prepare")).toHaveLength(1);
      expect(h.durableCommit).toHaveBeenCalledTimes(1);
    } finally { await h.session.shutdown(); h.client.close(); h.close(); }
  });

  it.each(pairs)("$source → $target shutdown during preparation aborts admission and disposes both owned runtimes", async ({ source, target }) => {
    const h = transaction(source, target);
    let resolve!: (runtime: SwitchRuntime) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(value => { entered = value; });
    h.setFactory(() => new Promise(value => { resolve = value; entered(); }));
    try {
      h.send({ type: "engine_switch_request", requestId: "shutdown", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
      await preparing;
      const shutdown = h.session.shutdown();
      resolve({ engine: h.next });
      await shutdown;
      expect(h.old.dispose).toHaveBeenCalledTimes(1);
      expect(h.next.dispose).toHaveBeenCalledTimes(1);
      expect(h.durableCommit).not.toHaveBeenCalled();
      expect(h.main.pending).toBe(false);
      expect(h.controls.at(-1)).toMatchObject({ type: ENGINE_SWITCH_CONTROL, phase: "abort" });
    } finally { h.client.close(); h.close(); }
  });
});

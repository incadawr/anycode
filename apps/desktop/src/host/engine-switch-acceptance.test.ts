import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, writeTool } from "@anycode/core";
import { RuntimeSessionHistory } from "./runtime-session-history.js";
import type { EngineSwitchIdentity } from "../shared/engine-switch-control.js";
import type { UiToHostMessage, EngineSwitchTarget } from "../shared/protocol.js";
import type { AgentEvent, HistoryItem, PermissionMode } from "@anycode/core";
import type { EngineId } from "../shared/engines.js";
import { ENGINE_SWITCH_CONTROL, type EngineSwitchControl } from "../shared/engine-switch-control.js";
import { EngineSwitchCoordinator } from "../main/engine-switch-coordinator.js";
import { createEngineSwitchClient } from "./engine-switch-client.js";
import { CORE_ENGINE_CAPABILITIES } from "./engines/session-engine.js";
import { CODEX_ENGINE_CAPABILITIES } from "./engines/codex/codex-engine.js";
import { CLAUDE_ENGINE_CAPABILITIES } from "./engines/claude/claude-engine.js";
import { persistedCoreMode } from "./engine-switch-runtime.js";
import type { RunTurnOptions, SessionEngine } from "./engines/session-engine.js";
import type { SessionOptions, SwitchRuntime } from "./session.js";
import { ChildReportQueue } from "./child-report-queue.js";
import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { createForeignSpawnModeCell } from "./spawn-mode-cell.js";
import { createHarness } from "./test-harness.js";

const engines = ["core", "codex", "claude"] as const;
const pairs = engines.flatMap(source => engines.filter(target => source !== target).map(target => ({ source, target })));
class Runtime implements SessionEngine {
  get capabilities() { return this.id === "core" ? CORE_ENGINE_CAPABILITIES : this.id === "codex" ? CODEX_ENGINE_CAPABILITIES : CLAUDE_ENGINE_CAPABILITIES; }
  readonly inputs: string[] = [];
  readonly dispose = vi.fn(async () => {});
  park?: Promise<void>;
  constructor(readonly id: EngineId) {}
  mode(): PermissionMode { return this.id === "core" ? "build" : "plan"; }
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

function transaction(source: EngineId, target: EngineId, stage?: "resolve" | "factory" | "commit" | "projection" | "children" | "cleanup", admission?: "busy" | "approval" | "child", history?: RuntimeSessionHistory) {
  const old = new Runtime(source), next = new Runtime(target);
  const durableCommit = vi.fn((_target: EngineSwitchTarget, identity: EngineSwitchIdentity) => {
    if (stage === "commit") throw new Error("disk full");
    if (history) history.store.commitRuntimeSwitch(history.sessionId,source,identity.runtime!);
  });
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
  const reportQueue = new ChildReportQueue({ sendDirect: message => h.outbound.sendDirect(message) });
  const h = createHarness({ steps: [], runtimeHistory: history, pendingChildReports: reportQueue, backgroundChildren: { list: () => childLive ? [{ childSessionId: "child", agentType: "executor", description: "work", startedAt: 1 }] : [], cancel: () => false, cancelAll: () => {}, onChange: () => () => { if (stage === "cleanup") throw new Error("old listener cleanup failed"); } }, engine: old, switchEngineFactory: (...args) => factory(...args), engineSwitchCoordinator: coordinator });
  return { ...h, old, next, controls, durableCommit, main, client, reportQueue, clearChildren() { childLive = false; }, setFactory(value: typeof factory) { factory = value; } };
}

describe("engine-switch refusal and rollback acceptance", () => {
  it("answers a malformed selection with a correlated failure and allows a valid retry", async () => {
    const h = transaction("codex","core");
    try {
      h.send({type:"engine_switch_request",requestId:"malformed",generation:7,engine:"core",model:"chosen",connectionId:""} as UiToHostMessage);
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switch_failed"));
      expect(h.received.find(message => message.type === "engine_switch_failed")).toMatchObject({requestId:"malformed",generation:7,reason:"Invalid engine switch selection."});
      expect(h.durableCommit).not.toHaveBeenCalled();
      h.send({type:"engine_switch_request",requestId:"retry",generation:7,engine:"core",model:"chosen",connectionId:"connection"});
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched" && message.requestId === "retry"));
      expect(h.durableCommit).toHaveBeenCalledOnce();
    } finally { await h.session.shutdown(); h.client.close(); h.close(); }
  });

  it.each(["codex","claude"] as const)("restores the persisted core mode through %s with production capabilities", async native => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"test-session",workspace:"/workspace",model:"old",mode:"build"});
    const outbound = transaction("core",native,undefined,undefined,new RuntimeSessionHistory(store,"test-session"));
    outbound.old.mode = () => "build";
    outbound.send({type:"engine_switch_request",requestId:"to-native",generation:7,engine:native,model:"chosen"});
    await outbound.waitUntil(() => outbound.received.some(message => message.type === "engine_switched"));
    await outbound.session.shutdown(); outbound.client.close(); outbound.close();
    const h = transaction(native,"core",undefined,undefined,new RuntimeSessionHistory(store,"test-session"));
    const core = createHarness({steps:[],mode:persistedCoreMode(store.loadRuntimeSession("test-session"))});
    expect(h.old.capabilities.supportsCorePermissions).toBe(false);
    h.setFactory(async () => ({engine:core.engine,identity:{model:"chosen",mode:"plan"}}));
    try {
      h.send({type:"engine_switch_request",requestId:"preserve-mode",generation:7,engine:"core",model:"chosen",connectionId:"connection"});
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(core.engine.mode()).toBe("build");
      expect(h.durableCommit.mock.calls[0]?.[1].mode).toBe("build");
      expect((await store.getRootSession("test-session"))?.mode).toBe("build");
      expect(store.loadRuntimeSession("test-session")?.segments.at(-1)).toMatchObject({selected:{mode:"build"},applied:{mode:"build"}});
      expect(h.received.find(message => message.type === "engine_switched")).toMatchObject({projection:{mode:"build"}});
      expect(persistedCoreMode(store.loadRuntimeSession("test-session"))).toBe("build");
    } finally { await h.session.shutdown(); h.client.close(); h.close(); await core.session.shutdown(); core.close(); await store.close(); }
  });

  it.each(["codex","claude"] as const)("keeps the native %s preset id in the commit identity", async target => {
    const h = transaction("core",target);
    h.setFactory(async () => ({engine:h.next,identity:{model:"chosen",mode:"read-only",externalSessionRef:"native-id"}}));
    try {
      h.send({type:"engine_switch_request",requestId:"native-preset",generation:7,engine:target,model:"chosen"});
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(h.durableCommit.mock.calls[0]?.[1].mode).toBe("read-only");
    } finally { await h.session.shutdown(); h.client.close(); h.close(); }
  });

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

// Synthetic native policies exercise the switch contract, without qualifying a CLI.
function compose(runtime: Runtime, base: PermissionMode, supported = true) {
  let mode = base;
  const authority = createForeignSpawnModeCell(() => mode);
  runtime.mode = () => mode;
  const apply = vi.fn(async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }));
  Object.assign(runtime, { setMode: (next: PermissionMode) => { mode = next; }, setCoreOrchestrate: () => true,
    orchestrationPolicy: { availability: () => ({ supported }), apply, nativeBase: () => runtime.id === "claude"
      ? { version: 1, engine: "claude", model: "chosen", preset: "read-only", permissionMode: "plan", mcpDigest: "a".repeat(64), tools: ["Read"] }
      : { version: 1, engine: "codex", model: "chosen", preset: "read-only", configDigest: "a".repeat(64) } } });
  const cleanup = vi.fn();
  const composition = bindRuntimeOrchestration(runtime, { ownerSessionId: "test-session",
    port: { hasRunningChildren: () => false, cancelAllBackgroundChildren: vi.fn() },
    baseMode: () => base, capture: authority.capture, clear: authority.clear, cleanup });
  vi.spyOn(runtime, "dispose");
  return { composition, authority, apply, cleanup };
}

it.each(pairs)("ON $source → $target captures only target authority before commit and retires routing", async ({ source, target }) => {
  const store = new SqlitePersistenceAdapter(":memory:");
  await store.createSession({ id: "test-session", workspace: "/workspace", model: "old", mode: "yolo", engineId: source });
  const h = transaction(source, target, undefined, undefined, new RuntimeSessionHistory(store, "test-session"));
  const old = compose(h.old, "yolo"), next = compose(h.next, target === "core" ? "edit" : "plan");
  const base = target === "core" ? "edit" : "plan";
  Object.assign(h.next, { verifyOrchestrationOff: async () => {} });
  const commit = h.durableCommit.getMockImplementation()!;
  h.durableCommit.mockImplementation((selection, identity) => {
    expect(next.authority.read()).toBe(target === "core" ? "edit" : "build");
    expect(h.old.dispose).not.toHaveBeenCalled();
    if (target !== "core") expect(next.apply).toHaveBeenCalledWith(true, { mode: base });
    commit(selection, identity);
  });
  try {
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
    h.send({ type: "set_orchestrate", enabled: true });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
    expect(h.session.childSpawnMode()).toBe("yolo");
    h.send({ type: "engine_switch_request", requestId: "authority", generation: 7, engine: target, model: "chosen", ...(target === "core" ? { connectionId: "connection" } : {}) });
    await h.waitUntil(() => h.received.some(m => m.type === "engine_switched"));
    expect(h.durableCommit).toHaveBeenCalledOnce();
    expect(store.loadRuntimeSession("test-session")?.segments.at(-1)?.applied.orchestration?.baseMode).toBe(base);
    expect(h.session.childSpawnPreOrchestrateMode()).toBe(base);
    expect(h.session.childSpawnMode()).toBe(target === "core" ? "edit" : "build");
    expect(old.composition.ready()).toBe(false);
    expect(() => old.composition.capture("yolo")).toThrow("disposed");
    expect(next.composition.ready()).toBe(true);
    expect(h.main.pending).toBe(false);
    h.send({ type: "set_orchestrate", enabled: false });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && !m.enabled));
    if (target === "core") expect(h.next.mode()).toBe("edit");
    else expect(next.apply).toHaveBeenLastCalledWith(false, { mode: "plan" });
    h.send({ type: "user_message", requestId: "next", text: "continue" });
    await h.waitUntil(() => h.next.inputs.length === 1);
    expect(h.next.inputs[0]).toContain("original conversation");
  } finally {
    await h.session.shutdown(); h.client.close(); h.close(); await store.close();
    expect(next.cleanup).toHaveBeenCalledOnce(); expect(old.cleanup).toHaveBeenCalledOnce();
  }
});

it("unavailable Claude candidate leaves an ON source and its captured authority intact", async () => {
  const h = transaction("codex", "claude");
  const old = compose(h.old, "yolo"), next = compose(h.next, "plan", false);
  try {
    h.send({ type: "set_orchestrate", enabled: true });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
    h.send({ type: "engine_switch_request", requestId: "unavailable", generation: 7, engine: "claude", model: "chosen" });
    await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed"));
    await h.waitUntil(() => !h.main.pending);
    expect(h.session.childSpawnMode()).toBe("yolo");
    expect(h.old.dispose).not.toHaveBeenCalled();
    expect(old.composition.ready()).toBe(true); expect(next.composition.ready()).toBe(false);
    expect(next.apply).not.toHaveBeenCalled(); expect(h.durableCommit).not.toHaveBeenCalled();
    h.send({ type: "user_message", requestId: "retry", text: "continue" });
    await h.waitUntil(() => h.old.inputs.length === 1);
  } finally { await h.session.shutdown(); h.client.close(); h.close(); }
});

it.each([false, true])("retains a session-owned pending report through candidate abort=%s", async abort => {
  const h = transaction("codex", "claude", abort ? "commit" : undefined);
  compose(h.old, "yolo"); compose(h.next, "plan");
  const make = async () => {
    h.reportQueue.add("terminal", "child report sentinel");
    return { engine: h.next, identity: { model: "chosen", mode: "read-only", externalSessionRef: "candidate-ref" } };
  };
  h.setFactory(make);
  try {
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
    h.send({ type: "set_orchestrate", enabled: true });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
    h.send({ type: "engine_switch_request", requestId: "reports", generation: 7, engine: "claude", model: "chosen" });
    await h.waitUntil(() => h.received.some(m => m.type === (abort ? "engine_switch_failed" : "engine_switched")));
    await h.waitUntil(() => !h.main.pending);
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.filter(m => m.type === "child_report" && m.id === "terminal").length === 2);
    expect(h.controls.at(-1)?.phase).toBe(abort ? "abort" : "retire");
    expect(h.reportQueue.snapshot().reports).toEqual([{ id: "terminal", text: "child report sentinel" }]);
    h.send({ type: "child_report_ack", id: "terminal" });
    await vi.waitFor(() => expect(h.reportQueue.snapshot().reports).toHaveLength(0));
    expect(h.old.dispose).toHaveBeenCalledTimes(abort ? 0 : 1);
    expect(h.next.dispose).toHaveBeenCalledTimes(abort ? 1 : 0);
  } finally { await h.session.shutdown(); h.client.close(); h.close(); }
});

it("refuses an ON switch while source routing owns an admitted child", async () => {
  const h = transaction("codex", "claude");
  const old = compose(h.old, "yolo"); compose(h.next, "plan");
  try {
    h.send({ type: "set_orchestrate", enabled: true });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
    old.composition.hasRunningChildren = () => true;
    h.send({ type: "engine_switch_request", requestId: "child-owner", generation: 7, engine: "claude", model: "chosen" });
    await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed"));
    expect(h.controls).toEqual([]);
    expect(h.durableCommit).not.toHaveBeenCalled();
    expect(h.old.dispose).not.toHaveBeenCalled(); expect(h.next.dispose).not.toHaveBeenCalled();
    expect(h.session.childSpawnMode()).toBe("yolo");
  } finally { await h.session.shutdown(); h.client.close(); h.close(); }
});

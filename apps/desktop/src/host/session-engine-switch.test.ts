import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
/**
 * (review 23.08 narrowing) — Session-level wire tests
 * for the in-session engine swap: the host-side Session can replace its
 * SessionEngine BETWEEN turns via `engine_switch_request`, old engine disposed
 * only after the replacement is live, canonical transcript continuous, the
 * boundary announced with an engine_notice on the ENGINE_SWITCH_TURN_ID
 * sentinel, and the new engine's FIRST turn receives the rendered import
 * prompt (one-shot) while later turns get the raw user text.
 *
 * createHarness drives the REAL Session over a real worker_threads
 * MessageChannel; the two fake engines below implement the SessionEngine
 * contract minimally (turn_start + loop_end, seeded history, dispose
 * recording). No live CLIs anywhere.
 */

import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentEvent, type HistoryItem, type PermissionMode } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "./engines/session-engine.js";
import { prepareSwitchRuntime } from "./engine-switch-runtime.js";
import { ENGINE_SWITCH_TURN_ID } from "./engine-switch.js";
import { createHarness, finishStep, ScriptedModelPort } from "./test-harness.js";
import { CoreEngine } from "./engines/core-engine.js";
import type { EngineSettingsSeam } from "./session.js";

const NO_CORE_CAPS: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  supportsContextUsage: false,
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: false,
  costAccounting: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
  supportsManualCompact: false,
};

/** Plain wire helpers (same shape session.test.ts uses). */
type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isSessionHistory = (m: HostToUiMessage): m is Of<"session_history"> => m.type === "session_history";
const isEngineSwitched = (m: HostToUiMessage): m is Of<"engine_switched"> => m.type === "engine_switched";
const isEngineSwitchFailed = (m: HostToUiMessage): m is Of<"engine_switch_failed"> =>
  m.type === "engine_switch_failed";
const isTurnRejected = (m: HostToUiMessage): m is Of<"turn_rejected"> => m.type === "turn_rejected";

const agentEventOf =
  (innerType: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === innerType;

const engineNoticeEvents = (received: readonly HostToUiMessage[]): Of<"agent_event">[] =>
  received.filter(
    (m): m is Of<"agent_event"> => m.type === "agent_event" && m.turnId === ENGINE_SWITCH_TURN_ID,
  );

/**
 * The engine being switched AWAY from: id "core", two seeded history items,
 * runTurn yields turn_start + loop_end{completed}, dispose records its reason.
 * `parkTurn` holds the stream open so a test can pin the busy gate.
 */
class SwitchableFakeEngine implements SessionEngine {
  readonly id = "core" as const;
  readonly capabilities = NO_CORE_CAPS;
  /** Every runTurn input, in order (asserts the import-prompt one-shot). */
  readonly inputs: string[] = [];
  disposeReasons: string[] = [];
  private release: (() => void) | null = null;
  private readonly items: HistoryItem[];

  constructor(items: HistoryItem[]) {
    this.items = items;
  }

  mode(): PermissionMode {
    return "build";
  }

  reasoningEffort(): undefined {
    return undefined;
  }

  setReasoningEffort(): void {}

  historyItems(): readonly HistoryItem[] {
    return this.items;
  }

  /** Holds each runTurn's stream open until releaseTurn() (busy-gate fixture). */
  parked = false;
  reportUsage = false;

  releaseTurn(): void {
    this.release?.();
    this.release = null;
  }

  async *runTurn(input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    yield { type: "turn_start", turn: 1 };
    if (this.parked) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.reportUsage) yield { type: "context_usage", estimatedTokens: 47000, budgetTokens: 100000, source: "provider" };
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }

  dispose(reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposeReasons.push(reason);
    return Promise.resolve();
  }
}

/** The engine being switched TO: id "codex", records runTurn inputs. */
class NextFakeEngine implements SessionEngine {
  readonly id = "codex" as const;
  readonly capabilities = NO_CORE_CAPS;
  readonly inputs: string[] = [];
  disposeReasons: string[] = [];

  mode(): PermissionMode {
    return "build";
  }

  reasoningEffort(): undefined {
    return undefined;
  }

  setReasoningEffort(): void {}

  historyItems(): readonly HistoryItem[] {
    return [];
  }

  async *runTurn(input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    yield { type: "turn_start", turn: 1 };
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }

  dispose(reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposeReasons.push(reason);
    return Promise.resolve();
  }
}

const SEEDED: HistoryItem[] = [
  { id: "seed-1", createdAt: 1, message: { role: "user", content: "first seeded turn" }, kind: "normal" },
  { id: "seed-2", createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "seeded answer" }] }, kind: "normal" },
];

function seededHistory(): HistoryItem[] {
  return SEEDED.map((item) => ({ ...item, message: { ...item.message } }));
}

describe("Session — engine switch", () => {
  it.each(["success", "failure"] as const)("drains an authenticated next-turn message after switch %s", async outcome => {
    const old = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    let entered!: () => void;
    let finish!: () => void;
    const factoryEntered = new Promise<void>(resolve => { entered = resolve; });
    const candidate = new Promise<SessionEngine>((resolve, reject) => {
      finish = () => outcome === "success" ? resolve(next) : reject(new Error("candidate unavailable"));
    });
    const h = createHarness({ steps: [], engine: old, switchEngineFactory: async () => { entered(); return candidate; } });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "switch", engine: "codex", model: "test-model" });
      await factoryEntered;
      const delivery = await h.session.receiveAgentMessage({
        messageId: "inbox-during-switch", sender: "authenticated-supervisor", recipientSessionId: h.session.communicationStatus().sessionId,
        kind: "agent_message", payload: "Continue the queued supervisor task", mode: "next_turn", createdAt: new Date().toISOString(),
      });
      expect(delivery.state).toBe("queued");
      expect(old.inputs).toEqual([]);
      expect(next.inputs).toEqual([]);
      finish();
      if (outcome === "success") await h.waitFor(isEngineSwitched);
      else await h.waitFor(isEngineSwitchFailed);
      const serving = outcome === "success" ? next : old;
      const idle = outcome === "success" ? old : next;
      await h.waitUntil(() => serving.inputs.length === 1);
      expect(serving.inputs[0]).toContain("Continue the queued supervisor task");
      expect(idle.inputs).toEqual([]);
      expect(h.session.agentMessageStatus("inbox-during-switch")?.state).toBe("acknowledged");
      expect(old.disposeReasons).toEqual(outcome === "success" ? ["session-close"] : []);
    } finally { finish(); h.close(); }
  });

  it("republishes Core authority after a native engine with the same display mode", async () => {
    const core = new SwitchableFakeEngine([]);
    const native = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: core,
      switchEngineFactory: async target => target === "codex" ? native : new SwitchableFakeEngine([]) });
    const modes: PermissionMode[] = [], orchestrate: boolean[] = [];
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.session.observePermissionMode(mode => modes.push(mode), enabled => orchestrate.push(enabled));
      expect(modes).toEqual(["build"]);
      expect(orchestrate).toEqual([false]);
      h.send({ type: "engine_switch_request", requestId: "native", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      expect(modes).toEqual(["build"]);
      expect(orchestrate).toEqual([false]);
      h.send({ type: "engine_switch_request", requestId: "core", engine: "core", model: "test-model" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switched" && m.requestId === "core"));
      expect(modes).toEqual(["build", "build"]);
      expect(orchestrate).toEqual([false, false]);
    } finally { h.close(); }
  });

  it("keeps a bounded duplicate window without refusing all requests after 1024 attempts", async () => {
    const old = new SwitchableFakeEngine([]);
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: old, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      for (let index = 0; index < 1025; index++) {
        h.send({ type: "engine_switch_request", requestId: `same-${index}`, engine: "core", model: "test-model" });
      }
      await h.waitUntil(() => h.received.some(m => isEngineSwitchFailed(m) && m.requestId === "same-1024"), 5000);
      expect(h.received.filter(isEngineSwitchFailed)).toHaveLength(1025);
      expect(h.received.filter(isEngineSwitchFailed).every(m => m.reason === 'already running the "core" engine')).toBe(true);
      h.send({ type: "engine_switch_request", requestId: "same-1024", engine: "codex", model: "test-model" });
      await h.waitUntil(() => h.received.filter(isEngineSwitchFailed).length === 1026);
      expect(h.received.filter(isEngineSwitchFailed).at(-1)?.reason).toBe("duplicate engine switch request");
      h.send({ type: "engine_switch_request", requestId: "same-0", engine: "core", model: "test-model" });
      await h.waitUntil(() => h.received.filter(isEngineSwitchFailed).length === 1027);
      expect(h.received.filter(isEngineSwitchFailed).at(-1)?.reason).toBe('already running the "core" engine');
      h.send({ type: "engine_switch_request", requestId: "new-request", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      expect(old.disposeReasons).toEqual(["session-close"]);
      expect(next.disposeReasons).toEqual([]);
    } finally { h.close(); }
  });

  it("refuses a switch with live children without cancelling them", async () => {
    const old = new SwitchableFakeEngine([]); const next = new NextFakeEngine();
    let cancelled = false; let created = false;
    const h = createHarness({ steps: [], engine: old, switchEngineFactory: async () => { created = true; return next; }, backgroundChildren: {
      list: () => [{ childSessionId: "child", agentType: "executor", description: "work", startedAt: 1 }],
      cancel: () => { cancelled = true; return true; }, cancelAll: () => { cancelled = true; },
    } });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw", engine: "codex", model: "test-model" });
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("children");
      expect(created).toBe(false); expect(cancelled).toBe(false); expect(old.disposeReasons).toEqual([]);
    } finally { h.close(); }
  });
  it("rechecks children admitted while the target factory is pending", async () => {
    const old = new SwitchableFakeEngine([]); const next = new NextFakeEngine();
    let live = false; let release!: () => void; let entered!: () => void;
    const factoryEntered = new Promise<void>(r => { entered = r; });
    const h = createHarness({ steps: [], engine: old, switchEngineFactory: async () => { await new Promise<void>(r => { release = r; entered(); }); return next; }, backgroundChildren: {
      list: () => live ? [{ childSessionId: "child", agentType: "executor", description: "work", startedAt: 1 }] : [],
      cancel: () => false, cancelAll: () => {},
    } });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw", engine: "codex", model: "test-model" });
      await factoryEntered; live = true; release();
      await h.waitFor(isEngineSwitchFailed);
      expect(old.disposeReasons).toEqual([]); expect(next.disposeReasons).toEqual(["session-close"]);
    } finally { h.close(); }
  });
  it.each(["codex", "claude"] as const)("rejects unsupported %s target without changing the ON parent", async (target) => {
    class Core extends SwitchableFakeEngine {
      override readonly capabilities = { ...NO_CORE_CAPS, supportsCorePermissions: true };
      private current: PermissionMode = "build";
      override mode(): PermissionMode { return this.current; }
      setMode(mode: PermissionMode): void { this.current = mode; }
    }
    const core = new Core([]); const next = new NextFakeEngine();
    Object.defineProperty(next, "id", { value: target });
    const h = createHarness({ steps: [], engine: core, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "set_orchestrate", enabled: true });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
      h.send({ type: "engine_switch_request", requestId: "sw", engine: target, model: "test-model" });
      await h.waitFor(isEngineSwitchFailed);
      expect(core.mode()).toBe("plan"); expect(core.disposeReasons).toEqual([]);
      expect(next.disposeReasons).toEqual(["session-close"]);
    } finally { h.close(); }
  });

  it("rejects a target owned by another session before applying its policy", async () => {
    const target = new NextFakeEngine();
    let applied = false;
    Object.assign(target,{orchestrationPolicy:{availability:() => ({supported:true}),apply:async (enabled: boolean,baseAuthority:unknown) => { applied = true; return {enabled,baseAuthority}; }}});
    bindRuntimeOrchestration(target,{ownerSessionId:"another-session",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:() => {}},baseMode:() => "plan"});
    class Core extends SwitchableFakeEngine {
      override readonly capabilities = {...NO_CORE_CAPS,supportsCorePermissions:true};
      private current: PermissionMode = "edit";
      override mode() { return this.current; }
      setMode(mode: PermissionMode) { this.current = mode; }
    }
    const core = new Core([]);
    const h = createHarness({steps:[],engine:core,switchEngineFactory:async () => target});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(isHostReady);
      h.send({type:"set_orchestrate",enabled:true});
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
      h.send({type:"engine_switch_request",requestId:"wrong-owner",engine:"codex",model:"test-model"});
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("composition");
      expect(applied).toBe(false); expect(core.disposeReasons).toEqual([]);
      h.send({type:"user_message",requestId:"source-next",text:"continue"});
      await h.waitFor(agentEventOf("loop_end")); expect(core.inputs).toHaveLength(1);
    } finally { h.close(); }
  });

  it("refuses a switch while a foreground or pending inline child owns the source", async () => {
    const source = new SwitchableFakeEngine([]); const target = new NextFakeEngine();
    let children = true;
    bindRuntimeOrchestration(source,{ownerSessionId:"test-session",port:{hasRunningChildren:() => children,cancelAllBackgroundChildren:() => {}},baseMode:() => "build"});
    const h = createHarness({steps:[],engine:source,switchEngineFactory:async () => target});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(isHostReady);
      h.send({type:"engine_switch_request",requestId:"child",engine:"codex",model:"test-model"});
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("children");
      expect(target.disposeReasons).toEqual([]);
      children = false;
      h.send({type:"engine_switch_request",requestId:"after-child",engine:"codex",model:"test-model"});
      await h.waitFor(isEngineSwitched);
    } finally { h.close(); }
  });

  it("rolls back a failed candidate settings acknowledgement and serves the next source turn", async () => {
    const source = new SwitchableFakeEngine([]); const target = new NextFakeEngine();
    const seam = {waitForSettingsChanges:async () => { throw new Error("Preset acknowledgement failed"); }} as unknown as EngineSettingsSeam;
    const h = createHarness({steps:[],engine:source,switchEngineFactory:async () => ({engine:target,engineSettings:seam})});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(isHostReady);
      h.send({type:"engine_switch_request",requestId:"ack-failed",engine:"codex",model:"test-model"});
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("acknowledgement");
      expect(source.disposeReasons).toEqual([]); expect(target.disposeReasons).toEqual(["session-close"]);
      h.send({type:"user_message",requestId:"source-next",text:"continue"});
      await h.waitFor(agentEventOf("loop_end")); expect(source.inputs).toHaveLength(1);
    } finally { h.close(); }
  });

  it("prepares the target policy before switching and restores the captured authority on disable", async () => {
    class Core extends SwitchableFakeEngine {
      override readonly capabilities = { ...NO_CORE_CAPS, supportsCorePermissions: true };
      private current: PermissionMode = "build";
      override mode(): PermissionMode { return this.current; }
      setMode(mode: PermissionMode): void { this.current = mode; }
    }
    class Target extends NextFakeEngine {
      readonly orchestrationCompositionReady = true;
      readonly calls: boolean[] = [];
      readonly orchestrationPolicy = { availability: () => ({ supported: true as const }), apply: async (enabled: boolean, baseAuthority: unknown) => { this.calls.push(enabled); return { enabled, baseAuthority }; } };
    }
    const core = new Core([]); const target = new Target();
    const h = createHarness({ steps: [], engine: core, switchEngineFactory: async () => target });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "set_orchestrate", enabled: true });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
      h.send({ type: "engine_switch_request", requestId: "sw", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched); expect(target.calls).toEqual([true]);
      expect(core.disposeReasons).toEqual(["session-close"]); expect(target.inputs).toEqual([]);
      h.send({ type: "set_orchestrate", enabled: false });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && !m.enabled));
      expect(target.calls).toEqual([true, false]);
    } finally { h.close(); }
  });
  it("commits a prepared core runtime through Session", async () => {
    const targetHarness = createHarness({ steps: [finishStep()] });
    const config = targetHarness.config;
    const source = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: source, switchEngineFactory: async () => prepareSwitchRuntime({ engine: "core", options: { loop: new AgentLoop(config), config } }) });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "core", engine: "core", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      expect(source.disposeReasons).toEqual(["session-close"]);
      h.send({ type: "user_message", requestId: "first", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      expect((config.modelPort as ScriptedModelPort).requests).toHaveLength(1);
    } finally { await h.session.shutdown(); h.close(); targetHarness.close(); }
  });

  it("rejects a candidate with the wrong engine identity", async () => {
    const old = new SwitchableFakeEngine([]);
    const wrong = new SwitchableFakeEngine([]);
    const h = createHarness({ steps: [], engine: old, switchEngineFactory: async () => ({ engine: wrong }) });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "wrong", engine: "codex", model: "test-model" });
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("does not match");
      expect(wrong.disposeReasons).toEqual(["session-close"]);
      expect(old.disposeReasons).toEqual([]);
    } finally { h.close(); }
  });

  it("prepares a core target in plan mode before switching from Codex", async () => {
    class Source extends NextFakeEngine {
      readonly orchestrationPolicy = { availability: () => ({ supported: true as const }), apply: async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }) };
    }
    const targetHarness = createHarness({ steps: [finishStep()], planExit: true });
    const config = targetHarness.config;
    const target = Object.assign(new CoreEngine({ loop: new AgentLoop(config), config }), { orchestrationCompositionReady: true });
    const source = new Source();
    const h = createHarness({ steps: [], engine: source, switchEngineFactory: async () => target });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "set_orchestrate", enabled: true });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
      h.send({ type: "engine_switch_request", requestId: "sw", engine: "core", model: "test-model" });
      await h.waitFor(isEngineSwitched); expect(target.mode()).toBe("plan");
      expect(config.orchestrate).toBe(true); expect(source.disposeReasons).toEqual(["session-close"]);
      h.send({ type: "user_message", requestId: "first", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      const requests = (config.modelPort as ScriptedModelPort).requests;
      expect(requests).toHaveLength(1);
      expect(requests[0]!.tools.map(tool => tool.name)).not.toContain("ExitPlanMode");
      h.send({ type: "set_orchestrate", enabled: false });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && !m.enabled));
      expect(target.mode()).toBe("build"); // Restore the target core base.
      expect(config.orchestrate).toBe(false);
    } finally { h.close(); targetHarness.close(); }
  });
  it("rejects an unconfirmed core flag and keeps the Codex parent active", async () => {
    class Source extends NextFakeEngine {
      readonly orchestrationPolicy = { availability: () => ({ supported: true as const }), apply: async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }) };
    }
    const targetHarness = createHarness({ steps: [] });
    const config = targetHarness.config;
    class RefusingCore extends CoreEngine {
      readonly orchestrationCompositionReady = true;
      override setCoreOrchestrate(): boolean { return false; }
    }
    const target = new RefusingCore({ loop: new AgentLoop(config), config });
    const source = new Source();
    const h = createHarness({ steps: [], engine: source, switchEngineFactory: async () => target });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(isHostReady);
      h.send({ type: "set_orchestrate", enabled: true });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && m.enabled));
      h.send({ type: "engine_switch_request", requestId: "sw", engine: "core", model: "test-model" });
      expect((await h.waitFor(isEngineSwitchFailed)).reason).toContain("unconfirmed");
      expect(source.disposeReasons).toEqual([]);
      expect((h.session as unknown as { engine: SessionEngine }).engine).toBe(source);
      h.send({ type: "user_message", requestId: "still-on", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(source.inputs).toHaveLength(1);
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isHostReady));
      expect(h.received.slice(before).find(isHostReady)?.orchestration?.enabled).toBe(true);
    } finally { h.close(); targetHarness.close(); }
  });
  it("success: swaps the engine, disposes the old one after, announces once, keeps the transcript continuous", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw1", engine: "codex", model: "test-model" });
      const switched = await h.waitFor(isEngineSwitched);
      expect(switched).toMatchObject({ requestId: "sw1", engine: "codex", previousEngine: "core" });

      // Live engine pointer moved; old engine disposed exactly once, after the swap.
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("codex");
      expect(next.disposeReasons).toEqual([]);
      expect(oldEngine.disposeReasons).toEqual(["session-close"]);

      // Exactly ONE switch announcement, on the sentinel turn id, as an info engine_notice.
      const notices = engineNoticeEvents(h.received).filter((m) => m.event.type === "engine_notice");
      expect(notices).toHaveLength(1);
      const notice = notices[0];
      if (notice !== undefined && notice.event.type === "engine_notice") {
        expect(notice.event.level).toBe("info");
        expect(notice.event.message).toContain('from the "core" engine to the "codex" engine');
        expect(notice.event.message).toContain("text import");
      }

      // Transcript continuity: a fresh ui_ready's session_history still carries
      // the 2 seeded canonical items (rebuilt from the SAME items at swap time).
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isSessionHistory));
      const handshake = h.received.slice(before).find(isSessionHistory);
      expect(handshake?.items.map((i) => i.id)).toEqual(["seed-1", "seed-2"]);
    } finally {
      h.close();
    }
  });

  it.each([false, true])("drops the old context reading on reconnect after a switch (history: %s)", async (history) => {
    const oldEngine = new SwitchableFakeEngine(history ? seededHistory() : []);
    oldEngine.reportUsage = true;
    const h = createHarness({ steps: [], engine: oldEngine, switchEngineFactory: async () => new NextFakeEngine() });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "usage", text: "hello" });
      await h.waitFor(agentEventOf("context_usage"));
      await h.waitUntil(() => !(h.session as unknown as { busy: boolean }).busy);
      h.send({ type: "engine_switch_request", requestId: "switch", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isHostReady));
      await new Promise(resolve => setTimeout(resolve, 30));
      const replay = h.received.slice(before);
      expect(replay.some(m => m.type === "session_checkpoint" && m.contextUsage !== undefined)).toBe(false);
      expect(replay.some(agentEventOf("context_usage"))).toBe(false);
    } finally { h.close(); }
  });

  it("busy: refuses while a turn runs, engine unchanged, old engine not disposed", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    oldEngine.parked = true;
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Start a turn; the parked stream holds busy=true.
      h.send({ type: "user_message", requestId: "r1", text: "hold this turn open" });
      await h.waitUntil(() => oldEngine.inputs.length === 1);

      h.send({ type: "engine_switch_request", requestId: "sw2", engine: "codex", model: "test-model" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed).toMatchObject({ requestId: "sw2", reason: "a turn is running" });

      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
      expect(h.received.some(isEngineSwitched)).toBe(false);

      // Release the parked turn so the harness drains cleanly.
      oldEngine.releaseTurn();
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      oldEngine.releaseTurn();
      h.close();
    }
  });

  it("same engine: refuses with 'already running' and touches nothing", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw3", engine: "core", model: "test-model" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed.reason).toBe('already running the "core" engine');
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("factory throws: fails with the factory's error, old engine stays live and runs the next turn", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => {
        throw new Error("codex not signed in");
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw4", engine: "codex", model: "test-model" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed).toMatchObject({ requestId: "sw4", reason: "codex not signed in" });

      // Old engine STILL active: not disposed, and the next turn still runs on it.
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
      h.send({ type: "user_message", requestId: "r2", text: "still on the old engine" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(oldEngine.inputs).toEqual(["still on the old engine"]);
      expect(h.received.some(isTurnRejected)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("disposes the candidate if rendering the import fails", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    const bad = { id: "bad", createdAt: 0, get message(): never { throw new Error("render failure"); } } as HistoryItem;
    (oldEngine as unknown as { readTranscript: () => Promise<readonly HistoryItem[]> }).readTranscript = async () => [bad];
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "render-failure", engine: "codex", model: "test-model" });
      expect(await h.waitFor(isEngineSwitchFailed)).toMatchObject({ requestId: "render-failure", reason: expect.stringContaining("render failure") });
      expect(next.disposeReasons).toEqual(["session-close"]);
      expect(oldEngine.disposeReasons).toEqual([]);
      h.send({ type: "user_message", requestId: "after-render-failure", text: "continue" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(oldEngine.inputs).toEqual(["continue"]);
    } finally { h.close(); }
  });

  it("keeps the source usable when candidate settings subscription fails", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    const next = new NextFakeEngine();
    const settings = { onSettingsApplied: () => { throw new Error("settings unavailable"); } } as unknown as EngineSettingsSeam;
    const h = createHarness({ steps: [], engine: oldEngine, switchEngineFactory: async () => ({ engine: next, engineSettings: settings }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "settings-failure", engine: "codex", model: "test-model" });
      expect(await h.waitFor(isEngineSwitchFailed)).toMatchObject({ reason: expect.stringContaining("settings unavailable") });
      expect(next.disposeReasons).toEqual(["session-close"]);
      expect(oldEngine.disposeReasons).toEqual([]);
      h.send({ type: "user_message", requestId: "after-settings-failure", text: "continue" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(oldEngine.inputs).toEqual(["continue"]);
    } finally { h.close(); }
  });

  it("factory absent: the message is refused with the explicit unavailability reason", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw5", engine: "codex", model: "test-model" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed.reason).toBe("engine switch is not available in this host");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("import prompt: the new engine's FIRST runTurn receives the rendered header, the second gets the raw text", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw6", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);

      h.send({ type: "user_message", requestId: "r1", text: "my typed message" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(next.inputs).toHaveLength(1);
      const firstInput = next.inputs[0] ?? "";
      expect(firstInput.startsWith("Session continued in this codex engine")).toBe(true);
      expect(firstInput).toContain("# user first seeded turn");
      expect(firstInput).toContain("# assistant seeded answer");
      // The import is PREPENDED: the user's own message still reaches the engine.
      expect(firstInput.endsWith("# user (current message)\nmy typed message")).toBe(true);

      // Second turn: raw user text, no header — the import was strictly one-shot.
      h.send({ type: "user_message", requestId: "r2", text: "plain follow-up" });
      await h.waitUntil(() => next.inputs.length === 2 && h.received.filter(agentEventOf("loop_end")).length >= 2);
      const secondInput = next.inputs[1] ?? "";
      expect(secondInput).toBe("plain follow-up");
      expect(secondInput.startsWith("Session continued")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("schema: malformed switches fail closed and only bounded request ids receive a reply", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const before = h.received.length;
      // Malformed on purpose: missing requestId -> zod fail-closed drop, no reply.
      h.send({ type: "engine_switch_request", engine: "codex", model: "test-model" } as unknown as UiToHostMessage);
      h.send({ type: "engine_switch_request", requestId: "", engine: "codex", model: "test-model" } as unknown as UiToHostMessage);
      h.send({ type: "engine_switch_request", requestId: "r", engine: "gpt", model: "test-model" } as unknown as UiToHostMessage);

      await h.waitFor(isEngineSwitchFailed);
      await h.flush();
      const arrivals = h.received.slice(before).filter((m) => isEngineSwitched(m) || isEngineSwitchFailed(m));
      expect(arrivals).toEqual([{type:"engine_switch_failed",requestId:"r",reason:"Invalid engine switch selection."}]);
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });
  it("shutdown racing the factory: the switched-to engine is disposed, never orphaned", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    let resolveFactory!: (engine: SessionEngine) => void;
    let factoryCalled = false;
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: () => {
        factoryCalled = true;
        return new Promise<SessionEngine>((resolve) => (resolveFactory = resolve));
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw7", engine: "codex", model: "test-model" });
      for (let i = 0; i < 100 && !factoryCalled; i++) await new Promise((r) => setTimeout(r, 5));
      expect(factoryCalled).toBe(true);
      const shutdown = h.session.shutdown();
      resolveFactory(next);
      await shutdown;
      expect(next.disposeReasons).toEqual(["host-shutdown"]);
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
    } finally {
      h.close();
    }
  });

  it("permission mode survives a swap between core-permission engines", async () => {
    const corePerms = { ...NO_CORE_CAPS, supportsCorePermissions: true };
    class ModalEngine extends NextFakeEngine {
      override readonly capabilities = corePerms;
      current: PermissionMode = "build";
      override mode(): PermissionMode {
        return this.current;
      }
      setMode(mode: PermissionMode): void {
        this.current = mode;
      }
    }
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    Object.defineProperty(oldEngine, "capabilities", { value: corePerms });
    oldEngine.mode = () => "plan";
    const next = new ModalEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw8", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      expect(next.current).toBe("plan");
    } finally {
      h.close();
    }
  });

  it("prefers the old engine's live transcript over its boot snapshot", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    (oldEngine as unknown as { readTranscript: () => Promise<readonly HistoryItem[]> }).readTranscript = async () => seededHistory();
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw9", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(next.inputs[0]).toContain("# user first seeded turn");
    } finally {
      h.close();
    }
  });

  it("refuses a switch when the live transcript cannot be read", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    (oldEngine as unknown as { readTranscript: () => Promise<readonly HistoryItem[]> }).readTranscript = async () => { throw new Error("read failed"); };
    let factoryCalled = false;
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => { factoryCalled = true; return new NextFakeEngine(); } });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "read-failure", engine: "codex", model: "test-model" });
      expect(await h.waitFor(isEngineSwitchFailed)).toMatchObject({ requestId: "read-failure", reason: expect.stringContaining("read failed") });
      expect(factoryCalled).toBe(false);
      expect(oldEngine.disposeReasons).toEqual([]);
      h.send({ type: "user_message", requestId: "after-failure", text: "continue" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(oldEngine.inputs).toEqual(["continue"]);
    } finally {
      h.close();
    }
  });

  it("empty import is announced honestly", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw10", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      const notice = engineNoticeEvents(h.received)[0];
      expect(notice?.event.type === "engine_notice" ? notice.event.message : "").toContain("no conversation history could be imported");
    } finally {
      h.close();
    }
  });

  // cross-review (finding 1): two legal switches with no turn in
  // between. The second switch must carry the PRE-SWITCH transcript forward,
  // not re-read the first switched-to engine's (empty-by-construction) history.
  it("double switch with no turn in between keeps the pre-switch transcript for the next engine", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const codex = new NextFakeEngine();
    // Runtime id "claude" — the cast keeps the shared fake's shape without a third class.
    const claude = Object.assign(new NextFakeEngine(), { id: "claude" }) as unknown as NextFakeEngine;
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async (id) => (id === "codex" ? codex : claude) as SessionEngine,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "dsw1", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);
      h.send({ type: "engine_switch_request", requestId: "dsw2", engine: "claude", model: "test-model" });
      await h.waitFor((m): m is Of<"engine_switched"> => isEngineSwitched(m) && m.requestId === "dsw2");

      h.send({ type: "user_message", requestId: "r1", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      const firstInput = claude.inputs[0] ?? "";
      expect(firstInput).toContain("# user first seeded turn");
      expect(firstInput).toContain("# assistant seeded answer");
      expect(firstInput).toContain("Conversation excerpts from 2 items; non-text content may be omitted.");

      // The reload snapshot still carries the seeded transcript.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isSessionHistory));
      const handshake = h.received.slice(before).find(isSessionHistory);
      expect(handshake?.items.map((i) => i.id)).toEqual(["seed-1", "seed-2"]);
    } finally {
      h.close();
    }
  });

  // cross-review (finding 3): a renderer reload after a switch
  // must not replay the pre-switch turns' stream events on top of the
  // switch-time transcript snapshot (which already carries them).
  it("reload after a switch does not replay pre-switch turns on top of the snapshot", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const codex = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => codex });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r0", text: "before the switch" });
      await h.waitFor(agentEventOf("loop_end"));
      const preSwitchTurnIds = new Set(
        h.received.flatMap((m) => (m.type === "agent_event" && m.turnId !== ENGINE_SWITCH_TURN_ID ? [m.turnId] : [])),
      );
      expect(preSwitchTurnIds.size).toBeGreaterThan(0);

      h.send({ type: "engine_switch_request", requestId: "rl1", engine: "codex", model: "test-model" });
      await h.waitFor(isEngineSwitched);

      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isSessionHistory));
      // The replay rides AFTER session_history; wait for the handshake's last
      // trailing message so the whole re-post has been delivered.
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "background_children"));
      const replayed = h.received
        .slice(before)
        .filter((m) => m.type === "agent_event" && preSwitchTurnIds.has(m.turnId));
      expect(replayed).toEqual([]);
    } finally {
      h.close();
    }
  });
});

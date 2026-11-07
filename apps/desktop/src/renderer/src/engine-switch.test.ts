import { describe, expect, it } from "vitest";
import { createDesktopStore } from "./store.js";
import { engineSwitchChoices, ENGINE_SWITCH_CONSEQUENCE } from "./components/EngineSwitchPicker.js";
import type { EngineSwitchProjection } from "../../shared/protocol.js";
import { rewriteToastText } from "./toasts.js";

const projection: EngineSwitchProjection = { engine: null, shell: null, model: "chosen", mode: "plan", reasoningEffort: "off", imageInput: false, imageFallback: false, contextWindowAssumed: false, modelSettingsConnectionId: "connection", steering: null, orchestration: { enabled: false, available: false }, pinnedConnection: { connectionId: "connection", providerId: "custom" } };
function ready() {
  const store = createDesktopStore();
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/workspace", sessionId: "session", model: "old", mode: "build", engineSwitch: { enabled: true, generation: 4 } });
  return store;
}

describe("correlated engine selection", () => {
  it("retains the original refusal for diagnostics and presents a readable toast after releasing pending", () => {
    const store = ready();
    store.getState().beginEngineSwitch("pick", {engine:"codex",model:"chosen"});
    store.getState().applyHostMessage({type:"engine_switch_failed",requestId:"pick",generation:4,reason:"stale host generation"});
    expect(store.getState().pendingEngineSwitch).toBeNull();
    expect(store.getState().model).toBe("old");
    const notice = store.getState().notice!;
    expect(notice).toEqual({kind:"engine_switch_failed",text:"stale host generation"});
    expect(rewriteToastText(notice.kind,notice.text)).toBe("The session reconnected. Try switching again.");
    expect(store.getState().beginEngineSwitch("retry", {engine:"codex",model:"chosen"})).toBe(4);
  });

  it.each(["setHostExited","setAwaitingPort","setPortClosed","setAwaitingHostReady"] as const)("releases pending selection on %s and permits a retry after reconnect", transition => {
    const store = ready();
    const target = {engine:"codex" as const,model:"chosen"};
    store.getState().beginEngineSwitch("pick",target);
    store.getState()[transition]();
    expect(store.getState().pendingEngineSwitch).toBeNull();
    expect(store.getState().model).toBe("old");
    store.getState().applyHostMessage({type:"engine_switched",engine:"codex",previousEngine:"core",requestId:"pick",generation:4,projection});
    expect(store.getState().model).toBe("old");
    store.getState().applyHostMessage({type:"host_ready",workspace:"/workspace",sessionId:"session",model:"old",mode:"build",engineSwitch:{enabled:true,generation:5}});
    expect(store.getState().beginEngineSwitch("retry",target)).toBe(5);
  });

  it("releases the old generation and ignores its replies after a new request", () => {
    const store = ready();
    const target = {engine:"codex" as const,model:"chosen"};
    store.getState().beginEngineSwitch("pick",target);
    store.getState().applyHostMessage({type:"host_ready",workspace:"/workspace",sessionId:"session",model:"old",mode:"build",engineSwitch:{enabled:true,generation:5}});
    expect(store.getState().pendingEngineSwitch).toBeNull();
    expect(store.getState().beginEngineSwitch("pick",target)).toBe(5);
    store.getState().applyHostMessage({type:"engine_switch_failed",requestId:"pick",generation:4,reason:"stale host generation"});
    expect(store.getState().pendingEngineSwitch?.generation).toBe(5);
  });

  it("keeps the old selection pending and rejects unrelated acknowledgements", () => {
    const store = ready();
    expect(store.getState().beginEngineSwitch("pick", { engine: "codex", model: "chosen" })).toBe(4);
    expect(store.getState().model).toBe("old");
    expect(store.getState().beginEngineSwitch("duplicate", { engine: "claude", model: "sonnet" })).toBeNull();
    store.getState().applyHostMessage({ type: "engine_switched", engine: "codex", previousEngine: "core", requestId: "other", generation: 4, projection });
    store.getState().applyHostMessage({ type: "engine_switch_failed", requestId: "pick", generation: 3, reason: "stale" });
    expect(store.getState().pendingEngineSwitch?.requestId).toBe("pick");
    expect(store.getState().model).toBe("old");
    store.getState().applyHostMessage({ type: "engine_switch_failed", requestId: "pick", generation: 4, reason: "unavailable" });
    expect(store.getState().pendingEngineSwitch).toBeNull();
    expect(store.getState().model).toBe("old");
  });

  it("replaces the full projection atomically without clearing transcript", () => {
    const store = ready();
    store.setState({ imageInput: true, imageFallback: true, contextWindowAssumed: true, contextUsage: { estimatedTokens: 12, budgetTokens: 20, source: "provider" }, transcript: [{ kind: "user_text", id: "human", text: "keep me" }] });
    store.getState().beginEngineSwitch("pick", { engine: "codex", model: "chosen" });
    store.getState().applyHostMessage({ type: "engine_switched", engine: "codex", previousEngine: "core", requestId: "pick", generation: 4, projection });
    const { orchestration, ...fields } = projection;
    expect(store.getState()).toMatchObject({ ...fields, orchestrateActive: orchestration.enabled, contextUsage: null, pendingEngineSwitch: null, transcript: [{ id: "human", text: "keep me" }] });
  });

  it("renders one boundary per request across replay and supports repeated engine pairs", () => {
    const store = ready();
    const marker = { type: "agent_event" as const, turnId: "engine-switch", boundaryId: "one", event: { type: "engine_notice" as const, level: "info" as const, message: ENGINE_SWITCH_CONSEQUENCE } };
    store.getState().applyHostMessage(marker);
    store.getState().applyHostMessage(marker);
    store.getState().applyHostMessage({ ...marker, boundaryId: "two" });
    expect(store.getState().transcript.filter(block => block.kind === "engine_boundary")).toHaveLength(2);
  });

  it("is disabled by default and refuses child, busy and approval surfaces", () => {
    const store = createDesktopStore();
    const target = { engine: "codex" as const, model: "chosen" };
    expect(store.getState().beginEngineSwitch("off", target)).toBeNull();
    const active = ready();
    active.setState({ childSurface: true });
    expect(active.getState().beginEngineSwitch("child", target)).toBeNull();
    active.setState({ childSurface: false, turn: { status: "running", requestId: "turn", turnId: "turn" } });
    expect(active.getState().beginEngineSwitch("busy", target)).toBeNull();
  });

  it("offers models only for other ready engines, with explicit import consequences", () => {
    expect(engineSwitchChoices("core", [], null, [{ id: "chosen", label: "Chosen" }])).toEqual([]);
    expect(engineSwitchChoices("core", ["core", "codex"], null, [{ id: "chosen", label: "Chosen" }])).toEqual([{ label: "Codex · Chosen", target: { engine: "codex", model: "chosen" } }]);
    expect(engineSwitchChoices("codex", ["codex"], null, [{ id: "chosen", label: "Chosen" }])).toEqual([]);
    expect(ENGINE_SWITCH_CONSEQUENCE).toContain("text will be imported");
    expect(ENGINE_SWITCH_CONSEQUENCE).toContain("context will not be transferred");
  });
});

it("uses the confirmed Claude draft catalog in the engine switch picker", () => {
  expect(engineSwitchChoices("core", ["claude"], null, [], [{ id: "account-model", label: "Account model 6.0" }])).toEqual([
    { label: "Claude · Account model 6.0", target: { engine: "claude", model: "account-model" } },
  ]);
});

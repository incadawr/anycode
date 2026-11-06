import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { formatChildTaskNotification, mapChildRunStatusToNotification } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { CHILD_RUN_EVENT_TYPE, parseChildSpawnRequest, type ChildRunEvent, type ChildSpawnRequest } from "../shared/child-sessions.js";
import { createDesktopStore } from "../renderer/src/store.js";
import { createTabsStore } from "../renderer/src/tabs-store.js";
import { cloneDefaults } from "../settings/schema.js";
import { ChildReportQueue } from "./child-report-queue.js";
import { createChildSessionPort } from "./child-session-port.js";
import { createForeignOrchestrationComposition } from "./foreign-orchestration-composition.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { RoleHealthCache } from "./role-route.js";
import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { createHarness, finishStep, nodeWirePort } from "./test-harness.js";

// CLI turns and main child events are scripted; admission, routing, reports and
// renderer persistence/dispatch use their production implementations.
async function rig(engine: "core" | "codex" | "claude") {
  const saved = new Map<string, string>();
  let failSave = false;
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failSave) throw new Error("quota"); saved.set(key, value); },
    removeItem: (key: string) => saved.delete(key),
  });
  let sendReport: (m: HostToUiMessage) => void = () => {};
  const reports = new ChildReportQueue({ sendDirect: m => sendReport(m) });
  const h = createHarness({ steps: [finishStep()], mode: "build", pendingChildReports: reports });
  sendReport = m => h.outbound.sendDirect(m);
  let release = () => {};
  let applying = false;
  Object.defineProperty(h.engine, "id", { value: engine });
  if (engine !== "core") Object.defineProperty(h.engine, "orchestrationPolicy", { value: {
    availability: () => ({ supported: true }),
    apply: async (enabled: boolean, baseAuthority: unknown) => {
      applying = true;
      await new Promise<void>(resolve => { release = resolve; });
      applying = false;
      return { enabled, baseAuthority };
    },
  } });
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "api", providerId: "custom", model: "child-model" }];
  settings.provider.activeConnectionId = "api";
  const health = new RoleHealthCache();
  const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {},
    deliver: (outcome, req) => reports.add(req.spawnToolCallId, formatChildTaskNotification({ taskId: req.spawnToolCallId, toolUseId: req.spawnToolCallId, agentId: outcome.childSessionId, subagentType: req.agentType, status: mapChildRunStatusToNotification(outcome.status, false), summary: outcome.finalText })),
    report: (id, text, meta) => reports.add(id, text, meta),
  });
  const composition = createForeignOrchestrationComposition({ settings: () => settings, profiles: async () => ({ profiles: [], problems: [] }), projectRoot: "/work", preset: () => "ask", health, routed });
  const sent: unknown[] = [];
  const spawns: ChildSpawnRequest[] = [];
  let listener!: (event: ChildRunEvent) => void;
  const port = createChildSessionPort({ parentSessionId: "parent", getPermissionMode: composition.childMode,
    subscribe: cb => { listener = cb; return () => {}; },
    send: message => { sent.push(message); const req = parseChildSpawnRequest(message); if (req) spawns.push(req); },
    onDetachedTerminal: routed.onTerminal,
  });
  routed.attach(port);
  bindRuntimeOrchestration(h.engine, { ownerSessionId: h.session.communicationStatus().sessionId, port, baseMode: composition.childMode, capture: composition.captureMode, clear: composition.clearBaseAuthority });
  const { createTabRegistry } = await import("../renderer/src/" + "tab-registry.js");
  const registries: ReturnType<typeof createTabRegistry>[] = [];
  const channels: MessageChannel[] = [];
  const frames: UiToHostMessage[] = [];
  let dropAdmission = false;
  let delayAdmission = false;
  const delayed: Array<() => void> = [];
  function connect() {
    const registry = createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: fn => fn() }));
    registries.push(registry);
    const channel = new MessageChannel(); channels.push(channel);
    const wire = nodeWirePort(channel.port2);
    h.session.bindPort({ ...wire, onMessage: cb => wire.onMessage(raw => { const m = raw as UiToHostMessage; frames.push(m); if (m.type === "user_message" && delayAdmission) delayed.push(() => cb(m)); else if (!(dropAdmission && m.type === "user_message")) cb(m); }) });
    registry.registerPort("root", "/work", channel.port1 as never);
    return { registry, store: registry.getStore("root")! as ReturnType<typeof createDesktopStore>, send: (m: UiToHostMessage) => channel.port1.postMessage(m) };
  }
  let ui = connect();
  await vi.waitFor(() => expect(ui.store.getState().connection).toBe("ready"));
  async function toggle(enabled: boolean) {
    const requestId = `toggle-${frames.length}`;
    const connectionId = ui.store.getState().beginOrchestrationToggle(requestId)!;
    ui.send({ type: "set_orchestrate", requestId, connectionId, enabled });
    if (engine !== "core") await vi.waitFor(() => expect(applying).toBe(true));
  }
  async function stable(enabled: boolean) {
    release();
    await vi.waitFor(() => expect(ui.store.getState().orchestration.posture).toBe(enabled ? "on" : "off"));
  }
  async function spawn(id: string, detach = true, role = "executor", signal?: AbortSignal) {
    const result = composition.call({ agent_type: role, description: "work", prompt: "work", detach }, { catalog: await composition.catalog(), port, spawnToolCallId: id, signal });
    await vi.waitFor(() => expect(spawns.some(s => s.spawnToolCallId === id)).toBe(true));
    const req = spawns.find(s => s.spawnToolCallId === id)!;
    listener({ type: CHILD_RUN_EVENT_TYPE, kind: "accepted", requestId: req.requestId, childSessionId: `child-${id}`, childTabId: `tab-${id}`, model: "child-model" });
    return { result: detach ? await result : result, req };
  }
  function terminal(req: ChildSpawnRequest, status: "completed" | "error" | "cancelled" | "max_turns" = "completed") {
    listener({ type: CHILD_RUN_EVENT_TYPE, kind: "terminal", requestId: req.requestId, childSessionId: `child-${req.spawnToolCallId}`, status, finalText: "child result", turns: 1, toolCalls: 0, truncated: false, durationMs: 1 });
  }
  return { h, port, sent, spawns, reports, frames, composition, spawn, terminal, toggle, stable,
    unobservedToggle: async (enabled: boolean) => {
      ui.send({ type: "set_orchestrate", requestId: "unobserved", connectionId: ui.store.getState().orchestration.protocol!.connectionId, enabled });
      await vi.waitFor(() => expect(applying).toBe(true));
    },
    delayAdmission: () => { delayAdmission = true; },
    releaseAdmissions: () => { delayAdmission = false; for (const deliver of delayed.splice(0)) deliver(); },
    get ui() { return ui; }, failSave: (value: boolean) => { failSave = value; }, dropAdmission: (value: boolean) => { dropAdmission = value; },
    reload: async (ready = true) => { ui = connect(); await vi.waitFor(() => expect(ready ? ui.store.getState().connection === "ready" : ui.store.getState().orchestrationDeliveries.length > 0).toBe(true)); },
    close: async () => { release(); port.cancelAllBackgroundChildren(); for (const registry of registries) registry.disposeTab("root"); for (const c of channels) { c.port1.close(); c.port2.close(); } await h.session.shutdown(); h.close(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(["codex", "claude", "core"] as const)("%s composed report delivery", engine => {
  it("keeps an OFF detached report pending across failed saves and reload, then acknowledges and deduplicates", async () => {
    const r = await rig(engine);
    try {
      await r.toggle(true); await r.stable(true);
      const { req } = await r.spawn("detached");
      expect(req).toMatchObject({ connectionId: "api", model: "child-model", permissionMode: "build", detach: true });
      await r.toggle(false); await r.stable(false);
      // Hold admission while inspecting persistence, including after a reload.
      r.dropAdmission(true);
      r.failSave(true);
      r.terminal(req);
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries.length + r.ui.store.getState().promptQueue.length).toBeGreaterThan(0));
      expect(r.frames.filter(m => m.type === "child_report_ack")).toHaveLength(0);
      expect(r.reports.snapshot().reports).toHaveLength(1);
      await r.reload(false);
      expect(r.reports.snapshot().reports).toHaveLength(1);
      r.failSave(false);
      await r.reload();
      await vi.waitFor(() => expect(r.reports.snapshot().reports).toHaveLength(0));
      const state = r.ui.store.getState();
      expect([...state.promptQueue, ...state.orchestrationDeliveries].filter(item => item.originId === "detached")).toHaveLength(1);
      await r.reload();
      expect(r.frames.filter(m => m.type === "user_message" && m.origin === "system")).toHaveLength(1);
      expect(r.ui.store.getState().orchestrationDeliveries).toMatchObject([{ originId: "detached", status: "unknown" }]);
    } finally { await r.close(); }
  });

  it.each([true, false])("holds reports through restart to enabled=%s and accepts each origin once", async enabled => {
    const r = await rig(engine);
    try {
      if (!enabled) { await r.toggle(true); await r.stable(true); }
      const { req } = await r.spawn("transition");
      await r.toggle(enabled);
      r.terminal(req);
      if (engine !== "core") {
        await vi.waitFor(() => expect(r.ui.store.getState().promptQueue).toHaveLength(1));
        expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(0);
      }
      await r.stable(enabled);
      await vi.waitFor(() => expect(r.frames.filter(m => m.type === "user_message" && m.origin === "system")).toHaveLength(1));
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[0]?.terminalReason).toBe("completed"));
      r.reports.add("transition", "duplicate");
      await vi.waitFor(() => expect(r.reports.snapshot().reports).toHaveLength(0));
      await r.reload();
      expect(r.frames.filter(m => m.type === "user_message" && m.origin === "system")).toHaveLength(1);
    } finally { await r.close(); }
  });

  it.skipIf(engine === "core").each([true, false])("retries explicit pre-accept refusal after stable enabled=%s with the same origin", async enabled => {
    const r = await rig(engine);
    try {
      if (!enabled) { await r.toggle(true); await r.stable(true); }
      const { req } = await r.spawn("race");
      r.delayAdmission();
      r.terminal(req);
      await vi.waitFor(() => expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(1));
      await r.unobservedToggle(enabled);
      r.releaseAdmissions();
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", originId: "race", retryAfterPosture: true }));
      expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(1);
      if (!enabled) await r.reload();
      await r.stable(enabled);
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[1]?.terminalReason).toBe("completed"));
      expect(r.ui.store.getState().orchestrationDeliveries).toMatchObject([{ status: "rejected", originId: "race" }, { status: "finished", originId: "race" }]);
      expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(2);
      await r.reload();
      expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(2);
    } finally { await r.close(); }
  });

  it("cascades synchronous cancellation while admitted detached work survives parent cancellation", async () => {
    const r = await rig(engine);
    try {
      const detachedAbort = new AbortController();
      const detached = await r.spawn("background", true, "executor", detachedAbort.signal);
      detachedAbort.abort();
      expect(r.port.hasRunningChildren()).toBe(true);
      expect(r.sent.filter(m => (m as { type: string }).type === "anycode:child-run-cancel")).toHaveLength(0);
      const syncAbort = new AbortController();
      const sync = await r.spawn("foreground", false, "executor", syncAbort.signal);
      syncAbort.abort();
      r.terminal(sync.req, "cancelled");
      await sync.result;
      expect(r.sent).toContainEqual(expect.objectContaining({ type: "anycode:child-run-cancel", requestId: sync.req.requestId }));
      expect(r.port.hasRunningChildren()).toBe(true);
      r.terminal(detached.req);
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[0]?.terminalReason).toBe("completed"));
    } finally { await r.close(); }
  });

  it.each(["error", "cancelled", "max_turns"] as const)("wakes with honest child failure status %s", async status => {
    const r = await rig(engine);
    try {
      const { req } = await r.spawn(`failure-${status}`);
      r.terminal(req, status);
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[0]?.terminalReason).toBe("completed"));
      const inputs = r.frames.filter((m): m is Extract<UiToHostMessage, { type: "user_message" }> => m.type === "user_message" && m.origin === "system");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.text).toContain(status === "cancelled" ? "cancelled" : "failed");
      expect(inputs[0]!.text).toContain(`child-failure-${status}`);
      expect(inputs[0]!.text).not.toContain("<status>completed</status>");
    } finally { await r.close(); }
  });

  it("queues concurrent reports without steering or losing an origin", async () => {
    const r = await rig(engine);
    try {
      const first = await r.spawn("first");
      const second = await r.spawn("second");
      r.delayAdmission();
      r.terminal(first.req);
      await vi.waitFor(() => expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(1));
      r.terminal(second.req);
      await vi.waitFor(() => expect(r.ui.store.getState().promptQueue).toHaveLength(1));
      r.releaseAdmissions();
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries.filter(item => item.terminalReason === "completed")).toHaveLength(2));
      expect(r.frames.filter(m => m.type === "user_message")).toHaveLength(2);
      expect(r.frames.filter(m => m.type === "steer_message")).toHaveLength(0);
      expect(r.ui.store.getState().orchestrationDeliveries.map(item => item.originId)).toEqual(["first", "second"]);
    } finally { await r.close(); }
  });

  it("preserves restricted routing and rejects spoofed terminal ownership", async () => {
    const r = await rig(engine);
    try {
      const { req } = await r.spawn("restricted", true, "reviewer");
      expect(req).toMatchObject({ restrictions: { readOnly: true }, permissionMode: "build", connectionId: "api" });
      r.terminal({ ...req, requestId: "foreign" });
      expect(r.reports.snapshot().reports).toHaveLength(0);
      expect(r.port.hasRunningChildren()).toBe(true);
      r.port.cancelBackgroundChild("child-restricted");
      expect(r.sent).toContainEqual(expect.objectContaining({ type: "anycode:child-run-cancel", requestId: req.requestId }));
      r.terminal(req, "cancelled");
      await vi.waitFor(() => expect(r.ui.store.getState().orchestrationDeliveries[0]?.terminalReason).toBe("completed"));
    } finally { await r.close(); }
  });
});

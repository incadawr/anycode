import { describe, expect, it, vi } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { SessionPermissionRules, bashTool } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { createTabsStore } from "../renderer/src/tabs-store.js";
import { createDesktopStore } from "../renderer/src/store.js";
import { FakeAppServer } from "./engines/codex/test-app-server.js";
import { createNativeCodexSession } from "./engines/codex/codex-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { MemFs, nodeWirePort } from "./test-harness.js";
import { formatChildApprovalNotice, formatChildStallNotice } from "@anycode/core";
import { CHILD_RUN_EVENT_TYPE, parseChildRunEvent, parseChildSpawnRequest, type ChildRunEvent, type ChildSpawnRequest } from "../shared/child-sessions.js";
import { cloneDefaults } from "../settings/schema.js";
import { ChildReportQueue } from "./child-report-queue.js";
import { createChildSessionPort } from "./child-session-port.js";
import { createForeignOrchestrationComposition } from "./foreign-orchestration-composition.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { RoleHealthCache } from "./role-route.js";
import { CodexDynamicToolBridge } from "./engines/codex/dynamic-tool-bridge.js";

function rig() {
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "a", providerId: "custom", model: "model-a" }, { id: "b", providerId: "other", model: "model-b" }];
  settings.provider.activeConnectionId = "a";
  const sent: ChildSpawnRequest[] = [];
  const reports: Array<{ type: string; id?: string; text?: string }> = [];
  let forwardReport: (message: import("../shared/protocol.js").HostToUiMessage) => void = () => {};
  const queue = new ChildReportQueue({ sendDirect: message => { reports.push(message); forwardReport(message); } });
  const listeners = new Set<(event: ChildRunEvent) => void>();
  const emit = (raw: unknown) => { const event = parseChildRunEvent(raw); if (!event) throw new Error("invalid scripted event"); for (const listener of listeners) listener(event); };
  const health = new RoleHealthCache();
  const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: (outcome) => queue.add(outcome.spawnToolCallId, outcome.finalText, { status: outcome.status, durationMs: outcome.durationMs }), report: (id, text, meta) => queue.add(id, text, meta) });
  let preset = "full-access";
  const composition = createForeignOrchestrationComposition({ settings: () => settings, profiles: async () => [], projectRoot: "/project", preset: () => preset, health, routed });
  composition.captureBaseAuthority(preset);
  preset = "read-only";
  const port = createChildSessionPort({ parentSessionId: "parent", getPermissionMode: composition.childMode, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, send: message => { const spawn = parseChildSpawnRequest(message); if (spawn) sent.push(spawn); }, onDetachedTerminal: routed.onTerminal, stallTimeoutMs: 100,
    onDetachedApproval: (ask, req, childSessionId) => queue.upsert(`approval:${req.spawnToolCallId}`, formatChildApprovalNotice({ taskId: req.spawnToolCallId, toolUseId: req.spawnToolCallId, agentId: childSessionId, subagentType: req.agentType, description: req.description, toolName: ask.toolName, subject: ask.subject, askTimeoutMs: 1000 })),
    onDetachedApprovalSettled: req => queue.ack(`approval:${req.spawnToolCallId}`),
    onDetachedStall: (report, req, childSessionId) => queue.upsert(`stall:${req.spawnToolCallId}`, formatChildStallNotice({ taskId: req.spawnToolCallId, toolUseId: req.spawnToolCallId, agentId: childSessionId, subagentType: report.agentType, description: report.description, silentMs: report.silentMs, waitingForApproval: report.waitingForApproval })) });
  routed.attach(port);
  const bridge = new CodexDynamicToolBridge([{ name: "executor", description: "executor", systemPrompt: "" }, { name: "reviewer", description: "reviewer", systemPrompt: "" }], port, undefined, composition.catalog, undefined, composition.call);
  const response = { result: vi.fn(), error: vi.fn() };
  function dispatch(id: string, role = "executor", active = { threadId: "thread", turnId: "turn" }) {
    return bridge.handle({ id: 1, method: "item/tool/call", params: { ...active, callId: id, tool: "anycode_agent", arguments: { agent_type: role, description: "work", prompt: "do work" } } }, response, active, () => {});
  }
  function accepted(spawn: ChildSpawnRequest) { emit({ type: CHILD_RUN_EVENT_TYPE, kind: "accepted", requestId: spawn.requestId, childSessionId: "child", childTabId: "tab", model: spawn.model ?? "native" }); }
  function terminal(spawn: ChildSpawnRequest, status: "completed" | "error" | "cancelled" | "max_turns", text: string) { emit({ type: CHILD_RUN_EVENT_TYPE, kind: "terminal", requestId: spawn.requestId, status, finalText: text, truncated: status === "max_turns", turns: 3, toolCalls: 0, durationMs: 10, childSessionId: "child" }); }
  return { settings, sent, reports, queue, response, dispatch, accepted, terminal, emit, bridge, forwardReports: (sink: typeof forwardReport) => { forwardReport = sink; } };
}

describe("Codex role dispatch through the child wire", () => {
  it("admits detached work before terminal and retains base authority across the overlay", async () => {
    const r = rig();
    const pending = r.dispatch("call-1");
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const spawn = r.sent[0]!;
    expect(spawn).toMatchObject({ agentType: "executor", connectionId: "a", model: "model-a", permissionMode: "yolo", detach: true });
    r.accepted(spawn);
    await pending;
    expect(r.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(r.reports).toHaveLength(0);
    r.terminal(spawn, "completed", "finished work");
    expect(r.reports).toEqual([expect.objectContaining({ type: "child_report", id: "call-1", text: "finished work" })]);
    r.queue.ack("call-1");
    r.queue.resendAll();
    expect(r.reports).toHaveLength(1);
  });

  it.each(["error", "cancelled", "max_turns"] as const)("delivers %s terminal after admission", async status => {
    const r = rig(); const pending = r.dispatch("call-1");
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const spawn = r.sent[0]!; r.accepted(spawn); await pending;
    r.terminal(spawn, status, `${status} details`);
    expect(r.reports[0]).toMatchObject({ id: "call-1", text: `${status} details`, childTerminal: { status } });
  });

  it("reloads role profile for the next wire request", async () => {
    const r = rig();
    r.settings.roleProfiles = { activeId: "one", profiles: [{ id: "one", name: "One", roles: { executor: { primary: { connection: "a", model: "model-a" } } } }, { id: "two", name: "Two", roles: { executor: { primary: { connection: "b", model: "model-b" } } } }], projects: [] };
    const first = r.dispatch("one"); await vi.waitFor(() => expect(r.sent).toHaveLength(1)); r.accepted(r.sent[0]!); await first;
    r.settings.roleProfiles.activeId = "two";
    const second = r.dispatch("two"); await vi.waitFor(() => expect(r.sent).toHaveLength(2)); r.accepted(r.sent[1]!); await second;
    expect(r.sent.map(s => [s.connectionId, s.model])).toEqual([["a", "model-a"], ["b", "model-b"]]);
    r.terminal(r.sent[0]!, "completed", "one"); r.terminal(r.sent[1]!, "completed", "two");
  });
  it("returns a capacity refusal without starting a second child", async () => {
    const r = rig(); const pending = r.dispatch("capacity");
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    r.emit({ type: CHILD_RUN_EVENT_TYPE, kind: "rejected", requestId: r.sent[0]!.requestId, reason: "limit_parent", message: "no room" });
    await pending;
    expect(r.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false, contentItems: [expect.objectContaining({ text: expect.stringContaining("no room") })] }));
    expect(r.sent).toHaveLength(1);
    expect(r.reports).toHaveLength(0);
  });

  it("refuses a native reviewer whose restrictions cannot be enforced before starting a child", async () => {
    const r = rig();
    r.settings.roles = { reviewer: { primary: { engine: "codex" } } };
    await r.dispatch("review", "reviewer");
    expect(r.sent).toHaveLength(0);
    expect(r.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false, contentItems: [expect.objectContaining({ text: expect.stringContaining("cannot enforce") })] }));
  });

  it.each([
    { text: "network error: connection failed", retry: true },
    { text: "tests failed in the child", retry: false },
  ])("only retries infrastructure failures: $text", async ({ text, retry }) => {
    const r = rig();
    r.settings.roles = { executor: { primary: { connection: "a", model: "model-a" }, fallbacks: [{ connection: "b", model: "model-b" }] } };
    const pending = r.dispatch("first"); await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const first = r.sent[0]!; r.accepted(first); await pending;
    r.terminal(first, "error", text);
    if (retry) {
      await vi.waitFor(() => expect(r.sent).toHaveLength(2));
      expect(r.sent[1]).toMatchObject({ connectionId: "b", model: "model-b", detach: true });
      r.accepted(r.sent[1]!);
      await vi.waitFor(() => expect(r.reports).toHaveLength(1));
      r.terminal(r.sent[1]!, "completed", "fallback finished");
      expect(r.reports).toHaveLength(2);
    } else {
      await new Promise(resolve => setImmediate(resolve));
      expect(r.sent).toHaveLength(1);
      expect(r.reports[0]).toMatchObject({ id: "first", text });
    }
  });

  it("delivers approval and stalled-child notices while the detached child remains running", async () => {
    const r = rig(); const pending = r.dispatch("ask");
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const spawn = r.sent[0]!; r.accepted(spawn); await pending;
    r.emit({ type: CHILD_RUN_EVENT_TYPE, kind: "attention", requestId: spawn.requestId, waiting: true, toolName: "Bash", subject: "npm test" });
    expect(r.reports).toContainEqual(expect.objectContaining({ id: "approval:ask", text: expect.stringContaining("npm test") }));
    r.emit({ type: CHILD_RUN_EVENT_TYPE, kind: "attention", requestId: spawn.requestId, waiting: false });
    expect(r.queue.snapshot().reports.some(report => report.id === "approval:ask")).toBe(false);
    await vi.waitFor(() => expect(r.reports).toContainEqual(expect.objectContaining({ id: "stall:ask" })), { timeout: 1000 });
    expect(r.sent).toHaveLength(1);
    r.terminal(spawn, "completed", "done");
  });

});

/** Real renderer queue and Session over a channel; only app-server/main are scripted. */
async function nativeRig() {
  const child = rig();
  const initial = new FakeAppServer();
  initial.threadId = "fresh-thread";
  const original = initial.request.bind(initial);
  initial.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }) => {
    if (method === "config/read") return Promise.resolve({ config: { mcp_servers: {}, features: { multi_agent: true }, sandbox_mode: "workspace-write", approval_policy: "on-request" } } as T);
    if (method === "thread/read") return Promise.resolve({ thread: { id: "fresh-thread", turns: Array.from({ length: 81 }, (_, i) => ({ id: `old-${i}` })) } } as T);
    return original<T>(method, params, opts);
  };
  const { engine } = await createNativeCodexSession(initial, "/work", undefined, { bootRpcMs: 2000 }, undefined, undefined, child.bridge);
  const servers: FakeAppServer[] = [];
  let releaseTransition!: () => void;
  const transitionGate = new Promise<void>(resolve => { releaseTransition = resolve; });
  engine.installOrchestration(() => {
    const server = new FakeAppServer(); server.threadId = "fresh-thread"; servers.push(server);
    server.serverRequestHandler = request => {
      const owner = engine.activeTurnDetails;
      return child.bridge.handle(request, child.response, owner, event => engine.pushBridgeEvent(event, owner));
    };
    const request = server.request.bind(server);
    server.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }) => {
      if (method === "config/read") return Promise.resolve({ config: { mcp_servers: {}, features: { multi_agent: false }, apps: { _default: { enabled: false } }, sandbox_mode: "read-only", approval_policy: "never" } } as T);
      if (method === "thread/resume") { server.calls.push({ method, params }); return Promise.resolve({ thread: { id: "fresh-thread" }, model: "gpt-native", approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } } as T); }
      return request<T>(method, params, opts);
    };
    return { client: server, start: () => transitionGate };
  }, async () => {});
  const outbound = new Outbound(); child.forwardReports(message => outbound.sendDirect(message));
  const broker = new IpcPermissionBroker(message => outbound.emit(message), 25);
  const session = new Session({ outbound, engine, engineSettings: engine, broker, fs: new MemFs(), workspace: "/work", model: "gpt-native", sessionId: "parent", rules: new SessionPermissionRules(), pendingChildReports: { resendAll: () => child.queue.resendAll(), ack: id => child.queue.ack(id) } });
  // The registry imports a TSX component; load it at runtime so the host-only
  // TypeScript project does not compile the renderer JSX graph.
  const { createTabRegistry } = await import("../renderer/src/" + "tab-registry.js");
  const registry = createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: fn => fn() }));
  const frames: UiToHostMessage[] = [];
  const channels: MessageChannel[] = [];
  function connect() {
    const channel = new MessageChannel(); channels.push(channel);
    channel.port2.on("message", (message: UiToHostMessage) => frames.push(message));
    session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));
    registry.registerPort("root", "/work", channel.port1 as never);
    return channel;
  }
  let channel = connect();
  const store = registry.getStore("root")! as ReturnType<typeof createDesktopStore>;
  await vi.waitFor(() => expect(store.getState().connection).toBe("ready"));
  const send = (message: UiToHostMessage) => channel.port1.postMessage(message);
  return { child, initial, servers, session, engine, broker, registry, store, frames, send, releaseTransition,
    reconnect: () => { channel = connect(); },
    close: async () => { releaseTransition(); registry.disposeTab("root"); for (const c of channels) { c.port1.close(); c.port2.close(); } await session.shutdown(); } };
}

describe("native Session, Codex and renderer report queue", () => {
  it("holds a report during a verified transition without steering or disarming unattended approval", async () => {
    const r = await nativeRig();
    try {
      const ask = r.broker.requestPermission({ toolName: "Bash", input: { command: "git status" }, metadata: bashTool.metadata, mode: "build" });
      await ask;
      expect(r.broker.isUnattended).toBe(true);
      const connectionId = r.store.getState().beginOrchestrationToggle("on")!;
      r.send({ type: "set_orchestrate", requestId: "on", enabled: true, connectionId });
      await vi.waitFor(() => expect(r.servers).toHaveLength(1));
      expect(r.store.getState().orchestration.posture).toBe("transitioning");
      r.child.queue.add("transition-report", "report during transition");
      await vi.waitFor(() => expect(r.store.getState().promptQueue.some(p => p.originId === "transition-report")).toBe(true));
      expect(r.frames.filter(f => f.type === "steer_message" || f.type === "user_message")).toHaveLength(0);
      expect(r.initial.turnStartParams()).toHaveLength(0);
      expect(r.broker.isUnattended).toBe(true);
      r.releaseTransition();
      await vi.waitFor(() => expect(r.servers[0]?.turnStartParams()).toHaveLength(1));
      expect(r.broker.isUnattended).toBe(true);
      expect(r.frames.filter(f => f.type === "steer_message")).toHaveLength(0);
      expect(r.frames.filter(f => f.type === "user_message")).toMatchObject([{ origin: "system", text: "report during transition" }]);
      r.servers[0]!.completeTurn("completed");
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("idle"));
    } finally { await r.close(); }
  });

  it("dispatches a role and drains its report once after busy, ack and reconnect, with native context", async () => {
    const r = await nativeRig();
    try {
      const connectionId = r.store.getState().beginOrchestrationToggle("on")!;
      r.send({ type: "set_orchestrate", requestId: "on", enabled: true, connectionId });
      await vi.waitFor(() => expect(r.servers).toHaveLength(1));
      expect(r.store.getState().orchestration.posture).toBe("transitioning");
      r.releaseTransition();
      await vi.waitFor(() => expect(r.store.getState().orchestration.posture).toBe("on"));
      r.send({ type: "user_message", requestId: "task", text: "delegate" });
      const server = r.servers[0]!;
      await vi.waitFor(() => expect(server.turnStartParams()).toHaveLength(1));
      await vi.waitFor(() => expect(r.engine.activeTurnDetails).not.toBeNull());
      await r.broker.requestPermission({ toolName: "Bash", input: { command: "git status" }, metadata: bashTool.metadata, mode: "build" });
      expect(r.broker.isUnattended).toBe(true);
      server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: server.threadId, turnId: server.turnId, tokenUsage: { last: { totalTokens: 13500 }, modelContextWindow: 100000 } } });
      await vi.waitFor(() => expect(r.store.getState().contextUsage).toMatchObject({ estimatedTokens: 13500, budgetTokens: 100000, source: "provider" }));
      const pending = server.serverRequest({ id: 1, method: "item/tool/call", params: { threadId: server.threadId, turnId: server.turnId, callId: "wire-call", tool: "anycode_agent", arguments: { agent_type: "executor", description: "work", prompt: "do work" } } });
      expect(server.serverRequests).toHaveLength(1);
      await vi.waitFor(() => expect(r.child.sent).toHaveLength(1));
      const spawn = r.child.sent[0]!;
      expect(spawn).toMatchObject({ agentType: "executor", detach: true, connectionId: "a" });
      // The role may have its own child budget; it is not a parent turn cap.
      expect(server.turnStartParams()[0]).not.toHaveProperty("maxTurns");
      r.child.accepted(spawn); await pending;
      expect(r.child.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      r.child.terminal(spawn, "completed", "child result");
      await vi.waitFor(() => expect(r.frames).toContainEqual({ type: "child_report_ack", id: "wire-call" }));
      expect(r.store.getState().promptQueue).toContainEqual(expect.objectContaining({ origin: "system", originId: "wire-call" }));
      expect(server.turnStartParams()).toHaveLength(1);
      expect(r.frames.filter(f => f.type === "steer_message")).toHaveLength(0);
      // A duplicate before or after normal ack/rebind has the same renderer id.
      r.child.queue.add("wire-call", "child result");
      await vi.waitFor(() => expect(r.frames.filter(f => f.type === "child_report_ack" && f.id === "wire-call").length).toBeGreaterThanOrEqual(2));
      r.reconnect();
      await vi.waitFor(() => expect(r.store.getState().connection).toBe("ready"));
      server.completeTurn("completed");
      await vi.waitFor(() => expect(server.turnStartParams()).toHaveLength(2));
      expect(server.turnStartParams()[1]).toMatchObject({ threadId: "fresh-thread", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      expect(JSON.stringify(server.turnStartParams()[1])).toContain("child result");
      expect(server.turnStartParams()[1]).not.toHaveProperty("maxTurns");
      expect(r.child.sent).toHaveLength(1);
      expect(r.frames.filter(f => f.type === "user_message" && f.origin === "system")).toHaveLength(1);
      expect(r.broker.isUnattended).toBe(true);
      server.completeTurn("completed");
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("idle"));
      expect(server.turnStartParams()).toHaveLength(2);
    } finally { await r.close(); }
  });
});

import { describe, expect, it, vi } from "vitest";
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
  const queue = new ChildReportQueue({ sendDirect: message => reports.push(message) });
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
  function dispatch(id: string, role = "executor") {
    return bridge.handle({ id: 1, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: id, tool: "anycode_agent", arguments: { agent_type: role, description: "work", prompt: "do work" } } }, response, { threadId: "thread", turnId: "turn" }, () => {});
  }
  function accepted(spawn: ChildSpawnRequest) { emit({ type: CHILD_RUN_EVENT_TYPE, kind: "accepted", requestId: spawn.requestId, childSessionId: "child", childTabId: "tab", model: spawn.model ?? "native" }); }
  function terminal(spawn: ChildSpawnRequest, status: "completed" | "error" | "cancelled" | "max_turns", text: string) { emit({ type: CHILD_RUN_EVENT_TYPE, kind: "terminal", requestId: spawn.requestId, status, finalText: text, truncated: status === "max_turns", turns: 3, toolCalls: 0, durationMs: 10, childSessionId: "child" }); }
  return { settings, sent, reports, queue, response, dispatch, accepted, terminal, emit, bridge };
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

import { describe, expect, it, vi } from "vitest";
import type { SessionSubagentOutcome, SessionSubagentRequest } from "@anycode/core";
import type { ChildSessionPort } from "./child-session-port.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { entryKey, RoleHealthCache } from "./role-route.js";
import { createChildSessionPort } from "./child-session-port.js";
import { CHILD_RUN_EVENT_TYPE, CHILD_SPAWN_REQUEST_TYPE, type ChildRunEvent, type ChildSpawnRequest } from "../shared/child-sessions.js";

describe("routed child snapshots", () => {
  it.each([false, true].flatMap(snapshot => [false, true].flatMap(detach => [
    { snapshot, detach, reason: "not_ready" as const, message: "Agent: this model is not available on the selected connection; select a matching provider/connection.", retry: true },
    { snapshot, detach, reason: "recursion" as const, message: "Permission policy forbids this child; network error", retry: false },
    { snapshot, detach, reason: "not_ready" as const, message: "Permission policy forbids this child; network error", retry: false },
  ])))("handles wire admission rejection $reason with detach=$detach snapshot=$snapshot", async ({ snapshot, detach, reason, message, retry }) => {
    const health = new RoleHealthCache();
    const sent: ChildSpawnRequest[] = [];
    let listener: (event: ChildRunEvent) => void = () => {};
    const composition = createRoutedChildComposition({ health, describeError: String,
      resolve: () => ({ entries: [{ model: "primary" }, { model: "fallback" }], skipped: [] }),
      prepare: req => req, record: () => {}, report: () => {}, deliver: () => {} });
    const port = createChildSessionPort({ parentSessionId: "parent", getPermissionMode: () => "build",
      send: msg => { if (msg.type === CHILD_SPAWN_REQUEST_TYPE) sent.push(msg); },
      subscribe: cb => { listener = cb; return () => {}; }, onDetachedTerminal: composition.onTerminal });
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "executor", description: "task", prompt: "work", spawnToolCallId: "call", model: "primary", routeStamped: true, detach };
    if (snapshot) composition.snapshot(req, { entries: [{ model: "primary" }, { model: "fallback" }], skipped: [] });
    const pending = port.run(req, {});
    listener({ type: CHILD_RUN_EVENT_TYPE, requestId: sent[0]!.requestId, kind: "rejected", reason, message });
    await vi.waitFor(() => expect(sent).toHaveLength(retry ? 2 : 1));
    if (retry) {
      expect(sent[1]).toMatchObject({ model: "fallback", spawnToolCallId: "call" });
      expect(health.snapshot().get(entryKey("executor", { model: "primary" }))).toMatchObject({ failures: 1, lastReason: "model_not_found" });
      listener({ type: CHILD_RUN_EVENT_TYPE, requestId: sent[1]!.requestId, kind: "accepted", childSessionId: "child", childTabId: "tab", model: "fallback" });
      if (detach) {
        expect(await pending).toMatchObject({ background: { reason: "requested" }, childSessionId: "child" });
      } else {
        listener({ type: CHILD_RUN_EVENT_TYPE, requestId: sent[1]!.requestId, kind: "terminal", status: "completed", finalText: "done", truncated: false, turns: 1, toolCalls: 0, durationMs: 1, childSessionId: "child" });
        expect(await pending).toMatchObject({ status: "completed", finalText: "done", childSessionId: "child" });
      }
    } else {
      expect(await pending).toMatchObject({ status: "error", finalText: message });
      expect(health.snapshot().size).toBe(0);
    }
  });
  it("refuses an admission respawn onto an engine entry for a restricted role", async () => {
    const run = vi.fn().mockResolvedValue({ status: "error", finalText: "Agent: this model is not available on the selected connection; select a matching provider/connection.", admissionRejectReason: "not_ready", truncated: false, turns: 0, toolCalls: 0, durationMs: 0, childSessionId: "", parentSessionId: "parent", spawnToolCallId: "call" });
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String,
      resolve: () => ({ entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] }),
      prepare: req => req, record: () => {}, report: () => {}, deliver: () => {} });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "planner", description: "task", prompt: "work", spawnToolCallId: "call", model: "primary", restrictions: { readOnly: true, tools: ["Read"] }, nativeRestrictionsUnsupported: true, routeStamped: true };
    composition.snapshot(req, { entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] });
    const outcome = await port.run(req, {});
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain("planner");
    expect(outcome.finalText).toContain("codex");
    expect(outcome.finalText).toContain("Settings");
  });

  it("still respawns an unrestricted role onto an engine entry", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ status: "error", finalText: "Agent: this model is not available on the selected connection; select a matching provider/connection.", admissionRejectReason: "not_ready", truncated: false, turns: 0, toolCalls: 0, durationMs: 0, childSessionId: "", parentSessionId: "parent", spawnToolCallId: "call" })
      .mockResolvedValueOnce({ status: "completed", finalText: "done", truncated: false, turns: 1, toolCalls: 0, durationMs: 1, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call" });
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String,
      resolve: () => ({ entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] }),
      prepare: req => req, record: () => {}, report: () => {}, deliver: () => {} });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "executor", description: "task", prompt: "work", spawnToolCallId: "call", model: "primary", routeStamped: true };
    composition.snapshot(req, { entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] });
    const outcome = await port.run(req, {});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toMatchObject({ engine: "codex" });
    expect(outcome).toMatchObject({ status: "completed", finalText: "done" });
  });

  it("refuses a detached respawn onto an engine entry for a restricted role and delivers the fix", async () => {
    const run = vi.fn().mockResolvedValue({ status: "completed", turns: 0, background: { reason: "requested" } });
    const deliver = vi.fn();
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String,
      resolve: () => ({ entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] }),
      prepare: req => req, record: () => {}, report: () => {}, deliver });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "planner", description: "task", prompt: "work", spawnToolCallId: "call", model: "primary", restrictions: { readOnly: true, tools: ["Read"] }, nativeRestrictionsUnsupported: true, routeStamped: true, detach: true };
    composition.snapshot(req, { entries: [{ model: "primary" }, { engine: "codex" }], skipped: [] });
    await port.run(req, {});
    composition.onTerminal({ status: "error", finalText: "rate limited (HTTP 429)", turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call" }, req);
    expect(run).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const delivered = deliver.mock.calls[0]![0] as SessionSubagentOutcome;
    expect(delivered.finalText).toContain("planner");
    expect(delivered.finalText).toContain("codex");
    expect(delivered.finalText).toContain("Settings");
  });

  it("uses the route selected before dispatch even if settings change", async () => {
    const run = vi.fn().mockResolvedValue({ status: "completed", turns: 0, background: { reason: "requested" } });
    const resolve = vi.fn(() => ({ entries: [{ model: "changed" }], skipped: [] }));
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String, resolve,
      prepare: (req) => req, record: () => {}, report: () => {}, deliver: () => {} });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "executor", description: "task", prompt: "work", spawnToolCallId: "first", model: "first", maxTurns: 42, restrictions: { readOnly: true, tools: ["Read"] }, routeStamped: true, detach: true };
    composition.snapshot(req, { entries: [{ model: "first" }, { model: "fallback" }], skipped: [] });
    await port.run(req, {});
    expect(resolve).not.toHaveBeenCalled();
    composition.onTerminal({ status: "error", finalText: "rate limited (HTTP 429)", turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "first" }, req);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ model: "fallback", detach: true, maxTurns: 42, restrictions: { readOnly: true, tools: ["Read"] } });
  });

  it.each([
    ["error", "task failed: assertion mismatch"], ["cancelled", "cancelled"], ["max_turns", "rate limited (HTTP 429)"],
  ] as const)("does not retry %s outcomes", async (status, finalText) => {
    const run = vi.fn().mockResolvedValue({ status: "completed", turns: 0, background: { reason: "requested" } });
    const record = vi.fn(); const deliver = vi.fn();
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String, resolve: () => null,
      prepare: req => ({ ...req, maxTurns: 25 }), record, report: () => {}, deliver });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "executor", description: "task", prompt: "work", spawnToolCallId: "first", routeStamped: true, detach: true };
    composition.snapshot(req, { entries: [{ model: "first" }, { model: "fallback" }], skipped: [] });
    await port.run(req, {});
    expect(run.mock.calls[0]![0]).toMatchObject({ maxTurns: 25 });
    expect(record).not.toHaveBeenCalled();
    composition.onTerminal({ status, finalText, turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "first" }, req);
    expect(run).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

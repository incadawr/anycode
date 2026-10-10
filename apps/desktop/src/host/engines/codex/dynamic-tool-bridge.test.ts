import { describe, it, expect, vi } from "vitest";
import type { AgentEvent, SessionSubagentPort } from "@anycode/core";
import { CodexDynamicToolBridge, ANYCODE_AGENT_TOOL, codexAgentPermissionMode } from "./dynamic-tool-bridge.js";

const catalog = [{ name: "glm-lead", model: "glm-5.3", description: "Plan and review", systemPrompt: "" }];
const active = { threadId: "thread-1", turnId: "turn-1" };
const params = { ...active, callId: "call-1", tool: ANYCODE_AGENT_TOOL,
  arguments: { agent_type: "glm-lead", description: "Tiny task", prompt: "Do the task" } };

function setup() {
  const run = vi.fn<SessionSubagentPort["run"]>().mockResolvedValue({
    status: "completed", finalText: "done", turns: 1, toolCalls: 0, truncated: false, durationMs: 1,
    childSessionId: "child-1", parentSessionId: "parent-1", spawnToolCallId: "call-1",
  });
  const bridge = new CodexDynamicToolBridge(catalog, { run });
  const response = { result: vi.fn(), error: vi.fn() };
  const events: AgentEvent[] = [];
  const call = (p: unknown = params, turn: typeof active | null = active) =>
    bridge.handle({ id: 1, method: "item/tool/call", params: p }, response, turn, (event) => events.push(event));
  return { bridge, run, response, events, call };
}

describe("Codex AnyCode dynamic tool", () => {
  it("TASK.218: a completed child's result text carries the child session id + continue_session hint (response AND tool_result)", async () => {
    const s = setup();
    s.run.mockImplementation(async (_req, options) => {
      options?.onProgress?.({ kind: "start", agentType: "glm-lead", description: "d" });
      return { status: "completed", finalText: "done", turns: 1, toolCalls: 0, truncated: false, durationMs: 1,
        childSessionId: "child-1", parentSessionId: "parent-1", spawnToolCallId: "call-1" };
    });
    await s.call();
    expect(s.response.result).toHaveBeenCalledWith({ success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining("Child session id: child-1") }] });
    expect(s.response.result).toHaveBeenCalledWith({ success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining("continue_session") }] });
    const last = s.events.at(-1) as { type: string; outcome: { result?: { output?: string } } };
    expect(last.type).toBe("tool_result");
    expect(last.outcome.result?.output).toContain("Child session id: child-1");
    expect(last.outcome.result?.output).toContain("continue_session");
  });

  it("declares the exact profile catalog and invokes the native session port", async () => {
    const s = setup();
    expect(s.bridge.declarations()[0]).toMatchObject({ type: "function", name: ANYCODE_AGENT_TOOL });
    await s.call();
    expect(s.run.mock.calls[0]![0]).toMatchObject({ agentType: "glm-lead", model: "glm-5.3", spawnToolCallId: "call-1" });
    expect(s.response.result).toHaveBeenCalledWith({ success: true, contentItems: [{ type: "inputText", text: expect.stringContaining("done") }] });
    expect(s.events.filter((e) => e.type === "tool_call")).toHaveLength(1);
    expect(s.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "success", result: { ok: true } } });
  });
  it.each([{ ...params, tool: "other" }, { ...params, threadId: "other" },
    { ...params, turnId: "other" }, { ...params, namespace: "foreign" },
    { ...params, arguments: { agent_type: "glm-lead" } }])("rejects unrelated or malformed requests without spawning", async (p) => {
    const s = setup(); await s.call(p);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
  it("rejects a call when there is no active turn", async () => {
    const s = setup(); await s.call(params, null); expect(s.run).not.toHaveBeenCalled();
  });
  it("Stop cancels the actual child signal and closes the tool card", async () => {
    const s = setup();
    s.run.mockImplementation((_req, options) => new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve({ status: "cancelled", finalText: "cancelled",
        turns: 0, toolCalls: 0, truncated: false, durationMs: 1, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" }));
    }));
    const pending = s.call(); s.bridge.cancel(); await pending;
    expect(s.response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(s.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "cancelled" } });
  });
  it("a duplicate in-flight call cannot spawn a second child", async () => {
    const s = setup();
    let finish!: (value: Awaited<ReturnType<SessionSubagentPort["run"]>>) => void;
    s.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = s.call(); await s.call(); expect(s.run).toHaveBeenCalledTimes(1);
    finish({ status: "completed", finalText: "done", turns: 1, toolCalls: 0, truncated: false, durationMs: 1,
      childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" });
    await first;
  });
});

describe("Codex bridge — detached (background) children", () => {
  it("declares detach for the Codex door", () => {
    const s = setup();
    const decl = s.bridge.declarations()[0] as { inputSchema: { properties: Record<string, { type?: string }> } };
    expect(decl.inputSchema.properties.detach?.type).toBe("boolean");
  });

  it("declares continue_session and passes it to the port as the child to resume", async () => {
    const s = setup();
    const decl = s.bridge.declarations()[0] as { inputSchema: { properties: Record<string, { type?: string }> } };
    expect(decl.inputSchema.properties.continue_session?.type).toBe("string");
    await s.call({ ...params, arguments: { ...params.arguments, detach: true, continue_session: "child-2" } });
    expect(s.run.mock.calls[0]![0]).toMatchObject({ resumeChildSessionId: "child-2", detach: true });
  });

  it("a detach:true call answers at admit, and ending the turn afterwards never reaches the child", async () => {
    const s = setup();
    let childSignal: AbortSignal | undefined;
    s.run.mockImplementation(async (req, options) => {
      childSignal = options?.signal;
      // The host port's detached admit (child-session-port.ts): settles at "accepted".
      return { status: "completed", finalText: "Agent: child session child-2 started in the background.",
        turns: 0, toolCalls: 0, truncated: false, durationMs: 1, childSessionId: "child-2", parentSessionId: "parent-1",
        spawnToolCallId: req.spawnToolCallId };
    });
    await s.call({ ...params, arguments: { ...params.arguments, detach: true } });
    expect(s.run.mock.calls[0]![0]).toMatchObject({ detach: true, spawnToolCallId: "call-1" });
    expect(s.response.result).toHaveBeenCalledWith({ success: true,
      contentItems: [{ type: "inputText", text: "Agent: child session child-2 started in the background.\n\n[Child session id: child-2. Pass it as continue_session in a later agent call to send a follow-up to this same child in its existing conversation.]" }] });
    // The turn ends (or the user presses Stop) after the call returned: the
    // bridge holds nothing for this call any more, so nothing is aborted.
    const { cancelled } = s.bridge.cancelAwaiting();
    expect(cancelled).toBe(false);
    expect(childSignal?.aborted).toBe(false);
  });
});

describe("Codex bridge lifecycle boundaries", () => {
  it("rejects completed-call redelivery but permits the same call id in a new turn", async () => {
    const s = setup();
    await s.call();
    await s.call();
    expect(s.run).toHaveBeenCalledTimes(1);
    await s.call({ ...params, turnId: "turn-2" }, { ...active, turnId: "turn-2" });
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("cancels promptly even if a child settles late and discards its trailing progress", async () => {
    const s = setup();
    let finish!: (value: Awaited<ReturnType<SessionSubagentPort["run"]>>) => void;
    let progress!: NonNullable<NonNullable<Parameters<SessionSubagentPort["run"]>[1]>["onProgress"]>;
    s.run.mockImplementation((_request, options) => {
      progress = options!.onProgress!;
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = s.call();
    s.bridge.cancel();
    await pending;
    expect(s.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "cancelled" } });
    const count = s.events.length;
    progress({ kind: "tool", toolName: "Write", summary: "late event" });
    finish({ status: "completed", finalText: "late", turns: 1, toolCalls: 0, truncated: false, durationMs: 1,
      childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" });
    await Promise.resolve();
    expect(s.events).toHaveLength(count);
    expect(s.response.result).toHaveBeenCalledTimes(1);
  });

  // TASK.226: the session-tier port never resolves on abort — only main's
  // eventual terminal does, strictly AFTER the abort won the bridge's race.
  // The immediate acknowledgement still closes the call (Stop stays
  // immediate), and when the real cancelled outcome settles late it must be
  // emitted as a terminal card event carrying the child-session target, so
  // the engine's pre-loop_end settle can deliver it while the turn owner is
  // still live (the live-GUI failure: parent card stayed running/final null
  // until reload while the durable log had the cancelled snapshot).
  it("emits the real cancelled outcome with its child target when it settles after the abort", async () => {
    const s = setup();
    s.run.mockImplementation((_request, options) => {
      // The card accumulator only starts once the child reports its identity.
      options?.onProgress?.({ kind: "start", agentType: "glm-lead", description: "Tiny task", model: "glm-5.3" });
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          setTimeout(() => resolve({ status: "cancelled", finalText: "child unwound", turns: 1, toolCalls: 0,
            truncated: false, durationMs: 100, childSessionId: "child-226", parentSessionId: "parent-226", spawnToolCallId: "call-1" }), 10);
        }, { once: true });
      });
    });
    const pending = s.call();
    s.bridge.cancel();
    await pending;
    // Immediate acknowledgement: cancelled, no presentation, exactly one response.
    expect(s.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "cancelled", toolCallId: "call-1" } });
    expect(s.response.result).toHaveBeenCalledTimes(1);
    // The bounded join sees a still-settling child...
    const join = s.bridge.cancelAwaiting();
    expect(join.cancelled).toBe(true);
    await join.completion;
    // ...and the real terminal card event carries the child-session target.
    const terminals = s.events.filter((e) => e.type === "tool_result");
    expect(terminals.length).toBe(2);
    expect((terminals.at(-1) as { outcome: { result?: { presentation?: { subagent?: { target?: unknown; final?: { status?: string } } } } } }).outcome.result?.presentation?.subagent).toMatchObject({
      final: { status: "cancelled" },
      target: { kind: "session", childSessionId: "child-226", parentSessionId: "parent-226", spawnToolCallId: "call-1" },
    });
    // TASK.226 review fix: the late-emission promise must be tracked and
    // deleted as the SAME entry — a settled call may not linger in the work
    // set, or every later drain()/cancelAwaiting() would wait on dead weight.
    // After one microtask tick the cleanup handlers have run; a subsequent
    // join must report nothing left to settle.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const rejoin = s.bridge.cancelAwaiting();
    expect(rejoin.cancelled).toBe(false);
    // The server got its failure answer with the first acknowledgement only.
    expect(s.response.result).toHaveBeenCalledTimes(1);
  });

  it("handles a failed child without exposing transport exception details", async () => {
    const s = setup();
    s.run.mockRejectedValue(new Error("sensitive internal transport detail"));
    await s.call();
    expect(s.response.result).toHaveBeenCalledWith({ success: false,
      contentItems: [{ type: "inputText", text: "AnyCode agent call failed" }] });
    expect(s.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "error" } });
  });

  it.each([["read-only", "plan"], ["unknown", "plan"], ["ask", "build"],
    ["approve-for-me", "build"], ["full-access", "yolo"]])("maps %s to %s without widening unknown postures", (preset, expected) => {
    expect(codexAgentPermissionMode(preset)).toBe(expected);
  });
});

describe("Codex profile refresh", () => {
  it("uses edited body/model for the next child without changing native tool declarations", async () => {
    const s = setup();
    let current = [{ ...catalog[0]!, systemPrompt: "policy v1" }];
    const refresh = vi.fn(async () => current);
    const log = { record: vi.fn(), list: vi.fn(async () => new Map()) };
    const bridge = new CodexDynamicToolBridge(catalog, { run: s.run }, log, refresh);
    const response = { result: vi.fn(), error: vi.fn() };
    const call = (callId: string, agentType = "glm-lead") => bridge.handle({ id: callId, method: "item/tool/call",
      params: { ...params, callId, arguments: { ...params.arguments, agent_type: agentType } } }, response, active, () => {});
    await call("first");
    current = [{ ...catalog[0]!, model: "glm-5.3-flash", systemPrompt: "policy v2" }];
    await call("second");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ model: "glm-5.3", prompt: "policy v1\n\n---\n\nDo the task" });
    expect(s.run.mock.calls[1]![0]).toMatchObject({ model: "glm-5.3-flash", prompt: "policy v2\n\n---\n\nDo the task" });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(bridge.declarations()[0]).toMatchObject({ inputSchema: expect.objectContaining({ properties: expect.objectContaining({ agent_type: expect.objectContaining({ enum: ["glm-lead"] }) }) }) });
    current = [{ ...catalog[0]!, name: "new-profile" }];
    await call("third", "new-profile");
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(response.result).toHaveBeenLastCalledWith(expect.objectContaining({ success: false }));
  });
});

describe("Codex bridge bounded shutdown drain", () => {
  it("does not hang shutdown on a child that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      let finish!: (value: Awaited<ReturnType<SessionSubagentPort["run"]>>) => void;
      s.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const pending = s.call();
      s.bridge.cancel();
      await pending;
      let drained = false;
      const drain = s.bridge.drain(25).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(24);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await drain;
      expect(drained).toBe(true);
      finish({ status: "cancelled", finalText: "cancelled", truncated: false, turns: 0, toolCalls: 0, durationMs: 1,
        childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" });
      await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
});

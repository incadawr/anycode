import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { shouldForwardClaudeDetachedEvent } from "./claude-detached-forwarding.js";

const command = (status: Extract<AgentEvent, { type: "claude_background_task" }>["status"]): AgentEvent => ({
  type: "claude_background_task", taskId: "b1", toolCallId: "call-1", kind: "bash", description: "sleep", startedAt: 1, status,
});
const agents = (count: number): AgentEvent => ({ type: "engine_background_agents", count, abandoned: false });
const end = { type: "subagent_end", toolCallId: "t" } as unknown as AgentEvent;
const other = { type: "text_delta", text: "x" } as unknown as AgentEvent;

describe("shouldForwardClaudeDetachedEvent", () => {
  it("forwards everything from the engine the session runs on", () => {
    for (const event of [command("running"), agents(3), agents(0), end, other]) expect(shouldForwardClaudeDetachedEvent(true, event)).toBe(true);
  });

  it("lets a retired engine settle its cards, commands and count, and nothing else", () => {
    expect(shouldForwardClaudeDetachedEvent(false, end)).toBe(true);
    for (const status of ["unknown", "completed", "failed", "stopped"] as const) expect(shouldForwardClaudeDetachedEvent(false, command(status))).toBe(true);
    expect(shouldForwardClaudeDetachedEvent(false, agents(0))).toBe(true);
    expect(shouldForwardClaudeDetachedEvent(false, command("running"))).toBe(false);
    expect(shouldForwardClaudeDetachedEvent(false, agents(1))).toBe(false);
    expect(shouldForwardClaudeDetachedEvent(false, other)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { shouldForwardClaudeDetachedEvent } from "./claude-detached-forwarding.js";

const command = (status: Extract<AgentEvent, { type: "claude_background_task" }>["status"]): AgentEvent => ({
  type: "claude_background_task", taskId: "b1", toolCallId: "call-1", kind: "bash", description: "sleep", startedAt: 1, status,
});

describe("shouldForwardClaudeDetachedEvent", () => {
  it("forwards everything from the engine the session runs on", () => {
    expect(shouldForwardClaudeDetachedEvent(true, command("running"))).toBe(true);
    expect(shouldForwardClaudeDetachedEvent(true, { type: "subagent_start", toolCallId: "a", description: "x" } as AgentEvent)).toBe(true);
  });

  it("lets a retired engine settle its cards and commands, and nothing else", () => {
    expect(shouldForwardClaudeDetachedEvent(false, { type: "subagent_end", toolCallId: "a", status: "cancelled" } as AgentEvent)).toBe(true);
    for (const status of ["unknown", "completed", "failed", "stopped"] as const) expect(shouldForwardClaudeDetachedEvent(false, command(status))).toBe(true);
    expect(shouldForwardClaudeDetachedEvent(false, command("running"))).toBe(false);
    expect(shouldForwardClaudeDetachedEvent(false, { type: "subagent_start", toolCallId: "a", description: "x" } as AgentEvent)).toBe(false);
  });
});

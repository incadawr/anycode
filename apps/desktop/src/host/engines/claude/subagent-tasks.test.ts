/**
 * The Claude CLI's own subagents (its `Agent` tool), projected onto the
 * existing subagent_* events. Driven by the committed captures of a real
 * background agent (w0-19) and a real foreground agent (w0-20).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import type { ClaudeStreamMessage } from "./protocol.js";
import { ClaudeSubagentTasks, isClaudeSubagentFrame } from "./subagent-tasks.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

function frames(file: string): ClaudeStreamMessage[] {
  return readFileSync(join(FIXTURES_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeStreamMessage);
}

function replay(file: string): AgentEvent[] {
  const tasks = new ClaudeSubagentTasks();
  return frames(file).flatMap((frame) => tasks.onFrame(frame));
}

function system(subtype: string, fields: Record<string, unknown>): ClaudeStreamMessage {
  return { type: "system", subtype, ...fields } as ClaudeStreamMessage;
}

const BACKGROUND_TOOL = "toolu_01AJKBpVVvTVqpg8nKBashrq";
const FOREGROUND_TOOL = "toolu_01RDu83vHyAmThJmAAheTCUb";

describe("ClaudeSubagentTasks — a real background agent (w0-19)", () => {
  const events = replay("w0-19-background-agent.jsonl");

  it("emits start, an activity row per child tool call, a progress per task_progress, then one end, in wire order", () => {
    expect(events.map((event) => event.type)).toEqual([
      "subagent_start",
      "subagent_activity", "subagent_progress",
      "subagent_activity", "subagent_progress",
      "subagent_activity", "subagent_progress",
      "subagent_end",
    ]);
  });

  it("keys every event to the parent Agent tool_use id", () => {
    for (const event of events) expect(event).toMatchObject({ toolCallId: BACKGROUND_TOOL });
  });

  it("starts with the subagent type and the Agent call's description", () => {
    expect(events[0]).toEqual({
      type: "subagent_start",
      toolCallId: BACKGROUND_TOOL,
      agentType: "general-purpose",
      description: "Summarize anycode docs",
    });
  });

  it("reports the child's own tool calls as activity (the shared summarizer's subject), and the CLI's counters as progress", () => {
    expect(events[1]).toEqual({ type: "subagent_activity", toolCallId: BACKGROUND_TOOL, toolName: "Read", summary: "/workspace/README.md" });
    expect(events[2]).toEqual({ type: "subagent_progress", toolCallId: BACKGROUND_TOOL, turns: 1, toolCalls: 1, lastTool: "Read" });
    expect(events[5]).toEqual({ type: "subagent_activity", toolCallId: BACKGROUND_TOOL, toolName: "Read", summary: "/workspace/AGENTS.md" });
  });

  it("ends with the notification's status and usage; turns are the child's distinct model responses", () => {
    // Three Read calls arrive as three assistant frames of ONE response
    // (same message.id), then a final text response: two model rounds.
    expect(events.at(-1)).toEqual({
      type: "subagent_end",
      toolCallId: BACKGROUND_TOOL,
      status: "completed",
      turns: 2,
      toolCalls: 3,
      durationMs: 4010,
    });
  });
});

describe("ClaudeSubagentTasks — a real foreground agent (w0-20)", () => {
  const events = replay("w0-20-foreground-agent.jsonl");

  it("produces the same lifecycle for an agent that runs inside the parent turn", () => {
    expect(events.map((event) => event.type)).toEqual([
      "subagent_start",
      "subagent_progress", "subagent_activity",
      "subagent_progress", "subagent_activity",
      "subagent_end",
    ]);
    expect(events[2]).toEqual({ type: "subagent_activity", toolCallId: FOREGROUND_TOOL, toolName: "Read", summary: "/workspace/AGENTS.md" });
    expect(events.at(-1)).toMatchObject({ toolCallId: FOREGROUND_TOOL, status: "completed", turns: 1, toolCalls: 2, durationMs: 3574 });
  });

  it("never reports turn 0 once the child has used a tool (a tool call implies a model response)", () => {
    // Here the first task_progress arrives BEFORE the child's assistant frame.
    expect(events[1]).toMatchObject({ type: "subagent_progress", turns: 1, toolCalls: 1 });
  });
});

describe("ClaudeSubagentTasks — edge cases", () => {
  it("ignores tasks that are not agents (a background Bash command keeps its own card)", () => {
    const tasks = new ClaudeSubagentTasks();
    const events = [
      system("task_started", { task_id: "b1", tool_use_id: "toolu_bash", description: "npm test", task_type: "local_bash" }),
      system("task_progress", { task_id: "b1", tool_use_id: "toolu_bash", description: "running", usage: { tool_uses: 0 } }),
      system("task_notification", { task_id: "b1", tool_use_id: "toolu_bash", status: "completed" }),
    ].flatMap((frame) => tasks.onFrame(frame));
    expect(events).toEqual([]);
  });

  it("ignores progress and notifications for a task it never saw start", () => {
    const tasks = new ClaudeSubagentTasks();
    expect(tasks.onFrame(system("task_progress", { task_id: "x", tool_use_id: "toolu_x", description: "Reading", last_tool_name: "Read" }))).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "x", tool_use_id: "toolu_x", status: "completed" }))).toEqual([]);
  });

  it.each([
    ["completed", "completed"],
    ["failed", "error"],
    ["stopped", "cancelled"],
    ["killed", "cancelled"],
    ["something_new", "error"],
  ] as const)("maps notification status %s to %s", (wire, status) => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a", subagent_type: "Explore", description: "look", task_type: "local_agent" }));
    expect(tasks.onFrame(system("task_notification", { task_id: "a1", tool_use_id: "toolu_a", status: wire }))).toEqual([
      { type: "subagent_end", toolCallId: "toolu_a", status, turns: 0, toolCalls: 0, durationMs: -1 },
    ]);
  });

  it("task_progress yields counters only; its prose description is not turned into an activity row", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a", description: "look" }));
    expect(tasks.onFrame(system("task_progress", { task_id: "a1", tool_use_id: "toolu_a", description: "Reading a.ts", usage: { tool_uses: 0 } }))).toEqual([
      { type: "subagent_progress", toolCallId: "toolu_a", turns: 0, toolCalls: 0 },
    ]);
  });

  it("one activity row per child tool_use, once even if a frame is repeated; none for a child it cannot attach", () => {
    const tasks = new ClaudeSubagentTasks();
    const child = (parent: string, blocks: unknown[]): ClaudeStreamMessage =>
      ({ type: "assistant", parent_tool_use_id: parent, message: { id: "msg_1", model: "m", content: blocks } }) as ClaudeStreamMessage;
    const call = { type: "tool_use", id: "toolu_c1", name: "Bash", input: { command: "npm test\nmore" } };
    expect(tasks.onFrame(child("toolu_a", [call]))).toEqual([]);
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a" }));
    expect(tasks.onFrame(child("toolu_a", [{ type: "text", text: "thinking" }, call]))).toEqual([
      { type: "subagent_activity", toolCallId: "toolu_a", toolName: "Bash", summary: "npm test" },
    ]);
    expect(tasks.onFrame(child("toolu_a", [call]))).toEqual([]);
    expect(tasks.onFrame(child("toolu_a", [{ type: "tool_use", id: "toolu_c2", name: "mcp__x__y", input: {} }]))).toEqual([
      { type: "subagent_activity", toolCallId: "toolu_a", toolName: "mcp__x__y", summary: "" },
    ]);
  });

  it("settles a task once: a repeated notification is dropped", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a", description: "look" }));
    expect(tasks.onFrame(system("task_notification", { task_id: "a1", tool_use_id: "toolu_a", status: "completed" }))).toHaveLength(1);
    expect(tasks.onFrame(system("task_notification", { task_id: "a1", tool_use_id: "toolu_a", status: "completed" }))).toEqual([]);
  });

  it("falls back to a generic agent type when the CLI names none", () => {
    const tasks = new ClaudeSubagentTasks();
    expect(tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a" }))).toEqual([
      { type: "subagent_start", toolCallId: "toolu_a", agentType: "agent", description: "" },
    ]);
  });

  it("drops a task_started without a tool_use_id (nothing to attach it to)", () => {
    const tasks = new ClaudeSubagentTasks();
    expect(tasks.onFrame(system("task_started", { task_id: "a1", description: "look" }))).toEqual([]);
  });

  it("abandonAll settles every live task as cancelled, once", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a" }));
    tasks.onFrame(system("task_started", { task_id: "a2", tool_use_id: "toolu_b" }));
    tasks.onFrame(system("task_progress", { task_id: "a2", usage: { tool_uses: 2 } }));
    tasks.onFrame(system("task_notification", { task_id: "a1", status: "completed" }));
    expect(tasks.abandonAll()).toEqual([
      { type: "subagent_end", toolCallId: "toolu_b", status: "cancelled", turns: 1, toolCalls: 2, durationMs: -1 },
    ]);
    expect(tasks.abandonAll()).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "a2", status: "completed" }))).toEqual([]);
  });

  it("after detachLive a running task reports only to the detach sink; a task started later stays with its turn", () => {
    const detached: AgentEvent[] = [];
    const tasks = new ClaudeSubagentTasks((event) => detached.push(event));
    tasks.onFrame(system("task_started", { task_id: "a1", tool_use_id: "toolu_a" }));
    tasks.detachLive();
    expect(tasks.onFrame(system("task_progress", { task_id: "a1", usage: { tool_uses: 1 } }))).toEqual([]);
    expect(tasks.onFrame(system("task_started", { task_id: "a2", tool_use_id: "toolu_b" }))).toHaveLength(1);
    expect(tasks.onFrame(system("task_notification", { task_id: "a1", status: "completed" }))).toEqual([]);
    expect(detached).toEqual([
      { type: "subagent_progress", toolCallId: "toolu_a", turns: 1, toolCalls: 1 },
      { type: "subagent_end", toolCallId: "toolu_a", status: "completed", turns: 1, toolCalls: 1, durationMs: -1 },
    ]);
  });
});

describe("isClaudeSubagentFrame", () => {
  it("is true for a child's own frames and for the task lifecycle frames", () => {
    expect(isClaudeSubagentFrame({ type: "assistant", parent_tool_use_id: "toolu_a", message: { model: "m", content: [] } })).toBe(true);
    expect(isClaudeSubagentFrame({ type: "user", parent_tool_use_id: "toolu_a", message: { role: "user", content: [] } })).toBe(true);
    for (const subtype of ["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"]) {
      expect(isClaudeSubagentFrame(system(subtype, {}))).toBe(true);
    }
  });

  it("is false for the parent's own frames", () => {
    expect(isClaudeSubagentFrame({ type: "assistant", parent_tool_use_id: null, message: { model: "m", content: [] } })).toBe(false);
    expect(isClaudeSubagentFrame(system("init", {}))).toBe(false);
    expect(isClaudeSubagentFrame(system("status", {}))).toBe(false);
  });
});

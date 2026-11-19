/**
 * The Claude CLI's own subagents (its `Agent` tool), projected onto the
 * existing subagent_* events. Driven by the committed captures of a real
 * background agent (w0-19) and a real foreground agent (w0-20).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("detachLive settles a foreground agent its turn left running as cancelled; a background one stays live", () => {
    const detached: AgentEvent[] = [];
    const tasks = new ClaudeSubagentTasks((event) => detached.push(event));
    tasks.onFrame(system("task_started", { task_id: "fg", tool_use_id: "toolu_fg", is_backgrounded: false }));
    tasks.onFrame(system("task_progress", { task_id: "fg", usage: { tool_uses: 2 } }));
    tasks.onFrame(system("task_started", { task_id: "bg", tool_use_id: "toolu_bg", is_backgrounded: true }));
    tasks.detachLive();
    expect(detached).toEqual([
      { type: "subagent_end", toolCallId: "toolu_fg", status: "cancelled", turns: 1, toolCalls: 2, durationMs: -1 },
    ]);
    // The interrupted agent's late notification is not reported again.
    expect(tasks.onFrame(system("task_notification", { task_id: "fg", status: "stopped" }))).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "bg", status: "completed" }))).toEqual([]);
    expect(detached.at(-1)).toMatchObject({ type: "subagent_end", toolCallId: "toolu_bg", status: "completed" });
    expect(detached).toHaveLength(2);
  });

  it("a foreground agent the CLI later moves to the background (task_updated) stays live past its turn", () => {
    const detached: AgentEvent[] = [];
    const tasks = new ClaudeSubagentTasks((event) => detached.push(event));
    tasks.onFrame(system("task_started", { task_id: "t", run_id: "r", tool_use_id: "toolu_fg", is_backgrounded: false }));
    // Wire shape: task_updated names the task and run, never the tool call.
    expect(tasks.onFrame(system("task_updated", { task_id: "t", run_id: "r", patch: { is_backgrounded: true } }))).toEqual([]);
    tasks.detachLive();
    expect(detached).toEqual([]);
    tasks.onFrame(system("task_notification", { task_id: "t", run_id: "r", status: "completed" }));
    expect(detached).toMatchObject([{ type: "subagent_end", toolCallId: "toolu_fg", status: "completed" }]);
  });

  it("a task_updated of an earlier run does not background the current one", () => {
    const detached: AgentEvent[] = [];
    const tasks = new ClaudeSubagentTasks((event) => detached.push(event));
    tasks.onFrame(system("task_started", { task_id: "t", run_id: "r2", tool_use_id: "toolu_fg", is_backgrounded: false }));
    tasks.onFrame(system("task_updated", { task_id: "t", run_id: "r1", patch: { is_backgrounded: true } }));
    tasks.detachLive();
    expect(detached).toMatchObject([{ type: "subagent_end", toolCallId: "toolu_fg", status: "cancelled" }]);
  });

});

describe("ClaudeSubagentTasks — an agent resumed by SendMessage", () => {
  // Wire shape captured from claude 2.1.325: the resumed run reuses the task_id,
  // its task_* frames carry the SendMessage call's tool_use_id, and the child's
  // own frames still name the original Agent call as their parent.
  const AGENT_CALL = "toolu_agent";
  const SEND_CALL = "toolu_send";
  const child = (id: string, blocks: unknown[]): ClaudeStreamMessage =>
    ({ type: "assistant", parent_tool_use_id: AGENT_CALL, message: { id, model: "m", content: blocks } }) as ClaudeStreamMessage;

  function firstRun(tasks: ClaudeSubagentTasks): void {
    tasks.onFrame(system("task_started", { task_id: "t1", tool_use_id: AGENT_CALL, task_type: "local_agent", subagent_type: "general-purpose", description: "Read README" }));
    tasks.onFrame(child("msg_1", [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/w/README.md" } }]));
    tasks.onFrame(system("task_progress", { task_id: "t1", tool_use_id: AGENT_CALL, usage: { tool_uses: 1 } }));
    tasks.onFrame(child("msg_2", [{ type: "text", text: "done" }]));
    tasks.onFrame(system("task_notification", { task_id: "t1", tool_use_id: AGENT_CALL, status: "completed", usage: { tool_uses: 1, duration_ms: 900 } }));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the resumed run on the SendMessage call, with the child's own tool calls as its activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const tasks = new ClaudeSubagentTasks();
    firstRun(tasks);
    vi.setSystemTime(20_000);
    const events = [
      system("task_started", { task_id: "t1", tool_use_id: SEND_CALL, task_type: "local_agent", subagent_type: "general-purpose", description: "Read README" }),
      child("msg_3", [{ type: "tool_use", id: "toolu_r2", name: "Read", input: { file_path: "/w/AGENTS.md" } }]),
      system("task_progress", { task_id: "t1", tool_use_id: SEND_CALL, usage: { tool_uses: 2 }, last_tool_name: "Read" }),
      child("msg_4", [{ type: "text", text: "done" }]),
    ].flatMap((frame) => tasks.onFrame(frame));
    vi.setSystemTime(20_800);
    // The CLI's duration_ms runs from the agent's FIRST start (idle time included):
    // the resumed run's own duration is measured from its task_started.
    events.push(...tasks.onFrame(system("task_notification", { task_id: "t1", tool_use_id: SEND_CALL, status: "completed", usage: { tool_uses: 2, duration_ms: 10_700 } })));

    expect(events).toEqual([
      { type: "subagent_start", toolCallId: SEND_CALL, agentType: "general-purpose", description: "Read README" },
      { type: "subagent_activity", toolCallId: SEND_CALL, toolName: "Read", summary: "/w/AGENTS.md" },
      { type: "subagent_progress", toolCallId: SEND_CALL, turns: 1, toolCalls: 1, lastTool: "Read" },
      { type: "subagent_end", toolCallId: SEND_CALL, status: "completed", turns: 2, toolCalls: 1, durationMs: 800 },
    ]);
  });

  it("matches a run's frames by run_id: the previous run's late frames never touch the resumed run, which counts from the last cumulative count", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "t1", run_id: "r1", tool_use_id: AGENT_CALL }));
    tasks.onFrame(system("task_progress", { task_id: "t1", run_id: "r1", tool_use_id: AGENT_CALL, usage: { tool_uses: 3 } }));
    tasks.onFrame(system("task_started", { task_id: "t1", run_id: "r2", tool_use_id: SEND_CALL }));
    expect(tasks.onFrame(system("task_progress", { task_id: "t1", run_id: "r1", tool_use_id: AGENT_CALL, usage: { tool_uses: 3 } }))).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "t1", run_id: "r1", tool_use_id: AGENT_CALL, status: "completed", usage: { tool_uses: 3 } }))).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "t1", run_id: "r2", tool_use_id: SEND_CALL, status: "completed", usage: { tool_uses: 4 } }))).toEqual([
      { type: "subagent_end", toolCallId: SEND_CALL, status: "completed", turns: 1, toolCalls: 1, durationMs: expect.any(Number) },
    ]);
  });

  it("without a run_id a run's frames are matched by their tool_use_id", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "t1", tool_use_id: AGENT_CALL }));
    tasks.onFrame(system("task_started", { task_id: "t1", tool_use_id: SEND_CALL }));
    expect(tasks.onFrame(system("task_notification", { task_id: "t1", tool_use_id: AGENT_CALL, status: "completed" }))).toEqual([]);
    expect(tasks.onFrame(system("task_notification", { task_id: "t1", tool_use_id: SEND_CALL, status: "completed" }))).toMatchObject([
      { type: "subagent_end", toolCallId: SEND_CALL, status: "completed" },
    ]);
  });

  it("an agent resumed while its first run is still tracked (no notification yet) moves to the new call", () => {
    const tasks = new ClaudeSubagentTasks();
    tasks.onFrame(system("task_started", { task_id: "t1", tool_use_id: AGENT_CALL }));
    expect(tasks.onFrame(system("task_started", { task_id: "t1", tool_use_id: SEND_CALL }))).toEqual([
      { type: "subagent_end", toolCallId: AGENT_CALL, status: "completed", turns: 0, toolCalls: 0, durationMs: -1 },
      { type: "subagent_start", toolCallId: SEND_CALL, agentType: "agent", description: "" },
    ]);
    expect(tasks.onFrame(child("msg_5", [{ type: "tool_use", id: "toolu_r3", name: "Read", input: {} }]))).toEqual([
      { type: "subagent_activity", toolCallId: SEND_CALL, toolName: "Read", summary: "" },
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

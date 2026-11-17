/**
 * The Claude CLI's OWN subagents (its native `Agent` tool, foreground or
 * `run_in_background`), projected onto the existing subagent_* events so the
 * parent's Agent card shows live progress the same way an AnyCode-routed
 * child does. Invents no protocol variant.
 *
 * Wire (captured in contract/fixtures/w0-19 and w0-20): the CLI reports each
 * agent task through `system` frames — `task_started`, `task_progress` (a
 * human-readable `description` such as "Reading src/a.ts", `last_tool_name`,
 * cumulative `usage`), `task_updated`, `task_notification` (terminal status +
 * usage) and `background_tasks_changed` — all keyed to the parent Agent
 * `tool_use_id`. The child's own assistant/user frames carry
 * `parent_tool_use_id`. A foreground agent's frames arrive inside the parent
 * turn; a background agent's arrive AFTER the parent turn's `result`, while
 * the engine is idle — which is why this state lives for the engine's
 * lifetime rather than one turn.
 *
 * Only `local_agent` tasks are mapped: other task types (a background Bash
 * command) already own a card of their own and must not turn into one.
 */

import { summarizeChildToolCall, type AgentEvent } from "@anycode/core";
import type { ClaudeStreamMessage } from "./protocol.js";

type SubagentEndStatus = Extract<AgentEvent, { type: "subagent_end" }>["status"];

const TASK_SUBTYPES = new Set(["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"]);

/** The CLI's terminal task status → the subagent_end vocabulary. Anything unrecognized is an honest error, never a success. */
const NOTIFICATION_STATUS: Record<string, SubagentEndStatus> = {
  completed: "completed",
  failed: "error",
  stopped: "cancelled",
  killed: "cancelled",
};

interface TrackedTask {
  toolCallId: string;
  /** The task outlived the owner turn that started it: its events go to the detached sink from then on. */
  detached: boolean;
  /** Distinct child `message.id`s seen: one per model response, however many frames it spans. */
  responses: Set<string>;
  /** Child tool_use ids already reported as activity. */
  toolUses: Set<string>;
  toolCalls: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** True for a frame that belongs to a subagent rather than to the parent's own turn. */
export function isClaudeSubagentFrame(frame: ClaudeStreamMessage): boolean {
  if (typeof frame.parent_tool_use_id === "string") return true;
  return frame.type === "system" && TASK_SUBTYPES.has((frame as { subtype?: string }).subtype ?? "");
}

export class ClaudeSubagentTasks {
  /** Live agent tasks keyed by the CLI's `task_id`; removed when the task settles. */
  private readonly tasks = new Map<string, TrackedTask>();

  /**
   * @param detach receives the events of a task that outlived its owner turn
   * (`detachLive`), wherever its frames arrive — between turns or inside a
   * later owner turn, which must not adopt another turn's card.
   */
  constructor(private readonly detach: (event: AgentEvent) => void = () => {}) {}

  /**
   * Feeds one frame; returns the subagent_* events it implies for the current
   * owner turn (usually none). Events of a detached task go to the detach sink
   * instead. Never throws on an unexpected shape.
   */
  onFrame(frame: ClaudeStreamMessage): AgentEvent[] {
    const { task, events } = this.translate(frame);
    if (task?.detached !== true) return events;
    for (const event of events) this.detach(event);
    return [];
  }

  /** The owner turn ended: every task still running now reports through the detach sink. */
  detachLive(): void {
    for (const task of this.tasks.values()) task.detached = true;
  }

  private translate(frame: ClaudeStreamMessage): { task?: TrackedTask; events: AgentEvent[] } {
    if (typeof frame.parent_tool_use_id === "string") return this.onChildFrame(frame.parent_tool_use_id, frame);
    if (frame.type !== "system") return { events: [] };
    const fields = frame as Record<string, unknown>;
    switch (fields.subtype) {
      case "task_started":
        return this.onStarted(fields);
      case "task_progress":
        return this.onProgress(fields);
      case "task_notification":
        return this.onNotification(fields);
      default:
        // task_updated / background_tasks_changed restate what the frames
        // around them carry. A terminal task_updated is always followed by
        // the task_notification that carries the final usage.
        return { events: [] };
    }
  }

  /**
   * A child's assistant frame: counts its model response and turns each new
   * tool_use into an activity row. A frame for a task not started yet is
   * dropped: on the wire task_started always precedes the child's frames.
   */
  private onChildFrame(toolCallId: string, frame: ClaudeStreamMessage): { task?: TrackedTask; events: AgentEvent[] } {
    if (frame.type !== "assistant") return { events: [] };
    const task = [...this.tasks.values()].find(candidate => candidate.toolCallId === toolCallId);
    if (task === undefined) return { events: [] };
    const message = record(frame.message);
    const id = text(message?.id);
    if (id !== undefined) task.responses.add(id);
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: AgentEvent[] = [];
    for (const block of content.map(record)) {
      const name = text(block?.name);
      const callId = text(block?.id);
      if (block?.type !== "tool_use" || name === undefined || callId === undefined || task.toolUses.has(callId)) continue;
      task.toolUses.add(callId);
      events.push({ type: "subagent_activity", toolCallId, toolName: name, summary: summarizeChildToolCall(name, block.input) });
    }
    return { task, events };
  }

  private onStarted(fields: Record<string, unknown>): { task?: TrackedTask; events: AgentEvent[] } {
    const taskId = text(fields.task_id);
    const toolCallId = text(fields.tool_use_id);
    const taskType = text(fields.task_type);
    if (taskId === undefined || toolCallId === undefined) return { events: [] };
    if (taskType !== undefined && taskType !== "local_agent") return { events: [] };
    const task: TrackedTask = { toolCallId, detached: false, responses: new Set(), toolUses: new Set(), toolCalls: 0 };
    this.tasks.set(taskId, task);
    return {
      task,
      events: [{
        type: "subagent_start",
        toolCallId,
        agentType: text(fields.subagent_type) ?? "agent",
        description: text(fields.description) ?? "",
      }],
    };
  }

  private onProgress(fields: Record<string, unknown>): { task?: TrackedTask; events: AgentEvent[] } {
    const found = this.taskFor(fields);
    if (found === undefined) return { events: [] };
    const { task } = found;
    task.toolCalls = count(record(fields.usage)?.tool_uses) ?? task.toolCalls;
    // `description` ("Reading src/a.ts") is prose that already carries a verb;
    // the activity rows come from the child's own tool_use blocks instead.
    const lastTool = text(fields.last_tool_name);
    return {
      task,
      events: [{
        type: "subagent_progress",
        toolCallId: task.toolCallId,
        turns: this.turns(task),
        toolCalls: task.toolCalls,
        ...(lastTool !== undefined ? { lastTool } : {}),
      }],
    };
  }

  private onNotification(fields: Record<string, unknown>): { task?: TrackedTask; events: AgentEvent[] } {
    const found = this.taskFor(fields);
    if (found === undefined) return { events: [] };
    const { taskId, task } = found;
    this.tasks.delete(taskId);
    const usage = record(fields.usage);
    task.toolCalls = count(usage?.tool_uses) ?? task.toolCalls;
    return {
      task,
      events: [{
        type: "subagent_end",
        toolCallId: task.toolCallId,
        status: NOTIFICATION_STATUS[text(fields.status) ?? ""] ?? "error",
        turns: this.turns(task),
        toolCalls: task.toolCalls,
        // -1 is the existing "duration unknown" marker (the card hides the time).
        durationMs: count(usage?.duration_ms) ?? -1,
      }],
    };
  }

  /**
   * Settles every live task as cancelled — for when the CLI process that ran
   * them is gone (it exited, the transport was replaced, the engine was
   * disposed), so no task_notification will ever come and the cards would
   * otherwise stay running forever.
   */
  abandonAll(): AgentEvent[] {
    const events: AgentEvent[] = [...this.tasks.values()].map(task => ({
      type: "subagent_end",
      toolCallId: task.toolCallId,
      status: "cancelled",
      turns: this.turns(task),
      toolCalls: task.toolCalls,
      durationMs: -1,
    }));
    this.tasks.clear();
    return events;
  }

  private taskFor(fields: Record<string, unknown>): { taskId: string; task: TrackedTask } | undefined {
    const taskId = text(fields.task_id);
    if (taskId === undefined) return undefined;
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : { taskId, task };
  }

  /** A tool call implies at least one model response, even when its frame has not arrived yet. */
  private turns(task: TrackedTask): number {
    return Math.max(task.responses.size, task.toolCalls > 0 ? 1 : 0);
  }
}

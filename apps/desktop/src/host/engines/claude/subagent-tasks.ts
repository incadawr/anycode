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
import { countWorkingBackgroundAgents, EMPTY_AGENT_CENSUS, reduceAgentCensus, type AgentCensus } from "./agent-census.js";
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
  /** The call whose card shows this run: the Agent call, or the SendMessage call that resumed the agent. */
  toolCallId: string;
  /**
   * The CLI's `run_id`: one per run of the agent, while the task_id stays the
   * same across SendMessage resumes. A late frame of an earlier run must not
   * land on the current one.
   */
  runId?: string;
  /** The Agent call that first started the agent: the child's own frames name it as their parent on every run. */
  agentCall: string;
  /** The CLI's tool_uses count is cumulative across runs of one agent; this run's card counts only its own. */
  baseToolUses: number;
  /**
   * Host time a resumed run started at. The CLI's duration_ms counts from the
   * agent's first start, idle time included, so a resumed run is timed here.
   */
  resumedAt?: number;
  /**
   * The CLI's `is_backgrounded`: the agent keeps running after its parent
   * turn. Absent counts as backgrounded, so an older CLI keeps the card live.
   * A later `task_updated` patch can move a foreground agent to the background.
   */
  backgrounded: boolean;
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
   * Every agent task seen, kept after it settles: SendMessage can resume a
   * finished agent under the same task_id, and its new run still needs the
   * original Agent call (the child frames' parent) and the cumulative count.
   */
  private readonly history = new Map<string, { agentCall: string; toolUses: number }>();

  /**
   * @param detach receives the events of a task that outlived its owner turn
   * (`detachLive`), wherever its frames arrive — between turns or inside a
   * later owner turn, which must not adopt another turn's card.
   */
  constructor(
    private readonly detach: (event: AgentEvent) => void = () => {},
    /** Receives the number of agents working in the background whenever it changes. */
    private readonly onBackgroundAgents: (update: { count: number; abandoned: boolean }) => void = () => {},
  ) {}

  /** Immutable; only ever reassigned. Independent of the card state: `detachLive` leaves it alone. */
  private census: AgentCensus = EMPTY_AGENT_CENSUS;
  private lastCount = 0;

  /** Check before translating: translation consumes a terminal task. */
  knowsNotification(frame: ClaudeStreamMessage): boolean {
    return frame.type === "system" && frame.subtype === "task_notification" && this.taskFor(frame as Record<string, unknown>) !== undefined;
  }

  /**
   * Feeds one frame; returns the subagent_* events it implies for the current
   * owner turn (usually none). Events of a detached task go to the detach sink
   * instead. Never throws on an unexpected shape.
   */
  onFrame(frame: ClaudeStreamMessage): AgentEvent[] {
    const next = reduceAgentCensus(this.census, frame);
    if (next !== this.census) {
      this.census = next;
      const count = countWorkingBackgroundAgents(next);
      if (count !== this.lastCount) {
        this.lastCount = count;
        this.onBackgroundAgents({ count, abandoned: false });
      }
    }
    const { task, events } = this.translate(frame);
    if (task?.detached !== true) return events;
    for (const event of events) this.detach(event);
    return [];
  }

  /**
   * The owner turn ended. A background task still running reports through
   * the detach sink from now on. A foreground task still running was cut off
   * with its turn (a Stop): it settles as cancelled here, since its card
   * would otherwise read as dispatched to the background.
   */
  detachLive(): void {
    for (const [taskId, task] of this.tasks) {
      task.detached = true;
      if (task.backgrounded) continue;
      this.settle(taskId, task);
      this.detach(this.endEvent(task, "cancelled", -1));
    }
  }

  /** Forgets a live task, keeping what a SendMessage resume of it needs. */
  private settle(taskId: string, task: TrackedTask): void {
    this.tasks.delete(taskId);
    this.history.set(taskId, { agentCall: task.agentCall, toolUses: task.baseToolUses + task.toolCalls });
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
      case "task_updated": {
        // A foreground agent moved to the background keeps running past its
        // turn. The rest of the patch restates what the frames around it
        // carry: a terminal one is always followed by the task_notification
        // that carries the final usage.
        const found = this.taskFor(fields);
        if (found !== undefined && record(fields.patch)?.is_backgrounded === true) found.task.backgrounded = true;
        return { events: [] };
      }
      default:
        // background_tasks_changed restates what the frames around it carry.
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
    const task = [...this.tasks.values()].find(candidate => candidate.agentCall === toolCallId);
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
      events.push({ type: "subagent_activity", toolCallId: task.toolCallId, toolName: name, summary: summarizeChildToolCall(name, block.input) });
    }
    return { task, events };
  }

  private onStarted(fields: Record<string, unknown>): { task?: TrackedTask; events: AgentEvent[] } {
    const taskId = text(fields.task_id);
    const toolCallId = text(fields.tool_use_id);
    const taskType = text(fields.task_type);
    if (taskId === undefined || toolCallId === undefined) return { events: [] };
    if (taskType !== undefined && taskType !== "local_agent") return { events: [] };
    // A task_started for a task already running moves it to the new call; the
    // old card settles here, since no notification will ever name it again.
    const events: AgentEvent[] = [];
    const running = this.tasks.get(taskId);
    if (running !== undefined) {
      const end = this.endEvent(running, "completed", -1);
      if (running.detached) this.detach(end);
      else events.push(end);
      // The new run counts from the last cumulative count the old one saw.
      this.settle(taskId, running);
    }
    const seen = this.history.get(taskId);
    const runId = text(fields.run_id);
    const agentCall = seen?.agentCall ?? toolCallId;
    const baseToolUses = seen?.toolUses ?? 0;
    this.history.set(taskId, { agentCall, toolUses: baseToolUses });
    const task: TrackedTask = {
      toolCallId,
      ...(runId === undefined ? {} : { runId }),
      agentCall,
      baseToolUses,
      ...(seen === undefined ? {} : { resumedAt: Date.now() }),
      backgrounded: fields.is_backgrounded !== false,
      detached: false,
      responses: new Set(),
      toolUses: new Set(),
      toolCalls: 0,
    };
    this.tasks.set(taskId, task);
    return {
      task,
      events: [...events, {
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
    task.toolCalls = this.ownToolCalls(task, record(fields.usage)?.tool_uses);
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
    const usage = record(fields.usage);
    task.toolCalls = this.ownToolCalls(task, usage?.tool_uses);
    this.settle(taskId, task);
    return {
      task,
      // -1 is the existing "duration unknown" marker (the card hides the time).
      events: [this.endEvent(
        task,
        NOTIFICATION_STATUS[text(fields.status) ?? ""] ?? "error",
        task.resumedAt === undefined ? count(usage?.duration_ms) ?? -1 : Date.now() - task.resumedAt,
      )],
    };
  }

  private endEvent(task: TrackedTask, status: SubagentEndStatus, durationMs: number): AgentEvent {
    return { type: "subagent_end", toolCallId: task.toolCallId, status, turns: this.turns(task), toolCalls: task.toolCalls, durationMs };
  }

  /** This run's own tool calls out of the CLI's cumulative count; an absent count keeps the last one. */
  private ownToolCalls(task: TrackedTask, cumulative: unknown): number {
    const total = count(cumulative);
    return total === undefined ? task.toolCalls : Math.max(0, total - task.baseToolUses);
  }

  /**
   * Settles every live task as cancelled — for when the CLI process that ran
   * them is gone (it exited, the transport was replaced, the engine was
   * disposed), so no task_notification will ever come and the cards would
   * otherwise stay running forever.
   */
  abandonAll(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [taskId, task] of this.tasks) {
      events.push(this.endEvent(task, "cancelled", -1));
      this.settle(taskId, task);
    }
    this.census = EMPTY_AGENT_CENSUS;
    if (this.lastCount > 0) {
      this.lastCount = 0;
      this.onBackgroundAgents({ count: 0, abandoned: true });
    }
    return events;
  }

  /**
   * The live run a lifecycle frame belongs to: same task_id, and the same
   * run_id when both carry one, else the same tool_use_id when the frame
   * names one. A frame of an earlier run of the task matches nothing.
   */
  private taskFor(fields: Record<string, unknown>): { taskId: string; task: TrackedTask } | undefined {
    const taskId = text(fields.task_id);
    if (taskId === undefined) return undefined;
    const task = this.tasks.get(taskId);
    if (task === undefined) return undefined;
    const runId = text(fields.run_id);
    if (runId !== undefined && task.runId !== undefined) return runId === task.runId ? { taskId, task } : undefined;
    const toolCallId = text(fields.tool_use_id);
    return toolCallId === undefined || toolCallId === task.toolCallId ? { taskId, task } : undefined;
  }

  /** A tool call implies at least one model response, even when its frame has not arrived yet. */
  private turns(task: TrackedTask): number {
    return Math.max(task.responses.size, task.toolCalls > 0 ? 1 : 0);
  }
}

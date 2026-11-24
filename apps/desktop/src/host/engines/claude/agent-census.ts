/**
 * How many of the Claude CLI's agents are working in the background.
 *
 * A pure fold over the CLI's `task_*` system frames. The census keeps one
 * entry per agent task (`task_id`), and an agent counts when it is running,
 * its lineage is backgrounded (itself or a running ancestor via `parent_task_id`),
 * and it has no running foreground child. That last clause counts a
 * background parent whose work is delegated to foreground children once, as
 * those children, not twice.
 *
 * Evidence, in contract/fixtures: w0-19 (a background agent) and w0-20 (a
 * foreground agent), then the nested runs w0-21 (background parent, two
 * foreground children), w0-22 (background parent, two background children)
 * and w0-23 (a nested agent restarted under the same task_id with a new
 * run_id).
 *
 * An agent that starts a command with `run_in_background` and ends its turn
 * to wait is still working: CLI 2.1.330 reports it settled while its
 * `local_bash` runs, then restarts it under the same task_id (new run_id)
 * once the command ends (w0-23). So the census also keeps one entry per
 * command of a known agent (`local_bash` whose `parent_task_id` names an
 * agent entry; main-session commands, monitors and other task types are
 * ignored). A foreground command is kept too, so a later `task_updated`
 * patch can background it; it never counts. A command's entry is deleted
 * when it ends: a terminal `task_updated` or a `task_notification` of its
 * run, or, once backgrounded, a `background_tasks_changed` that omits it.
 *
 * A settled agent still counts while it waits: it is backgrounded itself and
 * owns at least one running background command. Commands never count, never
 * make their owner "delegating", and lineage skips them; a waiting agent is
 * not running for its children's lineage or its parent's delegating test.
 * "Waiting" is derived from the command entries and never stored on the
 * agent, so its restart `task_started` simply replaces its entry.
 *
 * The census settles an agent on `task_updated` carrying a terminal status,
 * while the Agent-card tracker (subagent-tasks.ts) settles on
 * `task_notification`. The two frames are one apart on the wire, the update
 * first; the badge only needs the status, the card needs the final usage.
 *
 * Never mutates: every reduction returns a new map, or the very same one when
 * the frame changes nothing.
 */

import type { ClaudeStreamMessage } from "./protocol.js";

export interface AgentCensusAgent {
  readonly kind: "agent";
  /** The CLI's `run_id`; absent on an older CLI. A frame of an earlier run must not settle the current one. */
  readonly runId?: string;
  readonly parentTaskId?: string;
  /** The CLI's `is_backgrounded`; absent counts as backgrounded. */
  readonly backgrounded: boolean;
  readonly running: boolean;
}

/** A `local_bash` of a known agent; deleted when it ends, so always running while present. */
export interface AgentCensusCommand {
  readonly kind: "command";
  readonly runId?: string;
  /** The agent that started it. */
  readonly parentTaskId: string;
  /** False for a foreground command, kept only so a later patch can background it. */
  readonly backgrounded: boolean;
  readonly running: true;
}

export type AgentCensusEntry = AgentCensusAgent | AgentCensusCommand;

/** Agent and command entries keyed by the CLI's `task_id`, in the order first seen. */
export type AgentCensus = ReadonlyMap<string, AgentCensusEntry>;

export const EMPTY_AGENT_CENSUS: AgentCensus = new Map();

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "killed"]);
/** Settled agent entries kept so a late frame still finds its task; the oldest go first. Commands never count here. */
const MAX_SETTLED = 500;
/** Longest parent chain followed; a malformed cycle ends here. */
const MAX_DEPTH = 32;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A frame without a run_id, or an entry without one, matches. */
function sameRun(entry: AgentCensusEntry, runId: string | undefined): boolean {
  return runId === undefined || entry.runId === undefined || runId === entry.runId;
}

function withEntry(census: AgentCensus, taskId: string, entry: AgentCensusEntry): AgentCensus {
  const next = new Map(census);
  next.set(taskId, entry);
  return evictSettled(next);
}

function withoutEntry(census: AgentCensus, taskId: string): AgentCensus {
  const next = new Map(census);
  next.delete(taskId);
  return next;
}

function isSettledAgent(entry: AgentCensusEntry): boolean {
  return entry.kind === "agent" && !entry.running;
}

/**
 * Drops the oldest settled agent entries beyond the cap, keeping any that is
 * an ancestor of a running entry (a running command included, so the agent
 * waiting on it stays).
 */
function evictSettled(census: Map<string, AgentCensusEntry>): Map<string, AgentCensusEntry> {
  let settled = 0;
  for (const entry of census.values()) if (isSettledAgent(entry)) settled += 1;
  if (settled <= MAX_SETTLED) return census;
  const ancestors = new Set<string>();
  for (const entry of census.values()) {
    if (!entry.running) continue;
    let parent = entry.parentTaskId;
    for (let depth = 0; parent !== undefined && depth < MAX_DEPTH && !ancestors.has(parent); depth += 1) {
      ancestors.add(parent);
      parent = census.get(parent)?.parentTaskId;
    }
  }
  for (const [taskId, entry] of census) {
    if (settled <= MAX_SETTLED) break;
    if (!isSettledAgent(entry) || ancestors.has(taskId)) continue;
    census.delete(taskId);
    settled -= 1;
  }
  return census;
}

function reduceCommand(census: AgentCensus, taskId: string, entry: AgentCensusCommand, fields: Record<string, unknown>): AgentCensus {
  if (!sameRun(entry, text(fields.run_id))) return census;
  if (fields.subtype === "task_notification") return withoutEntry(census, taskId);
  const patch = record(fields.patch);
  const status = text(patch?.status);
  if (status !== undefined && TERMINAL_STATUS.has(status)) return withoutEntry(census, taskId);
  if (entry.backgrounded || patch?.is_backgrounded !== true) return census;
  return withEntry(census, taskId, { ...entry, backgrounded: true });
}

export function reduceAgentCensus(census: AgentCensus, frame: ClaudeStreamMessage): AgentCensus {
  if (frame.type !== "system") return census;
  const fields = frame as Record<string, unknown>;
  const taskId = text(fields.task_id);
  switch (fields.subtype) {
    case "task_started": {
      const taskType = text(fields.task_type);
      if (taskId === undefined) return census;
      const runId = text(fields.run_id);
      const parentTaskId = text(fields.parent_task_id);
      if (taskType === "local_bash") {
        if (parentTaskId === undefined || census.get(parentTaskId)?.kind !== "agent") return census;
        return withEntry(census, taskId, {
          kind: "command",
          ...(runId === undefined ? {} : { runId }),
          parentTaskId,
          backgrounded: fields.is_backgrounded !== false,
          running: true,
        });
      }
      if (taskType !== undefined && taskType !== "local_agent") return census;
      return withEntry(census, taskId, {
        kind: "agent",
        ...(runId === undefined ? {} : { runId }),
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        backgrounded: fields.is_backgrounded !== false,
        running: true,
      });
    }
    case "task_updated": {
      const entry = taskId === undefined ? undefined : census.get(taskId);
      if (taskId === undefined || entry === undefined) return census;
      if (entry.kind === "command") return reduceCommand(census, taskId, entry, fields);
      if (!sameRun(entry, text(fields.run_id))) return census;
      const patch = record(fields.patch);
      const status = text(patch?.status);
      const settles = entry.running && status !== undefined && TERMINAL_STATUS.has(status);
      const moves = !entry.backgrounded && patch?.is_backgrounded === true;
      if (!settles && !moves) return census;
      return withEntry(census, taskId, { ...entry, backgrounded: entry.backgrounded || moves, running: entry.running && !settles });
    }
    case "task_notification": {
      const entry = taskId === undefined ? undefined : census.get(taskId);
      if (taskId === undefined || entry === undefined) return census;
      if (entry.kind === "command") return reduceCommand(census, taskId, entry, fields);
      if (!entry.running || !sameRun(entry, text(fields.run_id))) return census;
      return withEntry(census, taskId, { ...entry, running: false });
    }
    case "background_tasks_changed": {
      const listed = new Set((Array.isArray(fields.tasks) ? fields.tasks : []).map((task) => text(record(task)?.task_id)));
      let next: Map<string, AgentCensusEntry> | undefined;
      for (const [id, entry] of census) {
        if (!entry.running || !entry.backgrounded || listed.has(id)) continue;
        next ??= new Map(census);
        if (entry.kind === "command") next.delete(id);
        else next.set(id, { ...entry, running: false });
      }
      return next === undefined ? census : evictSettled(next);
    }
    default:
      return census;
  }
}

/**
 * True when the agent is backgrounded, or its running ancestor chain is: a
 * settled parent (a waiting one included) no longer carries its children.
 */
function lineageBackgrounded(census: AgentCensus, entry: AgentCensusAgent): boolean {
  let current: AgentCensusAgent = entry;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (current.backgrounded) return true;
    const parent = current.parentTaskId === undefined ? undefined : census.get(current.parentTaskId);
    if (parent === undefined || parent.kind !== "agent" || !parent.running) return false;
    current = parent;
  }
  return false;
}

export function countWorkingBackgroundAgents(census: AgentCensus): number {
  const delegating = new Set<string>();
  const waiting = new Set<string>();
  for (const entry of census.values()) {
    if (!entry.running || entry.parentTaskId === undefined) continue;
    if (entry.kind === "command") {
      if (entry.backgrounded) waiting.add(entry.parentTaskId);
    } else if (!entry.backgrounded) delegating.add(entry.parentTaskId);
  }
  let total = 0;
  for (const [taskId, entry] of census) {
    if (entry.kind !== "agent") continue;
    const working = entry.running && !delegating.has(taskId) && lineageBackgrounded(census, entry);
    const waits = !entry.running && entry.backgrounded && waiting.has(taskId);
    if (working || waits) total += 1;
  }
  return total;
}

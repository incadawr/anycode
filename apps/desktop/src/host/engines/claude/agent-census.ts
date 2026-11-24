/**
 * How many of the Claude CLI's agents are working in the background.
 *
 * A pure fold over the CLI's `task_*` system frames. The census keeps one
 * entry per agent task (`task_id`), and an agent counts when it is running,
 * its lineage is backgrounded (itself or any ancestor via `parent_task_id`),
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
 * The census settles an agent on `task_updated` carrying a terminal status,
 * while the Agent-card tracker (subagent-tasks.ts) settles on
 * `task_notification`. The two frames are one apart on the wire, the update
 * first; the badge only needs the status, the card needs the final usage.
 *
 * Never mutates: every reduction returns a new map, or the very same one when
 * the frame changes nothing.
 */

import type { ClaudeStreamMessage } from "./protocol.js";

export interface AgentCensusEntry {
  /** The CLI's `run_id`; absent on an older CLI. A frame of an earlier run must not settle the current one. */
  readonly runId?: string;
  readonly parentTaskId?: string;
  /** The CLI's `is_backgrounded`; absent counts as backgrounded. */
  readonly backgrounded: boolean;
  readonly running: boolean;
}

/** Agent entries keyed by the CLI's `task_id`, in the order they started. */
export type AgentCensus = ReadonlyMap<string, AgentCensusEntry>;

export const EMPTY_AGENT_CENSUS: AgentCensus = new Map();

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "killed"]);
/** Settled entries kept so a late frame still finds its task; the oldest go first. */
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

/** Drops the oldest settled entries beyond the cap, keeping any that is an ancestor of a running one. */
function evictSettled(census: Map<string, AgentCensusEntry>): Map<string, AgentCensusEntry> {
  let settled = 0;
  for (const entry of census.values()) if (!entry.running) settled += 1;
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
    if (entry.running || ancestors.has(taskId)) continue;
    census.delete(taskId);
    settled -= 1;
  }
  return census;
}

export function reduceAgentCensus(census: AgentCensus, frame: ClaudeStreamMessage): AgentCensus {
  if (frame.type !== "system") return census;
  const fields = frame as Record<string, unknown>;
  const taskId = text(fields.task_id);
  switch (fields.subtype) {
    case "task_started": {
      const taskType = text(fields.task_type);
      if (taskId === undefined || (taskType !== undefined && taskType !== "local_agent")) return census;
      const runId = text(fields.run_id);
      const parentTaskId = text(fields.parent_task_id);
      return withEntry(census, taskId, {
        ...(runId === undefined ? {} : { runId }),
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        backgrounded: fields.is_backgrounded !== false,
        running: true,
      });
    }
    case "task_updated": {
      const entry = taskId === undefined ? undefined : census.get(taskId);
      if (taskId === undefined || entry === undefined || !sameRun(entry, text(fields.run_id))) return census;
      const patch = record(fields.patch);
      const status = text(patch?.status);
      const settles = entry.running && status !== undefined && TERMINAL_STATUS.has(status);
      const moves = !entry.backgrounded && patch?.is_backgrounded === true;
      if (!settles && !moves) return census;
      return withEntry(census, taskId, { ...entry, backgrounded: entry.backgrounded || moves, running: entry.running && !settles });
    }
    case "task_notification": {
      const entry = taskId === undefined ? undefined : census.get(taskId);
      if (taskId === undefined || entry === undefined || !entry.running || !sameRun(entry, text(fields.run_id))) return census;
      return withEntry(census, taskId, { ...entry, running: false });
    }
    case "background_tasks_changed": {
      const listed = new Set((Array.isArray(fields.tasks) ? fields.tasks : []).map((task) => text(record(task)?.task_id)));
      let next: Map<string, AgentCensusEntry> | undefined;
      for (const [id, entry] of census) {
        if (!entry.running || !entry.backgrounded || listed.has(id)) continue;
        next ??= new Map(census);
        next.set(id, { ...entry, running: false });
      }
      return next === undefined ? census : evictSettled(next);
    }
    default:
      return census;
  }
}

/** True when the entry, or an ancestor of it, was backgrounded. */
function lineageBackgrounded(census: AgentCensus, entry: AgentCensusEntry): boolean {
  let current: AgentCensusEntry | undefined = entry;
  for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth += 1) {
    if (current.backgrounded) return true;
    current = current.parentTaskId === undefined ? undefined : census.get(current.parentTaskId);
  }
  return false;
}

export function countWorkingBackgroundAgents(census: AgentCensus): number {
  const delegating = new Set<string>();
  for (const entry of census.values()) {
    if (entry.running && !entry.backgrounded && entry.parentTaskId !== undefined) delegating.add(entry.parentTaskId);
  }
  let total = 0;
  for (const [taskId, entry] of census) {
    if (entry.running && !delegating.has(taskId) && lineageBackgrounded(census, entry)) total += 1;
  }
  return total;
}

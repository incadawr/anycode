import type { AgentEvent } from "@anycode/core";
import type { ClaudeStreamMessage } from "./protocol.js";

type Task = Extract<AgentEvent, { type: "claude_background_task" }>;

/** Tracks explicit native task lifecycle frames. Unknown task types are ignored. */
export class ClaudeNativeBackgroundTasks {
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, string>();
  /**
   * Tasks the CLI tracks for a FOREGROUND tool call (`is_backgrounded:false`),
   * of any task type: a long Bash command or a foreground Agent. CLI 2.1.330
   * emits their terminal notification BEFORE the owner's own tool_result and
   * starts no autonomous turn for it. An id leaves the set only on a
   * `task_updated` patch that backgrounds it, on its own terminal
   * notification, or when observation ends — never on the tool_result, whose
   * position relative to the notification is not part of the contract.
   */
  private readonly foreground = new Map<string, string | undefined>();

  /** A frame naming another run of a reused task id must not touch this run's state. */
  private foregroundRunMatches(id: string, f: Record<string, unknown>): boolean {
    if (!this.foreground.has(id)) return false;
    const run = this.foreground.get(id);
    return run === undefined || typeof f.run_id !== "string" || f.run_id === run;
  }

  /**
   * True for the terminal notification of a foreground task: it settles the
   * running tool call itself and no autonomous turn follows it. Consumes the
   * id, so each notification is classified once.
   */
  takeForegroundCompletion(frame: ClaudeStreamMessage): boolean {
    if (frame.type !== "system" || frame.subtype !== "task_notification") return false;
    const f = frame as Record<string, unknown>;
    const id = f.task_id;
    return typeof id === "string" && this.foregroundRunMatches(id, f) && this.foreground.delete(id);
  }

  /** Transport loss does not establish whether the native command stopped. */
  abandonAll(): Task[] {
    this.foreground.clear();
    const changed: Task[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") continue;
      const unknown: Task = { ...task, status: "unknown", summary: "Claude connection ended; task status is unknown." };
      this.tasks.set(id, unknown);
      changed.push(unknown);
    }
    return changed;
  }

  knowsNotification(frame: ClaudeStreamMessage): boolean {
    if (frame.type !== "system" || frame.subtype !== "task_notification") return false;
    const f = frame as Record<string, unknown>;
    if (typeof f.task_id !== "string") return false;
    const task = this.tasks.get(f.task_id);
    if (!task || (typeof f.tool_use_id === "string" && f.tool_use_id !== task.toolCallId)) return false;
    const run = this.runs.get(f.task_id);
    return !(run && typeof f.run_id === "string" && run !== f.run_id);
  }

  onFrame(frame: ClaudeStreamMessage): Task | undefined {
    if (frame.type !== "system") return undefined;
    const f = frame as Record<string, unknown>;
    const id = typeof f.task_id === "string" && f.task_id ? f.task_id : undefined;
    if (!id) return undefined;
    if (f.subtype === "task_started") {
      if (f.is_backgrounded === false) this.foreground.set(id, typeof f.run_id === "string" && f.run_id ? f.run_id : undefined);
      else this.foreground.delete(id);
      const kind = f.task_type === "local_bash" ? "bash" : f.task_type === "monitor" || f.task_type === "local_monitor" ? "monitor" : undefined;
      if (!kind || typeof f.tool_use_id !== "string" || !f.tool_use_id) return undefined;
      const task: Task = { type: "claude_background_task", taskId: id, toolCallId: f.tool_use_id, kind,
        description: typeof f.description === "string" ? f.description : "", startedAt: Date.now(), status: "running" };
      this.tasks.set(id, task);
      if (typeof f.run_id === "string") this.runs.set(id, f.run_id);
      else this.runs.delete(id);
      return task;
    }
    if (f.subtype === "task_updated") {
      const patch = f.patch && typeof f.patch === "object" ? f.patch as Record<string, unknown> : undefined;
      if (patch?.is_backgrounded === true && this.foregroundRunMatches(id, f)) this.foreground.delete(id);
      return undefined;
    }
    const old = this.tasks.get(id);
    if (!old || (old.status !== "running" && !(old.status === "unknown" && f.subtype === "task_notification")) || (typeof f.tool_use_id === "string" && f.tool_use_id !== old.toolCallId)) return undefined;
    const run = this.runs.get(id);
    if (run && typeof f.run_id === "string" && run !== f.run_id) return undefined;
    if (f.subtype === "task_progress") {
      if (typeof f.description !== "string" || f.description === old.description) return undefined;
      const task = { ...old, description: f.description };
      this.tasks.set(id, task);
      return task;
    }
    if (f.subtype !== "task_notification") return undefined;
    const status = f.status === "completed" ? "completed" : f.status === "failed" ? "failed" : f.status === "stopped" || f.status === "killed" ? "stopped" : undefined;
    if (!status) return undefined;
    const task: Task = { ...old, status,
      ...(typeof f.summary === "string" ? { summary: f.summary } : {}),
      ...(typeof f.output_file === "string" ? { outputFile: f.output_file } : {}) };
    if (old.status === "unknown" && typeof f.summary !== "string") delete task.summary;
    this.tasks.set(id, task);
    return task;
  }
}

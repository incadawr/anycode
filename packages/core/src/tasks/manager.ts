/**
 * InProcessTaskManager: session-scoped BackgroundTaskPort backed by
 * ExecutionPort. A task is a non-awaited `exec.run` with a per-task
 * AbortController — there is NO new spawn path. The kill/orphan contract
 * (SIGTERM -> SIGKILL after SIGKILL_GRACE_MS on the process group) and the
 * output cap are inherited verbatim from `spawnAndTrack` via ExecutionPort.run;
 * this manager only owns the registry, the live-output buffer, the read cursor,
 * the terminal-notice queue, and the bounded reap on dispose.
 *
 * Deliberately does NOT import child_process or anything from adapters/ (the
 * core->adapters back-edge is an architectural lock); the ~12-line output
 * append-cap below is a conscious duplicate of the adapter's private
 * appendCapped, operating on already-decoded chunk text from ExecRequest.onOutput.
 */

import type {
  BackgroundTaskNotice,
  BackgroundTaskPort,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStartResult,
  BackgroundTaskStatus,
} from "../ports/tasks.js";
import type { ExecStatus, ExecutionPort } from "../ports/execution.js";
import {
  BACKGROUND_DISPOSE_DEADLINE_MS,
  BACKGROUND_TASK_BUFFER_MAX_BYTES,
  BACKGROUND_TASK_TIMEOUT_MS,
  MAX_CONCURRENT_BACKGROUND_TASKS,
} from "../types/config.js";

type TerminalStatus = Exclude<BackgroundTaskStatus, "running">;

/** Maps the ExecutionPort's terminal status onto a background task's status (never "running"). */
function mapExecStatus(status: ExecStatus): TerminalStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "killed";
    case "spawn_error":
      return "spawn_error";
  }
}

/**
 * Appends already-decoded chunk text to `current`, capping at maxBytes (UTF-8).
 * Conscious duplicate of adapters/node/node-execution.ts:appendCapped (core must
 * not import from adapters). Same UTF-8 chunk-boundary naivety as the original.
 */
function appendCapped(current: string, chunk: string, maxBytes: number): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf-8");
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { text: current, truncated: true };
  }
  const chunkBytes = Buffer.byteLength(chunk, "utf-8");
  if (chunkBytes <= remaining) {
    return { text: current + chunk, truncated: false };
  }
  return { text: current + Buffer.from(chunk, "utf-8").subarray(0, remaining).toString("utf-8"), truncated: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TaskRecord {
  taskId: string;
  command: string;
  description?: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  controller: AbortController;
  /** Interleaved stdout+stderr in arrival order, capped at BACKGROUND_TASK_BUFFER_MAX_BYTES. */
  buffer: string;
  outputTruncated: boolean;
  /** Read cursor by string length; the buffer only grows (capped, not ring) so it is always valid. */
  cursor: number;
  /** Resolves once the task is finalized (used by disposeAll to await reaping). */
  settled: Promise<void>;
}

export class InProcessTaskManager implements BackgroundTaskPort {
  private readonly tasks = new Map<string, TaskRecord>();
  private notices: BackgroundTaskNotice[] = [];
  private counter = 0;

  constructor(private readonly exec: ExecutionPort) {}

  start(req: BackgroundTaskStartRequest): BackgroundTaskStartResult {
    const runningCount = this.countRunning();
    if (runningCount >= MAX_CONCURRENT_BACKGROUND_TASKS) {
      return {
        ok: false,
        reason: "limit_reached",
        message: `background task limit reached (${MAX_CONCURRENT_BACKGROUND_TASKS} concurrent running); wait for one to finish or kill one`,
      };
    }

    const taskId = `task-${++this.counter}`;
    const controller = new AbortController();
    const record: TaskRecord = {
      taskId,
      command: req.command,
      ...(req.description !== undefined ? { description: req.description } : {}),
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      controller,
      buffer: "",
      outputTruncated: false,
      cursor: 0,
      settled: Promise.resolve(),
    };
    this.tasks.set(taskId, record);

    // Fire-and-forget: the run promise is intentionally NOT awaited. The task
    // survives turn-abort by construction — only this manager's controller can
    // cancel it. A spawn failure surfaces as a resolved spawn_error ExecResult
    // (finalize below); a hypothetical port-level rejection is mapped the same.
    const runPromise = this.exec.run({
      command: req.command,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs ?? BACKGROUND_TASK_TIMEOUT_MS,
      maxOutputBytes: BACKGROUND_TASK_BUFFER_MAX_BYTES,
      abortSignal: controller.signal,
      onOutput: (chunk) => this.appendOutput(record, chunk.text),
    });
    record.settled = runPromise.then(
      (result) => this.finalize(record, mapExecStatus(result.status), result.exitCode),
      () => this.finalize(record, "spawn_error", null),
    );

    return { ok: true, taskId };
  }

  get(taskId: string): BackgroundTaskSnapshot | undefined {
    const record = this.tasks.get(taskId);
    return record ? this.toSnapshot(record) : undefined;
  }

  readOutput(taskId: string): { snapshot: BackgroundTaskSnapshot; newOutput: string } | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    const newOutput = record.buffer.slice(record.cursor);
    record.cursor = record.buffer.length;
    return { snapshot: this.toSnapshot(record), newOutput };
  }

  kill(taskId: string): boolean {
    const record = this.tasks.get(taskId);
    if (!record || record.status !== "running") return false;
    // Only registry-owned controllers are reachable — no arbitrary pid/signal
    // path exists. The status transitions to "killed" asynchronously when the
    // process is reaped (cancelled -> killed via mapExecStatus in finalize).
    record.controller.abort();
    return true;
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()].map((record) => this.toSnapshot(record));
  }

  drainNotices(): BackgroundTaskNotice[] {
    const drained = this.notices;
    this.notices = [];
    return drained;
  }

  async disposeAll(): Promise<void> {
    const live = [...this.tasks.values()].filter((record) => record.status === "running");
    for (const record of live) {
      record.controller.abort();
    }
    const pending = live.map((record) => record.settled);
    if (pending.length === 0) return;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BACKGROUND_DISPOSE_DEADLINE_MS);
    });
    await Promise.race([Promise.allSettled(pending).then(() => undefined), deadline]);
    // Clear the deadline timer if reaping won so no lingering timer keeps the
    // event loop alive (critical for a clean, non-hanging CLI exit).
    if (timer) clearTimeout(timer);
  }

  private countRunning(): number {
    let n = 0;
    for (const record of this.tasks.values()) {
      if (record.status === "running") n += 1;
    }
    return n;
  }

  private appendOutput(record: TaskRecord, text: string): void {
    const res = appendCapped(record.buffer, text, BACKGROUND_TASK_BUFFER_MAX_BYTES);
    record.buffer = res.text;
    if (res.truncated) record.outputTruncated = true;
  }

  private finalize(record: TaskRecord, status: TerminalStatus, exitCode: number | null): void {
    if (record.status !== "running") return; // idempotent: only the first terminal wins
    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = Date.now();
    this.notices.push({
      taskId: record.taskId,
      command: record.command,
      status,
      exitCode,
      durationMs: record.endedAt - record.startedAt,
    });
  }

  private toSnapshot(record: TaskRecord): BackgroundTaskSnapshot {
    return {
      taskId: record.taskId,
      command: record.command,
      ...(record.description !== undefined ? { description: record.description } : {}),
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      outputBytes: Buffer.byteLength(record.buffer, "utf-8"),
      outputTruncated: record.outputTruncated,
    };
  }
}

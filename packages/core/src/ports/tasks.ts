/**
 * BackgroundTaskPort: session-scoped registry of long-running Bash tasks
 * (slice 5.5). A task is a non-awaited `ExecutionPort.run` with its own
 * AbortController — there is NO new spawn path; the kill/orphan contract
 * (SIGTERM -> SIGKILL after SIGKILL_GRACE_MS on the process group) is inherited
 * verbatim from `spawnAndTrack`. Tasks do not persist across the process; the
 * only death paths are BashKill, `/tasks kill`, the task's own timeout, or
 * `disposeAll` on session exit.
 */

export type BackgroundTaskStatus =
  | "running" | "completed" | "failed" | "timed_out" | "killed" | "spawn_error";

export interface BackgroundTaskSnapshot {
  taskId: string;
  command: string;
  description?: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  outputBytes: number;
  outputTruncated: boolean;
}

export interface BackgroundTaskNotice {
  taskId: string;
  command: string;
  status: Exclude<BackgroundTaskStatus, "running">;
  exitCode: number | null;
  durationMs: number;
}

export interface BackgroundTaskStartRequest {
  command: string;
  cwd: string;
  description?: string;
  /** Default BACKGROUND_TASK_TIMEOUT_MS; an explicit Bash `timeout` input wins. */
  timeoutMs?: number;
}

export type BackgroundTaskStartResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: "limit_reached"; message: string };

export interface BackgroundTaskPort {
  /** Fire-and-forget spawn; a later spawn failure surfaces as a "spawn_error" notice. */
  start(req: BackgroundTaskStartRequest): BackgroundTaskStartResult;
  get(taskId: string): BackgroundTaskSnapshot | undefined;
  /** Appended-since-last-read increment (per-task cursor); undefined = unknown id. */
  readOutput(taskId: string): { snapshot: BackgroundTaskSnapshot; newOutput: string } | undefined;
  /** false = unknown id or already terminal. Only registry-owned tasks are reachable. */
  kill(taskId: string): boolean;
  list(): BackgroundTaskSnapshot[];
  /** Terminal-notice queue, exactly-once semantics (drain empties it). */
  drainNotices(): BackgroundTaskNotice[];
  /** Aborts every live task and awaits reaping, bounded by BACKGROUND_DISPOSE_DEADLINE_MS. */
  disposeAll(): Promise<void>;
}

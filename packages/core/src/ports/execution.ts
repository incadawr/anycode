/**
 * ExecutionPort: the only way core code spawns processes (Bash tool, shell
 * hooks in Phase 1). Cancellation contract: when `abortSignal` fires or the
 * timeout elapses, the adapter sends SIGTERM to the process tree and escalates
 * to SIGKILL after SIGKILL_GRACE_MS (750ms) if the process has not exited.
 */

export interface ExecRequest {
  /** Shell command string, executed via the platform shell. */
  command: string;
  cwd: string;
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string>;
  /** Data written to the child's stdin, then EOF. Omitted → stdin closed (current "ignore" behavior). */
  stdin?: string;
  timeoutMs: number;
  /** Per-stream capture cap; overflow sets the corresponding *Truncated flag. */
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
  /** Live-output callback, invoked from the child's stream data handlers (uncapped chunks; the consumer buffers/caps). Optional so existing implementations/mocks keep compiling. */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export type ExecStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error";

export interface ExecResult {
  status: ExecStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

/**
 * Argv-spawn request: no shell, so `file`/`args` are never interpreted by a
 * shell (no quoting/injection surface for callers with untrusted arguments,
 * e.g. Grep's ripgrep backend spawning an attacker-controlled regex pattern).
 */
export interface BinaryExecRequest {
  /** Path (or PATH-resolvable name) of the executable. */
  file: string;
  args: string[];
  /** Defaults to the adapter's own process.cwd() when omitted. */
  cwd?: string;
  /** Extra environment variables merged over the inherited environment (mirror of ExecRequest.env). */
  env?: Record<string, string>;
  /** Defaults to DEFAULT_TOOL_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
  /** Per-stream capture cap; overflow sets the corresponding *Truncated flag. */
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
}

/**
 * Long-lived bidirectional stdio child (LSP servers). argv-spawn, never a
 * shell. No wall-clock timeout: lifetime is bounded by kill() / the owner's
 * disposeAll on session exit. Kill contract identical to run/runBinary:
 * SIGTERM to the process group, SIGKILL after SIGKILL_GRACE_MS.
 */
export interface PersistentChildRequest {
  /** Path (or PATH-resolvable name) of the executable; argv semantics, no shell. */
  file: string;
  args: string[];
  /** Defaults to the adapter's own process.cwd() when omitted. */
  cwd?: string;
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string>;
  /** Raw stdout bytes (protocol framing is byte-counted; the consumer buffers/decodes). */
  onStdout: (chunk: Buffer) => void;
  /** Decoded stderr text, best-effort (diagnostic tail only; the consumer caps). */
  onStderr?: (text: string) => void;
  /** Exactly-once terminal callback; spawnError is set when the process never started (ENOENT etc.). */
  onExit: (info: { code: number | null; signal: string | null; spawnError?: string }) => void;
}

export interface PersistentChildHandle {
  readonly pid: number | undefined;
  /** True once onExit has fired. */
  readonly exited: boolean;
  /** Write to child stdin; silently a no-op after exit (never throws). */
  write(data: Buffer | string): void;
  /**
   * SIGTERM to the process group -> SIGKILL after SIGKILL_GRACE_MS. Resolves
   * when the child's close is observed, or SIGKILL_GRACE_MS + 250ms after the
   * SIGKILL as a hard bound (unkillable child never hangs the caller).
   * Idempotent; resolves immediately if already exited.
   */
  kill(): Promise<void>;
}

export interface ExecutionPort {
  run(request: ExecRequest): Promise<ExecResult>;
  /**
   * Optional argv-spawn escape hatch, same cancel contract as `run`
   * (SIGTERM -> SIGKILL after SIGKILL_GRACE_MS). Optional so existing
   * ExecutionPort implementations/mocks keep compiling unchanged.
   */
  runBinary?(request: BinaryExecRequest): Promise<ExecResult>;
  /** Optional so existing implementations/mocks keep compiling unchanged (runBinary precedent). */
  spawnPersistent?(request: PersistentChildRequest): PersistentChildHandle;
}

/**
 * Node implementation of ExecutionPort over node:child_process.spawn
 * (plain spawn, no pty). Kill contract: on abort or timeout send SIGTERM to
 * the process group, escalate to SIGKILL after SIGKILL_GRACE_MS (750ms) if the
 * child has not exited. Output collectors enforce maxOutputBytes per stream
 * and set the *Truncated flags on overflow. `run` and `runBinary` share the
 * same lifecycle tracking (timeout/abort/kill-sequence/output-capture); they
 * differ only in how the child is spawned (shell string vs argv, optional
 * stdin).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TOOL_TIMEOUT_MS, SIGKILL_GRACE_MS } from "../../types/config.js";
import type {
  BinaryExecRequest,
  ExecRequest,
  ExecResult,
  ExecStatus,
  ExecutionPort,
  PersistentChildHandle,
  PersistentChildRequest,
} from "../../ports/execution.js";

/**
 * Sends `signal` to the whole process tree rooted at `child`. The child is
 * spawned detached (POSIX) so its pid is also its process group id; a
 * negative pid targets the group. Windows has no process-group kill via
 * `process.kill`, so `taskkill /t` is used to reach descendants instead.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } catch {
      // best-effort; process may already be gone
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: process (group) already exited
  }
}

/** Appends a chunk to an accumulated string, capping at maxBytes (UTF-8). Returns whether truncation occurred. */
function appendCapped(current: string, chunk: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf-8");
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { text: current, truncated: true };
  }
  const chunkBytes = Buffer.byteLength(chunk.toString("utf-8"), "utf-8");
  if (chunkBytes <= remaining) {
    return { text: current + chunk.toString("utf-8"), truncated: false };
  }
  return { text: current + chunk.subarray(0, remaining).toString("utf-8"), truncated: true };
}

function cancelledResult(start: number): ExecResult {
  return {
    status: "cancelled",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Date.now() - start,
  };
}

interface TrackOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  /** Written to the child's stdin then EOF; only meaningful when the spawn used a "pipe" stdin. */
  stdin?: string;
  /** Live-output callback fired per data chunk (uncapped) before appendCapped; the consumer buffers/caps. */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export class NodeExecutionAdapter implements ExecutionPort {
  run(request: ExecRequest): Promise<ExecResult> {
    const start = Date.now();
    if (request.abortSignal?.aborted) {
      return Promise.resolve(cancelledResult(start));
    }

    return this.spawnAndTrack(
      start,
      () =>
        spawn(request.command, {
          cwd: request.cwd,
          env: { ...process.env, ...request.env },
          shell: true,
          detached: process.platform !== "win32",
          stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        }),
      {
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        abortSignal: request.abortSignal,
        stdin: request.stdin,
        onOutput: request.onOutput,
      },
    );
  }

  /** Argv spawn (no shell): `file`/`args` are passed to execve verbatim, never interpreted by /bin/sh. */
  runBinary(request: BinaryExecRequest): Promise<ExecResult> {
    const start = Date.now();
    if (request.abortSignal?.aborted) {
      return Promise.resolve(cancelledResult(start));
    }

    return this.spawnAndTrack(
      start,
      () =>
        spawn(request.file, request.args, {
          cwd: request.cwd ?? process.cwd(),
          env: { ...process.env, ...request.env },
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      {
        timeoutMs: request.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        abortSignal: request.abortSignal,
      },
    );
  }

  /**
   * Long-lived bidirectional stdio child (LSP servers). argv spawn, no shell,
   * no wall-clock timeout: lifetime is bounded by kill()/disposeAll only. Reuses
   * the same kill machinery as run/runBinary — killProcessTree (SIGTERM to the
   * detached process group, then SIGKILL after SIGKILL_GRACE_MS) — so the
   * orphan/pgid discipline is inherited at the module level, not reinvented.
   */
  spawnPersistent(request: PersistentChildRequest): PersistentChildHandle {
    let child: ChildProcess;
    let exited = false;
    let killInitiated = false;
    let killGaveUp = false;
    const closeResolvers: Array<() => void> = [];
    const killTimers: NodeJS.Timeout[] = [];

    const resolveAllKills = () => {
      for (const resolve of closeResolvers.splice(0)) resolve();
    };

    // Exactly-once terminal: the first of error/close (or a synchronous spawn
    // throw) wins; later events are ignored. Also unblocks any pending kill().
    const settle = (info: { code: number | null; signal: string | null; spawnError?: string }) => {
      if (exited) return;
      exited = true;
      for (const timer of killTimers) clearTimeout(timer);
      killTimers.length = 0;
      request.onExit(info);
      resolveAllKills();
    };

    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd ?? process.cwd(),
        env: { ...process.env, ...request.env },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Synchronous spawn failure (invalid options); report asynchronously so
      // the caller receives the handle before onExit fires. ENOENT does not land
      // here — it arrives on the async "error" event below.
      const spawnError = err instanceof Error ? err.message : String(err);
      queueMicrotask(() => settle({ code: null, signal: null, spawnError }));
      return {
        pid: undefined,
        get exited() {
          return exited;
        },
        write() {
          // Never started; writing is a no-op.
        },
        kill() {
          return Promise.resolve();
        },
      };
    }

    const spawnedChild = child;
    // A child that exits without reading stdin raises EPIPE on write; swallow it
    // (the close-event path still reports the correct exit).
    spawnedChild.stdin?.on("error", () => {});

    spawnedChild.stdout?.on("data", (chunk: Buffer) => {
      request.onStdout(chunk);
    });
    spawnedChild.stderr?.on("data", (chunk: Buffer) => {
      request.onStderr?.(chunk.toString("utf-8"));
    });

    spawnedChild.on("error", (err) => {
      settle({ code: null, signal: null, spawnError: err instanceof Error ? err.message : String(err) });
    });
    spawnedChild.on("close", (code, signal) => {
      settle({ code, signal });
    });

    const kill = (): Promise<void> => {
      if (exited || killGaveUp) return Promise.resolve();
      return new Promise<void>((resolve) => {
        if (exited || killGaveUp) {
          resolve();
          return;
        }
        closeResolvers.push(resolve);
        if (killInitiated) return;
        killInitiated = true;
        killProcessTree(spawnedChild, "SIGTERM");
        killTimers.push(
          setTimeout(() => {
            killProcessTree(spawnedChild, "SIGKILL");
          }, SIGKILL_GRACE_MS),
        );
        // Hard bound: an unkillable child never hangs the caller. After this the
        // caller is unblocked regardless of whether close was observed.
        killTimers.push(
          setTimeout(() => {
            killGaveUp = true;
            resolveAllKills();
          }, SIGKILL_GRACE_MS + 250),
        );
      });
    };

    return {
      get pid() {
        return spawnedChild.pid;
      },
      get exited() {
        return exited;
      },
      write(data: Buffer | string) {
        if (exited) return;
        try {
          spawnedChild.stdin?.write(data);
        } catch {
          // stdin already closed/destroyed; a post-exit write is a documented no-op.
        }
      },
      kill,
    };
  }

  private spawnAndTrack(start: number, spawnChild: () => ChildProcess, opts: TrackOptions): Promise<ExecResult> {
    const maxBytes = opts.maxOutputBytes;

    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnChild();
      } catch (err) {
        resolve({
          status: "spawn_error",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - start,
        });
        return;
      }

      if (opts.stdin !== undefined) {
        // A child that exits without reading stdin raises EPIPE on write; swallow it
        // (the close-event path below still reports the correct exit status).
        child.stdin?.on("error", () => {});
        child.stdin?.end(opts.stdin);
      }

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let forcedStatus: ExecStatus | undefined;

      const finish = (status: ExecStatus, exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        opts.abortSignal?.removeEventListener("abort", onAbort);
        resolve({
          status,
          exitCode,
          signal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - start,
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        opts.onOutput?.({ stream: "stdout", text: chunk.toString("utf-8") });
        const res = appendCapped(stdout, chunk, maxBytes);
        stdout = res.text;
        if (res.truncated) stdoutTruncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        opts.onOutput?.({ stream: "stderr", text: chunk.toString("utf-8") });
        const res = appendCapped(stderr, chunk, maxBytes);
        stderr = res.text;
        if (res.truncated) stderrTruncated = true;
      });

      const startKillSequence = (status: ExecStatus) => {
        if (settled || forcedStatus) return;
        forcedStatus = status;
        killProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          killProcessTree(child, "SIGKILL");
        }, SIGKILL_GRACE_MS);
      };

      const timeoutTimer = setTimeout(() => {
        startKillSequence("timed_out");
      }, opts.timeoutMs);

      const onAbort = () => {
        startKillSequence("cancelled");
      };
      opts.abortSignal?.addEventListener("abort", onAbort);

      child.on("error", (err) => {
        if (!stderr) stderr = err instanceof Error ? err.message : String(err);
        finish("spawn_error", null, null);
      });

      child.on("close", (code, signal) => {
        const status: ExecStatus = forcedStatus ?? (code === 0 ? "completed" : "failed");
        finish(status, code, signal);
      });
    });
  }
}

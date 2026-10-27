import { constants, closeSync, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { classifyEngineFailure, safeFailureCode, safeFailureMessage } from "./safe-failure.js";

function safeSystemCode(text: string): string | undefined {
  return text.match(/\b(EACCES|ENOENT|EPERM|EISDIR|ENOTDIR|EMFILE|ENFILE|ENOSPC|EROFS|ELOOP)\b/)?.[1];
}

/** Bounded per-session status log; raw errors, URLs and credentials are excluded. */
export function recordErrorDiagnostic(directory: string | undefined, sessionId: string, code: string, statusCode?: number, exitCode?: number, errorLine?: string, signal?: string): void {
  if (!directory || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
  let fd: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = openSync(join(directory, `${sessionId}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (fstatSync(fd).size >= 1_048_576) return;
    const message = safeFailureMessage(code);
    writeSync(fd, JSON.stringify({ at: new Date().toISOString(), code: safeFailureCode(code), message,
      ...(typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
      ...(errorLine ? { errorLine } : {}),
      ...(signal && /^SIG[A-Z0-9]+$/.test(signal) ? { signal } : {}),
    }) + "\n");
  } catch { /* Diagnostics must not interrupt a task. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * A host startup failure used to leave only an exit code in the
 * main log. Classify the raw error into a fixed-vocabulary
 * safe code and record it to the same per-session diagnostic file the turn
 * errors use, so the crash cause is reliably visible without ever echoing a
 * raw provider body, URL or credential.
 */
export function recordHostBootFailure(directory: string | undefined, sessionId: string | undefined, error: unknown): void {
  const failure = classifyEngineFailure(error);
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const systemCode = safeSystemCode(`${typeof value.code === "string" ? value.code : ""} ${typeof value.message === "string" ? value.message : ""}`);
  recordErrorDiagnostic(directory, sessionId !== undefined && sessionId.length > 0 ? sessionId : "host", failure.code, failure.statusCode, undefined, systemCode ? `Error: ${systemCode}: [details redacted]` : undefined);
}

/**
 * The reasons a tab's host was never able to run, recorded by
 * MAIN (the fork/breaker owner) because in these two cases there is no host
 * process left that could write anything itself:
 *
 * - `connection_env_unavailable` — the fork was refused fail-closed because the
 *   tab's pinned connection has no cached env. This is the exact shape of the
 *   0.0.45 defect (a non-active Sessions API tab died as `crash_looped` on a
 *   cache miss), so the cause now reaches a diagnostic file instead of living
 *   only in an inherited-stdio log line.
 * - `host_crash_loop` — the breaker gave up after repeated immediate exits;
 *   the exit code alone named no cause.
 */
export type HostFailureReason = "connection_env_unavailable" | "host_crash_loop" | "host_module_load" | "host_syntax_error" | "host_native_load";

export function recordHostFailure(directory: string | undefined, sessionId: string, reason: HostFailureReason, exitCode?: number, stderr = "", signal?: string): void {
  // Keep only the standard error class; arbitrary error text can contain secrets.
  const line = stderr.split(/\r?\n/).find((part) => /(?:^|\s)(?:[A-Za-z]*Error|Error):/.test(part));
  const kind = line?.match(/\b(Error|SyntaxError|TypeError|ReferenceError|RangeError|URIError|EvalError):/)?.[1];
  const systemCode = line ? safeSystemCode(line) : undefined;
  const errorLine = kind ? `${kind}:${systemCode ? ` ${systemCode}:` : ""} [details redacted]` : stderr.trim() ? "[first error line redacted]" : undefined;
  recordErrorDiagnostic(directory, sessionId, reason, undefined, exitCode, errorLine, signal);
}

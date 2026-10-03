import { constants, closeSync, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { safeFailureCode, safeFailureMessage } from "./safe-failure.js";

/** Bounded per-session status log; raw errors, URLs and credentials are excluded. */
export function recordErrorDiagnostic(directory: string | undefined, sessionId: string, code: string, statusCode?: number): void {
  if (!directory || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
  let fd: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = openSync(join(directory, `${sessionId}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (fstatSync(fd).size >= 1_048_576) return;
    const message = safeFailureMessage(code);
    writeSync(fd, JSON.stringify({ at: new Date().toISOString(), code: safeFailureCode(code), message,
      ...(typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
    }) + "\n");
  } catch { /* Diagnostics must not interrupt a task. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

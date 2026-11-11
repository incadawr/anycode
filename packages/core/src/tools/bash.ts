import type { PersistedRenderContext, ToolDefinition, ToolMetadata } from "../types/tools.js";
import {
  ARTIFACT_PREVIEW_BYTES,
  BASH_EXEC_MAX_OUTPUT_BYTES,
  BASH_MAX_TIMEOUT_MS,
  BASH_RESULT_MAX_MODEL_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
} from "../types/config.js";
// Value-only import of the envelope markers; dispatcher.ts pulls in no tool at
// runtime (its registry import is type-only), so this cannot close a cycle.
import {
  PERSISTED_OUTPUT_CLOSE_TAG,
  PERSISTED_OUTPUT_OPEN_TAG,
} from "../dispatch/dispatcher.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { bashInputSchema, type BashInput, type BashOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "Bash",
  description:
    "Execute a shell command and return its stdout, stderr and exit code.\n" +
    "- Each command runs in a fresh shell process starting in the workspace directory. On POSIX the local shell is /bin/bash when available, otherwise the default shell; on Windows it is the default shell. " +
    "`cd`, exported variables and shell state do NOT persist between calls: use `cd DIR && command` in the same call, or absolute paths.\n" +
    "- In POSIX shells, a pipeline normally reports the exit code of its LAST command, so `make | tail` can report 0 even when make fails. " +
    "When supported by the shell, use `set -o pipefail;` before the pipeline, or redirect to a log file and check the producer's exit code before reading the log.\n" +
    "- A nonzero exitCode means the command failed, even if the tool call returned normally. A null exitCode means no exit code is available; check status. Background starts return a task id instead of an exit code.\n" +
    "- Redirect background job stdout and stderr to a file or /dev/null if it must survive the AnyCode process exiting. During the session, output after the foreground call returns is discarded.\n" +
    "- timeout is in milliseconds (max 600000); the default is 120000 for foreground commands and 21600000 for background commands.",
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "process",
  needsApproval: true,
  timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  maxTimeoutMs: BASH_MAX_TIMEOUT_MS,
  maxOutputBytes: BASH_EXEC_MAX_OUTPUT_BYTES,
  // A build log's verdict is its last lines, so an oversized run keeps the tail.
  // Bash is the first tool to opt into the artifact strategy (§3), and
  // for the reason the task was written: the failure in a test run is as often
  // in the middle of the log as at its end, and re-running the command to see
  // it costs the whole command again. With no store wired the strategy simply
  // degrades back to the tail truncation above.
  resultBudget: {
    maxModelBytes: BASH_RESULT_MAX_MODEL_BYTES,
    previewDirection: "tail",
    strategy: "artifact",
    artifact: { retention: "session" },
  },
};

/** Truncation point for the stderr excerpt carried inside Bash's persisted envelope. */
const PERSISTED_STDERR_PREVIEW_BYTES = 500;

/**
 * Executes a shell command through ExecutionPort. The per-call `timeout` input
 * overrides metadata.timeoutMs up to maxTimeoutMs. Cancellation follows the
 * ExecutionPort contract (SIGTERM, then SIGKILL after 750ms).
 */
export const bashTool: ToolDefinition<BashInput, BashOutput> = {
  metadata,
  inputSchema: bashInputSchema,
  handler: async (input, ctx) => {
    const timeoutMs = input.timeout ?? metadata.timeoutMs;

    let stdoutTail: Buffer = Buffer.alloc(0);
    let stderrTail: Buffer = Buffer.alloc(0);
    const result = await ctx.ports.exec.run({
      command: input.command,
      cwd: ctx.cwd,
      timeoutMs,
      maxOutputBytes: metadata.maxOutputBytes,
      settleOnShellExit: true,
      onOutput: ({ stream, text }) => {
        const chunk = Buffer.from(text);
        if (stream === "stdout") stdoutTail = rollingTail(stdoutTail, chunk);
        else stderrTail = rollingTail(stderrTail, chunk);
      },
      abortSignal: ctx.abortSignal,
    });

    const output: BashOutput = {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      durationMs: result.durationMs,
    };

    // "completed"/"failed" both mean the command ran to completion (exit code
    // carries the command's own success/failure); timed_out/cancelled/
    // spawn_error mean it never finished, which is a handler-level failure.
    // errorKind classifies the named races so the dispatcher can map the
    // outcome status deterministically while keeping captured output (B2).
    const ok = result.status === "completed" || result.status === "failed";
    const errorKind =
      result.status === "timed_out" || result.status === "cancelled" ? result.status : undefined;
    return {
      ok,
      output,
      error: ok ? undefined : describeFailure(result, stdoutTail.toString("utf-8"), stderrTail.toString("utf-8")),
      errorKind,
    };
  },

  formatPersistedModelContent: formatPersistedBashOutput,
};

const FAILURE_TAIL_BYTES = 2000;

function rollingTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return Buffer.from(combined.subarray(Math.max(0, combined.length - FAILURE_TAIL_BYTES)));
}

/** Status and bounded rolling output tails, including a capture truncation notice. */
function describeFailure(result: { status: string; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }, stdoutTail: string, stderrTail: string): string {
  const parts = [`command ${result.status}`];
  for (const [name, captured, tail, truncated] of [
    ["stdout", result.stdout, stdoutTail, result.stdoutTruncated],
    ["stderr", result.stderr, stderrTail, result.stderrTruncated],
  ] as const) {
    const text = tail || captured.slice(-FAILURE_TAIL_BYTES);
    if (text) parts.push(`${name} (tail${truncated ? "; capture truncated" : ""}):\n${text}`);
  }
  return parts.join("\n");
}

/** Fields of the persisted result this envelope speaks about; anything else is ignored. */
interface PersistedBashFields {
  status?: unknown;
  exitCode?: unknown;
  durationMs?: unknown;
  stderr?: unknown;
}

/**
 * Envelope for an oversized run whose output was spilled to an artifact
 * (§2). Bash needs its own because what gets persisted is a serialized
 * BashOutput — the generic envelope's preview would open on a JSON fragment,
 * burying the one fact the model always needs (did it pass?) inside quoting.
 * Here the verdict comes first, stderr second (it is where diagnostics live,
 * and it is usually short enough to carry whole), and the output preview last.
 *
 * The stated path points at the JSON document, not at raw stdout: the
 * dispatcher persists what it rendered for the model, so a later Grep over the
 * artifact searches escaped JSON. That is a known limit of v1 (design,
 * assumption 5) — persisting raw stdout would have to happen in the execution
 * adapter, which this task does not touch.
 *
 * Typed on `unknown` output and read defensively so the background-capable Bash
 * (whose result type is a union) can share this exact function rather than a
 * drifting copy — the same reason it shares `metadata` by reference.
 */
export function formatPersistedBashOutput({
  result,
  path,
  originalBytes,
  preview,
  previewDirection,
}: PersistedRenderContext<unknown>): string {
  const out: PersistedBashFields =
    typeof result.output === "object" && result.output !== null
      ? (result.output as PersistedBashFields)
      : {};
  const exit = typeof out.exitCode === "number" ? String(out.exitCode) : "none";
  const status = typeof out.status === "string" ? out.status : "unknown";
  const duration = typeof out.durationMs === "number" ? ` after ${out.durationMs}ms` : "";
  const lines = [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${originalBytes} bytes). Full output saved to: ${path}`,
    `Command ${status}; exit code ${exit}${duration}.`,
    "The saved file is the JSON tool result (stdout, stderr, exitCode). Read it with the Read tool (use offset/limit for large files) or search it with Grep.",
  ];

  const stderr = typeof out.stderr === "string" ? out.stderr : "";
  if (stderr.length > 0) {
    const excerpt = capUtf8Bytes(stderr, PERSISTED_STDERR_PREVIEW_BYTES);
    lines.push(
      "",
      `stderr (first ${PERSISTED_STDERR_PREVIEW_BYTES} bytes):`,
      excerpt.truncated ? `${excerpt.text}\n...` : excerpt.text,
    );
  }

  lines.push(
    "",
    `Preview (${previewDirection === "tail" ? "last" : "first"} ${ARTIFACT_PREVIEW_BYTES} bytes of the saved file):`,
    preview,
    "...",
    PERSISTED_OUTPUT_CLOSE_TAG,
  );
  return lines.join("\n");
}

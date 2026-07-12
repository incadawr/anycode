import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { BASH_MAX_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { bashInputSchema, type BashInput, type BashOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "Bash",
  description: "Execute a shell command in the workspace and return its stdout, stderr and exit code.",
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "process",
  needsApproval: true,
  timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  maxTimeoutMs: BASH_MAX_TIMEOUT_MS,
};

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

    const result = await ctx.ports.exec.run({
      command: input.command,
      cwd: ctx.cwd,
      timeoutMs,
      maxOutputBytes: metadata.maxOutputBytes,
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
      error: ok ? undefined : `command ${result.status}`,
      errorKind,
    };
  },
};

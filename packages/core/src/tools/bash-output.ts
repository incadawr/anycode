/**
 * BashOutput (Phase 5 slice 5.5, design §2-B6): reads the output a background
 * task appended since the last read (per-task cursor) plus a status snapshot.
 *

 * needsApproval:false — peeking a session-owned task mutates nothing, so it is
 * allowed in every mode INCLUDING plan (the model must be able to poll a task it
 * already started). Fail-closed idiom (B6): absence of ctx.tasks => honest
 * "unavailable" error-outcome; an unknown id => honest error. Never throws.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import {
  bashOutputInputSchema,
  type BashOutputInput,
  type BashOutputToolOutput,
} from "./schemas.js";

const metadata: ToolMetadata = {
  name: "BashOutput",
  description:
    "Read the output a background task has produced since your last read, along with its current status and exit code.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
};

export const bashOutputTool: ToolDefinition<BashOutputInput, BashOutputToolOutput> = {
  metadata,
  inputSchema: bashOutputInputSchema,
  handler: async (input, ctx) => {
    if (!ctx.tasks) {
      return {
        ok: false,
        error: "background tasks are not available in this session",
      };
    }

    const read = ctx.tasks.readOutput(input.task_id);
    if (!read) {
      return {
        ok: false,
        error: `no background task with id "${input.task_id}" in this session`,
      };
    }

    const { snapshot, newOutput } = read;
    return {
      ok: true,
      output: {
        taskId: snapshot.taskId,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        newOutput,
        outputTruncated: snapshot.outputTruncated,
        // Elapsed wall-clock while running; final duration once terminal.
        runningForMs: (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
      },
    };
  },
};

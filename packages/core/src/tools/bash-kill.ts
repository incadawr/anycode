/**
 * BashKill (Phase 5 slice 5.5, design §2-B7): kills a session-owned background
 * task by id.
 *

 * + sideEffectScope:"process" + needsApproval:false. Kill is the withdrawal of a
 * previously SANCTIONED effect (the task's launch already passed the full Bash
 * permission gate), and only registry-owned tasks are reachable (the port aborts
 * a controller, never signals an arbitrary pid), so the abuse surface is bounded
 * to stopping the session's own tasks — gating each kill would only add noise
 * without adding safety. sideEffectScope:"process" trips the once-per-turn lazy
 * checkpoint (dispatcher.checkpointRequired); harmless and conservatively correct.
 *
 * Fail-closed idiom: absence of ctx.tasks => honest "unavailable" error-outcome;
 * an unknown id => honest error (mirror of BashOutput, B6). A known but
 * already-terminal task returns ok:true with killed:false. Never throws.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import {
  bashKillInputSchema,
  type BashKillInput,
  type BashKillOutput,
} from "./schemas.js";

const metadata: ToolMetadata = {
  name: "BashKill",
  description: "Stop a background task you previously started, by its task id.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "process",
  needsApproval: false,
  timeoutMs: 10_000,
};

export const bashKillTool: ToolDefinition<BashKillInput, BashKillOutput> = {
  metadata,
  inputSchema: bashKillInputSchema,
  handler: async (input, ctx) => {
    if (!ctx.tasks) {
      return {
        ok: false,
        error: "background tasks are not available in this session",
      };
    }

    // Honest unknown-id error (B6/B7): a typo'd id is distinct from a known task
    // that was already terminal. Only registry-owned ids are reachable.
    const before = ctx.tasks.get(input.task_id);
    if (!before) {
      return {
        ok: false,
        error: `no background task with id "${input.task_id}" in this session`,
      };
    }

    // false => the task was already terminal (kill is a no-op). The abort makes
    // the transition to "killed" asynchronous (reaped -> cancelled -> killed), so
    // the status here is honest at read time (typically still "running").
    const killed = ctx.tasks.kill(input.task_id);
    const after = ctx.tasks.get(input.task_id) ?? before;
    return {
      ok: true,
      output: { taskId: after.taskId, killed, status: after.status },
    };
  },
};

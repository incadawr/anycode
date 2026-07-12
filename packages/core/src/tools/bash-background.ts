/**
 * Background-capable Bash (Phase 5 slice 5.5, design §2-B5). This tool is
 * registered by the CLI wiring OVER the default Bash (same name "Bash"); the
 * default tool registry and the desktop model-facing surface never see it


 * riskLevel "high", needsApproval true — validate -> hooks -> gate -> broker all
 * rule exactly as they do for the sync tool. `run_in_background` is invisible to
 * the SafeCommandPermissionEngine (it keys on toolName + input.command only).
 *
 * Handler dispatch:
 *   - run_in_background !== true  -> delegate to the UNCHANGED bashTool.handler,
 *     so the sync path is behaviourally identical (delegation-equivalence, §6#12).
 *   - run_in_background === true  -> start a session-scoped task via ctx.tasks
 *     and return { taskId, status:"running", command } immediately. The task
 *     survives turn-abort by construction — the handler does NOT link

 *     an honest "unavailable" error-outcome, never a throw.
 */

import type { ToolDefinition } from "../types/tools.js";
import { bashTool } from "./bash.js";
import {
  backgroundBashInputSchema,
  type BackgroundBashInput,
  type BashBackgroundStartedOutput,
  type BashOutput,
} from "./schemas.js";

export const backgroundCapableBashTool: ToolDefinition<
  BackgroundBashInput,
  BashOutput | BashBackgroundStartedOutput
> = {

  // copy — a copy would still gate the same today, but sharing the reference
  // makes the "byte-identical permission path" invariant structural.
  metadata: bashTool.metadata,
  inputSchema: backgroundBashInputSchema,
  handler: async (input, ctx) => {
    if (input.run_in_background !== true) {
      // Sync path: delegate verbatim. BackgroundBashInput is a structural
      // superset of BashInput, so the unchanged handler runs identically.
      return bashTool.handler(input, ctx);
    }

    // Fail-closed: no registry in this session => honest unavailable outcome.
    if (!ctx.tasks) {
      return {
        ok: false,
        error:
          "background execution is not available in this session; run the command synchronously",
      };
    }

    const started = ctx.tasks.start({
      command: input.command,
      cwd: ctx.cwd,
      description: input.description,
      // An explicit Bash `timeout` wins; otherwise the manager applies its own


      timeoutMs: input.timeout,
    });

    if (!started.ok) {
      return { ok: false, error: started.message };
    }

    return {
      ok: true,
      output: { taskId: started.taskId, status: "running", command: input.command },
    };
  },
};

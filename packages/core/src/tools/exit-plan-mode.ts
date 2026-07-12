/**
 * ExitPlanMode tool (Phase 4 slice 4.3, design §2.5/§3.1): the model calls it to
 * leave plan mode once it has researched read-only and assembled a full plan. Its
 * metadata (readOnly:true + needsApproval:true) makes the existing permission
 * engine escalate it to an ask in plan mode, so approval of the plan is a normal
 * broker ask — no permission-engine special case. The handler runs ONLY after the
 * broker approved that ask; it then performs the single sanctioned mid-turn mode
 * change through ctx.planMode.
 *
 * The port is populated by the loop when the wiring set AgentLoopConfig.planExitMode
 * (cli/main.ts); its absence is the fail-closed lock (children, and any client that
 * did not opt in, get no control). This tool is NOT in createDefaultToolRegistry
 * and NOT in the tools barrel — the CLI wiring registers it directly, so the
 * desktop prompt and child registries are unchanged. The handler never throws —
 * every path is a ToolResult.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import {
  exitPlanModeInputSchema,
  type ExitPlanModeInput,
  type ExitPlanModeOutput,
} from "./schemas.js";

/** Instantaneous mode flip; no I/O, so a short deadline is ample. */
const EXIT_PLAN_MODE_TIMEOUT_MS = 30_000;

const metadata: ToolMetadata = {
  name: "ExitPlanMode",
  description:
    "Call this ONLY while in plan mode, after you have finished read-only research and can present a complete implementation plan. Pass the full plan as `plan`; the user reviews it and either approves (the session leaves plan mode and you may start implementing — write actions still ask for approval individually) or rejects it (you stay in plan mode; refine the plan and try again). Do not attempt to write files or run commands before the plan is approved.",
  readOnly: true,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: true,
  timeoutMs: EXIT_PLAN_MODE_TIMEOUT_MS,
};

export const exitPlanModeTool: ToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> = {
  metadata,
  inputSchema: exitPlanModeInputSchema,
  handler: async (_input, ctx) => {
    // Fail-closed lock (design §2.4/§3.1): no control => plan exit is unavailable,
    // exactly like the Agent tool without a SubagentPort. Children and any client
    // that did not wire planExitMode land here.
    if (!ctx.planMode) {
      return { ok: false, error: "ExitPlanMode: plan-mode control is unavailable in this context." };
    }

    // The single sanctioned mid-turn transition. Returns null (with zero effects)
    // when the current mode is not plan — the model called the tool outside plan
    // mode (e.g. the client boots in yolo/build), which is a benign no-op error.
    const target = ctx.planMode.exitPlan();
    if (target === null) {
      return {
        ok: false,
        error: `ExitPlanMode: not in plan mode (current mode: ${ctx.planMode.currentMode()}).`,
      };
    }

    return { ok: true, output: { previousMode: "plan", mode: target } };
  },
  formatResultForModel: (result) => {
    if (!result.ok) {
      return result.error ?? "ExitPlanMode: failed to exit plan mode.";
    }
    const mode = result.output?.mode ?? "build";
    return `Plan approved by the user. Permission mode is now "${mode}" — proceed with the implementation; write actions still ask for approval individually.`;
  },
};

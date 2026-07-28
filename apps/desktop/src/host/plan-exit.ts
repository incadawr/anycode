/**
 * Desktop plan-exit contract (TASK.27) — the host-side mirror of the CLI's
 * two-line wiring (cli/main.ts's `registry.register(exitPlanModeTool)` plus the
 * `planExitMode`/`onModeChange` pair in its AgentLoopConfig).
 *
 * It exists as ONE function rather than two inline statements because the two
 * halves are only safe together. Registering the tool alone puts `ExitPlanMode`
 * in the model's tool list while `ctx.planMode` stays absent, so every call
 * comes back "plan-mode control is unavailable in this context" — a worse state
 * than today's, where the model at least does not know the tool exists. Setting
 * `planExitMode` alone builds a control nothing can reach. Both callers (the
 * real boot in index.ts and the protocol test harness) therefore go through
 * this, and plan-exit.test.ts pins the atomicity.
 *
 * The target mode is hard-wired to "build": an approved plan buys the right to
 * start implementing, not blanket write trust — every write action still asks
 * individually, exactly as in the CLI. There is deliberately no "approve +
 * auto-accept edits" variant.
 */

import { exitPlanModeTool } from "@anycode/core";
import type { AgentLoopConfig, PermissionMode, ToolRegistry } from "@anycode/core";

/** Mode an approved plan advances the session to. Never "auto"/"edit" (see file header). */
export const DESKTOP_PLAN_EXIT_MODE = "build" as const;

/** The two AgentLoopConfig fields that switch the plan-exit arc on. */
export type PlanExitControl = Required<Pick<AgentLoopConfig, "planExitMode" | "onModeChange">>;

/**
 * Registers `ExitPlanMode` into `registry` and returns the matching loop
 * control. `onModeChange` fires MID-TURN, from inside the approved tool's
 * handler, after the loop has already advanced `config.mode` — the callback's
 * only job is to tell the host (persist + notify the UI), never to change the
 * mode again.
 */
export function wirePlanExit(
  registry: ToolRegistry,
  onModeChange: (mode: PermissionMode) => void,
): PlanExitControl {
  registry.register(exitPlanModeTool);
  return { planExitMode: DESKTOP_PLAN_EXIT_MODE, onModeChange };
}

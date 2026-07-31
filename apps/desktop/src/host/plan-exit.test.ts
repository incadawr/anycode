/**
 * TASK.27 — the atomicity guard for the desktop plan-exit contract.
 *
 * The bug this closes was exactly a split wiring: the CLI registered
 * `exitPlanModeTool` AND set `AgentLoopConfig.planExitMode`, the desktop host
 * did neither. The dangerous middle state is registering the tool WITHOUT the
 * control — the model then sees `ExitPlanMode` in its tool list, calls it, and
 * gets the fail-closed "plan-mode control is unavailable" error forever. These
 * tests pin that both halves are produced by ONE call, so they cannot drift
 * apart in a future edit of host/index.ts or the test harness.
 */
import { describe, expect, it, vi } from "vitest";
import { createDefaultToolRegistry } from "@anycode/core";
import { DESKTOP_PLAN_EXIT_MODE, wirePlanExit } from "./plan-exit.js";

describe("wirePlanExit", () => {
  it("registers ExitPlanMode into the passed registry (it is absent from the default one)", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.list()).not.toContain("ExitPlanMode");

    wirePlanExit(registry, vi.fn());

    expect(registry.list()).toContain("ExitPlanMode");
    expect(registry.get("ExitPlanMode")?.metadata.needsApproval).toBe(true);
  });

  it("returns the loop control in the SAME call — the tool is never model-visible without planExitMode", () => {
    const registry = createDefaultToolRegistry();

    const control = wirePlanExit(registry, vi.fn());

    expect(control.planExitMode).toBe("build");
    expect(typeof control.onModeChange).toBe("function");
  });

  it("targets build, never auto/edit — an approved plan buys implementation, not blanket write trust", () => {
    expect(DESKTOP_PLAN_EXIT_MODE).toBe("build");
  });

  it("forwards the loop's mode notification verbatim to the host callback", () => {
    const notify = vi.fn();
    const control = wirePlanExit(createDefaultToolRegistry(), notify);

    control.onModeChange("build");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("build");
  });
});

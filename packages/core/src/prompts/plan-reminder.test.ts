/**
 * TASK.27: the plan-mode reminder is consumed by BOTH clients now (the CLI REPL
 * and the desktop host's Session), so it lives in prompts/ rather than cli/ and
 * is reachable from the package barrel. These tests pin the two facts a second
 * consumer depends on: the tag shape (the transcript sanitizers on both sides
 * strip exactly `<plan-mode-reminder>`), and barrel reachability — without the
 * barrel export the desktop host cannot import it at all, and the only way to
 * keep parity would be a third copy of the rule text.
 */
import { describe, expect, it } from "vitest";
import { PLAN_MODE_REMINDER, withPlanModeReminder } from "./plan-reminder.js";
import * as barrel from "../index.js";

describe("withPlanModeReminder", () => {
  it("appends the reminder inside a paired <plan-mode-reminder> tag, after the user's own text", () => {
    expect(withPlanModeReminder("draft a plan")).toBe(
      `draft a plan\n<plan-mode-reminder>\n${PLAN_MODE_REMINDER}\n</plan-mode-reminder>`,
    );
  });

  it("names ExitPlanMode — the reminder is the only place the model learns the tool exists", () => {
    expect(PLAN_MODE_REMINDER).toContain("ExitPlanMode");
  });

  it("leaves an empty prompt's tag intact (pure string function, no trimming)", () => {
    expect(withPlanModeReminder("")).toBe(
      `\n<plan-mode-reminder>\n${PLAN_MODE_REMINDER}\n</plan-mode-reminder>`,
    );
  });
});

describe("core barrel reachability (TASK.27 desktop consumption)", () => {
  it("exports withPlanModeReminder", () => {
    expect(barrel.withPlanModeReminder).toBe(withPlanModeReminder);
  });

  it("exports exitPlanModeTool so a non-CLI host can register it without a deep import", () => {
    expect(barrel.exitPlanModeTool.metadata.name).toBe("ExitPlanMode");
  });

  it("still keeps ExitPlanMode OUT of the default registry (fail-closed default for children)", () => {
    expect(barrel.createDefaultToolRegistry().list()).not.toContain("ExitPlanMode");
  });
});

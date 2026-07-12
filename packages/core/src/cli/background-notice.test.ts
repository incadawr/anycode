/**
 * Background-task notice formatting/injection tests (design

 * hermetic e2e (notices actually reaching a scripted turn) lives in
 * main.test.ts (§6#5).
 */

import { describe, expect, it } from "vitest";
import { formatTaskNotices, withBackgroundTaskNotices } from "./background-notice.js";
import type { BackgroundTaskNotice } from "../ports/tasks.js";

function notice(overrides?: Partial<BackgroundTaskNotice>): BackgroundTaskNotice {
  return {
    taskId: "task-1",
    command: "pnpm test",
    status: "completed",
    exitCode: 0,
    durationMs: 34_000,
    ...overrides,
  };
}

describe("formatTaskNotices (design §2/R9)", () => {
  it("formats a single completed notice as 'id (`command`): status, exit N, Ns'", () => {
    expect(formatTaskNotices([notice()])).toBe("task-1 (`pnpm test`): completed, exit 0, 34s");
  });

  it("formats multiple notices one per line", () => {
    const notices = [
      notice({ taskId: "task-1", command: "pnpm test", status: "completed", exitCode: 0, durationMs: 34_000 }),
      notice({ taskId: "task-2", command: "npm run build", status: "failed", exitCode: 1, durationMs: 12_500 }),
    ];
    expect(formatTaskNotices(notices)).toBe(
      "task-1 (`pnpm test`): completed, exit 0, 34s\n" + "task-2 (`npm run build`): failed, exit 1, 13s",
    );
  });

  it("formats a null exit code (e.g. killed by signal) honestly as 'exit none', never 'exit null'", () => {
    const text = formatTaskNotices([notice({ status: "killed", exitCode: null, durationMs: 5_000 })]);
    expect(text).toBe("task-1 (`pnpm test`): killed, exit none, 5s");
    expect(text).not.toContain("null");
  });

  it("rounds sub-second durations to the nearest whole second", () => {
    expect(formatTaskNotices([notice({ durationMs: 400 })])).toContain(", 0s");
    expect(formatTaskNotices([notice({ durationMs: 600 })])).toContain(", 1s");
  });

  it("never includes the task's output — only id/command/status/exit/duration", () => {
    const text = formatTaskNotices([notice()]);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).not.toMatch(/stdout|stderr|output/i);
  });

  it("an empty array formats to the empty string", () => {
    expect(formatTaskNotices([])).toBe("");
  });
});

describe("withBackgroundTaskNotices (design §2.C1, mirror of withPlanModeReminder)", () => {
  it("appends a <system-reminder> block with the formatted notices after the user input", () => {
    const result = withBackgroundTaskNotices("continue", [notice()]);
    expect(result).toBe(
      "continue\n<system-reminder>\nBackground task update:\ntask-1 (`pnpm test`): completed, exit 0, 34s\n</system-reminder>",
    );
  });

  it("wraps every notice inside the SAME single tag pair, not one pair per notice", () => {
    const notices = [
      notice({ taskId: "task-1" }),
      notice({ taskId: "task-2", command: "npm run build", status: "failed", exitCode: 1 }),
    ];
    const result = withBackgroundTaskNotices("continue", notices);
    expect(result.match(/<system-reminder>/g)).toHaveLength(1);
    expect(result.match(/<\/system-reminder>/g)).toHaveLength(1);
    expect(result).toContain("task-1");
    expect(result).toContain("task-2");
  });

  it("never mutates the original userInput text — it is a strict prefix of the result", () => {
    const userInput = "keep going with the refactor";
    const result = withBackgroundTaskNotices(userInput, [notice()]);
    expect(result.startsWith(userInput)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { backgroundCardStatus, backgroundExitCode, backgroundTaskForToolCall, formatTaskElapsed, outputFileFromResult, visibleBackgroundTasks, type ClaudeBackgroundTask } from "./claude-background-tasks.js";

const task = (extra: Partial<ClaudeBackgroundTask> = {}): ClaudeBackgroundTask => ({ type: "claude_background_task", taskId: "t", toolCallId: "call", kind: "bash", description: "", startedAt: 0, status: "running", ...extra });

describe("Claude background task linking", () => {
  it("hides foreground-tracked tasks from the list and the card link", () => {
    const fg = task({ taskId: "fg", toolCallId: "fg-call", foreground: true });
    expect(visibleBackgroundTasks([task(), fg]).map(item => item.taskId)).toEqual(["t"]);
    expect(backgroundTaskForToolCall([fg], "fg-call")).toBeUndefined();
    expect(backgroundTaskForToolCall([task()], "call")?.taskId).toBe("t");
  });
  it("maps task state to the card badge with the exit code", () => {
    expect(backgroundCardStatus(task())).toEqual({ label: "Running in background", tone: "running" });
    expect(backgroundCardStatus(task({ status: "completed", summary: 'Background command "sleep 5" completed (exit code 0)' }))).toEqual({ label: "Completed (exit 0)", tone: "success" });
    expect(backgroundCardStatus(task({ status: "failed", summary: 'Background command "x" failed with exit code 2' }))).toEqual({ label: "Failed (exit 2)", tone: "error" });
    expect(backgroundCardStatus(task({ status: "failed" }))).toEqual({ label: "Failed", tone: "error" });
    expect(backgroundCardStatus(task({ status: "stopped" })).label).toBe("Stopped");
    expect(backgroundCardStatus(task({ status: "unknown" })).tone).toBe("unknown");
    expect(backgroundExitCode("no code here")).toBeUndefined();
  });
  it("reads the output path from the launch result", () => {
    expect(outputFileFromResult("Command running in background with ID: b7c02s81d. Output is being written to: /tmp/claude-501/proj/sess/tasks/b7c02s81d.output")).toBe("/tmp/claude-501/proj/sess/tasks/b7c02s81d.output");
    expect(outputFileFromResult("Output is being written to: /tmp/a b/x.output\nmore")).toBe("/tmp/a b/x.output");
    expect(outputFileFromResult("nothing")).toBeUndefined();
    expect(outputFileFromResult(null)).toBeUndefined();
  });
  it("formats elapsed time", () => {
    expect(formatTaskElapsed(0, 5000)).toBe("5s");
    expect(formatTaskElapsed(0, 125000)).toBe("2m 5s");
  });
});

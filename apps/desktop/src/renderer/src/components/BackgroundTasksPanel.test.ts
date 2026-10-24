import { describe, expect, it } from "vitest";
import type { BackgroundTaskSnapshot } from "@anycode/core";
import { buildTaskKillRequest, buildTaskOutputRequest, formatTaskStatus, isTaskStoppable, sortTasksNewestFirst } from "./BackgroundTasksPanel.js";

function task(overrides: Partial<BackgroundTaskSnapshot> = {}): BackgroundTaskSnapshot {
  return {
    taskId: "task-1",
    command: "pnpm test",
    status: "running",
    exitCode: null,
    startedAt: 1_000,
    outputBytes: 0,
    outputTruncated: false,
    ...overrides,
  };
}

describe("formatTaskStatus", () => {
  it("maps all six statuses to their labels", () => {
    expect(formatTaskStatus("running")).toBe("Running");
    expect(formatTaskStatus("completed")).toBe("Completed");
    expect(formatTaskStatus("failed")).toBe("Failed");
    expect(formatTaskStatus("timed_out")).toBe("Timed out");
    expect(formatTaskStatus("killed")).toBe("Killed");
    expect(formatTaskStatus("spawn_error")).toBe("Spawn error");
  });
});

describe("isTaskStoppable", () => {
  it("running → true", () => {
    expect(isTaskStoppable(task({ status: "running" }))).toBe(true);
  });

  it("each terminal status → false", () => {
    const terminal: BackgroundTaskSnapshot["status"][] = ["completed", "failed", "timed_out", "killed", "spawn_error"];
    for (const status of terminal) {
      expect(isTaskStoppable(task({ status, endedAt: 2_000 }))).toBe(false);
    }
  });
});

describe("sortTasksNewestFirst", () => {
  it("returns an empty array for an empty list", () => {
    expect(sortTasksNewestFirst([])).toEqual([]);
  });

  it("orders newest startedAt first regardless of input order", () => {
    const oldest = task({ taskId: "a", startedAt: 100 });
    const middle = task({ taskId: "b", startedAt: 200 });
    const newest = task({ taskId: "c", startedAt: 300 });
    expect(sortTasksNewestFirst([oldest, newest, middle])).toEqual([newest, middle, oldest]);
  });

  it("does not mutate the input array", () => {
    const list = [task({ taskId: "a", startedAt: 100 }), task({ taskId: "b", startedAt: 200 })];
    const original = [...list];
    sortTasksNewestFirst(list);
    expect(list).toEqual(original);
  });
});

describe("buildTaskKillRequest", () => {
  it("builds a confirmed:true task_kill_request carrying the given taskId/requestId (the SOLE kill constructor, TASK.91)", () => {
    expect(buildTaskKillRequest("task-9", "req-1")).toEqual({
      type: "task_kill_request",
      requestId: "req-1",
      taskId: "task-9",
      confirmed: true,
    });
  });
});

describe("buildTaskOutputRequest", () => {
  it("builds a payload-carrying task_output_request", () => {
    expect(buildTaskOutputRequest("task-9")).toEqual({
      type: "task_output_request",
      taskId: "task-9",
    });
  });
});

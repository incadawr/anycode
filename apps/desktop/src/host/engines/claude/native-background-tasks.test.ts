import { describe, expect, it } from "vitest";
import { ClaudeNativeBackgroundTasks } from "./native-background-tasks.js";
import type { ClaudeStreamMessage } from "./protocol.js";

// Synthetic lifecycle frames: these do not assert the live CLI's Bash/Monitor wire shape.
const frame = (subtype: string, fields: Record<string, unknown>) => ({ type: "system", subtype, ...fields }) as ClaudeStreamMessage;

describe("native background task correlation", () => {
  it("tracks concurrent tasks by id and rejects mismatched or duplicate terminal frames", () => {
    const tasks = new ClaudeNativeBackgroundTasks();
    expect(tasks.onFrame(frame("task_started", { task_id: "a", tool_use_id: "ta", task_type: "local_bash", description: "build" }))).toMatchObject({ taskId: "a", kind: "bash", status: "running" });
    expect(tasks.onFrame(frame("task_started", { task_id: "b", tool_use_id: "tb", task_type: "monitor", description: "watch" }))).toMatchObject({ taskId: "b", kind: "monitor" });
    expect(tasks.onFrame(frame("task_notification", { task_id: "a", tool_use_id: "tb", status: "completed" }))).toBeUndefined();
    expect(tasks.onFrame(frame("task_progress", { task_id: "b", description: "waiting" }))).toMatchObject({ taskId: "b", description: "waiting" });
    expect(tasks.onFrame(frame("task_notification", { task_id: "a", status: "completed", summary: "done", output_file: "/tmp/a.output" }))).toMatchObject({ taskId: "a", status: "completed", summary: "done" });
    expect(tasks.onFrame(frame("task_notification", { task_id: "a", status: "failed" }))).toBeUndefined();
    expect(tasks.onFrame(frame("task_notification", { task_id: "b", status: "failed" }))).toMatchObject({ taskId: "b", status: "failed" });
  });
  it("does not infer tasks from unrelated or incomplete frames", () => {
    const tasks = new ClaudeNativeBackgroundTasks();
    expect(tasks.onFrame(frame("task_started", { task_id: "x", tool_use_id: "t", task_type: "local_agent" }))).toBeUndefined();
    expect(tasks.onFrame(frame("task_started", { task_id: "x", task_type: "local_bash" }))).toBeUndefined();
    expect(tasks.onFrame(frame("task_notification", { task_id: "x", status: "completed" }))).toBeUndefined();
  });
});

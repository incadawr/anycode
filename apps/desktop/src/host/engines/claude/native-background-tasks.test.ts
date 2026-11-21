import { describe, expect, it } from "vitest";
import { ClaudeNativeBackgroundTasks } from "./native-background-tasks.js";
import type { ClaudeStreamMessage } from "./protocol.js";
import { readFileSync } from "node:fs";

// Synthetic lifecycle frames: these do not assert the live CLI's Bash/Monitor wire shape.
const frame = (subtype: string, fields: Record<string, unknown>) => ({ type: "system", subtype, ...fields }) as ClaudeStreamMessage;

describe("native background task correlation", () => {
  it("projects the task ids and terminal result of a redacted live Bash capture", () => {
    // This is a field-only summary of the actual CLI 2.1.326 stream, not raw
    // assistant messages; use it only for lifecycle and origin assertions.
    const lines = readFileSync(new URL("./contract/evidence/claude-2.1.326-background-bash-summary.jsonl", import.meta.url), "utf8").trim().split("\n");
    const frames = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    const started = frames.find(frame => frame.subtype === "task_started")!;
    const notification = frames.find(frame => frame.subtype === "task_notification")!;
    const results = frames.filter(frame => frame.type === "result");
    expect(started.task_type).toBe("local_bash");
    expect(notification).toMatchObject({ task_id: started.task_id, tool_use_id: started.tool_use_id, status: "completed" });
    expect(results).toHaveLength(2);
    expect(results[0]?.origin).toBeUndefined();
    expect(results[1]?.origin).toMatchObject({ kind: "task-notification", producer: "session-task" });
    expect(frames.indexOf(results[0]!)).toBeLessThan(frames.indexOf(notification));
    expect(frames.indexOf(notification)).toBeLessThan(frames.indexOf(results[1]!));
    const tasks = new ClaudeNativeBackgroundTasks();
    expect(tasks.onFrame(started as ClaudeStreamMessage)).toMatchObject({ taskId: started.task_id, kind: "bash", status: "running" });
    expect(tasks.onFrame(notification as ClaudeStreamMessage)).toMatchObject({ taskId: started.task_id, status: "completed" });
  });
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

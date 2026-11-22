// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement as h, mount, byRole, click } from "../ui/ui.test-utils.js";
const send = vi.fn();
let state: Record<string, unknown> = {};
vi.mock("../tab-context.js", () => ({ useTabSend: () => send, useTabStore: (selector: (s: unknown) => unknown) => selector(state) }));
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayFlag: () => {} }));
import { ClaudeBackgroundTasks, taskOutputHint } from "./ClaudeBackgroundTasks.js";

const base = { type: "claude_background_task" as const, taskId: "task-a", toolCallId: "call", kind: "bash" as const, description: "", startedAt: Date.now() - 5000, status: "running" as const };
const call = { kind: "tool_call", toolCallId: "call", input: { command: "sleep 5" }, modelText: "Command running in background with ID: task-a. Output is being written to: /tmp/claude-1/p/sess/tasks/task-a.output" };
const read = vi.fn();
const open = vi.fn();
afterEach(() => { vi.useRealTimers(); read.mockReset(); open.mockReset(); send.mockReset(); });
function setup(tasks: unknown[], response: unknown = null) {
  state = { claudeBackgroundTasks: tasks, claudeTaskOutput: response, transcript: [call] };
  Object.defineProperty(window, "anycode", { configurable: true, value: { claudeTaskOutput: { read, open } } });
}

describe("Claude background tasks indicator", () => {
  it("renders nothing without tasks and ignores foreground-tracked ones", () => {
    setup([{ ...base, foreground: true }]);
    expect(mount(h(ClaudeBackgroundTasks)).container.querySelector(".claude-bg-tasks")).toBeNull();
  });

  it("shows the running count, lists the task and requests output by task id only", () => {
    setup([base, { ...base, taskId: "b", toolCallId: "other", kind: "monitor", description: "watch", status: "completed" }]);
    const view = mount(h(ClaudeBackgroundTasks));
    const trigger = byRole(view.container, "button", "Background tasks: 1 running");
    expect(trigger.textContent).toBe("1");
    expect(view.container.querySelector(".claude-bg-popover")).toBeNull();
    click(trigger);
    const panel = byRole(view.container, "dialog", "Background tasks");
    expect(panel.textContent).toContain("Bash: sleep 5");
    expect(panel.textContent).toContain("Monitor: watch");
    expect(panel.textContent).toContain("Running in background");
    expect(panel.textContent).not.toContain("Choose output file");
  });

  it("shows the output tail directly, with the launch-result path as a hint, and opens the file", async () => {
    read.mockResolvedValue({ ok: true, content: "line 1\nline 2", truncated: false });
    setup([base]);
    const view = mount(h(ClaudeBackgroundTasks));
    click(byRole(view.container, "button", /Background tasks/));
    const request = send.mock.lastCall![0];
    expect(request).toEqual({ type: "claude_task_output_request", taskId: "task-a", requestId: expect.any(String) });
    setup([base], { taskId: "task-a", requestId: request.requestId, sessionRef: "sess" });
    await act(async () => { view.render(h(ClaudeBackgroundTasks)); await Promise.resolve(); });
    expect(read).toHaveBeenCalledWith({ taskId: "task-a", sessionRef: "sess", outputFile: "/tmp/claude-1/p/sess/tasks/task-a.output" });
    expect(view.container.querySelector(".claude-bg-output")?.textContent).toBe("line 1\nline 2");
    click(byRole(view.container, "button", "Open output file"));
    expect(open).toHaveBeenCalledWith({ taskId: "task-a", sessionRef: "sess", outputFile: "/tmp/claude-1/p/sess/tasks/task-a.output" });
  });

  it("says so when the output cannot be read and closes on Escape", async () => {
    read.mockResolvedValue({ ok: false, reason: "unavailable" });
    setup([{ ...base, status: "completed" }]);
    const view = mount(h(ClaudeBackgroundTasks));
    click(byRole(view.container, "button", "Background tasks: 1"));
    setup([{ ...base, status: "completed" }], { taskId: "task-a", requestId: send.mock.lastCall![0].requestId });
    await act(async () => { view.render(h(ClaudeBackgroundTasks)); await Promise.resolve(); });
    expect(view.container.textContent).toContain("Output is not available yet.");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(view.container.querySelector(".claude-bg-popover")).toBeNull();
  });

  it("prefers the notification's output file over the launch result", () => {
    expect(taskOutputHint({ ...base, outputFile: "/tmp/x.output" }, [call as never])).toBe("/tmp/x.output");
    expect(taskOutputHint(base, [call as never])).toBe("/tmp/claude-1/p/sess/tasks/task-a.output");
  });
});

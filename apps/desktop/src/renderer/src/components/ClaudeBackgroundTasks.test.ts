// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement as h, mount, byRole, click } from "../ui/ui.test-utils.js";
const send = vi.fn();
vi.mock("../tab-context.js", () => ({ useTabSend: () => send, useTabStore: (selector: (s: unknown) => unknown) => selector({ claudeTaskOutput: null, transcript: [{ kind: "tool_call", toolCallId: "call", input: { command: "sleep 5" } }] }) }));
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayFlag: () => {} }));
import { ClaudeBackgroundTasks } from "./ClaudeBackgroundTasks.js";

describe("Claude background tasks", () => {
  it("shows running details and the completed summary and requests only a task id", () => {
    const now = Date.now();
    const startedAt = now - 5000;
    const task = { type: "claude_background_task" as const, taskId: "task-a", toolCallId: "call", kind: "bash" as const, description: "", startedAt, status: "running" as const };
    const view = mount(h(ClaudeBackgroundTasks, { tasks: [task], now }));
    const indicator = byRole(view.container, "button", /Background Bash: sleep 5/);
    expect(indicator.title).toContain("running · 5s");
    click(indicator);
    expect(view.container.textContent).toContain("sleep 5");
    view.render(h(ClaudeBackgroundTasks, { tasks: [{ ...task, status: "completed", summary: "Finished" }], now: Date.now() }));
    expect(view.container.textContent).toContain("Finished");
    click(byRole(view.container, "button", "Choose output file…"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "claude_task_output_request", taskId: "task-a", requestId: expect.any(String) }));
    expect(send.mock.lastCall?.[0]).not.toHaveProperty("path");
  });
});

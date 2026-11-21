// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement as h, mount, byRole, click } from "../ui/ui.test-utils.js";
const send = vi.fn();
let response: unknown = null;
vi.mock("../tab-context.js", () => ({ useTabSend: () => send, useTabStore: (selector: (s: unknown) => unknown) => selector({ claudeTaskOutput: response, transcript: [{ kind: "tool_call", toolCallId: "call", input: { command: "sleep 5" } }] }) }));
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayFlag: () => {} }));
import { ClaudeBackgroundTasks } from "./ClaudeBackgroundTasks.js";

describe("Claude background tasks", () => {
  it("shows running details and the completed summary and requests only a task id", () => {
    response = null;
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

  it("shows selected output and distinguishes cancellation", async () => {
    response = null;
    const pick = vi.fn().mockResolvedValueOnce({ ok: true, content: "fixture output" }).mockResolvedValueOnce({ ok: false, reason: "cancelled" });
    Object.defineProperty(window, "anycode", { configurable: true, value: { claudeTaskOutput: { pick } } });
    const task = { type: "claude_background_task" as const, taskId: "task-a", toolCallId: "call", kind: "bash" as const, description: "job", startedAt: 1, status: "completed" as const };
    const view = mount(h(ClaudeBackgroundTasks, { tasks: [task], now: 1 }));
    click(byRole(view.container, "button", /Background Bash: job/));
    click(byRole(view.container, "button", "Choose output file…"));
    response = { taskId: "task-a", requestId: send.mock.lastCall![0].requestId, sessionRef: "session" };
    await act(async () => { view.render(h(ClaudeBackgroundTasks, { tasks: [task], now: 2 })); await Promise.resolve(); });
    expect(pick).toHaveBeenCalledWith("task-a", "session");
    expect(view.container.textContent).toContain("fixture output");
    click(byRole(view.container, "button", "Choose output file…"));
    response = { taskId: "task-a", requestId: send.mock.lastCall![0].requestId, sessionRef: "session" };
    await act(async () => { view.render(h(ClaudeBackgroundTasks, { tasks: [task], now: 3 })); await Promise.resolve(); });
    expect(view.container.textContent).toContain("File selection cancelled.");
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createElement as h, mount } from "../ui/ui.test-utils.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore, type ToolCallBlock } from "../store.js";
import { ToolCallCard } from "./ToolCallCard.js";

const block: ToolCallBlock = { kind: "tool_call", id: "b1", toolCallId: "call", toolName: "Bash", input: { command: "sleep 60", run_in_background: true }, status: "success", modelText: "Command running in background", snapshots: { before: null, after: null }, subagent: null, workflow: null };
const task = { type: "claude_background_task" as const, taskId: "t", toolCallId: "call", kind: "bash" as const, description: "sleep 60", startedAt: 1, status: "running" as const };

describe("Bash card linked to its background task", () => {
  it("shows running in background, then the final result with the exit code", () => {
    const store = createDesktopStore();
    const send = (event: object) => store.getState().applyHostMessage({ type: "agent_event", turnId: "detached-subagent", event: event as never });
    const view = mount(h(TabContext.Provider, { value: { tabId: "tab", store } }, h(ToolCallCard, { block })));
    const badge = () => view.container.querySelector(".tool-call-status-badge")?.textContent;
    expect(badge()).toBe("Success");
    act(() => send(task));
    expect(badge()).toBe("Running in background");
    expect(view.container.querySelector(".tool-call-card")?.className).toContain("tool-call-status-running");
    act(() => send({ ...task, status: "completed", summary: 'Background command "sleep 60" completed (exit code 0)' }));
    expect(badge()).toBe("Completed (exit 0)");
    expect(view.container.querySelector(".tool-call-card")?.className).toContain("tool-call-status-success");
    act(() => send({ ...task, status: "failed", summary: "failed with exit code 3" }));
    expect(badge()).toBe("Failed (exit 3)");
  });

  it("leaves a card whose task is foreground-tracked or absent untouched", () => {
    const store = createDesktopStore();
    const view = mount(h(TabContext.Provider, { value: { tabId: "tab", store } }, h(ToolCallCard, { block })));
    act(() => store.getState().applyHostMessage({ type: "agent_event", turnId: "detached-subagent", event: { ...task, foreground: true } as never }));
    expect(view.container.querySelector(".tool-call-status-badge")?.textContent).toBe("Success");
  });
});

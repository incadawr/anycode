// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { BackgroundAgents } from "./BackgroundAgents.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows admission elapsed time immediately and stops ticking when empty", async () => {
  vi.useFakeTimers();
  const store = createDesktopStore();
  const container = document.createElement("div");
  const root = createRoot(container);
  const startedAt = Date.now();
  const child = { childSessionId: "child", agentType: "executor", description: "Review", startedAt, turns: 31, toolCalls: 72, lastTool: "A very long tool name", waitingForApproval: true };
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(BackgroundAgents))));
    await act(async () => { vi.advanceTimersByTime(120_000); });
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [child] }));
    expect(container.textContent).toContain("2m 00s");
    expect(container.querySelector(".background-agents-progress")?.getAttribute("title")).toBe("turn 31 · 72 tools · A very long tool name");
    expect(container.querySelector(".background-agents-waiting")?.getAttribute("title")).toBe("Waiting for permission");
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(container.textContent).toContain("2m 01s");
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [{ ...child, childSessionId: "other", startedAt: Date.now() - 5_000 }] }));
    expect(container.textContent).toContain("5s");
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [] }));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [child] }));
    expect(container.textContent).toContain("2m 01s");
  } finally {
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it("keeps a failed child visible with its reason after it leaves the live snapshot", async () => {
  const store = createDesktopStore();
  const container = document.createElement("div");
  const root = createRoot(container);
  const child = { childSessionId: "child", spawnToolCallId: "spawn", agentType: "codex", description: "Review", startedAt: Date.now() };
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(BackgroundAgents))));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [child] }));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [] }));
    await act(async () => store.getState().applyHostMessage({ type: "child_report", id: "spawn", text: "failed", childTerminal: { status: "error", durationMs: 1, failureReason: "host failed to initialize: timeout" } }));
    expect(container.textContent).toContain("Error: host failed to initialize: timeout");
    expect(container.textContent).not.toContain("Stop");
  } finally { await act(async () => root.unmount()); }
});

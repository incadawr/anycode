// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";
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

afterEach(() => { vi.restoreAllMocks(); });

const mount = async (store: ReturnType<typeof createDesktopStore>) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(BackgroundAgents))));
  return { container, root };
};
const failChild = (store: ReturnType<typeof createDesktopStore>, spawn: string, reason: string) =>
  act(async () => store.getState().applyHostMessage({ type: "child_report", id: spawn, text: "failed", childTerminal: { status: "error", durationMs: 90_000, failureReason: reason } }));

it("freezes a failed duration while a running one advances, with a mixed heading", async () => {
  vi.useFakeTimers();
  const store = createDesktopStore();
  const { container, root } = await mount(store);
  const t0 = Date.now();
  const running = { childSessionId: "run-1", spawnToolCallId: "s-run", agentType: "executor", description: "Keep going", startedAt: t0 };
  const running2 = { ...running, childSessionId: "run-2", spawnToolCallId: "s-run2", description: "Also going" };
  const doomed = { childSessionId: "bad", spawnToolCallId: "s-bad", agentType: "codex", description: "Doomed task", startedAt: t0 };
  try {
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [running, running2, doomed] }));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [running, running2] }));
    await failChild(store, "s-bad", "host failed to initialize");
    expect(container.querySelector(".background-agents-heading")?.textContent).toBe("2 running · 1 failed");
    const rows = () => Array.from(container.querySelectorAll(".background-agents-item"));
    const elapsed = (row: Element) => row.querySelector(".background-agents-elapsed")?.textContent;
    const failedRow = () => rows().find((row) => row.textContent?.includes("Doomed task"))!;
    expect(elapsed(failedRow())).toBe("1m 30s");
    expect(failedRow().textContent).toContain("Error: host failed to initialize");
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(elapsed(failedRow())).toBe("1m 30s");
    expect(elapsed(rows().find((row) => row.textContent?.includes("Keep going"))!)).toBe("2m 00s");
    // Only failed rows offer Dismiss; only running rows offer Stop.
    expect(failedRow().querySelector("button")?.textContent).toBe("Dismiss");
    expect(rows().filter((row) => row.textContent?.includes("Stop")).length).toBe(2);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("a failed-only strip keeps a frozen clock, stops the tick and names its heading", async () => {
  vi.useFakeTimers();
  const store = createDesktopStore();
  const { container, root } = await mount(store);
  const child = { childSessionId: "bad", spawnToolCallId: "s-bad", agentType: "codex", description: "Doomed", startedAt: Date.now() };
  try {
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [child] }));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [] }));
    await failChild(store, "s-bad", "boom");
    expect(container.querySelector(".background-agents-heading")?.textContent).toBe("1 background agent failed");
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(container.querySelector(".background-agents-elapsed")?.textContent).toBe("1m 30s");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("Dismiss by keyboard removes only the failed row and sends no host request", async () => {
  const sendSpy = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => undefined as never);
  const store = createDesktopStore();
  const { container, root } = await mount(store);
  const base = { agentType: "codex", startedAt: Date.now() };
  const longDescription = "Investigate the intermittent startup failure across every managed worktree and report the exact cause ".repeat(3);
  const longReason = "host failed to initialize: timeout while waiting for the child process to report ready ".repeat(3);
  try {
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [
      { ...base, childSessionId: "run", spawnToolCallId: "s-run", description: "Still running" },
      { ...base, childSessionId: "bad", spawnToolCallId: "s-bad", description: longDescription },
    ] }));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [{ ...base, childSessionId: "run", spawnToolCallId: "s-run", description: "Still running" }] }));
    await failChild(store, "s-bad", longReason);
    const failedRow = Array.from(container.querySelectorAll(".background-agents-item")).find((row) => row.textContent?.includes("Investigate"))!;
    // Full text stays available through the title; layout truncates it.
    expect(failedRow.querySelector(".background-agents-description")?.getAttribute("title")).toBe(longDescription);
    expect(failedRow.querySelector(".background-agents-failure")?.getAttribute("title")).toBe(longReason);
    // No relation is known to this renderer, so there is no Open button.
    expect(failedRow.textContent).not.toContain("Open");
    const dismiss = failedRow.querySelector("button") as HTMLButtonElement;
    expect(dismiss.getAttribute("aria-label")).toBe(`Dismiss failed background agent ${longDescription}`);
    await act(async () => {
      dismiss.focus();
      expect(document.activeElement === dismiss || dismiss.type === "button").toBe(true);
      dismiss.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      dismiss.click(); // a browser turns Enter on a focused button into this click
    });
    expect(container.textContent).not.toContain("Investigate");
    expect(container.textContent).toContain("Still running");
    expect(container.querySelector(".background-agents-heading")?.textContent).toBe("1 background agent running");
    expect(store.getState().failedBackgroundChildren).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
    // A repeated report does not bring the dismissed row back.
    await failChild(store, "s-bad", longReason);
    expect(container.textContent).not.toContain("Investigate");
  } finally { await act(async () => root.unmount()); }
});

it("falls back to the agent type in the Dismiss name and treats an empty reason as failed", async () => {
  const store = createDesktopStore();
  const { container, root } = await mount(store);
  const child = { childSessionId: "bad", spawnToolCallId: "s-bad", agentType: "reviewer", description: "", startedAt: Date.now() };
  try {
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [child] }));
    await act(async () => store.getState().applyHostMessage({ type: "background_children", children: [] }));
    await act(async () => store.setState({ failedBackgroundChildren: [{ ...child, endedAt: child.startedAt + 5_000, failureReason: "" }] }));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Dismiss failed background agent reviewer");
    expect(container.querySelector(".background-agents-failure")?.textContent).toBe("Failed");
    expect(container.textContent).not.toContain("Stop");
  } finally { await act(async () => root.unmount()); }
});

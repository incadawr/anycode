// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("restored context popover", () => {
  it.each([
    [{ costUsd: 0.0271 }, "$0.0271"],
    [{ costUsd: 0 }, "$0"],
    [{ unpricedSteps: 1 }, "price unknown"],
  ])("shows the saved cost while the breakdown is pending", async (cost, expected) => {
    Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
    const store = createDesktopStore();
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
    store.getState().applyHostMessage({ type: "session_checkpoint", usageAudit: { lastStep: null, totalSteps: 1, totals: { input: 0, output: 0, total: 0, stepsReported: 1, stepsWithCache: 0, ...cost } } });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]');
      expect(trigger?.textContent).toContain("25%");
      await act(async () => trigger!.click());
      expect(container.textContent?.toLowerCase()).toContain(expected.toLowerCase());
      expect(container.querySelector('[aria-label="Loading context breakdown"]')).not.toBeNull();
      expect(send).toHaveBeenCalledWith("tab", { type: "context_breakdown_request" });
    } finally { await act(async () => root.unmount()); container.remove(); send.mockRestore(); }
  });
});

it("replaces the restored reading with newer live usage", () => {
  const store = createDesktopStore();
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
  store.getState().applyHostMessage({ type: "agent_event", turnId: "new", event: { type: "context_usage", estimatedTokens: 50, budgetTokens: 100, source: "estimate" } });
  expect(store.getState().contextUsage).toEqual({ estimatedTokens: 50, budgetTokens: 100, source: "estimate" });
});

it("keeps saved cost accessible without inventing a context percentage", async () => {
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const store = createDesktopStore();
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s" });
  store.getState().applyHostMessage({ type: "session_checkpoint", usageAudit: { lastStep: null, totalSteps: 1, totals: { input: 0, output: 0, total: 0, stepsReported: 1, stepsWithCache: 0, costUsd: 0.0271 } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]');
    expect(trigger?.textContent).toBe("Usage");
    await act(async () => trigger!.click());
    expect(container.textContent).toContain("$0.0271");
    expect(container.querySelector(".ctx-popover-bar")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("never attributes a previous measured turn to a new streaming or failed turn", async () => {
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const store = createDesktopStore();
  vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const old = { turnId: "old", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0, outputTokens: 100, generationDurationMs: 1000 };
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
  store.getState().applyHostMessage({ type: "usage_audit", steps: [old], totals: { input: 0, output: 100, total: 100, stepsReported: 1, stepsWithCache: 0, generationTokensPerSecond: 100 } });
  store.getState().applyHostMessage({ type: "turn_started", turnId: "new", requestId: "r" });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]')!.click());
    expect(container.textContent).toContain("Generation speed: session 100 t/s · this turn —");
    await act(async () => store.getState().applyHostMessage({ type: "agent_event", turnId: "new", event: { type: "loop_end", reason: "error", turns: 1 } }));
    expect(container.textContent).toContain("Generation speed: session 100 t/s · this turn —");
    await act(async () => store.getState().applyHostMessage({ type: "session_checkpoint", latestTurnId: "new" }));
    expect(container.textContent).toContain("Generation speed: session 100 t/s · this turn —");
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); }
});

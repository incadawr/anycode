// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useSettingsStore } from "../settings-store.js";
import { tabRegistry } from "../tab-registry.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("shows only the pinned connection and follows settings updates", async () => {
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const settings = cloneDefaults();
  const quota = (n: number) => ({ observedAt: new Date().toISOString(), windows: { rolling: { usedPercent: n }, weekly: { usedPercent: n + 1 }, monthly: { usedPercent: n + 2 } } });
  settings.provider.connections = [{ id: "a", providerId: "opencode", lastGoQuota: quota(12) }, { id: "b", providerId: "opencode", lastGoQuota: quota(90) }]; settings.provider.activeConnectionId = "b";
  const original = useSettingsStore.getState().snapshot;
  const snapshot = { settings, readOnly: false, secrets: [], envOverrides: [], providerReady: true, catalog: [] };
  useSettingsStore.setState({ snapshot });
  const store = createDesktopStore(); store.getState().setPinnedConnection({ connectionId: "a", providerId: "opencode" });
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]')!.click());
    expect(element.textContent).toContain("5h · 12% used"); expect(element.textContent).toContain("Weekly · 13% used"); expect(element.textContent).toContain("Monthly · 14% used"); expect(element.textContent).not.toContain("90% used");
    const updated = { ...settings, provider: { ...settings.provider, connections: [{ ...settings.provider.connections[0]!, lastGoQuota: undefined }, settings.provider.connections[1]!] } };
    await act(async () => useSettingsStore.setState({ snapshot: { ...snapshot, settings: updated } })); expect(element.querySelector(".go-quota")).toBeNull();
  } finally { await act(async () => root.unmount()); element.remove(); send.mockRestore(); useSettingsStore.setState({ snapshot: original }); }
});

it("expires an open popover and cleans up its clock when closed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T06:00:00Z"));
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "a", providerId: "opencode", lastGoQuota: { observedAt: new Date().toISOString(), windows: { monthly: { usedPercent: 16 } } } }];
  const original = useSettingsStore.getState().snapshot;
  useSettingsStore.setState({ snapshot: { settings, readOnly: false, secrets: [], envOverrides: [], providerReady: true, catalog: [] } });
  const store = createDesktopStore(); store.getState().setPinnedConnection({ connectionId: "a", providerId: "opencode" });
  store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const interval = vi.spyOn(window, "setInterval"); const clear = vi.spyOn(window, "clearInterval");
  const add = vi.spyOn(document, "addEventListener"); const remove = vi.spyOn(document, "removeEventListener");
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]')!;
    await act(async () => trigger.click());
    expect(element.querySelector(".go-quota")?.textContent).toContain("Monthly · 16% used");
    const clockIndex = interval.mock.calls.findIndex(call => call[1] === 60_000);
    expect(clockIndex).toBeGreaterThanOrEqual(0);
    const clock = interval.mock.results[clockIndex]!.value;
    const listener = add.mock.calls.find(call => call[0] === "visibilitychange")?.[1];
    expect(listener).toBeDefined();
    await act(async () => vi.advanceTimersByTime(300_000));
    expect(element.querySelector(".go-quota")).toBeNull();
    await act(async () => trigger.click());
    expect(clear).toHaveBeenCalledWith(clock);
    expect(remove).toHaveBeenCalledWith("visibilitychange", listener);
  } finally {
    await act(async () => root.unmount()); element.remove(); send.mockRestore(); interval.mockRestore(); clear.mockRestore(); add.mockRestore(); remove.mockRestore();
    useSettingsStore.setState({ snapshot: original }); vi.useRealTimers();
  }
});

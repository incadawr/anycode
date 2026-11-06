// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PluginsPane, type PluginsBridge } from "./PluginsPane.js";
import type { PluginsChangedReason, PluginsSnapshot } from "../../../shared/plugins-config.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the catalog origin for mount, push, mutation and update-check refreshes", async () => {
  const snapshot: PluginsSnapshot = {
    plugins: [{ name: "fixture", displayName: "Fixture", description: "", version: "1", tier: "official", status: "active", disabled: false,
      source: { kind: "official" }, managed: { enabled: true, pinned: false, active: "1" },
      capabilities: { skills: 1, agents: 0, workflows: 0, mcp: [], commands: 0, hooks: false, docs: false, engineSupport: [], promptOverlays: 0, services: [] },
      mcpServerNames: [], serviceNames: [], mcpConsentGranted: false, problems: [] }],
    available: [], index: { status: "ok", serial: 1, checkedAt: undefined }, settings: { autoUpdateOfficial: false, indexConfigured: true },
  };
  let push!: (payload: PluginsChangedReason) => void;
  const unsubscribe = vi.fn();
  const list = vi.fn(async () => snapshot);
  const setEnabled = vi.fn(async () => ({ ok: true as const }));
  const checkUpdates = vi.fn(async () => ({ ...snapshot, plugins: [] }));
  const bridge = { list, setEnabled, checkUpdates, onChanged: (fn: typeof push) => { push = fn; return unsubscribe; } } as unknown as PluginsBridge;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PluginsPane, { bridge, catalogTabId: "b", sessionsApiStateOf: async () => "off" as const })));
    expect(list).toHaveBeenLastCalledWith({ tabId: "b" });
    await act(async () => push("install"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ tabId: "b" });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Disable fixture"]')!.click());
    expect(setEnabled).toHaveBeenCalledWith("fixture", false);
    expect(list).toHaveBeenCalledTimes(3);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Check for updates")!.click());
    expect(checkUpdates).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Fixture");
    expect(list.mock.calls.every(args => JSON.stringify(args) === JSON.stringify([{ tabId: "b" }]))).toBe(true);
    await act(async () => root.render(createElement(PluginsPane, { bridge, catalogTabId: "a" })));
    expect(list).toHaveBeenLastCalledWith({ tabId: "a" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(PluginsPane, { bridge })));
    expect(list).toHaveBeenLastCalledWith(undefined);
  } finally { await act(async () => root.unmount()); }
});

it("ignores late origin reads, shows a neutral closed-origin state, and recovers on scope change and retry", async () => {
  const snapshot: PluginsSnapshot = { plugins: [], available: [], index: { status: "not configured" },
    settings: { autoUpdateOfficial: false, indexConfigured: false } };
  const replies: { resolve: (snapshot: PluginsSnapshot) => void; reject: (error: Error) => void }[] = [];
  const list = vi.fn(() => new Promise<PluginsSnapshot>((resolve, reject) => replies.push({ resolve, reject })));
  let push!: (payload: PluginsChangedReason) => void;
  const bridge = { list, onChanged: (fn: typeof push) => { push = fn; return () => {}; } } as unknown as PluginsBridge;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (catalogTabId: string, catalogOriginUnavailable = false) => act(async () => root.render(createElement(PluginsPane,
    { bridge, catalogTabId, catalogOriginUnavailable, sessionsApiStateOf: async () => "off" as const })));
  try {
    await render("b");
    await act(async () => replies[0]!.resolve(snapshot));
    await act(async () => push("install"));
    await render("b", true);
    await act(async () => replies[1]!.reject(new Error("closed origin")));
    expect(container.textContent).toContain("original session is no longer available");
    expect(container.textContent).not.toContain("Plugins service unavailable");
    await render("a");
    expect(list).toHaveBeenLastCalledWith({ tabId: "a" });
    await act(async () => replies[2]!.resolve(snapshot));
    expect(container.querySelector('[data-plugins-state="ready"]')).not.toBeNull();
    await act(async () => push("install"));
    await act(async () => replies[3]!.reject(new Error("temporary")));
    expect(container.textContent).toContain("Plugins service unavailable");
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click());
    await act(async () => replies[4]!.resolve(snapshot));
    expect(container.querySelector('[data-plugins-state="ready"]')).not.toBeNull();
    await act(async () => push("install"));
    await act(async () => replies[5]!.resolve(snapshot));
    expect(container.querySelector('[data-plugins-state="ready"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});

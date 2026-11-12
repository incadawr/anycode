// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import type { ScopeWorkspaceEntry, ScopeWorkspacesListResult } from "../../../shared/scope-workspaces.js";
import type { SettingsStoreApi } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen.js";
import type { SettingsPaneRequest } from "./settings-extensions-navigation.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
const runtime = vi.hoisted(() => ({ stores: new Map() }));
vi.mock("../tab-registry.js", () => ({ tabRegistry: { getStore: (id: string) => runtime.stores.get(id) } }));
vi.mock("./McpServersPane.js", () => ({ McpServersPane: (p: { tabId?: string; servers: { name: string; state: string }[] }) =>
  createElement("output", { "data-pane": "mcp" }, `${p.tabId ?? "user"}:${p.servers.map(s => `${s.name}/${s.state}`).join(",")}`) }));
vi.mock("./SkillsPane.js", () => ({ SkillsPane: (p: { tabId?: string }) => createElement("output", null, `skills:${p.tabId ?? "user"}`) }));
vi.mock("./PluginsPane.js", () => ({ PluginsPane: (p: { catalogTabId?: string; catalogOriginUnavailable?: boolean; onCatalogReset?: () => void }) =>
  createElement("output", null, p.catalogOriginUnavailable ? createElement("button", { onClick: p.onCatalogReset }, "Reload plugins") : `plugins:${p.catalogTabId ?? "default"}`) }));
vi.mock("./RolesPane.js", () => ({ RolesPane: (p: { registerGuard?: (g: ((action: () => void, cancel?: () => void) => void) | null) => void }) => {
  const [pending, setPending] = useState<{ action: () => void; cancel?: () => void }>();
  useEffect(() => {
    p.registerGuard?.((action, cancel) => setPending({ action, cancel }));
    return () => p.registerGuard?.(null);
  }, [p.registerGuard]);
  return createElement("div", null, "Roles draft", pending && createElement("div", null,
    createElement("button", { onClick: () => { setPending(undefined); pending.action(); } }, "Accept"),
    createElement("button", { onClick: () => { setPending(undefined); pending.cancel?.(); } }, "Cancel")));
} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let store: SettingsStoreApi;
let entries: ScopeWorkspaceEntry[];
let list: ReturnType<typeof vi.fn<() => Promise<ScopeWorkspacesListResult>>>;
let consume: ReturnType<typeof vi.fn<(token: number) => void>>;
let legacy: (pane: "mcp") => void;
let send: (request: SettingsPaneRequest) => void;
const originalTabs = useTabsStore.getState();
const request = { pane: "mcp", tabId: "b", scope: "project", token: 1 } as const;
function folder(id: string, tabIds: string[]): ScopeWorkspaceEntry {
  return { id, tabIds, name: id, displayPath: `~/projects/${id}`, exists: true };
}
async function mount(extra: Partial<SettingsScreenProps> = {}) {
  const bridge = { list };
  function Host() {
    const [initialPane, setInitialPane] = useState(extra.initialPane ?? "tools");
    legacy = setInitialPane;
    const [pending, setPending] = useState<SettingsPaneRequest>();
    send = setPending;
    return createElement(SettingsScreen, { store, scopeBridge: bridge, ...extra, initialPane,
      paneRequest: pending, onPaneRequestConsumed: token => { consume(token); setPending(p => p?.token === token ? undefined : p); } });
  }
  await act(async () => root.render(createElement(Host)));
}
async function navigate(value: SettingsPaneRequest = request) { await act(async () => send(value)); }
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
function output() { return container.querySelector("output")?.textContent; }
async function active(id: string) { await act(async () => useTabsStore.setState({ activeTabId: id })); }
beforeEach(() => {
  entries = [folder("ws_a", ["a"]), folder("ws_b", ["b"])];
  list = vi.fn(async () => ({ ok: true as const, workspaces: entries }));
  consume = vi.fn();
  runtime.stores.clear();
  runtime.stores.set("a", createStore(() => ({ mcpServers: [{ name: "A", state: "failed" }] })));
  runtime.stores.set("b", createStore(() => ({ mcpServers: [{ name: "B", state: "connected" }] })));
  useTabsStore.setState({ tabs: [{ tabId: "a", workspace: "/a" }, { tabId: "b", workspace: "/b" }] as typeof originalTabs.tabs, activeTabId: "a" });
  store = createStore(() => ({ snapshot: { settings: cloneDefaults(), secrets: [], envOverrides: [], readOnly: false, catalog: [] },
    notice: null, updateStatus: { kind: "idle" }, subscribeUpdates: () => () => {} })) as unknown as SettingsStoreApi;
  vi.stubGlobal("anycode", { settings: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useTabsStore.setState(originalTabs, true);
  vi.unstubAllGlobals();
});

it.each([false, true])("keeps origin runtime after consumption and active-tab changes, same workspace=%s", async same => {
  if (same) entries = [folder("ws_shared", ["a", "b"])];
  await mount();
  await navigate();
  expect(consume).toHaveBeenCalledWith(1);
  expect(output()).toBe(`${same ? "ws_shared" : "ws_b"}:B/connected`);
  await active("b");
  await active("a");
  expect(output()).toContain("B/connected");
  await act(async () => runtime.stores.get("b").setState({ mcpServers: [{ name: "B", state: "closed" }] }));
  expect(output()).toContain("B/closed");
  await act(async () => {
    entries = same ? [folder("ws_shared", ["a"])] : [folder("ws_a", ["a"]), folder("ws_b", [])];
    useTabsStore.setState({ tabs: [{ tabId: "a", workspace: "/a" }] as typeof originalTabs.tabs });
  });
  expect(output()).not.toContain("A/");
  expect(output()).not.toContain("B/");
  expect(container.textContent).toContain("Live status is unavailable");
});

it("clears the rail filter for identical repeat requests and applies User without runtime", async () => {
  await mount();
  await navigate();
  const search = container.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!;
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "tools");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(output()).toBeUndefined();
  await navigate({ ...request, token: 2 });
  expect(search.value).toBe("");
  expect(output()).toBe("ws_b:B/connected");
  await navigate({ ...request, scope: "user", token: 3 });
  expect(output()).toBe("user:");
  expect(container.textContent).toContain("Live status is unavailable");
});

it("consumes Cancel without changing scope, and Accept applies pane and scope together", async () => {
  await mount({ initialPane: "roles" });
  await navigate();
  expect(container.textContent).toContain("Roles draft");
  expect(consume).not.toHaveBeenCalled();
  await click("Cancel");
  expect(consume).toHaveBeenCalledWith(1);
  expect(container.textContent).toContain("Roles draft");
  await navigate({ ...request, token: 2 });
  await click("Accept");
  expect(output()).toBe("ws_b:B/connected");
  expect(consume).toHaveBeenCalledWith(2);
});

it("revalidates a tab that disappears while the Roles guard is open", async () => {
  await mount({ initialPane: "roles" });
  await navigate();
  await act(async () => {
    entries = [folder("ws_a", ["a"])];
    useTabsStore.setState({ tabs: [{ tabId: "a", workspace: "/a" }] as typeof originalTabs.tabs });
  });
  await click("Accept");
  expect(output()).toBe("user:");
  expect(container.textContent).toContain("That project is no longer available");
  expect(consume).toHaveBeenCalledTimes(1);
});

it("waits for a late scope list while active tab changes", async () => {
  let resolve!: (result: ScopeWorkspacesListResult) => void;
  list.mockImplementation(() => new Promise(done => { resolve = done; }));
  await mount();
  await navigate();
  await active("b");
  expect(consume).not.toHaveBeenCalled();
  await act(async () => resolve({ ok: true, workspaces: entries }));
  expect(output()).toBe("ws_b:B/connected");
  await active("a");
  expect(output()).toBe("ws_b:B/connected");
});

it("passes the originating catalog tab to Plugins and keeps legacy MCP active-tab behavior", async () => {
  await mount();
  await navigate({ ...request, pane: "plugins" });
  expect(output()).toBe("plugins:b");
  await active("b");
  await click("MCP");
  expect(output()).toBe("ws_b:B/connected");
  await active("a");
  expect(output()).toBe("ws_b:");
});

it("hides origin dots when its workspace changes and permits explicit scope navigation", async () => {
  await mount();
  await navigate();
  await act(async () => {
    entries = [folder("ws_a", ["a", "b"]), folder("ws_b", [])];
    useTabsStore.setState({ tabs: [{ tabId: "a", workspace: "/a" }, { tabId: "b", workspace: "/a" }] as typeof originalTabs.tabs });
  });
  expect(output()).toBe("ws_b:");
  expect(container.textContent).toContain("Live status is unavailable");
  await act(async () => container.querySelector<HTMLButtonElement>(".scope-dropdown-trigger")!.click());
  await act(async () => {
    const user = document.querySelector<HTMLElement>('[role="option"]')!;
    user.click();
  });
  expect(output()).toBe("user:");
});

it("shows visible fallback when a vanished origin requested a pane without a scope bar", async () => {
  await mount();
  await navigate({ ...request, pane: "plugins", tabId: "vanished" });
  expect(output()).toBe("Reload plugins");
  expect(container.textContent).toContain("That project is no longer available");
  expect(consume).toHaveBeenCalledWith(1);
});

it("a legacy request for the same pane restores active-tab runtime behavior", async () => {
  entries = [folder("ws_shared", ["a", "b"])];
  await mount();
  await navigate();
  expect(output()).toBe("ws_shared:B/connected");
  await act(async () => legacy("mcp"));
  expect(output()).toBe("ws_shared:A/failed");
  await active("b");
  expect(output()).toBe("ws_shared:B/connected");
});

it("ignores an older scope reply after a tab-list change", async () => {
  const replies: ((result: ScopeWorkspacesListResult) => void)[] = [];
  list.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  await mount();
  await navigate();
  await act(async () => useTabsStore.setState({ tabs: [...useTabsStore.getState().tabs, { tabId: "c", workspace: "/c" }] as typeof originalTabs.tabs }));
  await act(async () => replies[0]!({ ok: true, workspaces: [folder("wrong", ["b"])] }));
  expect(consume).not.toHaveBeenCalled();
  await act(async () => replies[1]!({ ok: true, workspaces: entries }));
  expect(output()).toBe("ws_b:B/connected");
  expect(consume).toHaveBeenCalledOnce();
});

it("retains origin status during async scope refresh and invalidates closed or moved origins immediately", async () => {
  await mount();
  await navigate();
  const replies: ((result: ScopeWorkspacesListResult) => void)[] = [];
  list.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  await act(async () => useTabsStore.setState({ tabs: [...useTabsStore.getState().tabs, { tabId: "c", workspace: "/c" }] as typeof originalTabs.tabs }));
  expect(output()).toBe("ws_b:B/connected");
  expect(container.textContent).not.toContain("Live status is unavailable");
  await act(async () => replies[0]!({ ok: true, workspaces: entries }));
  expect(output()).toBe("ws_b:B/connected");
  await act(async () => useTabsStore.setState({ tabs: useTabsStore.getState().tabs.map(tab => tab.tabId === "b" ? { ...tab, workspace: "/moved" } : tab) }));
  expect(output()).not.toContain("B/connected");
  await act(async () => useTabsStore.setState({ tabs: useTabsStore.getState().tabs.filter(tab => tab.tabId !== "b") }));
  expect(output()).not.toContain("B/connected");
  expect(container.textContent).toContain("Live status is unavailable");
  await act(async () => replies[2]!({ ok: true, workspaces: [folder("ws_a", ["a"]), folder("ws_b", [])] }));
  expect(output()).not.toContain("B/connected");
});

it("offers a neutral Plugins state after origin closure and reloads without the closed origin", async () => {
  await mount();
  await navigate({ ...request, pane: "plugins" });
  let resolve!: (result: ScopeWorkspacesListResult) => void;
  list.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => useTabsStore.setState({ tabs: useTabsStore.getState().tabs.filter(tab => tab.tabId !== "b") }));
  expect(output()).toBe("Reload plugins");
  await act(async () => resolve({ ok: true, workspaces: [folder("ws_a", ["a"])] }));
  await click("Reload plugins");
  expect(output()).toBe("plugins:default");
});


it.each(["rejected", "failed", "missing"])("keeps the Plugins origin unknown when the scope snapshot is %s", async mode => {
  if (mode === "rejected") list.mockRejectedValue(new Error("unavailable"));
  if (mode === "failed") list.mockResolvedValue({ ok: false, reason: "failed" });
  await mount(mode === "missing" ? { scopeBridge: undefined } : {});
  await navigate({ ...request, pane: "plugins" });
  expect(consume).toHaveBeenCalledWith(1);
  expect(output()).toBe("plugins:b");
  expect(container.textContent).not.toContain("Reload plugins");
});

it("keeps a new tab's origin unknown after a failed refresh of an older snapshot", async () => {
  await mount();
  list.mockRejectedValue(new Error("unavailable"));
  await act(async () => useTabsStore.setState({ tabs: [...useTabsStore.getState().tabs, { tabId: "c", workspace: "/c" }] as typeof originalTabs.tabs }));
  await navigate({ ...request, pane: "plugins", tabId: "c" });
  expect(output()).toBe("plugins:c");
});

it("clears a saved turn limit and shows inline errors for invalid input", async () => {
  const setPatch = vi.fn(async () => {});
  const settings = cloneDefaults();
  settings.tools.maxTurns = 300;
  store.setState({ snapshot: { ...store.getState().snapshot!, settings }, setPatch } as never);
  await mount();
  const rootTurns = container.querySelector<HTMLInputElement>('input[placeholder="Unlimited"]')!;
  const childTurns = container.querySelector<HTMLInputElement>('input[placeholder="150"]')!;
  const setValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  expect(rootTurns.value).toBe("300");
  await setValue(rootTurns, "");
  await setValue(childTurns, "oops");
  expect(childTurns.getAttribute("aria-invalid")).toBe("true");
  expect(container.textContent).toContain("Enter a positive whole number or leave blank.");
  await click("Save tools settings");
  expect(setPatch).not.toHaveBeenCalled();
  await setValue(childTurns, "");
  await click("Save tools settings");
  expect(setPatch).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.objectContaining({ maxTurns: "" }) }));
});

it("shows the subagent turns hint only for a valid value and the error only for an invalid one", async () => {
  await mount();
  const childTurns = container.querySelector<HTMLInputElement>('input[placeholder="150"]')!;
  const setValue = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(childTurns, value);
      childTurns.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const field = () => childTurns.closest("label")!;
  const hint = () => field().querySelector(".settings-field-hint")?.textContent ?? null;
  const error = () => field().querySelector(".settings-field-error")?.textContent ?? null;
  await setValue("150");
  expect(hint()).toBe("Whole number, 1 or more; blank = default.");
  expect(error()).toBeNull();
  await setValue("oops");
  expect(hint()).toBeNull();
  expect(error()).toBe("Enter a positive whole number or leave blank.");
  expect(error()).not.toBe(hint());
});

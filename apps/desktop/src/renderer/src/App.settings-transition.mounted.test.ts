// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { cloneDefaults } from "../../settings/schema.js";
import { useSettingsStore } from "./settings-store.js";
import { useTabsStore } from "./tabs-store.js";
import { ConnectionDrawerFields } from "./components/ConnectionDrawer.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("./port.js", () => ({ startConnectionManager: () => () => {} }));
vi.mock("./preview/overlay-flag.js", async (original) => ({ ...await original<typeof import("./preview/overlay-flag.js")>(), useOverlayFlag: () => {} }));
vi.mock("./components/WelcomeScreen.js", () => ({ WelcomeScreen: ({ onOpenSettings }: { onOpenSettings: () => void }) => createElement("button", { onClick: onOpenSettings }, "Open settings") }));
vi.mock("./components/Sidebar.js", () => ({ Sidebar: () => createElement("div", null, "Shell"), SIDEBAR_SEARCH_EVENT: "search" }));
vi.mock("./components/StartScreen.js", () => ({ StartScreen: () => createElement("div", null, "Start") }));
vi.mock("./components/TerminalPanel.js", () => ({ TerminalPanel: () => null }));
vi.mock("./components/AccountBudgetCard.js", () => ({ AccountBudgetCard: () => null }));
vi.mock("./components/SettingsScreen.js", async (original) => ({ ...await original<typeof import("./components/SettingsScreen.js")>(), SettingsDialog: ({ open }: { open: boolean }) => open ? createElement("section", null, createElement(ConnectionDrawerFields, { mode: "add", catalog: fixture.catalog as never, connections: [], secrets: [], readOnly: false, store: fixture.store as never })) : null }));

const fixture = vi.hoisted(() => ({ catalog: [] as unknown[], store: null as unknown }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalSettings = useSettingsStore.getState();
const originalTabs = useTabsStore.getState();
afterEach(() => { useSettingsStore.setState(originalSettings, true); useTabsStore.setState(originalTabs, true); vi.unstubAllGlobals(); });

it.each(["before submit", "during submit"])("preserves the first connection drawer when a late external engine becomes available %s", async (timing) => {
  let changed = () => {};
  let engines = ["core"];
  Object.defineProperty(window, "anycode", { configurable: true, value: { platform: "darwin", listAvailableEngines: async () => ({ engineIds: engines }), onEnginesChanged: (fn: () => void) => { changed = fn; return () => {}; } } });
  const settings = cloneDefaults();
  const snapshot = { settings, providerReady: false, readOnly: false, catalog: [], secrets: [], envOverrides: [] };
  useSettingsStore.setState({ snapshot: snapshot as never, load: vi.fn() });
  useTabsStore.setState({ tabs: [], activeTabId: null, draftActive: false });
  let finishCreate!: (value: unknown) => void;
  const create = vi.fn(() => new Promise(resolve => { finishCreate = resolve; }));
  fixture.catalog = [{ id: "openai", name: "OpenAI", authKind: "api_key", models: [{ id: "test-model" }] }];
  fixture.store = createStore(() => ({ snapshot, oauthPendingProviderId: null, connectionCreate: create, load: vi.fn() }));
  const { App } = await import("./App.js");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Open settings")!.click());
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { provider.value = "openai"; provider.dispatchEvent(new Event("change", { bubbles: true })); });
    const label = container.querySelector<HTMLInputElement>('input[placeholder="e.g. Work, Personal"]') ?? container.querySelector<HTMLInputElement>("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(label, "Main"); label.dispatchEvent(new Event("input", { bubbles: true })); });
    const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create connection")!;
    expect(button.disabled).toBe(false);
    if (timing === "during submit") await act(async () => button.click());
    await act(async () => { engines = ["core", "claude"]; changed(); });
    expect(container.textContent).toContain("Shell");
    expect(container.querySelector("input")).toBe(label);
    expect(label.value).toBe("Main");
    if (timing === "before submit") await act(async () => button.click());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai", label: "Main" }));
    await act(async () => finishCreate({ ok: true, createdConnectionId: "conn-1", snapshot }));
    expect(provider.disabled).toBe(true);
    expect(container.textContent).toContain("Save");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

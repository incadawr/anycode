// @vitest-environment jsdom
import { act, createElement, Fragment, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionHeader } from "./SessionHeader.js";
import { LspPanel } from "./LspPanel.js";
import { tabRegistry } from "../tab-registry.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useTabsStore } from "../tabs-store.js";
import { isOverlayOpen, useOverlayFlag } from "../preview/overlay-flag.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createDesktopStore>;
const originalTabs = useTabsStore.getState();
const originalWidth = window.innerWidth;
const props = { sidebarCollapsed: true, onToggleSidebar: () => {}, onToast: () => {} };
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Extensions"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Extensions"]');
async function render(tabId = "a", content: ReactNode = createElement(SessionHeader, props)) {
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId, store } }, content)));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function key(element: HTMLElement, value: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });
}
beforeEach(() => {
  store = createDesktopStore();
  store.setState({ workspace: "/project", transcript: [{ kind: "user", text: "Hello" } as never] });
  useTabsStore.setState({ tabs: [{ tabId: "a", title: "Project" } as never], activeTabId: "a" });
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    sessionPeers: { get: vi.fn(async () => ({ ok: false })) },
    communication: { get: vi.fn(async () => ({ ok: false })) },
    browserAccess: { get: vi.fn(async () => ({ ok: true, tabs: [] })), onChanged: () => () => {} },
    mcpConfig: { get: vi.fn(async () => ({ entries: [
      { name: "project-mcp", source: "project", enabled: false }, { name: "compat-mcp", source: "compat" },
      { name: "user-mcp", source: "user", shadowed: true },
    ], pluginServers: [{ name: "plugin-mcp", shadowed: false }], problems: [] })) },
    plugins: { list: vi.fn(async () => ({ plugins: [{ name: "installed-plugin" }], available: [{}, {}] })), onChanged: () => () => {} },
    skills: { list: vi.fn(async () => ({ rows: ["one", "two", "three"].map((name) => ({ name, sourceKind: "user", enabled: true })), problems: [] })) },
    lspConfig: { status: vi.fn(async () => ({ entries: { project: [{ name: "project-lsp" }], user: [{ name: "user-lsp" }] }, catalog: [] })) },
  } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  useTabsStore.setState(originalTabs, true);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

it("opens one portal dialog with scoped configured counts and returns focus on Escape", async () => {
  await render();
  expect(window.anycode.mcpConfig.get).not.toHaveBeenCalled();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await click(trigger());
  const panel = dialog()!;
  expect(panel.parentElement).toBe(document.body);
  expect(panel.getAttribute("aria-modal")).toBe("false");
  expect(trigger().getAttribute("aria-controls")).toBe(panel.id);
  expect(isOverlayOpen()).toBe(true);
  const rows = [...panel.querySelectorAll("button")];
  expect(rows.map((row) => row.textContent)).toEqual(["MCP2›", "Plugins1›", "Skills3›", "LSP2›"]);
  expect(document.activeElement).toBe(rows[0]);
  expect(panel.querySelector("button button, button input")).toBeNull();
  for (const call of [window.anycode.mcpConfig.get, window.anycode.plugins.list, window.anycode.skills.list, window.anycode.lspConfig.status]) {
    expect(call).toHaveBeenCalledExactlyOnceWith({ tabId: "a" });
  }
  await key(rows[0]!, "End");
  expect(document.activeElement).toBe(rows[3]);
  await key(rows[3]!, "ArrowUp");
  expect(document.activeElement).toBe(rows[2]);
  await key(rows[2]!, "Home");
  expect(document.activeElement).toBe(rows[0]);
  await key(rows[0]!, "Escape");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(isOverlayOpen()).toBe(false);
});

it("opens with ArrowDown and preserves outside and Tab-exit destination focus", async () => {
  await render();
  await key(trigger(), "ArrowDown");
  expect(dialog()).not.toBeNull();
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () => {
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    outside.focus();
  });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(outside);
  await click(trigger());
  await key(document.activeElement as HTMLElement, "Tab");
  await act(async () => outside.focus());
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect(isOverlayOpen()).toBe(false);
});

it("cleans overlay on tab switch and unmount without stealing focus", async () => {
  await render();
  await click(trigger());
  await render("b");
  expect(dialog()).toBeNull();
  expect(isOverlayOpen()).toBe(false);
  await click(trigger());
  expect(isOverlayOpen()).toBe(true);
  await act(async () => root.render(null));
  expect(dialog()).toBeNull();
  expect(isOverlayOpen()).toBe(false);
});

it("matches header environment visibility and preserves the new-session composer environment", async () => {
  await render();
  expect(trigger()).not.toBeNull();
  expect(container.querySelector('[aria-label="Open environment menu"]')).not.toBeNull();
  await act(async () => store.setState({ transcript: [] }));
  expect(trigger()).toBeNull();
  expect(container.querySelector('[aria-label="Open environment menu"]')).toBeNull();
  await render("a", createElement(EnvironmentMenu, { placement: "composer" }));
  expect(container.querySelector('[aria-label="Open environment menu"]')).not.toBeNull();
  await act(async () => store.setState({ workspace: null }));
  await render();
  expect(trigger()).toBeNull();
  expect(container.querySelector('[aria-label="Open environment menu"]')).toBeNull();
  await act(async () => store.setState({ transcript: [{ kind: "user", text: "Hello" } as never] }));
  expect(trigger()).toBeNull();
});

it("keeps unavailable counts distinct from empty catalogs", async () => {
  vi.mocked(window.anycode.skills.list).mockRejectedValue(new Error("private details"));
  vi.mocked(window.anycode.plugins.list).mockResolvedValue({ plugins: [], available: [] } as never);
  await render();
  await click(trigger());
  expect(dialog()!.textContent).toContain("Skills—");
  expect(dialog()!.textContent).toContain("Plugins0");
  expect(dialog()!.textContent).not.toContain("private details");
});

it("does not mount Extensions in the child breadcrumb view", async () => {
  const { ActiveTabBody } = await import("../App.js");
  const { childLayoutStore } = await import("../child-layout.js");
  Object.assign(window.anycode, {
    previewPanel: {
      list: vi.fn(async () => ({ tabId: "a", previews: [], visiblePanelPreviewId: null })),
      setState: vi.fn(async () => {}),
    },
  });
  childLayoutStore.getState().open("a", "child-call");
  try {
    await render("a", createElement(ActiveTabBody, { ...props, tabId: "a" }));
    expect(container.querySelector(".child-session-breadcrumb")).not.toBeNull();
    expect(trigger()).toBeNull();
    expect(dialog()).toBeNull();
    expect(window.anycode.mcpConfig.get).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.render(null));
    childLayoutStore.getState().close("a");
  }
});

it("clamps the portal to viewport edges and recalculates on resize", async () => {
  await render();
  vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue({ left: 900, bottom: 750 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: 280, height: 180 } as DOMRect;
  });
  await click(trigger());
  expect(dialog()!.style.left).toBe(`${window.innerWidth - 288}px`);
  expect(dialog()!.style.top).toBe(`${window.innerHeight - 188}px`);
  vi.mocked(trigger().getBoundingClientRect).mockReturnValue({ left: -20, bottom: 10 } as DOMRect);
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(dialog()!.style.left).toBe("8px");
  expect(dialog()!.style.top).toBe("14px");
});

const categoryButtons = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".session-extensions-category")];
const details = () => dialog()!.querySelector<HTMLElement>('[role="region"]');
async function hover(element: HTMLElement, enter = true) {
  await act(async () => { element.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", { bubbles: true })); });
}
async function resize(width: number) {
  await act(async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

it("opens read-only lists with click, Enter, Space and Right, and returns with Left or Back", async () => {
  await render();
  await click(trigger());
  const categories = categoryButtons();
  for (const [index, name] of ["MCP", "Plugins", "Skills", "LSP"].entries()) {
    await key(categories[index]!, ["ArrowRight", "Enter", " ", "ArrowRight"][index]!);
    expect(details()!.getAttribute("aria-label")).toBe(name);
    expect(document.activeElement).toBe(details());
    expect(categories[index]!.getAttribute("aria-controls")).toBe(details()!.id);
    expect(details()!.querySelectorAll("li").length).toBe([4, 1, 3, 2][index]);
    await key(details()!, "ArrowLeft");
    expect(details()).toBeNull();
    expect(document.activeElement).toBe(categories[index]);
  }
  await click(categories[0]!);
  expect(details()!.textContent).toContain("compat-mcp");
  expect(details()!.textContent).toContain("Shadowed");
  expect(details()!.textContent).toContain("Saved: disabled");
  expect(dialog()!.querySelector('input, button button')).toBeNull();
  expect(dialog()!.querySelectorAll('[role="switch"]')).toHaveLength(2);
  await click(details()!.querySelector("button")!);
  expect(document.activeElement).toBe(categories[0]);
  expect(document.querySelectorAll('[role="dialog"][aria-label="Extensions"]').length).toBe(1);
});

it("delays hover, cancels on leave, and never steals focus or replaces focused details", async () => {
  vi.useFakeTimers();
  await render();
  await click(trigger());
  const categories = categoryButtons();
  await hover(categories[1]!);
  await act(async () => { vi.advanceTimersByTime(149); });
  expect(details()).toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(details()!.getAttribute("aria-label")).toBe("Plugins");
  expect(document.activeElement).toBe(categories[0]);
  await hover(categories[2]!);
  await hover(categories[2]!, false);
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(details()!.getAttribute("aria-label")).toBe("Plugins");
  await click(categories[1]!);
  const back = details()!.querySelector("button")!;
  await act(async () => back.focus());
  await hover(categories[2]!);
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(details()!.getAttribute("aria-label")).toBe("Plugins");
  expect(document.activeElement).toBe(back);
  await key(back, "Escape");
  expect(document.activeElement).toBe(trigger());
  expect(isOverlayOpen()).toBe(false);
  await act(async () => { vi.advanceTimersByTime(0); });
  expect(vi.getTimerCount()).toBe(0);
});

it("uses drill-down below 600px, keeps focus through resize and restores the category", async () => {
  await resize(599);
  await render();
  await click(trigger());
  expect(dialog()!.dataset.layout).toBe("drill-down");
  await click(categoryButtons()[2]!);
  expect(dialog()!.querySelector<HTMLElement>(".session-extensions-categories")!.hidden).toBe(true);
  expect(document.activeElement).toBe(details());
  await click(details()!.querySelector("button")!);
  expect(document.activeElement).toBe(categoryButtons()[2]);
  await resize(600);
  expect(dialog()!.dataset.layout).toBe("columns");
  vi.useFakeTimers();
  await hover(categoryButtons()[1]!);
  await act(async () => { vi.advanceTimersByTime(150); });
  expect(document.activeElement).toBe(categoryButtons()[2]);
  await resize(599);
  expect(document.activeElement).toBe(details());
  await resize(900);
  expect(dialog()!.querySelector<HTMLElement>(".session-extensions-categories")!.hidden).toBe(false);
  expect(document.activeElement).toBe(details());
  await key(details()!, "ArrowLeft");
  expect(document.activeElement).toBe(categoryButtons()[1]);
});

it("renders sanitized names as plain text and excludes private DTO fields", async () => {
  const name = "https://example.test/token-like-name<img src=x>\u202e\n" + "界".repeat(90);
  const snapshot = {
    entries: [{ name, source: "project", enabled: true, commandLine: "PRIVATE_COMMAND", cwd: "PRIVATE_CWD", envKeys: ["PRIVATE_ENV"] }],
    pluginServers: [{ name: "plugin", pluginRoot: "PRIVATE_ROOT" }], problems: ["PRIVATE_ERROR"],
  };
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue(snapshot as never);
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  const text = details()!.querySelector(".session-extensions-name")!.textContent!;
  expect(Array.from(text)).toHaveLength(80);
  expect(text).toMatch(/^https:\/\/example.test\/token-like-name<img src=x>/);
  expect(text).not.toMatch(/[\u202e\n]/);
  expect(text.endsWith("…")).toBe(true);
  expect(details()!.querySelector("img")).toBeNull();
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_");
  expect(details()!.textContent).toContain("Some entries could not be loaded.");
});

it("shows loading, unavailable, retry and empty detail states", async () => {
  let finish!: (value: never) => void;
  vi.mocked(window.anycode.skills.list).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await click(trigger());
  await click(categoryButtons()[2]!);
  expect(details()!.textContent).toContain("Loading configured entries");
  await act(async () => finish({ rows: [], problems: [] } as never));
  expect(details()!.textContent).toContain("No configured entries.");
  await key(details()!, "Escape");
  vi.mocked(window.anycode.skills.list).mockRejectedValueOnce(new Error("PRIVATE_REJECTION"));
  await click(trigger());
  await click(categoryButtons()[2]!);
  expect(details()!.textContent).toContain("Could not load configured entries.");
  const retry = [...details()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
  await click(retry);
  expect(document.activeElement).toBe(details());
  expect(details()!.querySelectorAll("li").length).toBe(3);
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_REJECTION");
});

it("closes after Shift+Tab leaves through the trigger without a late focus restore", async () => {
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  await act(async () => trigger().focus());
  expect(dialog()).not.toBeNull();
  const destination = document.createElement("button");
  document.body.append(destination);
  const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => { trigger().dispatchEvent(tab); destination.focus(); });
  expect(tab.defaultPrevented).toBe(false);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(destination);
  expect(isOverlayOpen()).toBe(false);
});

it("does not trap Tab and cleans pending hover on tab switch", async () => {
  vi.useFakeTimers();
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  const outside = document.createElement("button");
  document.body.append(outside);
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => { details()!.dispatchEvent(event); outside.focus(); });
  expect(event.defaultPrevented).toBe(false);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(outside);
  await click(trigger());
  await hover(categoryButtons()[1]!);
  await render("b");
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(dialog()).toBeNull();
  expect(isOverlayOpen()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

const mcpStatus = (state: "connected" | "failed" | "connecting" | "closed", name = "project-mcp") => ({
  name, state, transport: "stdio" as const, toolCount: 0, toolsTruncated: false, error: "PRIVATE_RUNTIME_ERROR",
});
const warning = () => trigger().querySelector(".session-extensions-warning");

it("updates the header warning before first open, while closed and after status recovery", async () => {
  await render();
  expect(warning()).toBeNull();
  await act(async () => store.setState({ mcpServers: [mcpStatus("failed", "MCP config")] }));
  expect(dialog()).toBeNull();
  expect(warning()).not.toBeNull();
  expect(document.getElementById(trigger().getAttribute("aria-describedby")!)!.textContent).toContain("MCP connection failed");
  expect(window.anycode.mcpConfig.get).not.toHaveBeenCalled();
  await click(trigger());
  expect(categoryButtons()[0]!.textContent).toContain("MCP connection failed");
  await key(categoryButtons()[0]!, "Escape");
  await act(async () => store.setState({ mcpServers: [mcpStatus("closed", "MCP config")] }));
  expect(warning()).toBeNull();
  expect(trigger().hasAttribute("aria-describedby")).toBe(false);
});

it("retains live failures and connections beside saved disabled entries and unmatched diagnostics", async () => {
  store.setState({ connection: "ready", mcpServers: [mcpStatus("failed"), mcpStatus("connected", "removed")] });
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  const text = details()!.textContent!;
  expect(text).toContain("Saved: disabled for new session starts; this session keeps its startup configuration");
  expect(text).toContain("Connection failed");
  expect(text).toContain("This session / Diagnostics");
  expect(text).toContain("Connected in this session");
  expect(text).toContain("Status not reported in this session");
  expect(text).not.toMatch(/no tools|0 tools/i);
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_");
  expect(warning()).not.toBeNull();
  expect(categoryButtons()[0]!.textContent).toContain("2");
});

it("shows unmatched runtime failures during config loading and rejection without false connection errors", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(window.anycode.mcpConfig.get).mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
  store.setState({ mcpServers: [mcpStatus("failed", "MCP config")] });
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Loading configured entries");
  expect(details()!.textContent).toContain("Connection failed");
  await act(async () => reject(new Error("PRIVATE_REJECTION")));
  expect(details()!.textContent).toContain("Could not load configured entries");
  expect(details()!.textContent).toContain("MCP config");
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_");
  await act(async () => store.setState({ mcpServers: [] }));
  expect(warning()).toBeNull();
  expect(details()!.textContent).not.toContain("Connection failed");
});

it("marks stale reports and never presents a disconnected host's last success as current", async () => {
  store.setState({ connection: "host_exited", mcpServers: [mcpStatus("connected"), mcpStatus("failed", "broken")] });
  await render();
  expect(warning()).not.toBeNull();
  expect(trigger().textContent).toContain("Last reported status; host unavailable");
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Last reported status: Connected in this session. Host unavailable");
  expect(details()!.querySelectorAll(".tone-success")).toHaveLength(0);
  expect(details()!.querySelectorAll(".tone-danger")).toHaveLength(1);
});

it("isolates the warning to the supplied tab store, including native engines with no startup report", async () => {
  store.setState({ engine: { id: "codex", capabilities: { supportsTasks: false } } as never, mcpServers: [] });
  await render();
  expect(warning()).toBeNull();
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Status not reported in this session");
  expect(details()!.querySelector(".tone-success")).toBeNull();
  const otherStore = createDesktopStore();
  otherStore.setState({ workspace: "/other", transcript: [{ kind: "user", text: "Other" } as never],
    mcpServers: [mcpStatus("failed", "other-tab")] });
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "b", store: otherStore } }, createElement(SessionHeader, props))));
  expect(dialog()).toBeNull();
  expect(warning()).not.toBeNull();
  await render("a");
  expect(warning()).toBeNull();
});

it("refreshes saved config without clearing a current failure, then retains it after the row disappears", async () => {
  store.setState({ mcpServers: [mcpStatus("failed")] });
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValueOnce({ entries: [
    { name: "project-mcp", source: "project", enabled: true },
  ], problems: [] } as never);
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Saved: enabled");
  expect(details()!.textContent).toContain("Connection failed");
  await key(details()!, "Escape");
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Saved: disabled");
  expect(warning()).not.toBeNull();
  await key(details()!, "Escape");
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue({ entries: [], problems: [] } as never);
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("This session / Diagnostics");
  expect(details()!.textContent).toContain("project-mcp");
  expect(details()!.textContent).toContain("Connection failed");
  expect(categoryButtons()[0]!.textContent).toContain("0");
  expect(warning()).not.toBeNull();
});

it("keeps parse problems separate from runtime failures and offers retry without leaking config", async () => {
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue({ entries: [], problems: ["PRIVATE_PARSE_ERROR"] } as never);
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(details()!.textContent).toContain("Some entries could not be loaded");
  expect(details()!.textContent).not.toContain("Connection failed");
  expect(warning()).toBeNull();
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_PARSE_ERROR");
});

it("updates open details on runtime events without reloading config or moving focus", async () => {
  store.setState({ connection: "ready", mcpServers: [mcpStatus("connecting")] });
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  const focused = document.activeElement;
  const calls = vi.mocked(window.anycode.mcpConfig.get).mock.calls.length;
  expect(details()!.textContent).toContain("Connecting");
  for (const state of ["failed", "connected"] as const) {
    await act(async () => store.setState({ mcpServers: [mcpStatus(state)] }));
    expect(warning() !== null).toBe(state === "failed");
    expect(details()!.textContent).toContain(state === "failed" ? "Connection failed" : "Connected in this session");
    expect(document.activeElement).toBe(focused);
  }
  expect(window.anycode.mcpConfig.get).toHaveBeenCalledTimes(calls);
});


const lspStatus = (state: "ready" | "crashed" | "not_started" | "initializing" | "disposed", name = "typescript") => ({
  name, state, extensions: [".ts"], stderrTail: "PRIVATE_STDERR", pid: 123,
});
const detailButton = (text: string) => [...details()!.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => button.textContent === text);

it("shows live LSP states and leaves status requests to the existing drawer", async () => {
  const servers = [lspStatus("ready"), lspStatus("crashed", "python")];
  store.setState({ connection: "ready", lspServers: servers });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  useTabsStore.setState({ tabs: [{ tabId: "a" } as never, { tabId: "b" } as never], activeTabId: "a" });
  await render("b", createElement(Fragment, null, createElement(SessionHeader, props), createElement(LspPanel)));
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(details()!.textContent).toContain("typescript ready");
  expect(details()!.textContent).toContain("python crashed");
  expect(details()!.textContent).toContain("A language server crashed");
  expect(details()!.querySelectorAll("li")).toHaveLength(2);
  expect(categoryButtons()[3]!.textContent).toContain("2");
  expect(detailButton("Restart")).toBeDefined();
  expect(details()!.querySelector('[role="switch"]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_STDERR");
  await click(detailButton("Details")!);
  expect(dialog()).toBeNull();
  expect(useTabsStore.getState().tabs.find((tab) => tab.tabId === "b")!.lspPanelOpen).toBe(true);
  expect(useTabsStore.getState().tabs.find((tab) => tab.tabId === "a")!.lspPanelOpen).toBeFalsy();
  expect(document.querySelectorAll('aside[aria-label="LSP status"]')).toHaveLength(1);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close LSP status");
  expect(send).toHaveBeenCalledExactlyOnceWith("b", { type: "lsp_status_request" });
  expect(isOverlayOpen()).toBe(true);
});

it("does not request live LSP status on open, focus, retry or reopen", async () => {
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  vi.mocked(window.anycode.lspConfig.status).mockRejectedValueOnce(new Error("PRIVATE_CONFIG_ERROR"));
  await render();
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(details()!.textContent).toContain("Could not load configured entries");
  expect(details()!.textContent).toContain("Not configured");
  await click(detailButton("Retry")!);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(details()!.querySelectorAll("li")).toHaveLength(2);
  expect(detailButton("Details")).toBeUndefined();
  await key(details()!, "Escape");
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(window.anycode.lspConfig.status).toHaveBeenCalledTimes(4);
  expect(send).not.toHaveBeenCalled();
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_CONFIG_ERROR");
});

it.each(["host_exited", "awaiting_port", "awaiting_host_ready"] as const)("disables live LSP actions when connection is %s", async (connection) => {
  store.setState({ connection, lspServers: [lspStatus("ready")] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render();
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(details()!.textContent).toContain("Host unavailable. Last reported status");
  expect(details()!.querySelectorAll("li")).toHaveLength(2);
  expect(detailButton("Details")!.disabled).toBe(true);
  await click(detailButton("Details")!);
  expect(dialog()).not.toBeNull();
  expect(useTabsStore.getState().tabs[0]!.lspPanelOpen).toBeFalsy();
  expect(send).not.toHaveBeenCalled();
});

it.each(["codex", "claude"])("keeps configured LSP and catalog counts with honest capability text for %s", async (id) => {
  store.setState({ connection: "ready", engine: { id, capabilities: { supportsTasks: false } } as never,
    lspServers: [lspStatus("crashed")] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render();
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(categoryButtons()[3]!.textContent).toContain("2");
  expect(details()!.textContent).toContain("AnyCode LSP is unavailable in this engine");
  expect(details()!.textContent).toContain("For new Core sessions");
  expect(details()!.querySelectorAll("li")).toHaveLength(2);
  expect(detailButton("Details")).toBeUndefined();
  expect(details()!.textContent).not.toContain("crashed");
  expect(trigger().querySelector(".session-extensions-warning")).toBeNull();
  for (const index of [1, 2]) {
    await click(categoryButtons()[index]!);
    expect(details()!.textContent).toContain("AnyCode catalog. Availability in the current engine is not confirmed");
  }
  expect(send).not.toHaveBeenCalled();
});

it("updates the shared LSP summary without equating an idle server to a crash", async () => {
  store.setState({ connection: "ready", lspServers: [lspStatus("not_started")] });
  await render();
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(details()!.textContent).toContain("typescript not started");
  expect(details()!.textContent).not.toContain("crashed");
  const focused = document.activeElement;
  await act(async () => store.setState({ lspServers: [lspStatus("ready")] }));
  expect(details()!.textContent).toContain("typescript ready");
  expect(document.activeElement).toBe(focused);
  await act(async () => store.setState({ lspServers: [lspStatus("crashed")] }));
  expect(details()!.textContent).toContain("A language server crashed");
});

it("shows plugin tier, saved status and consent hints without exposing diagnostics or service definitions", async () => {
  vi.mocked(window.anycode.plugins.list).mockResolvedValue({ plugins: [
    { name: "local-plugin", tier: "local", status: "disabled", disabled: true,
      problems: ["PRIVATE_PROBLEM"], mcpServerNames: ["mcp"], mcpConsentGranted: false,
      serviceNames: ["service"], servicesConsentGranted: false,
      services: [{ command: "PRIVATE_COMMAND", envKeys: ["PRIVATE_ENV"] }], source: { path: "PRIVATE_PATH" } },
    { name: "official-plugin", tier: "official", status: "active", disabled: false,
      problems: [], mcpServerNames: ["mcp"], mcpConsentGranted: true, serviceNames: [] },
  ], available: [] } as never);
  vi.mocked(window.anycode.skills.list).mockResolvedValue({ rows: [
    { name: "plugin-skill", sourceKind: "plugin", enabled: true },
  ], problems: [] } as never);
  await render();
  await click(trigger());
  await click(categoryButtons()[1]!);
  const rows = details()!.querySelectorAll("li");
  expect(rows[0]!.textContent).toContain("local · disabled · Saved: disabled");
  expect(rows[0]!.textContent).toContain("Needs attention in Plugins");
  expect(rows[0]!.textContent).toContain("MCP needs approval in Plugins");
  expect(rows[0]!.textContent).toContain("Services need approval in Plugins");
  expect(rows[1]!.textContent).toContain("official · active · Saved: enabled");
  expect(rows[1]!.textContent).not.toContain("needs approval");
  expect(details()!.textContent).toContain("All projects; background services and account sources may change immediately");
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_");
  expect(switches().every((control) => control.disabled)).toBe(true);
  await click(categoryButtons()[2]!);
  expect(details()!.textContent).toContain("Plugin · Saved: enabled · Read-only; manage in Plugins");
});

it("sanitizes names in the shared LSP summary without exposing runtime metadata", async () => {
  store.setState({ connection: "ready", lspServers: [lspStatus("ready", "<img src=x>\u202e\n" + "界".repeat(90))] });
  await render();
  await click(trigger());
  await click(categoryButtons()[3]!);
  const summary = details()!.querySelector('[aria-label="Language server summary"]')!;
  expect(summary.textContent).toContain("<img src=x>");
  expect(summary.textContent).toContain("… ready");
  expect(summary.querySelector("img")).toBeNull();
  expect(summary.textContent).not.toMatch(/[\u202e\n]/);
  expect(summary.outerHTML).not.toContain("PRIVATE_STDERR");
});


const switches = () => [...details()!.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
const editableMcp = (enabled = true) => ({ entries: [
  { name: "same\u202e", source: "project", enabled, commandLine: "PRIVATE_COMMAND" },
  { name: "same\u202e", source: "user", enabled: true, shadowed: true, envKeys: ["PRIVATE_ENV"] },
  { name: "compat", source: "compat", enabled: true },
], pluginServers: [{ name: "plugin", pluginName: "owner", consentGranted: false }], problems: [], projectAvailable: true });
async function openMcp() { await render(); await click(trigger()); await click(categoryButtons()[0]!); }
function prepareMcp() {
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue(editableMcp() as never);
  const setEnabled = vi.fn<Window["anycode"]["mcpConfig"]["setEnabled"]>();
  window.anycode.mcpConfig.setEnabled = setEnabled;
  return setEnabled;
}

it("patches exact raw project/user identities, confirms checked after save and keeps runtime untouched", async () => {
  const setEnabled = prepareMcp();
  let finish!: (value: never) => void;
  setEnabled.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  store.setState({ connection: "ready", mcpServers: [mcpStatus("failed", "same\u202e")] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await openMcp();
  const control = switches()[0]!;
  await act(async () => control.focus());
  await click(control);
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith({ tabId: "a", scope: "project", name: "same\u202e", enabled: false });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(switches().every((button) => button.disabled)).toBe(true);
  expect(control.closest("li")!.textContent).toContain("Saving…");
  await click(switches()[1]!);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(setEnabled).toHaveBeenCalledTimes(1);
  expect(window.anycode.mcpConfig.get).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, snapshot: editableMcp(false) } as never));
  expect(switches()[0]).toBe(control);
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.closest("li")!.textContent).toContain("Saved for new session starts");
  expect(warning()).not.toBeNull();
  setEnabled.mockResolvedValueOnce({ ok: true, snapshot: editableMcp(false) } as never);
  await click(switches()[1]!);
  expect(setEnabled).toHaveBeenLastCalledWith({ tabId: "a", scope: "user", name: "same\u202e", enabled: false });
  expect(details()!.textContent).toContain("Shadowed by another scope");
  expect(send).not.toHaveBeenCalled();
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_");
});

it("renders compat, plugin and runtime-only rows without a switch", async () => {
  const setEnabled = prepareMcp();
  store.setState({ mcpServers: [mcpStatus("failed", "removed")] });
  await openMcp();
  expect(switches()).toHaveLength(2);
  const rows = [...details()!.querySelectorAll("li")];
  for (const row of rows.filter((row) => /compat|plugin|removed/.test(row.textContent!))) {
    expect(row.querySelector('[role="switch"]')).toBeNull();
  }
  expect(details()!.textContent).toContain("Read-only compatibility source");
  expect(details()!.textContent).toContain("Needs approval in Plugins");
  expect(setEnabled).not.toHaveBeenCalled();
});

it.each(["invalid", "io_error", "read_only_source", "no_workspace"] as const)("shows safe %s refusal and preserves checked without fallback writes", async (reason) => {
  const setEnabled = prepareMcp();
  setEnabled.mockResolvedValue({ ok: false, reason });
  await openMcp();
  await click(switches()[0]!);
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
  expect(switches()[0]!.disabled).toBe(false);
  expect(details()!.querySelector('[aria-live="polite"]')!.textContent).not.toBe("");
  expect(detailButton("Retry")).toBeDefined();
  expect(details()!.textContent).not.toContain("Saved for new session starts");
  expect(setEnabled).toHaveBeenCalledTimes(1);
});

it("refreshes a removed entry on not_found and distinguishes it from a successful save", async () => {
  const setEnabled = prepareMcp();
  setEnabled.mockResolvedValue({ ok: false, reason: "not_found" });
  await openMcp();
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue({ entries: [], problems: [] } as never);
  await click(switches()[0]!);
  expect(window.anycode.mcpConfig.get).toHaveBeenCalledTimes(2);
  expect(details()!.textContent).toContain("This entry no longer exists");
  expect(switches()).toHaveLength(0);
  expect(details()!.textContent).not.toContain("Saved for new session starts");
});

it("handles rejected writes and missing write bridge with safe retry and no optimistic check", async () => {
  const setEnabled = prepareMcp();
  setEnabled.mockRejectedValueOnce(new Error("PRIVATE_WRITE_ERROR"));
  await openMcp();
  await click(switches()[0]!);
  expect(details()!.textContent).toContain("Could not save this change");
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_WRITE_ERROR");
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
  await click(detailButton("Retry")!);
  expect(window.anycode.mcpConfig.get).toHaveBeenCalledTimes(2);
  expect(details()!.textContent).not.toContain("Could not save this change");
  expect(detailButton("Retry")).toBeUndefined();
  await key(details()!, "Escape");
  delete (window.anycode.mcpConfig as Partial<Window["anycode"]["mcpConfig"]>).setEnabled;
  await click(trigger());
  await click(categoryButtons()[0]!);
  expect(switches().every((button) => button.disabled)).toBe(true);
});

it("allows config-only writes without a ready host and ignores a completion after tab change", async () => {
  const setEnabled = prepareMcp();
  let finish!: (value: never) => void;
  setEnabled.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  store.setState({ connection: "host_exited" });
  await openMcp();
  expect(switches()[0]!.disabled).toBe(false);
  await click(switches()[0]!);
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith({ tabId: "a", scope: "project", name: "same\u202e", enabled: false });
  await render("b");
  await click(trigger());
  await click(categoryButtons()[0]!);
  await act(async () => finish({ ok: true, snapshot: { entries: [], problems: [] } } as never));
  expect(switches()).toHaveLength(2);
  expect(details()!.textContent).not.toContain("Saved for new session starts");
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
});


const ownSkills = (enabled = true) => ({ rows: [
  { name: "own\u202e", sourceKind: "project", source: "project", enabled, path: "PRIVATE_PATH" },
  { name: "global", sourceKind: "user", source: "user", enabled: true },
  { name: "contributed", sourceKind: "plugin", source: "plugin:example", enabled: true },
], problems: [] });
const installedPlugins = (disabled = false) => ({ plugins: [
  { name: "example", tier: "project", status: disabled ? "disabled" : "active", disabled,
    mcpServerNames: ["server"], mcpConsentGranted: false, serviceNames: ["service"], servicesConsentGranted: false, problems: [] },
], available: [] });
async function openCatalog(index: number) { await render(); await click(trigger()); await click(categoryButtons()[index]!); }
function prepareCatalogs() {
  vi.mocked(window.anycode.skills.list).mockResolvedValue(ownSkills() as never);
  vi.mocked(window.anycode.plugins.list).mockResolvedValue(installedPlugins() as never);
  const skillWrite = vi.fn<Window["anycode"]["skills"]["setEnabled"]>();
  const pluginWrite = vi.fn<Window["anycode"]["plugins"]["setEnabled"]>();
  window.anycode.skills.setEnabled = skillWrite;
  window.anycode.plugins.setEnabled = pluginWrite;
  return { skillWrite, pluginWrite };
}

it("writes own skills by raw name and tab, serializes writes and leaves contributed skills read-only", async () => {
  const { skillWrite } = prepareCatalogs();
  let finish!: (value: never) => void;
  skillWrite.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await openCatalog(2);
  expect(switches()).toHaveLength(2);
  expect(details()!.textContent).toContain("Read-only; manage in Plugins");
  expect(details()!.textContent).toContain("This session keeps its startup configuration");
  const control = switches()[0]!;
  await act(async () => control.focus());
  await click(control);
  expect(skillWrite).toHaveBeenCalledExactlyOnceWith({ tabId: "a", name: "own\u202e", enabled: false });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(switches().every((button) => button.disabled)).toBe(true);
  await click(switches()[1]!);
  expect(skillWrite).toHaveBeenCalledTimes(1);
  expect(control.closest("li")!.textContent).toContain("Saving…");
  await act(async () => finish({ ok: true, snapshot: ownSkills(false) } as never));
  expect(switches()[0]).toBe(control);
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.closest("li")!.textContent).toContain("Saved for new session starts");
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_PATH");
  expect(send).not.toHaveBeenCalled();
});

it("saves plugins globally, refreshes the origin catalog and related reads without granting consent", async () => {
  const { pluginWrite } = prepareCatalogs();
  const approveMcp = vi.fn();
  const approveServices = vi.fn();
  Object.assign(window.anycode.plugins, { approveMcp, approveServices, install: vi.fn(), update: vi.fn() });
  pluginWrite.mockImplementationOnce(async () => {
    vi.mocked(window.anycode.plugins.list).mockResolvedValue(installedPlugins(true) as never);
    return { ok: true };
  });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render("b");
  await click(trigger());
  await click(categoryButtons()[1]!);
  expect(details()!.textContent).toContain("All projects; background services and account sources may change immediately");
  expect(switches()[0]!.getAttribute("aria-label")).toContain("for all projects");
  await click(switches()[0]!);
  expect(pluginWrite).toHaveBeenCalledExactlyOnceWith("example", false);
  expect(window.anycode.plugins.list).toHaveBeenLastCalledWith({ tabId: "b" });
  expect(window.anycode.plugins.list).toHaveBeenCalledTimes(2);
  expect(window.anycode.mcpConfig.get).toHaveBeenCalledTimes(2);
  expect(window.anycode.skills.list).toHaveBeenCalledTimes(2);
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
  expect(details()!.textContent).toContain("Saved for all projects");
  expect(details()!.textContent).toContain("MCP needs approval");
  expect(details()!.textContent).toContain("Services need approval");
  expect(details()!.textContent).not.toContain("Saved for new session starts");
  expect(approveMcp).not.toHaveBeenCalled();
  expect(approveServices).not.toHaveBeenCalled();
  expect(window.anycode.plugins.update).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it.each([1, 2])("handles refusal/rejection and explicit refresh for catalog %s without optimistic state", async (index) => {
  const { pluginWrite, skillWrite } = prepareCatalogs();
  const writer = index === 1 ? pluginWrite : skillWrite;
  writer.mockResolvedValueOnce({ ok: false, reason: "read_only_source" });
  await openCatalog(index);
  await click(switches()[0]!);
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
  expect(details()!.textContent).toContain("Could not save this change");
  writer.mockRejectedValueOnce(new Error("PRIVATE_REFUSAL"));
  await click(switches()[0]!);
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_REFUSAL");
  expect(detailButton("Retry")).toBeDefined();
  await click(detailButton("Retry")!);
  expect(index === 1 ? window.anycode.plugins.list : window.anycode.skills.list).toHaveBeenCalledTimes(2);
  expect(details()!.textContent).not.toContain("Could not save this change");
  expect(detailButton("Retry")).toBeUndefined();
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
});

it("refreshes missing skills and distinguishes a plugin save from a failed catalog reload", async () => {
  const { pluginWrite, skillWrite } = prepareCatalogs();
  skillWrite.mockResolvedValue({ ok: false, reason: "not_found" });
  await openCatalog(2);
  vi.mocked(window.anycode.skills.list).mockResolvedValue({ rows: [], problems: [] });
  await click(switches()[0]!);
  expect(details()!.textContent).toContain("This entry no longer exists");
  expect(switches()).toHaveLength(0);
  await click(categoryButtons()[1]!);
  pluginWrite.mockImplementationOnce(async () => {
    vi.mocked(window.anycode.plugins.list).mockRejectedValue(new Error("PRIVATE_REFRESH"));
    return { ok: true };
  });
  await click(switches()[0]!);
  expect(details()!.textContent).toContain("Saved, but could not reload the catalog");
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_REFRESH");
});

it.each([1, 2])("discards stale catalog write responses after tab change for category %s", async (index) => {
  const { pluginWrite, skillWrite } = prepareCatalogs();
  let finish!: (value: never) => void;
  (index === 1 ? pluginWrite : skillWrite).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await openCatalog(index);
  await click(switches()[0]!);
  await render("b");
  await click(trigger());
  await click(categoryButtons()[index]!);
  await act(async () => finish(index === 1 ? { ok: true } as never : { ok: true, snapshot: { rows: [], problems: [] } } as never));
  expect(switches().length).toBeGreaterThan(0);
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
  expect(details()!.textContent).not.toContain("Saved for all projects");
  if (index === 1) expect(window.anycode.plugins.list).toHaveBeenCalledWith({ tabId: "a" });
});

it("keeps native catalog guidance beside active switches and never adds an LSP switch", async () => {
  prepareCatalogs();
  store.setState({ connection: "host_exited", engine: { id: "claude", capabilities: { supportsTasks: false } } as never });
  await openCatalog(2);
  expect(details()!.textContent).toContain("Availability in the current engine is not confirmed");
  expect(switches()[0]!.disabled).toBe(false);
  await click(categoryButtons()[1]!);
  expect(details()!.textContent).toContain("background services and account sources may change immediately");
  expect(switches()[0]!.disabled).toBe(false);
  await click(categoryButtons()[3]!);
  expect(switches()).toHaveLength(0);
  expect(details()!.textContent).not.toContain("Saving…");
});

it.each(["heading", "notice", "row", "padding"])("keeps the panel open after pointer blur on non-focusable %s content", async (targetName) => {
  await render();
  await click(trigger());
  await click(categoryButtons()[0]!);
  const panel = dialog()!;
  const target = targetName === "heading" ? panel.querySelector<HTMLElement>(".session-extensions-heading")!
    : targetName === "notice" ? details()!.querySelector<HTMLElement>("p")!
    : targetName === "row" ? details()!.querySelector<HTMLElement>(".session-extensions-name")! : panel;
  const focused = details()!.querySelector<HTMLButtonElement>("button")!;
  await act(async () => focused.focus());
  await key(focused, "Tab");
  // jsdom does not blur on mouse clicks, so model Chromium's pointer/blur sequence explicitly.
  await act(async () => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    focused.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(dialog()).toBe(panel);
  expect(isOverlayOpen()).toBe(true);
});


it("places Extensions beside the environment controls, before the connection status and spacer", async () => {
  await render();
  const spacer = container.querySelector(".session-header-spacer")!;
  expect(trigger().nextElementSibling!.classList.contains("session-header-connection")).toBe(true);
  expect(trigger().compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("closes on a genuine Tab exit with no destination without restoring trigger focus", async () => {
  await render();
  await click(trigger());
  const focused = document.activeElement as HTMLElement;
  await key(focused, "Tab");
  await act(async () => focused.blur());
  expect(dialog()).toBeNull();
  expect(document.activeElement).not.toBe(trigger());
  expect(isOverlayOpen()).toBe(false);
});


it.each([[0, "mcp"], [1, "plugins"], [2, "skills"], [3, "language-servers"]] as const)("hands footer %s to structured Settings with focus after closing the menu", async (index, pane) => {
  const { SettingsDialog } = await import("./SettingsScreen.js");
  const { RUN_ACTION_EVENT } = await import("../slash-menu.js");
  const { createStore } = await import("zustand/vanilla");
  Object.assign(window.anycode, { settings: {} });
  const settingsStore = createStore(() => ({ updateStatus: { kind: "idle" }, subscribeUpdates: () => () => {},
    subscribeProviderHealth: () => () => {}, subscribeProviderQuota: () => () => {} }));
  let request: unknown;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLButtonElement>("button")?.focus();
  } });
  function Host() {
    const [open, setOpen] = useState(false);
    useOverlayFlag(open);
    useEffect(() => {
      const action = (event: Event) => {
        if ((event as CustomEvent).detail === "settings.open") {
          expect(dialog()).toBeNull();
          setOpen(true);
        }
      };
      window.addEventListener(RUN_ACTION_EVENT, action);
      return () => window.removeEventListener(RUN_ACTION_EVENT, action);
    }, []);
    return createElement(Fragment, null, createElement(SessionHeader, props), createElement(SettingsDialog, {
      open, onClose: () => setOpen(false), store: settingsStore as never,
      screenComponent: (screenProps) => { request = screenProps.paneRequest; return createElement("button", null, "Settings destination"); },
    }));
  }
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue({ entries: [], problems: [], projectAvailable: true });
  try {
    await render("b", createElement(Host));
    await click(trigger());
    await click(categoryButtons()[index]!);
    await click(details()!.querySelector<HTMLButtonElement>("footer button")!);
    expect(request).toMatchObject({ pane, tabId: "b", scope: "project" });
    expect(document.activeElement?.textContent).toBe("Settings destination");
    expect(isOverlayOpen()).toBe(true);
  } finally {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  }
});

it("routes user rows and plugin contributions to their own management scope", async () => {
  prepareMcp();
  const { SETTINGS_SELECT_PANE_EVENT } = await import("../slash-menu.js");
  const listener = vi.fn();
  window.addEventListener(SETTINGS_SELECT_PANE_EVENT, listener);
  try {
    await openMcp();
    await click(details()!.querySelectorAll<HTMLButtonElement>("li button:not([role=switch])")[1]!);
    expect(listener.mock.calls[0]![0].detail).toEqual({ pane: "mcp", tabId: "a", scope: "user" });
    await click(trigger());
    await click(categoryButtons()[0]!);
    await click(details()!.querySelectorAll<HTMLButtonElement>("li button:not([role=switch])")[3]!);
    expect(listener.mock.calls[1]![0].detail).toEqual({ pane: "plugins", tabId: "a", scope: "project" });
  } finally { window.removeEventListener(SETTINGS_SELECT_PANE_EVENT, listener); }
});

const footerButton = (text: string) => [...details()!.querySelectorAll<HTMLButtonElement>("footer button")].find((button) => button.textContent === text)!;
it.each(["project", "user", "compat"] as const)("opens only the chosen %s source; retries and reveals explicitly after safe failure", async (source) => {
  prepareMcp();
  const openFile = vi.fn().mockResolvedValueOnce({ ok: false, reason: "open_failed" }).mockResolvedValue({ ok: true });
  window.anycode.mcpConfig.openFile = openFile;
  await openMcp();
  await click(footerButton("Configuration file"));
  expect(openFile).not.toHaveBeenCalled();
  await click(footerButton({ project: "Project", user: "User", compat: "Compatibility file (.mcp.json)" }[source]));
  expect(openFile).toHaveBeenCalledExactlyOnceWith({ tabId: "a", source, action: "open" });
  expect(details()!.textContent).toContain("Could not open configuration file");
  await click(footerButton("Show in folder"));
  expect(openFile).toHaveBeenLastCalledWith({ tabId: "a", source, action: "reveal" });
  expect(details()!.textContent).toContain("Shown in folder");
});

it.each(["invalid", "no_workspace", "not_found", "unsafe_path", "rejection"])("handles %s safely and retries the same source without creating files", async (reason) => {
  prepareMcp();
  const openFile = vi.fn().mockImplementationOnce(() => reason === "rejection" ? Promise.reject(new Error("PRIVATE_OS_ERROR")) : Promise.resolve({ ok: false, reason }))
    .mockResolvedValue({ ok: true });
  window.anycode.mcpConfig.openFile = openFile;
  await openMcp();
  await click(footerButton("Configuration file"));
  await click(footerButton("User"));
  expect(dialog()!.outerHTML).not.toContain("PRIVATE_OS_ERROR");
  expect(footerButton("Manage")).toBeDefined();
  await click(footerButton("Retry"));
  expect(openFile).toHaveBeenLastCalledWith({ tabId: "a", source: "user", action: "open" });
  expect(details()!.textContent).toContain("Opened in your default application");
});

it("disables project sources for user-only config and discards timed out or unmounted responses", async () => {
  vi.mocked(window.anycode.mcpConfig.get).mockResolvedValue({ entries: [], problems: [], projectAvailable: false });
  let finish!: (value: unknown) => void;
  const openFile = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  window.anycode.mcpConfig.openFile = openFile as never;
  await openMcp();
  await click(footerButton("Configuration file"));
  expect(footerButton("Project").disabled).toBe(true);
  expect(footerButton("Compatibility file (.mcp.json)").disabled).toBe(true);
  vi.useFakeTimers();
  await click(footerButton("User"));
  expect(footerButton("User").disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(footerButton("Retry")).toBeDefined();
  await render("b");
  await click(trigger());
  await click(categoryButtons()[0]!);
  await act(async () => finish({ ok: false, reason: "unsafe_path" }));
  expect(details()!.querySelector('[aria-label="Configuration source"]')).toBeNull();
});


it.each(["codex", "claude"])("locks pending native configuration writes and refuses duplicate activation for %s", async (id) => {
  const setEnabled = prepareMcp();
  let finish!: (value: never) => void;
  setEnabled.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  store.setState({ connection: "ready", engine: { id, capabilities: { supportsTasks: false } } as never });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await openMcp();
  const control = switches()[0]!;
  await click(control);
  expect(control.getAttribute("aria-busy")).toBe("true");
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(details()!.textContent).toContain("Saving configuration…");
  expect(switches().every((button) => button.disabled)).toBe(true);
  await click(control);
  await key(control, "Enter");
  await key(control, " ");
  expect(setEnabled).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: false, reason: "io_error" } as never));
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(control.getAttribute("aria-busy")).toBe("false");
  expect(details()!.textContent).toContain("Could not write the configuration");
  expect(details()!.textContent).not.toContain("Saved for new session starts");
  await click(categoryButtons()[3]!);
  expect(details()!.textContent).toContain("LSP is unavailable in this engine");
  expect(details()!.querySelector('[role="switch"]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ["ready", "ready", "success"], ["initializing", "initializing", "warning"],
  ["not_started", "not started", "neutral"], ["crashed", "crashed", "danger"],
  ["disposed", "disposed", "neutral"],
] as const)("shows the %s LSP state and only offers Restart for a crash", async (state, label, tone) => {
  store.setState({ connection: "ready", lspServers: [lspStatus(state)] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render("b");
  expect(!!trigger().querySelector(".session-extensions-warning")).toBe(state === "crashed");
  if (state === "crashed") expect(trigger().textContent).toContain("A language server crashed");
  await click(trigger());
  await click(categoryButtons()[3]!);
  const summary = details()!.querySelector('[aria-label="Language server summary"]')!;
  expect(summary.textContent).toContain(`typescript ${label}`);
  expect(summary.querySelector(`.session-extensions-dot.tone-${tone}`)).not.toBeNull();
  expect(!!detailButton("Restart")).toBe(state === "crashed");
  expect(send).not.toHaveBeenCalled();
  if (state === "crashed") {
    await click(detailButton("Restart")!);
    expect(send).toHaveBeenCalledExactlyOnceWith("b", { type: "lsp_restart_request" });
    expect(dialog()).not.toBeNull();
    await act(async () => store.setState({ lspServers: [lspStatus("ready")] }));
    expect(trigger().querySelector(".session-extensions-warning")).toBeNull();
    expect(detailButton("Restart")).toBeUndefined();
  }
});

it("keeps last reported crashes visible but disables Restart without a host", async () => {
  store.setState({ connection: "host_exited", lspServers: [lspStatus("crashed")] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render();
  expect(trigger().textContent).toContain("Last reported status");
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(detailButton("Restart")!.disabled).toBe(true);
  await click(detailButton("Restart")!);
  expect(send).not.toHaveBeenCalled();
});

it("keeps Hooks in Environment and removes its duplicate LSP row and actions", async () => {
  store.setState({ connection: "ready", lspServers: [lspStatus("crashed")] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render("a", createElement(EnvironmentMenu, { placement: "header" }));
  await click(container.querySelector<HTMLButtonElement>('[aria-label="Open environment menu"]')!);
  expect(container.querySelector('[aria-label="Language servers"]')).toBeNull();
  expect(container.querySelector('[data-environment-action^="lsp-"]')).toBeNull();
  expect(container.querySelector('[aria-label="Hooks"]')).not.toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("offers Extensions and LSP setup in the new-session composer without host requests", async () => {
  window.anycode.listSessions = vi.fn(async () => []);
  const { Composer } = await import("./Composer.js");
  store.setState({ transcript: [], connection: "ready" });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  await render("a", createElement(Composer));
  expect(trigger()).not.toBeNull();
  await click(trigger());
  await click(categoryButtons()[3]!);
  expect(detailButton("Manage language servers")).toBeDefined();
  expect(send).not.toHaveBeenCalled();
});

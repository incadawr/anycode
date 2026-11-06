// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopState } from "../store.js";
import type { DesktopStoreApi } from "../tab-registry.js";
import type { McpConfigSnapshot } from "../../../shared/mcp-config.js";
import type { PluginsSnapshot } from "../../../shared/plugins-config.js";
import type { SkillsSnapshot } from "../../../shared/skills-config.js";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";
import { useSessionExtensions, type SessionExtensionsBridge } from "./useSessionExtensions.js";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), invoke: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mcp: McpConfigSnapshot = { entries: [], problems: [], projectAvailable: true };
const plugins: PluginsSnapshot = {
  plugins: [], available: [], index: { status: "not configured" },
  settings: { autoUpdateOfficial: false, indexConfigured: false },
};
const skills: SkillsSnapshot = { rows: [], problems: [] };
const lsp: LspConfigStatus = {
  entries: { project: [], user: [] }, catalog: [], issues: [], projectScopeAvailable: true, projectTrusted: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeStore() {
  return createStore<DesktopState>(() => ({
    workspace: "/project-a", engine: null, connection: "ready", mcpServers: [],
  }) as unknown as DesktopState) as DesktopStoreApi;
}
let root: Root;
let container: HTMLDivElement;
let store: DesktopStoreApi;
let current: ReturnType<typeof useSessionExtensions>;
let bridge: SessionExtensionsBridge;
let changed: (() => void) | undefined;
let unsubscribe: ReturnType<typeof vi.fn<() => void>>;
function Harness(props: { tabId: string; bridge: SessionExtensionsBridge }) {
  current = useSessionExtensions({ ...props, store });
  return null;
}
async function render(tabId = "a", injected = bridge) {
  await act(async () => root.render(createElement(Harness, { tabId, bridge: injected })));
}
async function open() { await act(async () => current.setOpen(true)); }
async function focus() { await act(async () => window.dispatchEvent(new Event("focus"))); }
beforeEach(() => {
  vi.useFakeTimers();
  store = makeStore();
  unsubscribe = vi.fn(() => { changed = undefined; });
  bridge = {
    mcpConfig: { get: vi.fn().mockResolvedValue(mcp) },
    plugins: {
      list: vi.fn().mockResolvedValue(plugins),
      onChanged: vi.fn((callback) => { changed = () => callback("enable"); return unsubscribe; }),
    },
    skills: { list: vi.fn().mockResolvedValue(skills) },
    lspConfig: { status: vi.fn().mockResolvedValue(lsp) },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads all four scoped catalogs only after opening and observes closed-menu runtime", async () => {
  await render();
  expect(bridge.mcpConfig!.get).not.toHaveBeenCalled();
  await focus();
  expect(bridge.plugins!.list).not.toHaveBeenCalled();
  const servers = [{ name: "diagnostic", state: "failed", transport: "stdio", toolCount: 0, toolsTruncated: false }] as DesktopState["mcpServers"];
  await act(async () => store.setState({ mcpServers: servers }));
  expect(current.mcpServers).toBe(servers);
  await open();
  for (const call of [bridge.mcpConfig!.get, bridge.plugins!.list, bridge.skills!.list, bridge.lspConfig!.status]) {
    expect(call).toHaveBeenCalledExactlyOnceWith({ tabId: "a" });
  }
  expect(Object.values(current.reads).map((read) => read.status)).toEqual(Array(4).fill("ready"));
});

it("settles rejections, synchronous throws and absent bridge independently, then retries one category", async () => {
  vi.mocked(bridge.mcpConfig!.get).mockRejectedValueOnce(new Error("private error"));
  vi.mocked(bridge.skills!.list).mockImplementationOnce(() => { throw new Error("private path"); });
  delete bridge.lspConfig;
  await render();
  await open();
  expect(current.reads.mcp.status).toBe("unavailable");
  expect(current.reads.skills.status).toBe("unavailable");
  expect(current.reads.lsp.status).toBe("unavailable");
  expect(current.reads.plugins).toMatchObject({ status: "ready", snapshot: plugins });
  expect(JSON.stringify(current.reads)).not.toContain("private");
  const generation = current.reads.mcp.generation;
  await act(async () => current.retry("mcp"));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
  expect(current.reads.mcp.generation).toBeGreaterThan(generation);
  expect(bridge.plugins!.list).toHaveBeenCalledTimes(1);
});

it("times out independently and ignores a late response even after Retry", async () => {
  const first = deferred<McpConfigSnapshot>();
  const second = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();
  await open();
  expect(current.reads.mcp.status).toBe("loading");
  expect(current.reads.skills.status).toBe("ready");
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(current.reads.mcp.status).toBe("unavailable");
  await act(async () => current.retry("mcp"));
  await act(async () => first.resolve({ ...mcp, projectAvailable: false }));
  expect(current.reads.mcp.status).toBe("loading");
  await act(async () => second.resolve(mcp));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
  expect(vi.getTimerCount()).toBe(0);
});

it("discards delayed A responses after switching to B and closes the menu", async () => {
  const late = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(late.promise);
  await render();
  await open();
  await render("b");
  expect(current.open).toBe(false);
  expect(bridge.plugins!.list).toHaveBeenLastCalledWith({ tabId: "b" });
  await act(async () => late.resolve({ ...mcp, projectAvailable: false }));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
  await render("a");
  expect(current.open).toBe(false);
});

it.each(["workspace", "engine", "connection"] as const)("invalidates on %s changes without accepting old reads", async (field) => {
  const late = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(late.promise);
  await render();
  await open();
  await act(async () => store.setState(field === "workspace" ? { workspace: "/project-b" }
    : field === "connection" ? { connection: "host_exited" }
    : { engine: { id: "codex" } as DesktopState["engine"] }));
  expect(current.open).toBe(false);
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(2);
  await act(async () => late.resolve({ ...mcp, projectAvailable: false }));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
});

it("refreshes on reopen/focus, limits plugin invalidation to related catalogs and avoids closed polling", async () => {
  await render();
  await open();
  await focus();
  expect(bridge.lspConfig!.status).toHaveBeenCalledTimes(2);
  await act(async () => changed!());
  expect(bridge.plugins!.list).toHaveBeenCalledTimes(3);
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(3);
  expect(bridge.skills!.list).toHaveBeenCalledTimes(3);
  expect(bridge.lspConfig!.status).toHaveBeenCalledTimes(2);
  await act(async () => current.setOpen(false));
  await act(async () => changed!());
  expect(current.reads.plugins.status).toBe("loading");
  expect(current.reads.lsp.status).toBe("ready");
  await focus();
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(bridge.plugins!.list).toHaveBeenCalledTimes(3);
  await open();
  expect(bridge.plugins!.list).toHaveBeenCalledTimes(4);
  expect(bridge.lspConfig!.status).toHaveBeenCalledTimes(3);
});

it("cancels superseded requests on rapid Retry and reopen", async () => {
  const late = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(late.promise);
  await render();
  await open();
  await act(async () => { current.retry(); current.retry(); });
  // Only the latest queued generation reaches the bridge.
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(2);
  await act(async () => current.setOpen(false));
  await open();
  await act(async () => late.reject(new Error("late refusal")));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans pending timers and listeners on unmount, ignoring later completion", async () => {
  const late = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(late.promise);
  const remove = vi.spyOn(window, "removeEventListener");
  await render();
  await open();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  // Keep afterEach's unmount valid without mounting another controller.
  root = createRoot(container);
  expect(vi.getTimerCount()).toBe(0);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(changed).toBeUndefined();
  expect(remove).toHaveBeenCalledWith("focus", expect.any(Function));
  const previous = current;
  await act(async () => late.resolve(mcp));
  await focus();
  expect(current).toBe(previous);
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(1);
});


it("keeps unknown catalogs unavailable when the read bridge is absent", async () => {
  await render("a", {});
  await open();
  expect(Object.values(current.reads).every((read) => read.status === "unavailable")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not revive a timed-out generation until an explicit refresh", async () => {
  const late = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(late.promise);
  await render();
  await open();
  await act(async () => vi.advanceTimersByTime(4_999));
  expect(current.reads.mcp.status).toBe("loading");
  await act(async () => vi.advanceTimersByTime(1));
  const timedOutGeneration = current.reads.mcp.generation;
  await act(async () => late.resolve(mcp));
  expect(current.reads.mcp).toEqual({ status: "unavailable", generation: timedOutGeneration });
  await focus();
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: mcp });
});

it("projects live failures while closed without requiring a config read or filtering error text", async () => {
  await render();
  const failed = { name: "removed", state: "failed" as const, transport: "stdio" as const,
    toolCount: 0, toolsTruncated: false, error: "disabled appeared in a real transport failure" };
  await act(async () => store.setState({ mcpServers: [failed] }));
  expect(current.open).toBe(false);
  expect(current.mcpFailed).toBe(true);
  expect(current.mcpRows[0]).toMatchObject({ diagnostic: true, tone: "danger", status: "Connection failed" });
  expect(bridge.mcpConfig!.get).not.toHaveBeenCalled();
  await act(async () => store.setState({ connection: "host_exited" }));
  expect(current.mcpFailed).toBe(true);
  expect(current.mcpRows[0]!.status).toContain("Host unavailable");
  await act(async () => store.setState({ mcpServers: [] }));
  expect(current.mcpFailed).toBe(false);
  expect(current.mcpRows).toEqual([]);
});


it("serializes same-tick MCP writes across close/reopen", async () => {
  const snapshot: McpConfigSnapshot = { ...mcp, entries: [
    { name: "server", source: "project", enabled: true, transport: "stdio", commandLine: "", envKeys: [] },
  ] };
  vi.mocked(bridge.mcpConfig!.get).mockResolvedValue(snapshot);
  const write = deferred<import("../../../shared/mcp-config.js").McpConfigMutationResult>();
  bridge.mcpConfig!.setEnabled = vi.fn().mockReturnValue(write.promise);
  await render();
  await open();
  const oldRead = deferred<McpConfigSnapshot>();
  vi.mocked(bridge.mcpConfig!.get).mockReturnValueOnce(oldRead.promise);
  await focus();
  // A loading refresh has no writable row, so first restore the current catalog.
  await act(async () => oldRead.resolve(snapshot));
  const key = JSON.stringify(["project", "server"]);
  await act(async () => { current.setMcpEnabled(key); current.setMcpEnabled(key); });
  expect(bridge.mcpConfig!.setEnabled).toHaveBeenCalledTimes(1);
  expect(current.mcpBusy).toBe(true);
  await act(async () => current.setOpen(false));
  await open();
  expect(current.mcpBusy).toBe(true);
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(2);
  const changedSnapshot = { ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, enabled: false })) };
  await act(async () => write.resolve({ ok: true, snapshot: changedSnapshot }));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: changedSnapshot });
  expect(current.mcpBusy).toBe(false);
  expect(current.mcpWrite.savedKeys).toEqual([key]);
});

it("discards in-flight write results after workspace/engine changes and unmount", async () => {
  const snapshot: McpConfigSnapshot = { ...mcp, entries: [
    { name: "server", source: "user", enabled: true, transport: "stdio", commandLine: "", envKeys: [] },
  ] };
  vi.mocked(bridge.mcpConfig!.get).mockResolvedValue(snapshot);
  const write = deferred<import("../../../shared/mcp-config.js").McpConfigMutationResult>();
  bridge.mcpConfig!.setEnabled = vi.fn().mockReturnValue(write.promise);
  await render();
  await open();
  await act(async () => current.setMcpEnabled(JSON.stringify(["user", "server"])));
  await act(async () => store.setState({ workspace: "/project-b", engine: { id: "codex" } as never }));
  expect(current.mcpWrite.pendingKey).toBe("");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => write.resolve({ ok: false, reason: "io_error" }));
  expect(current.mcpWrite.error).toBe("");
});


it("refetches the current catalog after a write completes across disconnect without applying its stale snapshot", async () => {
  const snapshot: McpConfigSnapshot = { ...mcp, entries: [
    { name: "server", source: "project", enabled: true, transport: "stdio", commandLine: "", envKeys: [] },
  ] };
  vi.mocked(bridge.mcpConfig!.get).mockResolvedValue(snapshot);
  const write = deferred<import("../../../shared/mcp-config.js").McpConfigMutationResult>();
  bridge.mcpConfig!.setEnabled = vi.fn().mockReturnValue(write.promise);
  await render();
  await open();
  await act(async () => current.setMcpEnabled(JSON.stringify(["project", "server"])));
  await act(async () => store.setState({ connection: "host_exited" }));
  expect(current.reads.mcp.status).toBe("loading");
  expect(current.mcpBusy).toBe(true);
  await act(async () => write.resolve({ ok: true, snapshot: { ...mcp, entries: [] } }));
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot });
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(2);
  expect(current.mcpWrite.savedKeys).toEqual([]);
  expect(current.mcpBusy).toBe(false);
});

it("keeps a scope locked through an away-and-back tab switch until the original write settles", async () => {
  const snapshot: McpConfigSnapshot = { ...mcp, entries: [
    { name: "server", source: "user", enabled: true, transport: "stdio", commandLine: "", envKeys: [] },
  ] };
  vi.mocked(bridge.mcpConfig!.get).mockResolvedValue(snapshot);
  const write = deferred<import("../../../shared/mcp-config.js").McpConfigMutationResult>();
  bridge.mcpConfig!.setEnabled = vi.fn().mockReturnValue(write.promise);
  await render();
  await open();
  const key = JSON.stringify(["user", "server"]);
  await act(async () => current.setMcpEnabled(key));
  await render("b");
  expect(current.mcpBusy).toBe(false);
  await render("a");
  expect(current.mcpBusy).toBe(true);
  await act(async () => current.setMcpEnabled(key));
  expect(bridge.mcpConfig!.setEnabled).toHaveBeenCalledTimes(1);
  await act(async () => write.resolve({ ok: false, reason: "no_workspace" }));
  expect(current.mcpWrite.error).toBe("");
  expect(current.mcpBusy).toBe(false);
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot });
});

it("invalidates a same-tick refresh before applying a confirmed write snapshot", async () => {
  const snapshot: McpConfigSnapshot = { ...mcp, entries: [
    { name: "server", source: "project", enabled: true, transport: "stdio", commandLine: "", envKeys: [] },
  ] };
  vi.mocked(bridge.mcpConfig!.get).mockResolvedValue(snapshot);
  bridge.mcpConfig!.setEnabled = vi.fn().mockResolvedValue({ ok: true, snapshot: { ...mcp, entries: [] } });
  await render();
  await open();
  await act(async () => { current.retry("mcp"); current.setMcpEnabled(JSON.stringify(["project", "server"])); });
  expect(bridge.mcpConfig!.get).toHaveBeenCalledTimes(1);
  expect(current.reads.mcp).toMatchObject({ status: "ready", snapshot: { ...mcp, entries: [] } });
  expect(vi.getTimerCount()).toBe(0);
});


it("serializes each catalog independently and defers plugin invalidation until a pending skill write finishes", async () => {
  const skillSnapshot = { rows: [{ name: "own", sourceKind: "user" as const, source: "user", enabled: true, description: "", path: "" }], problems: [] };
  vi.mocked(bridge.skills!.list).mockResolvedValue(skillSnapshot);
  const pluginSnapshot = { ...plugins, plugins: [{ name: "example", disabled: false } as never] };
  vi.mocked(bridge.plugins!.list).mockResolvedValue(pluginSnapshot);
  const skillWrite = deferred<import("../../../shared/skills-config.js").SkillsMutationResult>();
  const pluginWrite = deferred<import("../../../shared/plugins-config.js").PluginsMutationResult>();
  bridge.skills!.setEnabled = vi.fn().mockReturnValue(skillWrite.promise);
  bridge.plugins!.setEnabled = vi.fn().mockReturnValue(pluginWrite.promise);
  await render();
  await open();
  await act(async () => {
    current.catalogControls.skills.setEnabled(JSON.stringify(["user", "own"]));
    current.catalogControls.skills.setEnabled(JSON.stringify(["user", "own"]));
    current.catalogControls.plugins.setEnabled("example");
    current.catalogControls.plugins.setEnabled("example");
  });
  expect(bridge.skills!.setEnabled).toHaveBeenCalledTimes(1);
  expect(bridge.plugins!.setEnabled).toHaveBeenCalledExactlyOnceWith("example", false);
  expect(current.catalogControls.skills.busy).toBe(true);
  expect(current.catalogControls.plugins.busy).toBe(true);
  await act(async () => changed!());
  await act(async () => pluginWrite.resolve({ ok: true }));
  expect(current.catalogControls.plugins.busy).toBe(false);
  expect(bridge.plugins!.list).toHaveBeenCalledTimes(2);
  expect(bridge.skills!.list).toHaveBeenCalledTimes(1);
  await act(async () => skillWrite.resolve({ ok: true, snapshot: { rows: [], problems: [] } }));
  expect(bridge.skills!.list).toHaveBeenCalledTimes(2);
  expect(current.reads.skills).toMatchObject({ status: "ready", snapshot: skillSnapshot });
});

it("bounds a post-save plugin catalog reload and releases the lock after timeout", async () => {
  vi.mocked(bridge.plugins!.list).mockResolvedValue({ ...plugins, plugins: [{ name: "example", disabled: true } as never] });
  bridge.plugins!.setEnabled = vi.fn().mockResolvedValue({ ok: true });
  await render();
  await open();
  vi.mocked(bridge.plugins!.list).mockReturnValue(new Promise(() => {}));
  await act(async () => current.catalogControls.plugins.setEnabled("example"));
  expect(current.catalogControls.plugins.busy).toBe(true);
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(current.catalogControls.plugins.busy).toBe(false);
  expect(current.catalogControls.plugins.write.error).toContain("Saved, but could not reload");
  expect(vi.getTimerCount()).toBe(0);
});


it("cancels a post-save refresh timer on unmount and ignores its later completion", async () => {
  vi.mocked(bridge.plugins!.list).mockResolvedValue({ ...plugins, plugins: [{ name: "example", disabled: false } as never] });
  bridge.plugins!.setEnabled = vi.fn().mockResolvedValue({ ok: true });
  await render();
  await open();
  const late = deferred<PluginsSnapshot>();
  vi.mocked(bridge.plugins!.list).mockReturnValue(late.promise);
  await act(async () => current.catalogControls.plugins.setEnabled("example"));
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  root = createRoot(container);
  expect(vi.getTimerCount()).toBe(0);
  const previous = current;
  await act(async () => late.resolve(plugins));
  expect(current).toBe(previous);
});


it("uses the actual preload plugin subscription and mutation contract", async () => {
  const { contextBridge, ipcRenderer } = await import("electron");
  const { PLUGINS_CHANGED_CHANNEL, PLUGINS_SET_ENABLED_CHANNEL, PLUGINS_LIST_CHANNEL } = await import("../../../shared/plugins-config.js");
  const argv = process.argv;
  try {
    process.argv = [...argv, `--anycode-renderer-url=${window.location.href}`];
    await import("../../../preload/index.js");
  } finally { process.argv = argv; }
  const exposed = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.find(([key]) => key === "anycode")![1] as Window["anycode"];
  expect(exposed.plugins.onChanged).toBeTypeOf("function");
  expect(exposed.plugins).not.toHaveProperty("onPluginsChanged");
  vi.mocked(ipcRenderer.invoke).mockImplementation(async channel => channel === PLUGINS_LIST_CHANNEL
    ? { ...plugins, plugins: [{ name: "example", disabled: false }] } : { ok: true });
  bridge.plugins = exposed.plugins;
  await render();
  await open();
  const listener = vi.mocked(ipcRenderer.on).mock.calls.find(([channel]) => channel === PLUGINS_CHANGED_CHANNEL)![1];
  await act(async () => listener({} as never, { reason: "enable" }));
  expect(current.reads.plugins.status).toBe("ready");
  await act(async () => current.catalogControls.plugins.setEnabled("example"));
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(PLUGINS_SET_ENABLED_CHANNEL, { name: "example", value: false });
  await act(async () => root.unmount());
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(PLUGINS_CHANGED_CHANNEL, listener);
  root = createRoot(container);
});

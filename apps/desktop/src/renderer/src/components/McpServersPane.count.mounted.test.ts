// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpConfigSnapshot } from "../../../shared/mcp-config.js";
import { McpServersPane, type McpConfigBridge } from "./McpServersPane.js";
import { countConfiguredMcp, extensionCountText } from "./extensions-model.js";

vi.mock("./SettingsScreen.js", () => ({
  describeMcpServer: () => ({ kind: "neutral", detail: "Last reported status" }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mixed: McpConfigSnapshot = {
  entries: [
    { name: "winner", source: "project", enabled: false, transport: "stdio", commandLine: "node", envKeys: [] },
    { name: "winner", source: "user", enabled: true, shadowed: true, transport: "stdio", commandLine: "node", envKeys: [] },
    { name: "compat", source: "compat", enabled: true, transport: "stdio", commandLine: "node", envKeys: [] },
  ],
  pluginServers: [
    { name: "plugin_waiting", pluginName: "waiting", consentGranted: false, shadowed: false, transport: "stdio", commandLine: "node", pluginRoot: "" },
    { name: "plugin_shadowed", pluginName: "shadowed", consentGranted: true, shadowed: true, transport: "stdio", commandLine: "node", pluginRoot: "" },
  ],
  problems: [], projectAvailable: true,
};
const userOnly: McpConfigSnapshot = {
  entries: [{ ...mixed.entries[1]!, shadowed: false }],
  pluginServers: [], problems: [], projectAvailable: false,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("anycode", { mcpSecrets: { list: vi.fn().mockResolvedValue({ ok: true, names: [] }) } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function bridgeFor(get: McpConfigBridge["get"]): McpConfigBridge {
  return { get, upsert: vi.fn(), delete: vi.fn(), setEnabled: vi.fn(), promoteCompat: vi.fn(), importScan: vi.fn(), importApply: vi.fn() };
}

it("reports the same total as Extensions for each scope, independently of search and runtime", async () => {
  const get = vi.fn<McpConfigBridge["get"]>(async (request) => request?.tabId ? mixed : userOnly);
  const bridge = bridgeFor(get);
  const onCountChange = vi.fn();
  const servers = [{ name: "runtime-only", transport: "stdio" as const, state: "failed" as const, toolCount: 0, toolsTruncated: false }];
  await act(async () => root.render(createElement(McpServersPane, { tabId: "tab-b", servers, bridge, onCountChange })));
  expect(get).toHaveBeenCalledWith({ tabId: "tab-b" });
  expect(onCountChange).toHaveBeenLastCalledWith(2);
  expect(String(onCountChange.mock.lastCall?.[0])).toBe(extensionCountText({ status: "ready", snapshot: mixed }, countConfiguredMcp));
  expect(container.textContent).toContain("From .mcp.json");
  expect(container.textContent).toContain("From plugins");
  expect(container.textContent).toContain("runtime-only");
  const search = container.querySelector<HTMLInputElement>('input[placeholder="Search MCP servers…"]')!;
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "no-match");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("No servers match your search.");
  expect(onCountChange).toHaveBeenLastCalledWith(countConfiguredMcp(mixed));

  await act(async () => root.render(createElement(McpServersPane, { servers, bridge, onCountChange })));
  expect(get).toHaveBeenLastCalledWith({ tabId: undefined });
  expect(onCountChange).toHaveBeenLastCalledWith(1);
  expect(String(onCountChange.mock.lastCall?.[0])).toBe(extensionCountText({ status: "ready", snapshot: userOnly }, countConfiguredMcp));
});

it("reports unknown while awaiting a snapshot, then reports a true empty count", async () => {
  let resolve!: (snapshot: McpConfigSnapshot) => void;
  const bridge = bridgeFor(() => new Promise((done) => { resolve = done; }));
  const onCountChange = vi.fn();
  await act(async () => root.render(createElement(McpServersPane, { servers: [], bridge, onCountChange })));
  expect(onCountChange).toHaveBeenLastCalledWith(null);
  expect(onCountChange).not.toHaveBeenCalledWith(0);
  await act(async () => resolve({ entries: [], problems: [], projectAvailable: false }));
  expect(onCountChange).toHaveBeenLastCalledWith(0);
});

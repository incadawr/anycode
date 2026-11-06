import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpConfigEntryView, McpPluginServerView } from "../../../shared/mcp-config.js";
import type { PluginRowView } from "../../../shared/plugins-config.js";
import type { SkillRowView } from "../../../shared/skills-config.js";
import type { LspEntryView } from "../../../shared/lsp-config.js";
import {
  countConfiguredMcp, countConfiguredPlugins, countConfiguredSkills, countConfiguredLsp,
  extensionCountText, extensionDisplayName, EXTENSION_NAME_MAX_LENGTH,
} from "./extensions-model.js";

const entry = (patch: Partial<McpConfigEntryView> = {}): McpConfigEntryView => ({
  name: "shared", source: "project", enabled: true, transport: "stdio", commandLine: "SECRET_COMMAND",
  envKeys: ["SECRET_ENV"], ...patch,
});
const plugin = (patch: Partial<McpPluginServerView> = {}): McpPluginServerView => ({
  name: "plugin_example_server", pluginName: "example", transport: "stdio", commandLine: "SECRET_ARGS",
  consentGranted: false, shadowed: false, pluginRoot: "SECRET_ROOT", ...patch,
});

describe("configured MCP count", () => {
  it("counts a project winner once while retaining its shadowed user row", () => {
    const snapshot = { entries: [entry(), entry({ source: "user", shadowed: true })] };
    expect(countConfiguredMcp(snapshot)).toBe(1);
    expect(snapshot.entries).toHaveLength(2);
  });

  it("includes a disabled winner, but not its shadowed fallback", () => {
    expect(countConfiguredMcp({ entries: [entry({ enabled: false }), entry({ source: "user", shadowed: true })] })).toBe(1);
  });

  it("leaves compat rows visible without counting them", () => {
    const snapshot = { entries: [entry({ source: "compat" })] };
    expect(countConfiguredMcp(snapshot)).toBe(0);
    expect(snapshot.entries[0]?.source).toBe("compat");
  });

  it.each([false, true])("includes a plugin server with consentGranted=%s", (consentGranted) => {
    expect(countConfiguredMcp({ entries: [], pluginServers: [plugin({ consentGranted })] })).toBe(1);
  });

  it("excludes shadowed plugins and runtime-only diagnostics", () => {
    const snapshot = {
      entries: [], pluginServers: [plugin({ shadowed: true })],
      servers: [{ name: "runtime-only", state: "failed", error: "SECRET_ERROR" }],
    };
    expect(countConfiguredMcp(snapshot)).toBe(0);
    expect(snapshot.pluginServers).toHaveLength(1);
    expect(snapshot.servers).toHaveLength(1);
  });

  it("counts the mixed catalog without mutating it", () => {
    const snapshot = {
      entries: [entry(), entry({ source: "user", shadowed: true }), entry({ name: "off", enabled: false }), entry({ source: "compat" })],
      pluginServers: [plugin(), plugin({ name: "hidden", shadowed: true })],
    };
    const before = structuredClone(snapshot);
    expect(countConfiguredMcp(snapshot)).toBe(3);
    expect(snapshot).toEqual(before);
  });
});

describe("other configured catalogs", () => {
  it("counts installed plugins including disabled/invalid entries, excluding available installs", () => {
    const row: PluginRowView = {
      name: "example", tier: "local", status: "disabled", disabled: true,
      problems: ["Invalid manifest"], source: { kind: "folder" }, mcpServerNames: [], serviceNames: [],
    };
    const installed = { plugins: [row], available: [] };
    expect(countConfiguredPlugins(installed)).toBe(1);
    const snapshot = { plugins: [], available: [{ name: "installable" }] };
    expect(countConfiguredPlugins(snapshot)).toBe(0);
  });

  it("counts own and plugin skills including disabled rows", () => {
    const own: SkillRowView = { name: "own", description: "", source: "user", sourceKind: "user", enabled: false, path: "" };
    const contributed: SkillRowView = { ...own, name: "contributed", source: "plugin:example", sourceKind: "plugin" };
    expect(countConfiguredSkills({ rows: [own, contributed] })).toBe(2);
    expect(countConfiguredSkills({ rows: [] })).toBe(0);
  });

  it("counts project and user LSP definitions without counting detected catalog entries", () => {
    const row: LspEntryView = { name: "typescript", command: "SECRET_COMMAND", args: [], extensions: [], presetId: null, hasInitOptions: false };
    const snapshot = { entries: { project: [row], user: [row] }, catalog: [row, row, row] };
    expect(countConfiguredLsp(snapshot)).toBe(2);
    expect(countConfiguredLsp({ entries: { project: null, user: [row] } })).toBe(1);
    expect(countConfiguredLsp({ entries: { project: [], user: [] } })).toBe(0);
  });
});

describe("count availability", () => {
  it("distinguishes loading and unavailable from an empty response", () => {
    const count = vi.fn(countConfiguredMcp);
    expect(extensionCountText({ status: "loading" }, count)).toBe("…");
    expect(extensionCountText({ status: "unavailable" }, count)).toBe("—");
    expect(count).not.toHaveBeenCalled();
    expect(extensionCountText({ status: "ready", snapshot: { entries: [] } }, count)).toBe("0");
    expect(extensionCountText({ status: "ready", snapshot: { entries: [entry()] } }, count)).toBe("1");
  });
});

describe("plain text display names", () => {
  it.each(["Сервер 日本語", "https://example.test/token?key=abc", "sk-example-token", "**server**", "<img src=x onerror=alert(1)>"])("keeps the recognizable name: %s", (name) => {
    expect(extensionDisplayName(name)).toBe(name);
  });

  it("removes controls and bidi markers without renaming the remaining text", () => {
    expect(extensionDisplayName("a\0\n\t\u007f\u0085\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069b")).toBe("ab");
  });

  it("limits Unicode code points without splitting surrogate pairs", () => {
    const name = "😀".repeat(EXTENSION_NAME_MAX_LENGTH + 1);
    expect(extensionDisplayName(name)).toBe(`${"😀".repeat(EXTENSION_NAME_MAX_LENGTH - 1)}…`);
    expect(Array.from(extensionDisplayName(name))).toHaveLength(EXTENSION_NAME_MAX_LENGTH);
    const exact = "я".repeat(EXTENSION_NAME_MAX_LENGTH);
    expect(extensionDisplayName(exact)).toBe(exact);
  });

  it("produces text suitable for a React text node, without config metadata", () => {
    const row = entry({ name: "<b>server</b>", cwd: "SECRET_CWD" });
    const label = extensionDisplayName(row.name);
    const html = renderToStaticMarkup(createElement("span", { title: label, "aria-label": label }, label));
    expect(html).toContain("&lt;b&gt;server&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("SECRET_");
    expect(row.name).toBe("<b>server</b>");
  });
});

// Runtime fixtures intentionally include private diagnostics; the projection must discard them.
import { hasFailedExtensionMcp, projectExtensionMcp, type McpRuntimeStatus } from "./extensions-model.js";
const runtime = (state: McpRuntimeStatus["state"], name = "shared"): McpRuntimeStatus => ({
  name, state, transport: "stdio", toolCount: 0, toolsTruncated: false, error: "PRIVATE_RUNTIME_ERROR",
});

describe("MCP runtime projection", () => {
  it.each([
    ["connected", "success", "Connected in this session"],
    ["connecting", "warning", "Connecting"],
    ["failed", "danger", "Connection failed"],
    ["closed", "neutral", "Connection closed"],
  ] as const)("projects %s independently of saved enabled", (state, tone, status) => {
    const rows = projectExtensionMcp({ entries: [entry({ enabled: false })] }, [runtime(state)], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tone, status, diagnostic: false });
    expect(rows[0]!.note).toContain("Saved: disabled for new session starts");
    expect(rows[0]!.note).toContain("startup configuration");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
    expect(hasFailedExtensionMcp([runtime(state)])).toBe(state === "failed");
  });

  it("does not infer successful boot, pending changes or empty tools from absent/zero native reports", () => {
    const snapshot = { entries: [entry(), entry({ name: "off", enabled: false })] };
    const absent = projectExtensionMcp(snapshot, [], true);
    expect(absent.every((row) => row.tone === "neutral")).toBe(true);
    expect(absent[0]!.status).toBe("Status not reported in this session");
    expect(absent[0]!.note).not.toContain("pending");
    expect(absent[1]!.note).not.toContain("startup configuration");
    const native = projectExtensionMcp(snapshot, [runtime("connected")], true);
    expect(native[0]!.status).toBe("Connected in this session");
    expect(JSON.stringify(native)).not.toMatch(/no tools|0 tools|toolCount/i);
  });

  it("joins only effective winners while preserving distinct raw source identities", () => {
    const snapshot = { entries: [entry(), entry({ source: "user", shadowed: true }), entry({ source: "compat", shadowed: true })],
      pluginServers: [plugin({ name: "shared", shadowed: true }), plugin({ name: "other" })] };
    const rows = projectExtensionMcp(snapshot, [runtime("failed"), runtime("connected", "other")], true);
    expect(new Set(rows.map((row) => row.key)).size).toBe(5);
    expect(rows.map((row) => row.tone)).toEqual(["danger", "neutral", "neutral", "neutral", "success"]);
    expect(rows[4]!.note).toBe("Needs approval in Plugins");
    expect(rows.filter((row) => row.diagnostic)).toEqual([]);
  });

  it("keeps removed servers, disappeared plugins and config failures as unmatched rows", () => {
    const servers = [runtime("failed", "MCP config"), runtime("connected", "removed"), runtime("closed", "plugin_gone")];
    const rows = projectExtensionMcp({ entries: [] }, servers, true);
    expect(rows.map((row) => row.name)).toEqual(servers.map((server) => server.name));
    expect(rows.every((row) => row.diagnostic && row.source === "This session / Diagnostics")).toBe(true);
    expect(hasFailedExtensionMcp(servers)).toBe(true);
    expect(countConfiguredMcp({ entries: [] })).toBe(0);
    expect(projectExtensionMcp(undefined, servers, true)).toEqual(rows);
  });

  it("does not let a shadowed-only catalog swallow an unmatched runtime failure", () => {
    const rows = projectExtensionMcp({ entries: [entry({ shadowed: true })] }, [runtime("failed")], true);
    expect(rows.map((row) => [row.diagnostic, row.tone])).toEqual([[false, "neutral"], [true, "danger"]]);
  });

  it("marks stale success neutral and retains a stale failure warning", () => {
    const servers = [runtime("connected"), runtime("failed", "broken")];
    const rows = projectExtensionMcp(undefined, servers, false);
    expect(rows.map((row) => row.tone)).toEqual(["neutral", "danger"]);
    expect(rows.every((row) => row.status.includes("Last reported status") && row.status.includes("Host unavailable"))).toBe(true);
    expect(hasFailedExtensionMcp(servers)).toBe(true);
  });

  it("sanitizes runtime display names and excludes every transport/detail field", () => {
    const rows = projectExtensionMcp(undefined, [runtime("failed", "<b>runtime</b>\u202e\n")], true);
    expect(rows[0]!.name).toBe("<b>runtime</b>");
    expect(Object.keys(rows[0]!)).toEqual(["key", "name", "source", "note", "status", "tone", "diagnostic"]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_RUNTIME_ERROR");
  });
});


it("offers saved switch state only for writable config sources, including shadowed rows", () => {
  const rows = projectExtensionMcp({ entries: [entry(), entry({ source: "user", shadowed: true }),
    entry({ source: "compat" })], pluginServers: [plugin()] }, [runtime("failed", "orphan")], true);
  expect(rows.map((row) => row.saved)).toEqual([{ enabled: true }, { enabled: true }, undefined, undefined, undefined]);
  expect(rows[0]!.key).not.toBe(rows[1]!.key);
  expect(rows[1]!.status).toBe("Shadowed by another scope");
});

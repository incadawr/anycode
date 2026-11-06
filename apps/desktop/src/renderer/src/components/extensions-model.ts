import type { McpServerStatus } from "@anycode/core";
import type { McpConfigSnapshot } from "../../../shared/mcp-config.js";
import type { PluginsSnapshot } from "../../../shared/plugins-config.js";
import type { SkillsSnapshot } from "../../../shared/skills-config.js";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";

/** Counts describe configured entries, independently of runtime and search. */
export function countConfiguredMcp(snapshot: Pick<McpConfigSnapshot, "entries" | "pluginServers">): number {
  return snapshot.entries.filter((entry) => !entry.shadowed && entry.source !== "compat").length
    + (snapshot.pluginServers ?? []).filter((server) => !server.shadowed).length;
}

export function countConfiguredPlugins(snapshot: Pick<PluginsSnapshot, "plugins">): number {
  return snapshot.plugins.length;
}

export function countConfiguredSkills(snapshot: Pick<SkillsSnapshot, "rows">): number {
  return snapshot.rows.length;
}

export function countConfiguredLsp(snapshot: Pick<LspConfigStatus, "entries">): number {
  return (snapshot.entries.project?.length ?? 0) + snapshot.entries.user.length;
}

export type ExtensionReadState<T> =
  | { status: "loading" }
  | { status: "ready"; snapshot: T }
  | { status: "unavailable" };

/** No snapshot means unknown, never a fabricated empty catalog. */
export function extensionCountText<T>(state: ExtensionReadState<T>, count: (snapshot: T) => number): string {
  switch (state.status) {
    case "loading": return "…";
    case "unavailable": return "—";
    case "ready": return String(count(state.snapshot));
  }
}

export const EXTENSION_NAME_MAX_LENGTH = 80;

/** Display text only: retain the raw identity separately for bridge requests.
 * Render with a text node, never HTML/Markdown; this does not redact names.
 */
export function extensionDisplayName(name: string): string {
  const characters = Array.from(name.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ""));
  return characters.length <= EXTENSION_NAME_MAX_LENGTH
    ? characters.join("")
    : `${characters.slice(0, EXTENSION_NAME_MAX_LENGTH - 1).join("")}…`;
}

export type McpRuntimeStatus = McpServerStatus;
export type McpExtensionRow = {
  key: string;
  name: string;
  source: string;
  note: string;
  status: string;
  tone: "success" | "warning" | "danger" | "neutral";
  diagnostic: boolean;
  saved?: { enabled: boolean };
};

/** Failures belong to this host's last snapshot, regardless of today's saved config. */
export function hasFailedExtensionMcp(servers: readonly McpRuntimeStatus[]): boolean {
  return servers.some((server) => server.state === "failed");
}

/** Only non-shadowed definitions may claim a runtime name. No boot identity is inferred. */
export function projectExtensionMcp(
  snapshot: Pick<McpConfigSnapshot, "entries" | "pluginServers"> | undefined,
  servers: readonly McpRuntimeStatus[],
  hostReady: boolean,
): McpExtensionRow[] {
  const runtime = new Map(servers.map((server) => [server.name, server]));
  const claimed = new Set<string>();
  function live(server: McpRuntimeStatus | undefined): Pick<McpExtensionRow, "status" | "tone"> {
    if (!server) return { status: "Status not reported in this session", tone: "neutral" };
    const status = { connected: "Connected in this session", connecting: "Connecting",
      failed: "Connection failed", closed: "Connection closed" }[server.state];
    const tone = { connected: "success", connecting: "warning", failed: "danger", closed: "neutral" }[server.state] as McpExtensionRow["tone"];
    return hostReady ? { status, tone } : {
      status: `Last reported status: ${status}. Host unavailable`,
      tone: server.state === "connected" ? "neutral" : tone,
    };
  }
  function row(key: string, name: string, source: string, note: string, shadowed: boolean): McpExtensionRow {
    const server = shadowed ? undefined : runtime.get(name);
    if (!shadowed) claimed.add(name);
    return { key, name: extensionDisplayName(name), source, note,
      ...(shadowed ? { status: "Shadowed by another scope", tone: "neutral" as const } : live(server)), diagnostic: false };
  }
  const rows: McpExtensionRow[] = (snapshot?.entries ?? []).map((entry) => ({ ...row(
    JSON.stringify([entry.source, entry.name]), entry.name,
    { project: "Project", user: "User", compat: "Compatibility" }[entry.source],
    `${entry.source === "compat" ? "Read-only compatibility source; manage in Settings. " : ""}Saved: ${entry.enabled ? "enabled" : "disabled"} for new session starts${!entry.enabled && !entry.shadowed && runtime.has(entry.name) ? "; this session keeps its startup configuration" : ""}`,
    !!entry.shadowed,
  ),
    ...(entry.source !== "compat" ? { saved: { enabled: entry.enabled } } : {}),
  }));
  rows.push(...(snapshot?.pluginServers ?? []).map((entry) => row(
    JSON.stringify(["plugin", entry.pluginName, entry.name]), entry.name, "Plugin",
    entry.consentGranted ? "Read-only; manage in Plugins" : "Needs approval in Plugins", entry.shadowed,
  )));
  rows.push(...servers.filter((server) => !claimed.has(server.name)).map((server) => ({
    key: JSON.stringify(["runtime", server.name]), name: extensionDisplayName(server.name),
    source: "This session / Diagnostics", note: "Runtime only; no saved switch", ...live(server), diagnostic: true,
  })));
  return rows;
}

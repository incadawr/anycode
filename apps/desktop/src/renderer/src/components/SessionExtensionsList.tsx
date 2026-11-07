import type { SettingsPaneSelection } from "./settings-extensions-navigation.js";
import { Button, Switch } from "../ui/index.js";
import type { LspServerStatus } from "@anycode/core";
import { hasCrashedLspServer } from "./EnvironmentMenu.js";
import { extensionDisplayName, type McpExtensionRow } from "./extensions-model.js";
import type { ExtensionToggleControls, ExtensionCategory, useSessionExtensions } from "./useSessionExtensions.js";

type Reads = ReturnType<typeof useSessionExtensions>["reads"];
type Row = { name: string; source: string; note?: string; key?: string; enabled?: boolean };
const scopeLabel = { project: "Project", user: "User", compat: "Compatibility", plugin: "Plugin" };

/** Only explicit display fields enter this surface; never spread bridge DTOs into the DOM. */
export function SessionExtensionsList({ category, reads, retry, mcpRows = [], mcpControls, catalogControls, onManage }: {
  onManage?: (pane: SettingsPaneSelection["pane"], scope: "project" | "user") => void;
  catalogControls?: Record<"skills" | "plugins", ExtensionToggleControls>;
  mcpControls?: { setEnabled: (key: string) => void; busy: boolean; writable: boolean;
    write: { pendingKey: string; error: string; savedKeys: string[] } };
  category: ExtensionCategory; reads: Reads; mcpRows?: McpExtensionRow[]; retry: (category: ExtensionCategory) => void;
}) {
  const read = reads[category];
  const controls = category === "skills" || category === "plugins" ? catalogControls?.[category] : undefined;
  if (category === "mcp") return <>
    <p>Changes apply when a session starts again. This session keeps its startup configuration.</p>
    <div aria-live="polite">
      {mcpControls?.write.error && <p role="status">{mcpControls.write.error}
        <Button type="button" disabled={mcpControls.busy} onClick={() => retry("mcp")}>Retry</Button></p>}
      {mcpControls?.write.pendingKey && <p>Saving configuration…</p>}
    </div>
    {read.status === "loading" && <p role="status">Loading configured entries…</p>}
    {read.status === "unavailable" && <div role="status"><p>Could not load configured entries.</p>
      <Button type="button" onClick={() => retry(category)}>Retry</Button></div>}
    {reads.mcp.status === "ready" && reads.mcp.snapshot.problems.length > 0 &&
      <p role="status">Some entries could not be loaded.</p>}
    {mcpRows.length === 0 && read.status === "ready" && <p>No configured entries.</p>}
    {[false, true].map((diagnostic) => {
      const rows = mcpRows.filter((row) => row.diagnostic === diagnostic);
      if (rows.length === 0) return null;
      return <section key={String(diagnostic)} aria-label={diagnostic ? "This session / Diagnostics" : "Configured MCP entries"}>
      {diagnostic && <h4>This session / Diagnostics</h4>}
      <ul className="session-extensions-list">{rows.map((row) => <li key={row.key}>
        <span className="session-extensions-name">{row.name}</span>
        <span className="session-extensions-source">{row.source} · {row.note}</span>
        {row.saved && mcpControls && <Switch checked={row.saved.enabled}
          aria-label={`${row.source}: ${row.name}; enabled for new session starts`}
          disabled={mcpControls.busy || !mcpControls.writable} aria-busy={mcpControls.write.pendingKey === row.key}
          onCheckedChange={() => mcpControls.setEnabled(row.key)} />}
        <span aria-live="polite">{mcpControls?.write.pendingKey === row.key ? "Saving…" :
          mcpControls?.write.savedKeys.includes(row.key) ? "Saved for new session starts" : ""}</span>
        <Button type="button" onClick={() => onManage?.(row.source === "Plugin" ? "plugins" : "mcp", row.source === "User" ? "user" : "project")}>Manage</Button>
        <span className="session-extensions-status">
          <span className={`session-extensions-dot tone-${row.tone}`} aria-hidden="true" />{row.status}
        </span>
      </li>)}</ul></section>;
    })}
  </>;
  if (read.status === "loading") return <p role="status">Loading configured entries…</p>;
  if (read.status === "unavailable") return <div role="status">
    <p>Could not load configured entries.</p><Button type="button" onClick={() => retry(category)}>Retry</Button>
  </div>;
  let rows: Row[] = [];
  let problems = false;
  if (category === "plugins" && reads.plugins.status === "ready") {
    rows = reads.plugins.snapshot.plugins.map((entry) => ({ key: entry.name, enabled: !entry.disabled, name: entry.name, source: "All projects",
      note: [entry.tier, entry.status, entry.disabled ? "Saved: disabled" : "Saved: enabled",
        entry.problems?.length ? "Needs attention in Plugins" : "",
        entry.mcpServerNames?.length && !entry.mcpConsentGranted ? "MCP needs approval in Plugins" : "",
        entry.serviceNames?.length && !entry.servicesConsentGranted ? "Services need approval in Plugins" : "",
      ].filter(Boolean).join(" · ") }));
  } else if (category === "skills" && reads.skills.status === "ready") {
    problems = reads.skills.snapshot.problems.length > 0;
    rows = reads.skills.snapshot.rows.map((entry) => ({ key: JSON.stringify([entry.sourceKind, entry.name]), enabled: ["project", "user"].includes(entry.sourceKind) ? entry.enabled : undefined, name: entry.name, source: scopeLabel[entry.sourceKind],
      note: `${entry.enabled ? "Saved: enabled" : "Saved: disabled"}${entry.sourceKind === "plugin" ? " · Read-only; manage in Plugins" : ""}` }));
  } else if (category === "lsp" && reads.lsp.status === "ready") {
    const entries = reads.lsp.snapshot.entries;
    rows = [...(entries.project ?? []).map((entry) => ({ name: entry.name, source: "Project" })),
      ...entries.user.map((entry) => ({ name: entry.name, source: "User" }))];
  }
  return <>
    {category === "skills" && <p>Changes apply when a session starts again. This session keeps its startup configuration.</p>}
    <div aria-live="polite">{controls?.write.error && <p role="status">{controls.write.error}
      <Button type="button" disabled={controls.busy} onClick={() => retry(category)}>Retry</Button></p>}</div>
    {problems && <p role="status">Some entries could not be loaded.</p>}
    {rows.length === 0 ? <p>No configured entries.</p> : <ul className="session-extensions-list">
      {rows.map((row, index) => <li key={row.key ?? index}>
        <span className="session-extensions-name">{extensionDisplayName(row.name)}</span>
        <span className="session-extensions-source">{row.source}{row.note && ` · ${row.note}`}</span>
        {controls && row.enabled !== undefined && row.key !== undefined && <Switch checked={row.enabled}
          aria-label={`${row.source}: ${extensionDisplayName(row.name)}; enabled${category === "plugins" ? " for all projects" : " for new session starts"}`}
          disabled={controls.busy || !controls.writable} aria-busy={controls.write.pendingKey === row.key}
          onCheckedChange={() => controls.setEnabled(row.key!)} />}
        {(category === "skills" || category === "lsp") && <Button type="button" onClick={() => onManage?.(row.source === "Plugin" ? "plugins" : category === "lsp" ? "language-servers" : "skills", row.source === "User" ? "user" : "project")}>Manage</Button>}
        <span aria-live="polite">{controls && controls.write.pendingKey === row.key ? "Saving…" :
          controls?.write.savedKeys.includes(row.key!) ? category === "plugins" ? "Saved for all projects" : "Saved for new session starts" : ""}</span>
      </li>)}
    </ul>}
  </>;
}

/** Store-backed runtime states; process details and refresh belong to the drawer. */
export function SessionExtensionsLspSummary({ servers, core, ready, onDetails, onRestart }: {
  servers: readonly LspServerStatus[]; core: boolean; ready: boolean; onDetails: () => void; onRestart: () => void;
}) {
  if (!core) return <p>AnyCode LSP is unavailable in this engine. For new Core sessions.</p>;
  return <section aria-label="Language server summary">
    {!ready && <p>Host unavailable. Last reported status:</p>}
    {servers.length === 0 && <p>Not configured</p>}
    {servers.map((server, index) => <div key={index} className="session-extensions-status">
      <span className={`session-extensions-dot tone-${server.state === "ready" ? "success" :
        server.state === "crashed" ? "danger" : server.state === "initializing" ? "warning" : "neutral"}`} aria-hidden="true" />
      <span>{extensionDisplayName(server.name)} {server.state === "not_started" ? "not started" : server.state}</span>
    </div>)}
    {hasCrashedLspServer(servers) && <Button type="button" disabled={!ready} onClick={onRestart}>Restart</Button>}
    {ready && hasCrashedLspServer(servers) && <p role="status">A language server crashed.</p>}
    {servers.length > 0 && <Button type="button" disabled={!ready} onClick={onDetails}>Details</Button>}
  </section>;
}

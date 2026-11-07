import type { SettingsPaneSelection } from "./settings-extensions-navigation.js";
import { Button, Switch } from "../ui/index.js";
import type { LspServerStatus } from "@anycode/core";
import { hasCrashedLspServer } from "../lsp-status.js";
import { extensionDisplayName, type McpExtensionRow } from "./extensions-model.js";
import type { ExtensionToggleControls, ExtensionCategory, useSessionExtensions } from "./useSessionExtensions.js";

type Reads = ReturnType<typeof useSessionExtensions>["reads"];
type Row = { name: string; source: string; note?: string; key?: string; enabled?: boolean };
const scopeLabel = { project: "Project", user: "User", compat: "Compatibility", plugin: "Plugin" };

/** Problem strings may contain OS errors or config contents; show only recognized file labels. */
function CatalogProblems({ problems, category }: { problems: string[]; category: "mcp" | "skills" }) {
  if (!problems.length) return null;
  const labels = problems.flatMap(problem => {
    if (category === "skills" && problem.startsWith("Skill discovery: ")) {
      const file = problem.match(/[\\/]([^\\/\r\n]+)[\\/]SKILL\.md(?=[:\s]|$)/)?.[1];
      if (!file) return [];
      const hint = problem.includes("invalid frontmatter in") ? "Fix the frontmatter."
        : problem.includes('a "description" is required') ? "Add a description to the frontmatter."
        : problem.includes(" — name ") ? "Fix the skill name in the frontmatter."
        : problem.startsWith("Skill discovery: could not read ") ? "Check file access, then retry." : "Review this skill in Settings.";
      return [`${extensionDisplayName(file)}/SKILL.md: ${hint}`];
    }
    if (category === "mcp") {
      const file = problem.match(/^(Invalid JSON in |Could not read )(.+?)(?:[\\/])([^\\/:]+):/);
      if (file) return [`${extensionDisplayName(file[3]!)}: ${file[1] === "Invalid JSON in " ? "Fix the JSON." : "Check file access, then retry."}`];
    }
    return [];
  });
  return <div role="status" className="session-extensions-problems">
    <p>{problems.length} configuration {problems.length === 1 ? "issue" : "issues"}. Open Manage {category === "mcp" ? "MCP servers" : "skills"} for details.</p>
    {labels.map((label, index) => <p key={index}>{label}</p>)}
  </div>;
}

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
    <p>Changes apply on the next session start.</p>
    <div aria-live="polite">
      {mcpControls?.write.error && <p role="status">{mcpControls.write.error}
        <Button type="button" disabled={mcpControls.busy} onClick={() => retry("mcp")}>Retry</Button></p>}
      {mcpControls?.write.pendingKey && <p>Saving configuration…</p>}
    </div>
    {read.status === "loading" && <p role="status">Loading configured entries…</p>}
    {read.status === "unavailable" && <div role="status"><p>Could not load configured entries.</p>
      <Button type="button" onClick={() => retry(category)}>Retry</Button></div>}
    {reads.mcp.status === "ready" && <CatalogProblems problems={reads.mcp.snapshot.problems} category="mcp" />}
    {mcpRows.length === 0 && read.status === "ready" && <p>No configured entries.</p>}
    {[false, true].map((diagnostic) => {
      const rows = mcpRows.filter((row) => row.diagnostic === diagnostic);
      if (rows.length === 0) return null;
      return <section key={String(diagnostic)} aria-label={diagnostic ? "This session / Diagnostics" : "Configured MCP entries"}>
      {diagnostic && <h4>This session / Diagnostics</h4>}
      <ul className="session-extensions-list">{rows.map((row) => <li key={row.key}>
        <div className="session-extensions-item">
        {row.saved && mcpControls && <Switch checked={row.saved.enabled}
          aria-label={`${row.source}: ${row.name}; enabled for new session starts`}
          disabled={mcpControls.busy || !mcpControls.writable} aria-busy={mcpControls.write.pendingKey === row.key}
          onCheckedChange={() => mcpControls.setEnabled(row.key)} />}
        <span className="session-extensions-name" title={row.name}>{row.name}</span>
        <span className="session-extensions-source">{row.source}</span>
        <Button type="button" className="session-extensions-manage" title={`Manage ${row.name}`} onClick={() => onManage?.(row.source === "Plugin" ? "plugins" : "mcp", row.source === "User" ? "user" : "project")}>Manage</Button>
        </div>
        {!(row.saved && mcpControls) && <span className="session-extensions-note">{row.note}</span>}
        <span className="session-extensions-feedback" aria-live="polite">{mcpControls?.write.pendingKey === row.key ? "Saving…" :
          mcpControls?.write.savedKeys.includes(row.key) ? "Saved for new session starts" : ""}</span>
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
  let problems: string[] = [];
  if (category === "plugins" && reads.plugins.status === "ready") {
    rows = reads.plugins.snapshot.plugins.map((entry) => ({ key: entry.name, enabled: !entry.disabled, name: entry.name, source: "All projects",
      note: [entry.tier, entry.status, !controls ? entry.disabled ? "Saved: disabled" : "Saved: enabled" : "",
        entry.problems?.length ? "Needs attention in Plugins" : "",
        entry.mcpServerNames?.length && !entry.mcpConsentGranted ? "MCP needs approval in Plugins" : "",
        entry.serviceNames?.length && !entry.servicesConsentGranted ? "Services need approval in Plugins" : "",
      ].filter(Boolean).join(" · ") }));
  } else if (category === "skills" && reads.skills.status === "ready") {
    problems = reads.skills.snapshot.problems;
    rows = reads.skills.snapshot.rows.map((entry) => ({ key: JSON.stringify([entry.sourceKind, entry.name]), enabled: ["project", "user"].includes(entry.sourceKind) ? entry.enabled : undefined, name: entry.name, source: scopeLabel[entry.sourceKind],
      note: entry.sourceKind === "plugin" ? `${entry.enabled ? "Saved: enabled" : "Saved: disabled"} · Read-only; manage in Plugins` : !controls ? entry.enabled ? "Saved: enabled" : "Saved: disabled" : "" }));
  } else if (category === "lsp" && reads.lsp.status === "ready") {
    const entries = reads.lsp.snapshot.entries;
    rows = [...(entries.project ?? []).map((entry) => ({ name: entry.name, source: "Project" })),
      ...entries.user.map((entry) => ({ name: entry.name, source: "User" }))];
  }
  return <>
    {category === "skills" && <p>Changes apply on the next session start.</p>}
    <div aria-live="polite">{controls?.write.error && <p role="status">{controls.write.error}
      <Button type="button" disabled={controls.busy} onClick={() => retry(category)}>Retry</Button></p>}</div>
    {category === "skills" && <CatalogProblems problems={problems} category="skills" />}
    {rows.length === 0 ? <p>No configured entries.</p> : <ul className="session-extensions-list">
      {rows.map((row, index) => <li key={row.key ?? index}>
        <div className="session-extensions-item">
        {controls && row.enabled !== undefined && row.key !== undefined && <Switch checked={row.enabled}
          aria-label={`${row.source}: ${extensionDisplayName(row.name)}; enabled${category === "plugins" ? " for all projects" : " for new session starts"}`}
          disabled={controls.busy || !controls.writable} aria-busy={controls.write.pendingKey === row.key}
          onCheckedChange={() => controls.setEnabled(row.key!)} />}
        <span className="session-extensions-name" title={extensionDisplayName(row.name)}>{extensionDisplayName(row.name)}</span>
        <span className="session-extensions-source">{row.source}</span>
        <Button type="button" className="session-extensions-manage" title={`Manage ${extensionDisplayName(row.name)}`} onClick={() => onManage?.(row.source === "Plugin" || category === "plugins" ? "plugins" : category === "lsp" ? "language-servers" : "skills", row.source === "User" ? "user" : "project")}>Manage</Button>
        </div>
        {row.note && <span className="session-extensions-note">{row.note}</span>}
        <span className="session-extensions-feedback" aria-live="polite">{controls && controls.write.pendingKey === row.key ? "Saving…" :
          controls?.write.savedKeys.includes(row.key!) ? category === "plugins" ? "Saved for all projects" : "Saved for new session starts" : ""}</span>
      </li>)}
    </ul>}
  </>;
}

/** Store-backed runtime states; process details and refresh belong to the drawer. */
export function SessionExtensionsLspSummary({ servers, core, ready, onDetails, onRestart }: {
  servers: readonly LspServerStatus[]; core: boolean; ready: boolean; onDetails: () => void; onRestart: () => void;
}) {
  if (!core) return <p>These language servers are saved for Core sessions. This engine does not use AnyCode LSP.</p>;
  return <section aria-label="Language server summary">
    {!ready && <p>Host unavailable. Last reported status:</p>}
    {servers.length === 0 && <p>Not configured</p>}
    {servers.map((server, index) => <div key={index} className="session-extensions-status">
      <span className={`session-extensions-dot tone-${server.state === "ready" ? "success" :
        server.state === "crashed" ? "danger" : server.state === "initializing" ? "warning" : "neutral"}`} aria-hidden="true" />
      <span>{extensionDisplayName(server.name)} {server.state === "not_started" ? "not started" : server.state}</span>
    </div>)}
    {hasCrashedLspServer(servers) && <Button type="button" data-extension-action="lsp-restart"
      aria-label="Restart crashed language servers" disabled={!ready} onClick={onRestart}>Restart</Button>}
    {ready && hasCrashedLspServer(servers) && <p role="status">A language server crashed.</p>}
    {servers.length > 0 && <Button type="button" data-extension-action="lsp-details" disabled={!ready} onClick={onDetails}>Details</Button>}
  </section>;
}

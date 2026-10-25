import { useContext, useEffect, useState } from "react";
import type { LspServerState, LspServerStatus } from "@anycode/core";
import type { LspConfigStatus } from "../../../shared/lsp-config.js";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { ServerStack, X } from "./icons.js";

const STATE_LABELS: Record<LspServerState, string> = {
  not_started: "Not started",
  initializing: "Initializing",
  ready: "Ready",
  crashed: "Crashed",
  disposed: "Disposed",
};

// Fixed display order for the header summary line, independent of server
// array order (which reflects config/spawn order, not a useful read order).
const STATE_SUMMARY_ORDER: readonly LspRowDisplayState[] = [
  "ready",
  "initializing",
  "crashed",
  "disposed",
  "not_started",
  "not_installed",
];

export function formatLspState(state: LspServerState): string {
  return STATE_LABELS[state];
}

export function formatLspExtensions(extensions: readonly string[]): string {
  return extensions.length > 0 ? extensions.join(", ") : "-";
}

// ── "Not installed" vs "Not started" (Taskana 4845) ──
//
// A lazy `not_started` server whose binary is missing looks broken in the
// panel ("enabled but never starts"). The Settings pane's existence-only
// detection (main/lsp-detect.ts via the lspConfig.status invoke channel —
// nothing is ever spawned) already knows the binary is absent, so the panel
// joins that answer by server NAME (the catalog id IS the written entry name)
// and displays a separate "Not installed" state with the catalog's install
// command. The lazy "Not started" stays reserved for an INSTALLED server
// before its first edit; custom entries (no catalog match) keep their live
// state — the catalog cannot speak for binaries it does not know.

/** Badge text for the missing-binary display state (distinct from Not started). */
export const LSP_NOT_INSTALLED_LABEL = "Not installed";

/** One catalog row's detection answer, indexed for the per-row join. */
export interface LspCatalogLookupEntry {
  found: boolean;
  installHint: string;
}

export type LspCatalogLookup = Map<string, LspCatalogLookupEntry>;

const EMPTY_LOOKUP: LspCatalogLookup = new Map();

/** Indexes a `lspConfig.status` snapshot's catalog by entry id (= server name). */
export function buildLspCatalogLookup(status: LspConfigStatus): LspCatalogLookup {
  const lookup: LspCatalogLookup = new Map();
  for (const entry of status.catalog) {
    lookup.set(entry.id, { found: entry.found, installHint: entry.installHint });
  }
  return lookup;
}

/** A server state as the panel DISPLAYS it: a live LspServerState, or the "Not installed" join result. */
export type LspRowDisplayState = LspServerState | "not_installed";

export function formatLspRowState(state: LspRowDisplayState): string {
  return state === "not_installed" ? LSP_NOT_INSTALLED_LABEL : formatLspState(state);
}

/**
 * Resolves one server's display state. When the catalog says the binary is
 * missing, both idle states a missing binary can present — `not_started`
 * (never touched) and `crashed` (the ENOENT spawn outcome, which carries no
 * pid/stderr of its own) — display as `not_installed` with the install hint.
 * Everything else passes through untouched: custom entries (no catalog
 * match), and every live outcome of a server whose binary WAS found.
 */
export function resolveLspRowState(
  server: LspServerStatus,
  lookup: LspCatalogLookup,
): { state: LspRowDisplayState; installHint: string | null } {
  const entry = lookup.get(server.name);
  if (entry !== undefined && !entry.found && (server.state === "not_started" || server.state === "crashed")) {
    return { state: "not_installed", installHint: entry.installHint };
  }
  return { state: server.state, installHint: null };
}

export function formatLspSummary(servers: readonly LspServerStatus[], lookup?: LspCatalogLookup): string {
  if (servers.length === 0) {
    return "";
  }
  const joined = lookup ?? EMPTY_LOOKUP;
  const counts = new Map<LspRowDisplayState, number>();
  for (const server of servers) {
    const state = resolveLspRowState(server, joined).state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return STATE_SUMMARY_ORDER.filter((state) => (counts.get(state) ?? 0) > 0)
    .map((state) => `${counts.get(state)} ${formatLspRowState(state).toLowerCase()}`)
    .join(" · ");
}

/**
 * Empty state = the setup guide. Language servers have no Settings pane:
 * they are declared in `lspServers` of `.anycode/config.json` (this project)
 * or `~/.anycode/config.json` (every project), so the panel says exactly that
 * and shows a copyable entry instead of a dead "not configured" line.
 */
export const LSP_SETUP_EXAMPLE = `{
  "lspServers": [
    {
      "name": "typescript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    }
  ]
}`;

function LspSetupHint() {
  return (
    <div className="lsp-empty">
      <p>No language servers configured.</p>
      <p>
        Language servers give the agent go-to-definition, references and diagnostics. Add an <code>lspServers</code> entry
        to <code>.anycode/config.json</code> in this project, or to <code>~/.anycode/config.json</code> for every
        project, then open a new tab. The server binary must be installed and on your PATH.
      </p>
      <pre className="lsp-setup-example">{LSP_SETUP_EXAMPLE}</pre>
      <p>A project's own language servers start only after you trust the folder.</p>
    </div>
  );
}

function LspServerRow({ server, lookup, onCopyInstallHint, copiedInstallName }: {
  server: LspServerStatus;
  lookup: LspCatalogLookup;
  onCopyInstallHint: (name: string, hint: string) => void;
  copiedInstallName: string | null;
}) {
  const hasStderr = server.stderrTail.trim().length > 0;
  const row = resolveLspRowState(server, lookup);
  const installHintCopied = row.state === "not_installed" && copiedInstallName === server.name;

  return (
    <div className="lsp-server-row">
      <div className="lsp-server-main">
        <span className="lsp-server-name" title={server.name}>
          {server.name}
        </span>
        <span className={`lsp-state lsp-state-${row.state}`}>{formatLspRowState(row.state)}</span>
      </div>
      <div className="lsp-server-meta">
        <span title={formatLspExtensions(server.extensions)}>{formatLspExtensions(server.extensions)}</span>
        <span>pid {server.pid ?? "-"}</span>
      </div>
      {row.state === "not_installed" && row.installHint !== null && (
        <div className="lsp-install-hint">
          <span className="lsp-install-command">{row.installHint}</span>
          <button
            type="button"
            className="git-btn"
            aria-label={`Copy install command for ${server.name}`}
            onClick={() => onCopyInstallHint(server.name, row.installHint ?? "")}
          >
            {installHintCopied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {hasStderr && (
        <details className="lsp-stderr">
          <summary>stderr</summary>
          <pre>{server.stderrTail}</pre>
        </details>
      )}
    </div>
  );
}

export function LspPanel() {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("LspPanel must be used within a <TabContext.Provider>");
  }

  const { tabId } = ctx;
  const servers = useTabStore((state) => state.lspServers);
  const send = useTabSend();
  const open = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.lspPanelOpen ?? false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // right-side drawer is up.
  useOverlayFlag(open);

  // Taskana 4845: existence-only binary detection for the "Not installed"
  // display state. Fetched while the drawer is open and on Refresh; a missing
  // bridge (tests/partial preload) or a failed invoke degrades to an empty
  // lookup — every row then keeps its live state (the pre-4845 behavior).
  const [lookup, setLookup] = useState<LspCatalogLookup>(() => new Map());
  const [copiedInstallName, setCopiedInstallName] = useState<string | null>(null);

  function refreshDetection(): void {
    const bridge = window.anycode?.lspConfig;
    if (!bridge) return;
    bridge
      .status({ tabId })
      .then((snapshot) => {
        setLookup(buildLspCatalogLookup(snapshot));
      })
      .catch(() => {
        // Fail-soft: no detection answer => keep live states.
      });
  }

  useEffect(() => {
    if (open) {
      send({ type: "lsp_status_request" });
      refreshDetection();
    }
  }, [open, send, tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  function copyInstallHint(name: string, hint: string): void {
    const write = navigator.clipboard?.writeText(hint);
    if (!write) return;
    void write.then(
      () => {
        setCopiedInstallName(name);
        window.setTimeout(() => setCopiedInstallName(null), 1500);
      },
      () => {},
    );
  }

  if (!open) {
    return null;
  }

  function refresh(): void {
    send({ type: "lsp_status_request" });
    refreshDetection();
  }

  function close(): void {
    useTabsStore.getState().setLspPanelOpen(tabId, false);
  }

  const summary = formatLspSummary(servers, lookup);

  return (
    <aside className="lsp-panel" aria-label="LSP status">
      <div className="lsp-panel-header">
        <ServerStack />
        <h2 className="lsp-panel-title">LSP status</h2>
        <button type="button" className="git-btn lsp-panel-refresh" onClick={refresh}>
          Refresh
        </button>
        <button type="button" className="lsp-panel-close" aria-label="Close LSP status" onClick={close}>
          <X />
        </button>
      </div>

      {summary.length > 0 && <div className="lsp-panel-summary">{summary}</div>}

      <div className="lsp-panel-body">
        {servers.length === 0 ? (
          <LspSetupHint />
        ) : (
          servers.map((server) => (
            <LspServerRow
              key={server.name}
              server={server}
              lookup={lookup}
              onCopyInstallHint={copyInstallHint}
              copiedInstallName={copiedInstallName}
            />
          ))
        )}
      </div>
    </aside>
  );
}

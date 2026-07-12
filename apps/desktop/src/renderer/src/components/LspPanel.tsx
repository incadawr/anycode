import { useContext, useEffect } from "react";
import type { LspServerState, LspServerStatus } from "@anycode/core";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
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
const STATE_SUMMARY_ORDER: readonly LspServerState[] = ["ready", "initializing", "crashed", "disposed", "not_started"];

export function formatLspState(state: LspServerState): string {
  return STATE_LABELS[state];
}

export function formatLspExtensions(extensions: readonly string[]): string {
  return extensions.length > 0 ? extensions.join(", ") : "-";
}

export function formatLspSummary(servers: readonly LspServerStatus[]): string {
  if (servers.length === 0) {
    return "";
  }
  const counts = new Map<LspServerState, number>();
  for (const server of servers) {
    counts.set(server.state, (counts.get(server.state) ?? 0) + 1);
  }
  return STATE_SUMMARY_ORDER.filter((state) => (counts.get(state) ?? 0) > 0)
    .map((state) => `${counts.get(state)} ${formatLspState(state).toLowerCase()}`)
    .join(" · ");
}

function LspServerRow({ server }: { server: LspServerStatus }) {
  const hasStderr = server.stderrTail.trim().length > 0;

  return (
    <div className="lsp-server-row">
      <div className="lsp-server-main">
        <span className="lsp-server-name" title={server.name}>
          {server.name}
        </span>
        <span className={`lsp-state lsp-state-${server.state}`}>{formatLspState(server.state)}</span>
      </div>
      <div className="lsp-server-meta">
        <span title={formatLspExtensions(server.extensions)}>{formatLspExtensions(server.extensions)}</span>
        <span>pid {server.pid ?? "-"}</span>
      </div>
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

  useEffect(() => {
    if (open) {
      send({ type: "lsp_status_request" });
    }
  }, [open, send]);

  if (!open) {
    return null;
  }

  function refresh(): void {
    send({ type: "lsp_status_request" });
  }

  function close(): void {
    useTabsStore.getState().setLspPanelOpen(tabId, false);
  }

  const summary = formatLspSummary(servers);

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
          <div className="lsp-empty">No language servers configured.</div>
        ) : (
          servers.map((server) => <LspServerRow key={server.name} server={server} />)
        )}
      </div>
    </aside>
  );
}

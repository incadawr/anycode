/**
 * Session header (design ui-redesign-direction.md §2.1/§2.4) — replaces
 * `StatusBar`. Mounted as the first child of `ActiveTabBody`, inside the
 * active tab's `<TabContext.Provider>`: reads `workspace`/`connection`
 * off `useTabStore` (the ACTIVE tab's own store) and this tab's `title`/
 * `terminalOpen` off the shell-level tabs-store, keyed by the context's
 * `tabId`. `mode` and `contextUsage` — StatusBar's other two fields — do NOT
 * live here: mode becomes the composer's `ModeMenu` and ctx% becomes the
 * composer's footer meter (both UI-5); the composer footer also picked up
 * the chip naming the connected LLM (GUI-P1 directive #3), so this header
 * only ever shows environment/connection + title + the terminal toggle.
 *
 * The sidebar's collapse state is App-level (not in TabContext), so it's
 * threaded in as two small props: `sidebarCollapsed` gates a re-expand
 * affordance at the header's left edge (App.tsx's former floating
 * `.sidebar-expand-button`, folded in here per UI-4) and `onToggleSidebar`
 * is the same toggle the sidebar footer's own collapse button calls. When
 * the sidebar is expanded its footer already owns the collapse control, so
 * the header shows nothing in that state.
 */
import { useContext } from "react";
import { TabContext, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { Collapse, Dot, History, HookIcon, ServerStack, Terminal } from "./icons.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";

/** Basename of a workspace path — same rule as Sidebar's (design §2.3/§2.4). */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/** "awaiting_port" -> "awaiting port" — cheap readability pass for the connection label. */
function formatConnectionLabel(connection: string): string {
  return connection.replace(/_/g, " ");
}

export interface SessionHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
}

export function SessionHeader({ sidebarCollapsed, onToggleSidebar }: SessionHeaderProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("SessionHeader must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;

  const workspace = useTabStore((state) => state.workspace);
  const connection = useTabStore((state) => state.connection);
  const engine = useTabStore((state) => state.engine);
  const isNewSession = useTabStore((state) => state.transcript.length === 0);

  const tab = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId));
  const terminalOpen = tab?.terminalOpen ?? false;
  const lspPanelOpen = tab?.lspPanelOpen ?? false;
  const hooksPanelOpen = tab?.hooksPanelOpen ?? false;
  const timelinePanelOpen = tab?.timelinePanelOpen ?? false;
  const title = tab?.title ?? (workspace ? basename(workspace) : "—");
  const externalEngine = engine !== null;
  const supportsRewind = engine?.capabilities.supportsRewind ?? true;

  /**
   * Pure UI flag flip (design §2.4) — absorbs App.tsx's former
   * `handleToggleTerminal` verbatim: no connection side-effect at all.
   * `TerminalPanel`'s own mount effect remains the one place that spawns the
   * xterm instance, reparents its holder, fits to the real container size,
   * and sends the first `term_open`; flipping this flag closed is a pure UI
   * hide, and the shell stays attached/buffering in the background.
   */
  function toggleTerminal(): void {
    useTabsStore.getState().setTerminalOpen(tabId, !terminalOpen);
  }

  function toggleLspPanel(): void {
    useTabsStore.getState().setLspPanelOpen(tabId, !lspPanelOpen);
  }

  function toggleHooksPanel(): void {
    useTabsStore.getState().setHooksPanelOpen(tabId, !hooksPanelOpen);
  }

  function toggleTimelinePanel(): void {
    useTabsStore.getState().setTimelinePanelOpen(tabId, !timelinePanelOpen);
  }

  return (
    <header className="session-header">
      {sidebarCollapsed && (
        <button
          type="button"
          className="session-header-expand"
          aria-label="Expand sidebar"
          onClick={onToggleSidebar}
        >
          <Collapse />
        </button>
      )}

      <span className="session-header-title" title={title}>{title}</span>

      {externalEngine && <span className="engine-identity session-header-engine">{engine.id === "codex" ? "Codex" : engine.id}</span>}

      {!isNewSession && <EnvironmentMenu placement="header" />}

      <span
        className={`session-header-connection session-header-connection-${connection}`}
        title="Connection to host"
        aria-label={`Connection: ${formatConnectionLabel(connection)}`}
      >
        <Dot className="session-header-connection-dot" />
        {connection !== "ready" && (
          <span className="session-header-connection-label">{formatConnectionLabel(connection)}</span>
        )}
      </span>

      <span className="session-header-spacer" />

      {!externalEngine && <button
        type="button"
        className={`session-header-panel-toggle${lspPanelOpen ? " session-header-panel-toggle-active" : ""}`}
        aria-label="Toggle LSP status"
        aria-pressed={lspPanelOpen}
        title="LSP status"
        onClick={toggleLspPanel}
      >
        <ServerStack />
      </button>}

      {!externalEngine && <button
        type="button"
        className={`session-header-panel-toggle${hooksPanelOpen ? " session-header-panel-toggle-active" : ""}`}
        aria-label="Toggle hooks"
        aria-pressed={hooksPanelOpen}
        title="Hooks"
        onClick={toggleHooksPanel}
      >
        <HookIcon />
      </button>}

      <>{supportsRewind && <button
        type="button"
        className={`session-header-panel-toggle${timelinePanelOpen ? " session-header-panel-toggle-active" : ""}`}
        aria-label="Toggle checkpoint timeline"
        aria-pressed={timelinePanelOpen}
        title="Timeline"
        onClick={toggleTimelinePanel}
      >
        <History />
      </button>}</>

      <button
        type="button"
        className={`session-header-panel-toggle session-header-terminal-toggle${terminalOpen ? " session-header-panel-toggle-active session-header-terminal-toggle-active" : ""}`}
        aria-label="Toggle terminal"
        aria-pressed={terminalOpen}
        title="Terminal"
        onClick={toggleTerminal}
      >
        <Terminal />
      </button>
    </header>
  );
}

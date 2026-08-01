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
 *
 * TASK.96 96-P3 (D15): also owns the compact "Previews" menu — the ONLY new
 * SessionHeader surface this slice adds — visible whenever the active tab
 * has >=1 preview of ANY container; picking a window-mode one transfers it
 * into the panel (`previewPanel.setContainer(..., "panel")`, raising the
 * D14 state-loss toast on `{ok:true, reloaded:true}` through the same
 * `onToast` pipeline `PreviewPanel`'s own "Open in window" button uses),
 * picking a panel-mode one just selects it. Dropdown idiom copied from
 * `EnvironmentMenu.tsx`: local `open` state + `useOverlayFlag` (D8) + a
 * rootRef click-outside/Escape close.
 */
import { useContext, useEffect, useRef, useState } from "react";
import { TabContext, useTabSend, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import type { ConnectionPhase, TurnState } from "../store.js";
import { Collapse, Dot, Globe, History, HookIcon, ServerStack, Terminal } from "./icons.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { PREVIEW_TRANSFERRED_TEXT, type ToastKind } from "../toasts.js";
import type { PreviewChangedPayload, PreviewContainerKind, PreviewPanelInfo } from "../../../shared/preview-panel.js";

/** Basename of a workspace path — same rule as Sidebar's (design §2.3/§2.4). */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

const EMPTY_PREVIEWS: never[] = [];

export interface PreviewMenuItem {
  previewId: string;
  label: string;
  container: PreviewContainerKind;
  /** Only meaningful for a "panel" item — is it the tab's current visible-slot occupant? */
  visible: boolean;
}

/** D15: the Previews menu is visible whenever the active tab has >=1 preview of ANY container. */
export function computePreviewMenuVisible(previews: readonly PreviewPanelInfo[]): boolean {
  return previews.length > 0;
}

/** Pure item-list derivation — label fallback mirrors PreviewPanel's own picker (title ?? sourcePath ?? url). */
export function derivePreviewMenuItems(payload: PreviewChangedPayload): PreviewMenuItem[] {
  return payload.previews.map((preview) => ({
    previewId: preview.previewId,
    label: preview.title ?? preview.sourcePath ?? preview.url,
    container: preview.container,
    visible: preview.container === "panel" && preview.previewId === payload.visiblePanelPreviewId,
  }));
}

/** "awaiting_port" -> "awaiting port" — cheap readability pass for the connection label. */
function formatConnectionLabel(connection: string): string {
  return connection.replace(/_/g, " ");
}

export interface WorktreeExitControlState {
  disabled: boolean;
  title: string;
  ariaLabel: string;
}

/** Pure projection shared by the real button and its node-environment tests. */
export function worktreeExitControlState(
  turnStatus: TurnState["status"],
  connection: ConnectionPhase,
): WorktreeExitControlState {
  if (connection !== "ready") {
    return {
      disabled: true,
      title: "Exit worktree is unavailable until the host connection is ready",
      ariaLabel: "Exit worktree unavailable until the host connection is ready",
    };
  }
  if (turnStatus === "running") {
    return {
      disabled: true,
      title: "Exit worktree is unavailable while a turn is running",
      ariaLabel: "Exit worktree unavailable while a turn is running",
    };
  }
  return {
    disabled: false,
    title: "Exit worktree; clean AnyCode-owned worktrees are removed automatically",
    ariaLabel: "Exit worktree",
  };
}

export interface SessionHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  /** P3 D14: raises the transfer state-loss toast (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

export function SessionHeader({ sidebarCollapsed, onToggleSidebar, onToast }: SessionHeaderProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("SessionHeader must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;
  const send = useTabSend();

  const workspace = useTabStore((state) => state.workspace);
  const connection = useTabStore((state) => state.connection);
  const turnStatus = useTabStore((state) => state.turn.status);
  const engine = useTabStore((state) => state.engine);
  const isNewSession = useTabStore((state) => state.transcript.length === 0);

  const tab = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId));
  const terminalOpen = tab?.terminalOpen ?? false;
  const lspPanelOpen = tab?.lspPanelOpen ?? false;
  const hooksPanelOpen = tab?.hooksPanelOpen ?? false;
  const timelinePanelOpen = tab?.timelinePanelOpen ?? false;
  const title = tab?.title ?? (workspace ? basename(workspace) : "—");
  const worktree = tab?.worktree;
  const externalEngine = engine !== null;
  const supportsRewind = engine?.capabilities.supportsRewind ?? true;
  const exitControl = worktreeExitControlState(turnStatus, connection);

  // D15 (96-P3): the Previews menu — visible whenever the active tab has
  // >=1 preview of ANY container.
  const previews = usePreviewStore((state) => state.byTab[tabId]?.previews ?? EMPTY_PREVIEWS);
  const visiblePanelPreviewId = usePreviewStore((state) => state.byTab[tabId]?.visiblePanelPreviewId ?? null);
  const previewMenuVisible = computePreviewMenuVisible(previews);
  const previewMenuItems = derivePreviewMenuItems({ tabId, previews, visiblePanelPreviewId });
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // header dropdown is up (same rule as EnvironmentMenu's own).
  useOverlayFlag(previewMenuOpen);
  const previewMenuRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!previewMenuOpen) {
      return;
    }
    function closeFromOutside(event: PointerEvent): void {
      if (previewMenuRootRef.current && !previewMenuRootRef.current.contains(event.target as Node)) {
        setPreviewMenuOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setPreviewMenuOpen(false);
      }
    }
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [previewMenuOpen]);

  /**
   * D15: a window-mode item transfers into the panel; a panel-mode item is
   * just selected. On a completed transfer (`{ok:true, reloaded:true}`) this
   * raises the SAME state-loss toast `PreviewPanel`'s "Open in window"
   * button does — the same D14 event, viewed from the other direction.
   */
  function pickPreview(item: PreviewMenuItem): void {
    if (item.container === "window") {
      window.anycode.previewPanel
        .setContainer(tabId, item.previewId, "panel")
        .then((result) => {
          if (!result.ok) {
            console.warn("[SessionHeader] setContainer failed", result.error);
            return;
          }
          if (result.reloaded) {
            onToast("preview_transferred", PREVIEW_TRANSFERRED_TEXT);
          }
        })
        .catch((error: unknown) => {
          console.warn("[SessionHeader] setContainer failed", error);
        });
    } else {
      window.anycode.previewPanel.select(tabId, item.previewId).catch((error: unknown) => {
        console.warn("[SessionHeader] select failed", error);
      });
    }
    setPreviewMenuOpen(false);
  }

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

      {worktree && (
        <span className="session-header-worktree" title={worktree.path} aria-label={`Worktree: ${worktree.branch}`}>
          Worktree · {worktree.id} · {worktree.branch}
          <button
            type="button"
            className="session-header-worktree-exit"
            onClick={() => send({ type: "exit_worktree", cleanup: "auto" })}
            disabled={exitControl.disabled}
            title={exitControl.title}
            aria-label={exitControl.ariaLabel}
          >
            Exit
          </button>
        </span>
      )}

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

      {previewMenuVisible && (
        <div ref={previewMenuRootRef} className="session-header-previews">
          <button
            type="button"
            className={`session-header-panel-toggle${previewMenuOpen ? " session-header-panel-toggle-active" : ""}`}
            aria-label="Previews"
            aria-haspopup="menu"
            aria-expanded={previewMenuOpen}
            title="Previews"
            onClick={() => setPreviewMenuOpen((current) => !current)}
          >
            <Globe />
          </button>
          {previewMenuOpen && (
            <div className="previews-menu" role="menu" aria-label="Previews">
              <div className="previews-menu-title">Previews</div>
              {previewMenuItems.map((item) => (
                <button
                  key={item.previewId}
                  type="button"
                  className={`previews-menu-row${item.visible ? " previews-menu-row-active" : ""}`}
                  role="menuitem"
                  onClick={() => pickPreview(item)}
                >
                  <span className="previews-menu-row-label" title={item.label}>{item.label}</span>
                  <span className="previews-menu-row-container">{item.container === "panel" ? "Panel" : "Window"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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

/**
 * Repository context for a session.  This deliberately is not a full Git UI:
 * it keeps the current workspace/branch quiet in the chrome and funnels the
 * rare, detailed work into the existing Git inspector drawer.
 */
import { SessionAccessRow } from "./SessionAccessRow.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { GitCommand } from "../../../shared/protocol.js";
import type { CommandHookDeclaration, LspServerStatus } from "@anycode/core";
import type { GitPendingRequest } from "../store.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Ellipsis, Folder, GitBranch, HookIcon, ServerStack } from "./icons.js";
import { gitPillLabel } from "./GitPill.js";
import { groupHooksByEvent } from "./HooksPanel.js";
// Taskana 4743: "Set up" routes through the same settings-open + pane-select
// seam SkillsPane uses (slash-menu.ts owns both event names).
import { RUN_ACTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";

type EnvironmentPlacement = "header" | "composer";

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * TASK.119 п.6: display form of the session's actual cwd. Full path when it
 * fits; otherwise "…/<last segments>" — the HEAD is sacrificed, never the
 * tail, so `proj/.anycode/worktrees/orch-1` never collapses into `proj/…`.
 * Handles both separators; "/" and "C:\" roots survive. */
export function workspaceLabel(path: string, maxChars = 44): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length <= maxChars) return path;
  const segments = trimmed.split(/[/\\]/).filter(Boolean);
  const tail: string[] = [];
  let used = 1; // the leading ellipsis
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    const cost = seg.length + (tail.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    tail.unshift(seg);
  }
  if (tail.length === 0) return `…${path.slice(-maxChars + 1)}`;
  return `…/${tail.join("/")}`;
}

function changesLabel(count: number): string {
  return count === 0 ? "Working tree clean" : `${count} change${count === 1 ? "" : "s"}`;
}

/** Taskana 4711: per-server name + ready/✓ vs anything-else/— summary; "Not configured" when empty. */
export function formatEnvironmentLspDetail(servers: readonly LspServerStatus[]): string {
  if (servers.length === 0) return "Not configured";
  return servers.map((s) => `${s.name} ${s.state === "ready" ? "✓" : "—"}`).join(", ");
}

/** Taskana 4711: the Restart action shows only when at least one server crashed. */
export function hasCrashedLspServer(servers: readonly LspServerStatus[]): boolean {
  return servers.some((s) => s.state === "crashed");
}

/** Taskana 4711: "3 hooks (PreToolUse 1, PostToolUse 2)" / "None" — reuses HooksPanel's stable event order. */
export function formatEnvironmentHooksDetail(hooks: readonly CommandHookDeclaration[]): string {
  if (hooks.length === 0) return "None";
  const groups = groupHooksByEvent(hooks);
  const parts = groups.map((g) => `${g.event} ${g.count}`).join(", ");
  return `${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"} (${parts})`;
}

export function EnvironmentMenu({ placement }: { placement: EnvironmentPlacement }) {
  const tabStore = useTabStoreApi();
  const send = useTabSend();
  const tabId = useContext(TabContext)?.tabId;
  const workspace = useTabStore((state) => state.workspace);
  const status = useTabStore((state) => state.git.status);
  const statusKnown = useTabStore((state) => state.git.statusKnown);
  const branches = useTabStore((state) => state.git.branches);
  // Taskana 4711: LSP/hooks status rows (core engines only — `engine === null`
  // mirrors the old header-button gate and the panels' mount gate in App.tsx).
  const engine = useTabStore((state) => state.engine);
  const lspServers = useTabStore((state) => state.lspServers);
  const hookDeclarations = useTabStore((state) => state.hookDeclarations);
  const gitAvailable = status !== null;
  const [open, setOpen] = useState(false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // header dropdown is up.
  useOverlayFlag(open);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const dispatch = useCallback(
    (command: GitCommand, pending: GitPendingRequest): void => {
      const requestId = crypto.randomUUID();
      tabStore.getState().gitRequestStarted(requestId, pending);
      send({ type: "git_command", requestId, command });
    },
    [send, tabStore],
  );

  // The menu is the primary lightweight Git entry point, so it refreshes the
  // branch list itself rather than relying on the debug drawer having opened.
  useEffect(() => {
    if (!open || !gitAvailable) {
      return;
    }
    dispatch({ op: "refresh" }, { kind: "refresh", label: "refresh" });
    dispatch({ op: "branches" }, { kind: "branches", label: "branches" });
  }, [dispatch, gitAvailable, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeFromOutside(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  if (!workspace) {
    return null;
  }

  const workspacePath: string = workspace;
  const branch = status ? gitPillLabel(status) : null;
  const dirtyCount = status?.dirtyCount ?? 0;
  const label = branch ? `${basename(workspacePath)} · ${branch}` : basename(workspacePath);

  function toggle(): void {
    setOpen((current) => !current);
    setBranchesOpen(false);
  }

  function openInspector(): void {
    tabStore.getState().gitSetView("changes");
    tabStore.getState().gitSetPanelOpen(true);
    setOpen(false);
  }

  // Taskana 4711 cross-review F4: a missing TabContext must not look like a
  // working Details click — the menu still closes, so say so in the console.
  function openPanel(apply: (id: string) => void): void {
    if (tabId) apply(tabId);
    else console.warn("EnvironmentMenu: no tab context, panel not opened");
    setOpen(false);
  }

  function openLspDetails(): void {
    openPanel((id) => useTabsStore.getState().setLspPanelOpen(id, true));
  }

  // Taskana 4743: "Set up" (zero servers) lands on the Language servers
  // SETTINGS pane now — the same settings.open + select-pane pair SkillsPane
  // uses — instead of the drawer; "Details" above keeps opening the drawer.
  function openLspSetup(): void {
    window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
    window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: "language-servers" }));
    setOpen(false);
  }

  function openHooksDetails(): void {
    openPanel((id) => useTabsStore.getState().setHooksPanelOpen(id, true));
  }

  // Menu stays open: the row's status text updates via the next lsp_status.
  function restartLsp(): void {
    send({ type: "lsp_restart_request" });
  }


  function switchBranch(name: string): void {
    if (!status || name === status.head.branch) {
      return;
    }
    dispatch({ op: "switch_branch", name }, { kind: "mutation", label: "switch branch" });
    setOpen(false);
  }

  function copyWorkspace(): void {
    const write = navigator.clipboard?.writeText(workspacePath);
    if (!write) {
      return;
    }
    void write.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  return (
    <div ref={rootRef} className={`environment-control environment-control-${placement}`}>
      <button
        type="button"
        className="environment-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Environment: ${label}`}
        onClick={toggle}
      >
        <Folder />
        <span className="environment-workspace" title={workspacePath}>{workspaceLabel(workspacePath)}</span>
        {branch && (
          <>
            <span className="environment-separator" aria-hidden="true">/</span>
            <GitBranch />
            <span className="environment-branch">{branch}</span>
          </>
        )}
      </button>
      <button
        type="button"
        className="environment-more"
        aria-label="Open environment menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Ellipsis />
      </button>

      {open && (
        <div className="environment-menu" role="menu" aria-label="Environment">
          <div className="environment-menu-title">Environment</div>
          <button type="button" className="environment-menu-row" role="menuitem" onClick={copyWorkspace}>
            <Folder />
            <span className="environment-menu-row-main">
              <span>Workspace</span>
              <span className="environment-menu-row-detail environment-menu-row-detail-wrap">{copied ? "Copied" : workspacePath}</span>
            </span>
          </button>

          {statusKnown && status && (
            <>
              <button
                type="button"
                className="environment-menu-row"
                role="menuitem"
                aria-expanded={branchesOpen}
                onClick={() => setBranchesOpen((current) => !current)}
              >
                <GitBranch />
                <span className="environment-menu-row-main">
                  <span>Branch</span>
                  <span className="environment-menu-row-detail">{branch}</span>
                </span>
                <span className={`environment-menu-chevron${branchesOpen ? " environment-menu-chevron-open" : ""}`}>⌄</span>
              </button>
              {branchesOpen && branches && (
                <div className="environment-branches" role="group" aria-label="Branches">
                  {branches.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className={`environment-branch-row${item.current ? " environment-branch-row-current" : ""}`}
                      onClick={() => switchBranch(item.name)}
                    >
                      <GitBranch />
                      <span>{item.name}</span>
                      {item.current && <span aria-label="Current branch">✓</span>}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="environment-menu-row" role="menuitem" onClick={openInspector}>
                <span className="environment-menu-spacer" aria-hidden="true" />
                <span className="environment-menu-row-main">
                  <span>Changes</span>
                  <span className="environment-menu-row-detail">{changesLabel(dirtyCount)}</span>
                </span>
                <span className="environment-menu-open">Open</span>
              </button>
            </>
          )}
          {engine === null && (
            <>
              <div className="environment-menu-row" role="group" aria-label="Language servers">
                <ServerStack />
                <span className="environment-menu-row-main">
                  <span>Language servers</span>
                  <span className="environment-menu-row-detail">{formatEnvironmentLspDetail(lspServers)}</span>
                </span>
                <span className="environment-menu-actions">
                  {hasCrashedLspServer(lspServers) && (
                    <button type="button" className="environment-menu-open" data-environment-action="lsp-restart" onClick={restartLsp}>Restart</button>
                  )}
                  {lspServers.length > 0 ? (
                    <button type="button" className="environment-menu-open" data-environment-action="lsp-details" onClick={openLspDetails}>Details</button>
                  ) : (
                    <button type="button" className="environment-menu-open" data-environment-action="lsp-setup" onClick={openLspSetup}>Set up</button>
                  )}
                </span>
              </div>
              <div className="environment-menu-row" role="group" aria-label="Hooks">
                <HookIcon />
                <span className="environment-menu-row-main">
                  <span>Hooks</span>
                  <span className="environment-menu-row-detail">{formatEnvironmentHooksDetail(hookDeclarations)}</span>
                </span>
                <span className="environment-menu-actions">
                  <button type="button" className="environment-menu-open" data-environment-action="hooks-details" onClick={openHooksDetails}>Details</button>
                </span>
              </div>
            </>
          )}
          {/* Taskana 4747: the per-session Sessions API switch (any engine; main owns the state). */}
          <SessionAccessRow />
          {statusKnown && status === null && <div className="environment-menu-note">Git is not available for this workspace.</div>}
          {!statusKnown && <div className="environment-menu-note">Checking repository…</div>}
        </div>
      )}
    </div>
  );
}

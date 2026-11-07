/**
 * Repository context for a session.  This deliberately is not a full Git UI:
 * it keeps the current workspace/branch quiet in the chrome and funnels the
 * rare, detailed work into the existing Git inspector drawer.
 */
import { useTabsStore } from "../tabs-store.js";
import { NativeSessionAccess } from "./NativeSessionAccess.js";
import { SessionAccessRow } from "./SessionAccessRow.js";
import { DiagnosticsExportSection } from "./DiagnosticsExportSection.js";
import { BrowserAccessRow } from "./BrowserAccessRow.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { GitCommand } from "../../../shared/protocol.js";
import type { GitPendingRequest } from "../store.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Copy, Folder, GitBranch } from "./icons.js";
import { Button, IconButton } from "../ui/index.js";
import { EnvironmentBranchPicker } from "./EnvironmentBranchPicker.js";
import { gitAheadBehindLabel, gitPillLabel } from "./GitPill.js";

type EnvironmentPlacement = "header" | "composer";

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * п.6: display form of the session's actual cwd. Full path when it
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

export function EnvironmentMenu({ placement }: { placement: EnvironmentPlacement }) {
  const tabStore = useTabStoreApi();
  const send = useTabSend();
  const tabId = useContext(TabContext)?.tabId;
  const title = useTabsStore(state => state.tabs.find(tab => tab.tabId === tabId)?.title);
  const [diagnosticsRequest, setDiagnosticsRequest] = useState(0);
  const workspace = useTabStore((state) => state.workspace);
  const status = useTabStore((state) => state.git.status);
  const statusKnown = useTabStore((state) => state.git.statusKnown);
  const gitAvailable = status !== null;
  const [open, setOpen] = useState(false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // header dropdown is up.
  useOverlayFlag(open);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [switchPending, setSwitchPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  const branchRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(copyTimer.current); };
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setDiagnosticsRequest(0);
    triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (open && !branchesOpen) {
      if (returning.current) branchRef.current?.focus();
      else panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      returning.current = false;
    }
  }, [open, branchesOpen]);
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
        if (!switchPending) close();
      }
    }
    function closeFromEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!switchPending) close();
      }
    }
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open, switchPending, close]);

  useEffect(() => {
    function openBranches(event: Event) {
      if ((event as CustomEvent<string>).detail !== tabId || !workspace || !gitAvailable) return;
      setDiagnosticsRequest(0);
      setBranchesOpen(true);
      setOpen(true);
      rootRef.current?.querySelector<HTMLInputElement>(".environment-branch-picker input")?.focus();
    }
    window.addEventListener("anycode:switch-branch", openBranches);
    return () => window.removeEventListener("anycode:switch-branch", openBranches);
  }, [tabId, workspace, gitAvailable]);

  useEffect(() => {
    const exportDiagnostics = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tabId || !workspace || switchPending) return;
      setBranchesOpen(false);
      setOpen(true);
      setDiagnosticsRequest(request => request + 1);
    };
    window.addEventListener("anycode:export-diagnostics", exportDiagnostics);
    return () => window.removeEventListener("anycode:export-diagnostics", exportDiagnostics);
  }, [tabId, workspace, switchPending]);

  if (!workspace) {
    return null;
  }

  const workspacePath: string = workspace;
  const showWorkspace = placement === "composer" || basename(workspacePath) !== (title ?? basename(workspacePath));
  const branch = status ? gitPillLabel(status) : null;
  const dirtyCount = status?.dirtyCount ?? 0;
  const label = branch ? `${basename(workspacePath)} · ${branch}` : basename(workspacePath);

  function toggle(): void {
    if (switchPending) return;
    if (open) close(); else setOpen(true);
    setBranchesOpen(false);
  }

  function openInspector(): void {
    tabStore.getState().gitSetView("changes");
    tabStore.getState().gitSetPanelOpen(true);
    close();
  }

  function copyWorkspace(): void {
    const write = navigator.clipboard?.writeText(workspacePath);
    if (!write) {
      return;
    }
    void write.then(
      () => {
        if (!mounted.current) return;
        window.clearTimeout(copyTimer.current);
        setCopied(true);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  return (
    <div ref={rootRef} className={`environment-control environment-control-${placement}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`environment-trigger${branch ? " environment-trigger-has-branch" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Environment: ${label}`}
        onClick={toggle}
      >
        <Folder />
        {showWorkspace && <span className="environment-workspace" title={workspacePath}>{workspaceLabel(workspacePath)}</span>}
        {branch && (
          <>
            {showWorkspace && <span className="environment-separator" aria-hidden="true">/</span>}
            <GitBranch />
            <span className="environment-branch">{branch}</span>
          </>
        )}
        {statusKnown && dirtyCount > 0 && <span className="environment-git-count" aria-label={changesLabel(dirtyCount)}>●{dirtyCount}</span>}
        {statusKnown && status && gitAheadBehindLabel(status.head) && <span className="environment-git-count">{gitAheadBehindLabel(status.head)}</span>}
        <span aria-hidden="true">⌄</span>
      </button>

      {open && (
        <div ref={panelRef} className="environment-menu" role="dialog" aria-modal="false" aria-label="Environment"
          onBlur={event => {
            if (!branchesOpen && !switchPending && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget as Node)) { setOpen(false); setDiagnosticsRequest(0); }
          }}
          onKeyDown={event => {
            if (event.key !== "Tab" || !branchesOpen) return;
            const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
            const first = controls[0], last = controls.at(-1);
            if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
              event.preventDefault();
              (event.shiftKey ? last : first)?.focus();
            }
          }}>
          {branchesOpen ? <EnvironmentBranchPicker back={() => { returning.current = true; setBranchesOpen(false); }}
            pendingChanged={setSwitchPending}
            retry={() => dispatch({ op: "branches" }, { kind: "branches", label: "branches" })}
            switched={close} /> : <>
          <section className="environment-menu-section" aria-label="Workspace">
            <div className="environment-menu-title">Workspace</div>
            <div className="environment-menu-row">
              <Folder />
              <span className="environment-menu-row-main">
                <span>{basename(workspacePath)}</span>
                <span className="environment-menu-row-detail environment-workspace-path" title={workspacePath}><bdi dir="ltr">{workspacePath}</bdi></span>
              </span>
              {copied && <span role="status">Copied</span>}
              <IconButton label="Copy path" icon={<Copy />} onClick={copyWorkspace} />
            </div>

            {statusKnown && status && (
              <>
                <Button
                  variant="ghost" size="sm"
                  type="button"
                  className="environment-menu-row"
                  ref={branchRef}
                  aria-haspopup="listbox"
                  onClick={() => { setDiagnosticsRequest(0); setBranchesOpen(true); }}
                >
                  <GitBranch />
                  <span className="environment-menu-row-main">
                    <span>Branch</span>
                    <span className="environment-menu-row-detail">{branch}</span>
                  </span>
                  <span aria-hidden="true">›</span>
                </Button>
                <Button variant="ghost" size="sm" type="button" className="environment-menu-row" onClick={openInspector}>
                  <span className="environment-menu-spacer" aria-hidden="true" />
                  <span className="environment-menu-row-main">
                    <span>Changes</span>
                    <span className="environment-menu-row-detail">{changesLabel(dirtyCount)}</span>
                  </span>
                  <span className="environment-menu-open">Open</span>
                </Button>
              </>
            )}
            {statusKnown && status === null && <div className="environment-menu-note">Git is not available for this workspace.</div>}
            {!statusKnown && <div className="environment-menu-note">Checking repository…</div>}
          </section>
          <section className="environment-menu-section environment-menu-group" aria-label="Session access">
            <div className="environment-menu-title">Session access <span className="environment-menu-scope">this session only</span></div>
            {/* the per-session Sessions API switch (any engine; main owns the state). */}
            <SessionAccessRow />
            {tabId && <NativeSessionAccess key={tabId} tabId={tabId} />}
            {/* the per-session "Full browser access" switch (asks before turning ON). */}
            <BrowserAccessRow />
          </section>
          <DiagnosticsExportSection request={diagnosticsRequest} />
          </>}
        </div>
      )}
    </div>
  );
}

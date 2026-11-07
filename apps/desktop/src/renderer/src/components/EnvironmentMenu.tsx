/**
 * Repository context for a session.  This deliberately is not a full Git UI:
 * it keeps the current workspace/branch quiet in the chrome and funnels the
 * rare, detailed work into the existing Git inspector drawer.
 */
import { NativeSessionAccess } from "./NativeSessionAccess.js";
import { SessionAccessRow, type SessionAccessBridge } from "./SessionAccessRow.js";
import { DiagnosticsExportSection } from "./DiagnosticsExportSection.js";
import { BrowserAccessRow, useBrowserAccessState } from "./BrowserAccessRow.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { GitCommand } from "../../../shared/protocol.js";
import type { GitPendingRequest } from "../store.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Copy, Folder, GitBranch, Globe, Robot, Warning } from "./icons.js";
import { Button, IconButton } from "../ui/index.js";
import { EnvironmentBranchPicker } from "./EnvironmentBranchPicker.js";
import { gitAheadBehindLabel, gitPillLabel } from "./GitPill.js";

import { useTabsStore } from "../tabs-store.js";
import { EnvironmentWorktree } from "./EnvironmentWorktree.js";

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
  const allocatedWorktree = useTabsStore(s => tabId ? s.childWorktrees[tabId] : undefined);
  const worktree = useTabsStore(s => s.tabs.find(t => t.tabId === tabId)?.worktree) ?? allocatedWorktree;
  const parentTitle = useTabsStore(s => allocatedWorktree ? s.tabs.find(t => t.sessionId === allocatedWorktree.parentSessionId)?.title : undefined);
  const parentLabel = parentTitle?.trim() ? `worktree of “${parentTitle}”` : undefined;
  const ownedWorktree = worktree?.ownedByAnyCode === true || !!allocatedWorktree;
  const branchLockReason = allocatedWorktree ? "Branch is managed by the parent session" : "Managed worktree branch; switch from the parent checkout";
  const [browserAccess, setBrowserAccess] = useBrowserAccessState(tabId, window.anycode.browserAccess);
  const [sessionsEnabled, setSessionsEnabled] = useState(false);
  const accessNames: string[] = [];
  if (browserAccess?.fullAccess === true) accessNames.push("Full browser access");
  if (sessionsEnabled) accessNames.push("Sessions API");
  const accessCount = accessNames.length;
  const accessPhrase = accessNames.join(" and ");
  // Bumped on every Sessions API change reported by the switch; a fetch started before it is stale.
  const sessionsEpoch = useRef(0);
  const onSessionsEnabledChange = useCallback((enabled: boolean) => {
    sessionsEpoch.current += 1;
    setSessionsEnabled(enabled);
  }, []);
  const workspace = useTabStore((state) => state.workspace);
  const status = useTabStore((state) => state.git.status);
  const statusKnown = useTabStore((state) => state.git.statusKnown);
  const gitAvailable = status !== null;
  const [open, setOpen] = useState(false);
  // One fetch per tab; later changes arrive through SessionAccessRow's onEnabledChange.
  useEffect(() => {
    let cancelled = false;
    const epoch = sessionsEpoch.current;
    setSessionsEnabled(false);
    void (window.anycode.communication as SessionAccessBridge).get().then(result => {
      if (!cancelled && result.ok && epoch === sessionsEpoch.current) setSessionsEnabled(result.view.tabs.find(t => t.tabId === tabId)?.enabled ?? false);
    });
    return () => { cancelled = true; };
  }, [tabId]);
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
      if ((event as CustomEvent<string>).detail !== tabId || !workspace || !gitAvailable || ownedWorktree) return;
      setBranchesOpen(true);
      setOpen(true);
      rootRef.current?.querySelector<HTMLInputElement>(".environment-branch-picker input")?.focus();
    }
    window.addEventListener("anycode:switch-branch", openBranches);
    return () => window.removeEventListener("anycode:switch-branch", openBranches);
  }, [tabId, workspace, gitAvailable, ownedWorktree]);

  if (!workspace) {
    return null;
  }

  const workspacePath: string = workspace;
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
        title={parentLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Environment: ${label}${worktree ? ", Worktree" : ""}${accessCount ? `, ${accessPhrase} enabled` : ""}`}
        onClick={toggle}
      >
        <Folder />
        {worktree && <span className="environment-worktree-label" title="Worktree">worktree</span>}
        <span className="environment-workspace" title={workspacePath}>{workspaceLabel(workspacePath)}</span>
        {branch && (
          <>
            <span className="environment-separator" aria-hidden="true">/</span>
            <GitBranch />
            <span className="environment-branch">{branch}</span>
          </>
        )}
        {statusKnown && dirtyCount > 0 && <span className="environment-git-count" aria-label={changesLabel(dirtyCount)}>●{dirtyCount}</span>}
        {statusKnown && status && gitAheadBehindLabel(status.head) && <span className="environment-git-count">{gitAheadBehindLabel(status.head)}</span>}
        {accessCount > 0 && <span className="environment-risks" aria-label={`${accessPhrase} enabled`}>
          <span className="environment-risk-icons">
            {browserAccess?.fullAccess && <span title="Full browser access"><Globe /></span>}
            {sessionsEnabled && <span title="Sessions API enabled"><Robot /></span>}
          </span>
          <span className="environment-risk-summary" title={`${accessPhrase} enabled`}><Warning />{accessCount}</span>
        </span>}
        <span aria-hidden="true">⌄</span>
      </button>

      {open && (
        <div ref={panelRef} className="environment-menu" role="dialog" aria-modal="false" aria-label="Environment"
          onBlur={event => {
            if (!branchesOpen && !switchPending && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
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
          {branchesOpen && !ownedWorktree ? <EnvironmentBranchPicker back={() => { returning.current = true; setBranchesOpen(false); }}
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

            {worktree && <EnvironmentWorktree parentLabel={parentLabel} managed={!!allocatedWorktree} worktree={worktree} known={statusKnown} dirtyCount={dirtyCount} />}
            {statusKnown && status && (
              <>
                <Button
                  variant="ghost" size="sm"
                  type="button"
                  className="environment-menu-row"
                  ref={branchRef}
                  disabled={ownedWorktree}
                  title={ownedWorktree ? branchLockReason : undefined}
                  aria-haspopup="listbox"
                  onClick={() => setBranchesOpen(true)}
                >
                  <GitBranch />
                  <span className="environment-menu-row-main">
                    <span>Branch</span>
                    <span className="environment-menu-row-detail">{branch}</span>
                    {ownedWorktree && <span className="environment-menu-row-detail environment-menu-row-detail-prose">{branchLockReason}</span>}
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
            <div className="environment-menu-title">Session access <span className="environment-menu-scope">{accessCount ? `${accessCount} on` : "this session only"}</span></div>
            {/* the per-session Sessions API switch (any engine; main owns the state). */}
            <SessionAccessRow onEnabledChange={onSessionsEnabledChange} />
            {tabId && <NativeSessionAccess key={tabId} tabId={tabId} />}
            {/* the per-session "Full browser access" switch (asks before turning ON). */}
            <BrowserAccessRow onStateChange={setBrowserAccess} />
          </section>
          <section className="environment-menu-section environment-menu-group" aria-label="Diagnostics">
            <div className="environment-menu-title">Diagnostics</div>
            {/* GitHub #18: export THIS session's tree (session + children) as an
                anonymised bundle, with a preview before saving. */}
            <DiagnosticsExportSection />
          </section>
          </>}
        </div>
      )}
    </div>
  );
}

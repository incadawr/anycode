/**
 * Repository context for a session.  This deliberately is not a full Git UI:
 * it keeps the current workspace/branch quiet in the chrome and funnels the
 * rare, detailed work into the existing Git inspector drawer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommand } from "../../../shared/protocol.js";
import type { GitPendingRequest } from "../store.js";
import { useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { Ellipsis, Folder, GitBranch } from "./icons.js";
import { gitPillLabel } from "./GitPill.js";

type EnvironmentPlacement = "header" | "composer";

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

function changesLabel(count: number): string {
  return count === 0 ? "Working tree clean" : `${count} change${count === 1 ? "" : "s"}`;
}

export function EnvironmentMenu({ placement }: { placement: EnvironmentPlacement }) {
  const tabStore = useTabStoreApi();
  const send = useTabSend();
  const workspace = useTabStore((state) => state.workspace);
  const status = useTabStore((state) => state.git.status);
  const statusKnown = useTabStore((state) => state.git.statusKnown);
  const branches = useTabStore((state) => state.git.branches);
  const gitAvailable = status !== null;
  const [open, setOpen] = useState(false);
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
        <span className="environment-workspace" title={workspacePath}>{basename(workspacePath)}</span>
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
              <span className="environment-menu-row-detail">{copied ? "Copied" : basename(workspacePath)}</span>
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
          {statusKnown && status === null && <div className="environment-menu-note">Git is not available for this workspace.</div>}
          {!statusKnown && <div className="environment-menu-note">Checking repository…</div>}
        </div>
      )}
    </div>
  );
}

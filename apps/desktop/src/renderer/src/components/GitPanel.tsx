/**
 * Git Review panel (design /working-docs/build/design/slice-5.8-cut.md §2.6):
 * self-connecting (`useTabStore`/`useTabSend`/`useTabStoreApi`, the
 * `ConnectedPermissionModal` idiom), mounted unconditionally in
 * `ActiveTabBody` and rendering `null` while `git.panelOpen` is false. Three
 * tabs — changes/history/diff — over the git slice frozen by wave C
 * (`store.ts` §2.5). Every non-destructive op (refresh/branches/log/diff/
 * stage/unstage/stage_all/commit/switch_branch/create_branch) is dispatched
 * directly through `gitRequestStarted` + `useTabSend`; every destructive op
 * (discard/stash_push/stash_pop/reset) goes ONLY through `gitStageConfirm`

 * command is ever built and sent. Destructive buttons are additionally

 * refuses server-side; this only keeps the UI honest about it). Errors render

 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GitBranchInfo, GitCommitInfo, GitDiffTarget, GitFileChange } from "@anycode/core";
import type { GitCommand, WireGitStatus } from "../../../shared/protocol.js";
import type { GitDestructiveIntent, GitDiffState, GitPanelView, GitPendingRequest } from "../store.js";
import { useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { GitDiffPane } from "./GitDiffPane.js";
import { Chevron, Plus, Search, X } from "./icons.js";

const VIEWS: readonly GitPanelView[] = ["changes", "history", "diff"];
const VIEW_LABELS: Record<GitPanelView, string> = { changes: "Changes", history: "History", diff: "Diff" };

/** `status.staged` paths, or `[]` before the first status arrives. Exported for the unit gate. */
export function stagedPaths(status: WireGitStatus | null): string[] {
  return status ? status.staged.map((f) => f.path) : [];
}

/** `status.unstaged` paths, or `[]` before the first status arrives. Exported for the unit gate. */
export function unstagedPaths(status: WireGitStatus | null): string[] {
  return status ? status.unstaged.map((f) => f.path) : [];
}

/**
 * Pure builder for a per-file diff request: the `op:"diff"` command and the
 * matching `kind:"diff"` pending entry that stamps `git.diff` with the spec
 * so a later out-of-order result can be stale-dropped (store.ts §2.5).
 * Exported for the unit gate — this is the one piece of dispatch logic worth
 * testing without a live store/send.
 */
export function buildDiffRequest(path: string, target: GitDiffTarget): { command: GitCommand; pending: GitPendingRequest } {
  return {
    command: { op: "diff", target, path },
    pending: { kind: "diff", diff: { path, target }, label: "diff" },
  };
}

/**
 * Pure builder for the "Unstage all" bulk action: `null` when nothing is
 * staged (the button has nothing to do — the caller no-ops rather than
 * sending an empty-paths command the wire schema would reject anyway, since
 * `unstage`'s `paths` array has a `.min(1)`).
 */
export function buildUnstageAllRequest(
  status: WireGitStatus | null,
): { command: GitCommand; pending: GitPendingRequest } | null {
  const paths = stagedPaths(status);
  if (paths.length === 0) {
    return null;
  }
  return { command: { op: "unstage", paths }, pending: { kind: "mutation", label: "unstage all" } };
}

/**
 * Pure builder for the "Discard all" bulk action's confirm intent: `discard`
 * over every currently-unstaged path, or `null` when there is nothing to
 * discard (mirrors `buildUnstageAllRequest`'s empty-set guard). The caller

 */
export function discardAllIntent(status: WireGitStatus | null): GitDestructiveIntent | null {
  const paths = unstagedPaths(status);
  return paths.length > 0 ? { op: "discard", paths } : null;
}

interface FileRowAction {
  label: string;
  onClick(): void;
  destructive?: boolean;
  disabled?: boolean;
}

function GitFileRow({
  path,
  badge,
  actions,
  onOpen,
}: {
  path: string;
  badge?: string;
  actions: FileRowAction[];
  onOpen?(): void;
}) {
  return (
    <div className="git-file-row">
      {onOpen ? (
        <button type="button" className="git-file-path git-file-path-button" title={`Open diff for ${path}`} onClick={onOpen}>
          {path}
        </button>
      ) : (
        <span className="git-file-path" title={path}>{path}</span>
      )}
      {badge && <span className="git-file-badge">{badge}</span>}
      <span className="git-file-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={`git-btn${action.destructive ? " git-btn-destructive" : ""}`}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </span>
    </div>
  );
}

interface NavigatorEntry {
  path: string;
  kind: string;
  target: GitDiffTarget | null;
}

interface NavigatorFolder {
  name: string;
  path: string;
  folders: Map<string, NavigatorFolder>;
  files: NavigatorEntry[];
}

function navigatorEntries(status: WireGitStatus | null): NavigatorEntry[] {
  if (!status) {
    return [];
  }
  // A path can be both staged and changed again in the worktree. The worktree
  // version wins because it is the most recent content a reviewer can inspect.
  const byPath = new Map<string, NavigatorEntry>();
  for (const file of status.staged) {
    byPath.set(file.path, { path: file.path, kind: file.kind, target: "staged" });
  }
  for (const file of status.unstaged) {
    byPath.set(file.path, { path: file.path, kind: file.kind, target: "worktree" });
  }
  for (const path of status.untracked) {
    byPath.set(path, { path, kind: "untracked", target: null });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildNavigatorTree(entries: readonly NavigatorEntry[]): NavigatorFolder {
  const root: NavigatorFolder = { name: "", path: "", folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const fileName = parts.pop() ?? entry.path;
    let folder = root;
    for (const part of parts) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.folders.get(part);
      if (!child) {
        child = { name: part, path, folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.push({ ...entry, path: entry.path || fileName });
  }
  return root;
}

function changeMark(kind: string): string {
  switch (kind) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "untracked": return "U";
    default: return "M";
  }
}

function GitFileNavigator({
  status,
  selectedPath,
  onSelect,
}: {
  status: WireGitStatus | null;
  selectedPath: string | null;
  onSelect(entry: NavigatorEntry): void;
}) {
  const [query, setQuery] = useState("");
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = navigatorEntries(status).filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedQuery));
  const root = buildNavigatorTree(entries);
  const showSearchResults = normalizedQuery.length >= 2;

  function toggleFolder(path: string): void {
    setClosedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderFile(entry: NavigatorEntry, depth: number, searchResult = false): ReactNode {
    const segments = entry.path.split("/");
    const name = segments.pop() ?? entry.path;
    const parent = segments.join("/");
    return (
      <button
        key={`file:${entry.path}`}
        type="button"
        className={`git-navigator-file${selectedPath === entry.path ? " git-navigator-file-selected" : ""}${searchResult ? " git-navigator-search-result" : ""}`}
        style={{ paddingLeft: `${searchResult ? 0.5 : 1.75 + depth * 0.8}rem` }}
        disabled={entry.target === null}
        title={entry.target === null ? `${entry.path} is untracked — stage it to review a diff` : entry.path}
        onClick={() => onSelect(entry)}
      >
        <span className={`git-navigator-mark git-navigator-mark-${changeMark(entry.kind).toLowerCase()}`}>{changeMark(entry.kind)}</span>
        <span className="git-navigator-file-copy">
          <span className="git-navigator-file-name">{name}</span>
          {searchResult && parent && <span className="git-navigator-file-parent">{parent}</span>}
        </span>
      </button>
    );
  }

  function renderFolder(folder: NavigatorFolder, depth: number): ReactNode[] {
    const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...folder.files].sort((a, b) => a.path.localeCompare(b.path));
    return [
      ...folders.flatMap((child) => {
        const open = !closedFolders.has(child.path);
        return [
          <button
            key={`folder:${child.path}`}
            type="button"
            className="git-navigator-folder"
            style={{ paddingLeft: `${0.5 + depth * 0.8}rem` }}
            aria-expanded={open}
            onClick={() => toggleFolder(child.path)}
          >
            <Chevron className={open ? "git-navigator-chevron-open" : ""} />
            <span>{child.name}</span>
          </button>,
          ...(open ? renderFolder(child, depth + 1) : []),
        ];
      }),
      ...files.map((entry) => renderFile(entry, depth)),
    ];
  }

  return (
    <aside className="git-file-navigator" aria-label="Changed files">
      <label className="git-navigator-search">
        <Search />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files…" aria-label="Filter changed files" />
      </label>
      <div className="git-navigator-tree">
        {entries.length === 0 ? (
          <div className="git-navigator-empty">No matching files.</div>
        ) : showSearchResults ? (
          <div className="git-navigator-search-results">{entries.map((entry) => renderFile(entry, 0, true))}</div>
        ) : (
          renderFolder(root, 0)
        )}
      </div>
    </aside>
  );
}

interface ChangesViewProps {
  status: WireGitStatus | null;
  turnRunning: boolean;
  dispatch(command: GitCommand, pending: GitPendingRequest): void;
  onDiff(path: string, target: GitDiffTarget): void;
}

function GitChangesView({ status, turnRunning, dispatch, onDiff }: ChangesViewProps) {
  const tabStore = useTabStoreApi();
  const [message, setMessage] = useState("");

  function handleStage(path: string): void {
    dispatch({ op: "stage", paths: [path] }, { kind: "mutation", label: "stage" });
  }
  function handleUnstage(path: string): void {
    dispatch({ op: "unstage", paths: [path] }, { kind: "mutation", label: "unstage" });
  }
  function handleDiscardOne(path: string): void {
    tabStore.getState().gitStageConfirm({ op: "discard", paths: [path] });
  }
  function handleUnstageAll(): void {
    const request = buildUnstageAllRequest(status);
    if (request) {
      dispatch(request.command, request.pending);
    }
  }
  function handleDiscardAll(): void {
    const intent = discardAllIntent(status);
    if (intent) {
      tabStore.getState().gitStageConfirm(intent);
    }
  }
  function handleStageAll(): void {
    dispatch({ op: "stage_all" }, { kind: "mutation", label: "stage all" });
  }
  function handleCommit(): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    dispatch({ op: "commit", message: trimmed }, { kind: "mutation", label: "commit" });
    setMessage("");
  }
  function handleStashPush(stashMessage: string, includeUntracked: boolean): void {
    tabStore.getState().gitStageConfirm({
      op: "stash_push",
      ...(stashMessage.trim() ? { message: stashMessage.trim() } : {}),
      includeUntracked,
    });
  }
  function handleStashPop(): void {
    tabStore.getState().gitStageConfirm({ op: "stash_pop" });
  }
  function handleReset(mode: "mixed" | "hard"): void {
    tabStore.getState().gitStageConfirm({ op: "reset", mode });
  }

  const staged: GitFileChange[] = status?.staged ?? [];
  const unstaged: GitFileChange[] = status?.unstaged ?? [];
  const untracked: string[] = status?.untracked ?? [];

  return (
    <div className="git-changes-view">
      <div className="git-changes-section">
        <div className="git-changes-section-header">
          <span>Staged ({staged.length})</span>
          <button type="button" className="git-btn git-btn-link" onClick={handleUnstageAll} disabled={staged.length === 0}>
            Unstage all
          </button>
        </div>
        {staged.length === 0 ? (
          <div className="git-changes-empty">No staged changes.</div>
        ) : (
          staged.map((file) => (
            <GitFileRow
              key={file.path}
              path={file.path}
              badge={file.kind}
              onOpen={() => onDiff(file.path, "staged")}
              actions={[
                { label: "Diff", onClick: () => onDiff(file.path, "staged") },
                { label: "Unstage", onClick: () => handleUnstage(file.path) },
              ]}
            />
          ))
        )}
      </div>

      <div className="git-changes-section">
        <div className="git-changes-section-header">
          <span>Unstaged ({unstaged.length})</span>
          <button
            type="button"
            className="git-btn git-btn-link git-btn-destructive"
            onClick={handleDiscardAll}
            disabled={turnRunning || unstaged.length === 0}
          >
            Discard all
          </button>
        </div>
        {unstaged.length === 0 ? (
          <div className="git-changes-empty">No unstaged changes.</div>
        ) : (
          unstaged.map((file) => (
            <GitFileRow
              key={file.path}
              path={file.path}
              badge={file.kind}
              onOpen={() => onDiff(file.path, "worktree")}
              actions={[
                { label: "Diff", onClick: () => onDiff(file.path, "worktree") },
                { label: "Stage", onClick: () => handleStage(file.path) },
                { label: "Discard", onClick: () => handleDiscardOne(file.path), destructive: true, disabled: turnRunning },
              ]}
            />
          ))
        )}
      </div>

      <div className="git-changes-section">
        <div className="git-changes-section-header">
          <span>Untracked ({untracked.length})</span>
        </div>
        {untracked.length === 0 ? (
          <div className="git-changes-empty">No untracked files.</div>
        ) : (
          untracked.map((path) => (
            <GitFileRow key={path} path={path} actions={[{ label: "Stage", onClick: () => handleStage(path) }]} />
          ))
        )}
      </div>

      <div className="git-commit-form">
        <textarea
          className="git-commit-message"
          placeholder="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="git-commit-actions">
          <button type="button" className="git-btn" onClick={handleStageAll}>
            Stage all
          </button>
          <button type="button" className="git-btn git-btn-primary" onClick={handleCommit} disabled={message.trim().length === 0}>
            Commit
          </button>
        </div>
      </div>

      <GitStashResetControls turnRunning={turnRunning} onStashPush={handleStashPush} onStashPop={handleStashPop} onReset={handleReset} />
    </div>
  );
}

interface StashResetProps {
  turnRunning: boolean;
  onStashPush(message: string, includeUntracked: boolean): void;
  onStashPop(): void;
  onReset(mode: "mixed" | "hard"): void;
}

function GitStashResetControls({ turnRunning, onStashPush, onStashPop, onReset }: StashResetProps) {
  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);

  return (
    <div className="git-stash-controls">
      <input
        type="text"
        className="git-stash-message"
        placeholder="Stash message (optional)"
        value={stashMessage}
        onChange={(event) => setStashMessage(event.target.value)}
        disabled={turnRunning}
      />
      <label className="git-stash-untracked">
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(event) => setIncludeUntracked(event.target.checked)}
          disabled={turnRunning}
        />
        Include untracked
      </label>
      <div className="git-stash-actions">
        <button
          type="button"
          className="git-btn git-btn-destructive"
          disabled={turnRunning}
          onClick={() => {
            onStashPush(stashMessage, includeUntracked);
            setStashMessage("");
            setIncludeUntracked(false);
          }}
        >
          Stash
        </button>
        <button type="button" className="git-btn" disabled={turnRunning} onClick={onStashPop}>
          Pop
        </button>
        <button type="button" className="git-btn" disabled={turnRunning} onClick={() => onReset("mixed")}>
          Reset
        </button>
        <button type="button" className="git-btn git-btn-destructive" disabled={turnRunning} onClick={() => onReset("hard")}>
          Reset --hard
        </button>
      </div>
    </div>
  );
}

function GitHistoryView({ log }: { log: GitCommitInfo[] | null }) {
  if (log === null) {
    return <div className="git-changes-empty">Loading history…</div>;
  }
  if (log.length === 0) {
    return <div className="git-changes-empty">No commits yet.</div>;
  }
  return (
    <div className="git-history-view">
      {log.map((commit) => (
        <div className="git-history-row" key={commit.sha}>
          <span className="git-history-sha">{commit.sha.slice(0, 7)}</span>
          <span className="git-history-subject" title={commit.subject}>
            {commit.subject}
          </span>
          <span className="git-history-meta">
            {commit.authorName} · {new Date(commit.authorDate).toLocaleDateString()}
          </span>
        </div>
      ))}
    </div>
  );
}

interface BranchControlsProps {
  status: WireGitStatus | null;
  branches: GitBranchInfo[] | null;
  dispatch(command: GitCommand, pending: GitPendingRequest): void;
}

function GitBranchControls({ status, branches, dispatch }: BranchControlsProps) {
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  const selected = status?.head.branch ?? "";

  function handleSwitch(name: string): void {
    if (!name || name === selected) {
      return;
    }
    dispatch({ op: "switch_branch", name }, { kind: "mutation", label: "switch branch" });
  }

  function handleCreate(): void {
    const trimmed = newBranchName.trim();
    if (!trimmed) {
      return;
    }
    dispatch({ op: "create_branch", name: trimmed, switch: true }, { kind: "mutation", label: "create branch" });
    setNewBranchName("");
    setCreating(false);
  }

  return (
    <div className="git-branch-controls">
      <select
        className="git-branch-select"
        aria-label="Current branch"
        value={selected}
        onChange={(event) => handleSwitch(event.target.value)}
      >
        {selected === "" && (
          <option value="" disabled>
            {status?.head.detached ? "detached" : "no branch"}
          </option>
        )}
        {(branches ?? []).map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
          </option>
        ))}
      </select>
      {creating ? (
        <span className="git-branch-create-form">
          <input
            type="text"
            className="git-branch-create-input"
            placeholder="New branch name"
            value={newBranchName}
            autoFocus
            onChange={(event) => setNewBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleCreate();
              } else if (event.key === "Escape") {
                setCreating(false);
                setNewBranchName("");
              }
            }}
          />
          <button type="button" className="git-btn" onClick={handleCreate}>
            Create
          </button>
        </span>
      ) : (
        <button type="button" className="git-btn git-branch-new" aria-label="New branch" onClick={() => setCreating(true)}>
          <Plus />
        </button>
      )}
    </div>
  );
}

export function GitPanel() {
  const tabStore = useTabStoreApi();
  const send = useTabSend();

  const panelOpen = useTabStore((state) => state.git.panelOpen);
  const view = useTabStore((state) => state.git.view);
  const status = useTabStore((state) => state.git.status);
  const branches = useTabStore((state) => state.git.branches);
  const log = useTabStore((state) => state.git.log);
  const diff = useTabStore((state) => state.git.diff);
  const lastError = useTabStore((state) => state.git.lastError);
  const turnRunning = useTabStore((state) => state.turn.status === "running");

  const dispatch = useCallback(
    (command: GitCommand, pending: GitPendingRequest): void => {
      const requestId = crypto.randomUUID();
      tabStore.getState().gitRequestStarted(requestId, pending);
      send({ type: "git_command", requestId, command });
    },
    [tabStore, send],
  );

  const refresh = useCallback((): void => {
    dispatch({ op: "refresh" }, { kind: "refresh", label: "refresh" });
    dispatch({ op: "branches" }, { kind: "branches", label: "branches" });
  }, [dispatch]);

  // Opening the panel re-syncs status + the branch dropdown (residual R11:
  // status also freshens on turn-end/bind/mutations — this covers the
  // "manual open" trigger from that same list).
  useEffect(() => {
    if (panelOpen) {
      refresh();
    }
  }, [panelOpen, refresh]);

  // History is fetched lazily on first visit to that tab, not on every panel
  // open (design §2.6) — re-fires if a prior fetch never populated `log`
  // (failed request) and the tab is revisited.
  useEffect(() => {
    if (panelOpen && view === "history" && log === null) {
      dispatch({ op: "log" }, { kind: "log", label: "history" });
    }
  }, [panelOpen, view, log, dispatch]);

  if (!panelOpen) {
    return null;
  }

  function handleDiff(path: string, target: GitDiffTarget): void {
    const request = buildDiffRequest(path, target);
    dispatch(request.command, request.pending);
    tabStore.getState().gitSetView("diff");
  }

  return (
    <aside className="git-panel" aria-label="Review changes">
      <div className="git-panel-header">
        <span className="git-panel-title">Review</span>
        <GitBranchControls status={status} branches={branches} dispatch={dispatch} />
        <button type="button" className="git-btn git-panel-refresh" onClick={refresh}>
          Refresh
        </button>
        <button
          type="button"
          className="git-panel-close"
          aria-label="Close git panel"
          onClick={() => tabStore.getState().gitSetPanelOpen(false)}
        >
          <X />
        </button>
      </div>

      <div className="git-panel-tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`git-panel-tab${view === v ? " git-panel-tab-active" : ""}`}
            onClick={() => tabStore.getState().gitSetView(v)}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {status?.filesTruncated && (
        <div className="git-panel-note">File list truncated — showing a capped number of files per section.</div>
      )}
      {lastError && (
        <div className="git-panel-error" role="alert">
          {lastError.label}: {lastError.reason}
        </div>
      )}

      <div className={`git-panel-body${view === "diff" ? " git-panel-body-diff" : ""}`}>
        {view === "changes" && (
          <GitChangesView status={status} turnRunning={turnRunning} dispatch={dispatch} onDiff={handleDiff} />
        )}
        {view === "history" && <GitHistoryView log={log} />}
        {view === "diff" && (
          <div className="git-review-diff">
            <div className="git-panel-diff">
              {diff ? <GitDiffPane diff={diff} /> : <div className="git-diff-empty">Select a file to view its diff.</div>}
            </div>
            <GitFileNavigator
              status={status}
              selectedPath={diff?.path ?? null}
              onSelect={(entry) => {
                if (entry.target) handleDiff(entry.path, entry.target);
              }}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

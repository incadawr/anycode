/**
 * Sidebar (design ui-redesign-direction.md §2.1/§2.3) — the single
 * session-switching surface that replaces the old horizontal TabBar +
 * NewTabMenu + SessionPicker dialog. It is built entirely from data the shell
 * already owns: open tabs come from the tabs-store (passed as props by App),
 * resumable sessions come from `window.anycode.listSessions()` (fetched here
 * via `useSessionIndex`). No store/wire/bridge shape changes — renderer-only.
 *
 * The two exported pure functions (`buildSidebarGroups`, `formatAge`) carry the
 * grouping / dedupe / ordering / label logic and are unit-tested directly
 * (Sidebar.test.ts), same discipline as SessionPicker's helpers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SessionSummary } from "../../../shared/tabs.js";
import type { TabInfo } from "../tabs-store.js";
import { useTabsStore } from "../tabs-store.js";
import { useSettingsStore } from "../settings-store.js";
import { fuzzyMatch, type MatchRange } from "../fuzzy.js";
import { rowStatusKind, useTabStatusStore, type RowStatusKind } from "../tab-status-store.js";
import { nextRovingIndex } from "./ModeMenu.js";
import { handleCreateTabResult, resolveConnectionMissingAction } from "./SessionPicker.js";
import { highlight } from "./highlight.js";
import { ArrowUp, Chevron, Collapse, Dot, Ellipsis, Folder, Gear, Plus, Search, Spinner, X } from "./icons.js";

/** Label fallback when a tab/session has no title (design §2.3). */
const UNTITLED = "Untitled task";

/**
 * R9 focus seam (slice-R9-cut ruling 1): the window event App's ⌘F runner and
 * palette row broadcast. Exactly one Sidebar is ever mounted (App renders one),
 * so the broadcast has exactly one listener — the ModeMenu
 * FOCUS_MODE_MENU_EVENT precedent, verbatim.
 */
export const SIDEBAR_SEARCH_EVENT = "anycode:focus-sidebar-search";

/** localStorage key for the collapsed-workspace-group set (R9). JSON string[] of raw workspace paths. */
const GROUP_COLLAPSE_KEY = "anycode.sidebar.collapsedGroups";

/** Collapsed-set read: missing/corrupt/non-array values fail-soft to empty (App's collapsed-flag idiom). */
function readCollapsedGroups(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSE_KEY);
    if (raw === null) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * R10 accessible-name suffix per row status: the indicator glyphs are
 * aria-hidden (icons.tsx discipline), so the row button's aria-label carries
 * the semantics — "{title}, {label}". Absent status → no aria-label → the
 * accessible name falls back to the button's content (title), as today.
 */
const ROW_STATUS_LABEL: Record<RowStatusKind, string> = {
  "host-exited": "task ended",
  permission: "needs approval",
  running: "running",
  attention: "new results",
};

/**
 * R10: the ONE status indicator an open row shows (precedence ruled in
 * rowStatusKind, tab-status-store.ts). Bare glyphs only — no wrapper element,
 * no `.sidebar-row` class anywhere near this (R9 arrow-nav queries
 * `.sidebar-row` buttons; adding that class here would poison it). The
 * host-exited branch renders byte-identical markup to the pre-R10 slot
 * (`<Dot className="sidebar-row-dot" />`) so the existing danger-dot
 * sign-off carries over unchanged.
 */
function RowStatusIndicator({ kind }: { kind: RowStatusKind | null }) {
  if (kind === null) {
    return null;
  }
  if (kind === "running") {
    return <Spinner className="sidebar-row-spinner icon-spin" />;
  }
  if (kind === "permission") {
    return <Dot className="sidebar-row-dot sidebar-row-dot-permission" />;
  }
  if (kind === "attention") {
    return <Dot className="sidebar-row-dot sidebar-row-dot-attention" />;
  }
  return <Dot className="sidebar-row-dot" />;
}

/** Basename of a workspace path (label), tolerant of trailing slashes and both separators — same rule as the old TabBar. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

export interface SidebarRow {
  kind: "open" | "resumable";
  /** tabId for open rows, sessionId for resumable rows — React key + interaction target. */
  key: string;
  title: string;
  /** Compact age ("22h") for resumable rows; `null` on open rows (liveness ≻ age). */
  age: string | null;
  /** Open rows only — drives the danger dot. */
  hostExited?: boolean;
  tabId?: string;
  sessionId?: string;
  /** Persistent non-color worktree state; full identity is exposed by tooltip. */
  worktree?: { id: string; branch: string; path: string };
}

export interface SidebarGroup {
  workspace: string;
  /** basename(workspace) — full path lives in the heading's `title=` tooltip. */
  label: string;
  rows: SidebarRow[];
}

/**
 * Compact relative-age label (design §2.3: "3m"/"22h"/"4d") — drops the
 * "ago"/"from now" suffix for the space-constrained sidebar.
 * `now` is injectable for deterministic tests.
 */
export function formatAge(epochMs: number, now: number = Date.now()): string {
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const abs = Math.abs(now - epochMs);

  if (abs < minuteMs) {
    return "now";
  }
  if (abs < hourMs) {
    return `${Math.max(1, Math.round(abs / minuteMs))}m`;
  }
  if (abs < dayMs) {
    return `${Math.round(abs / hourMs)}h`;
  }
  return `${Math.round(abs / dayMs)}d`;
}

/**
 * Assembles the sidebar's grouped rows from open tabs + persisted sessions
 * (design §2.3):
 *  - group by raw `workspace` (label = basename); group order = first-seen
 *    across tabs then sessions, so the most-recently-active / open workspaces
 *    float up (first-seen ordering);
 *  - within a group, open tab rows first (tabs-store order), then resumable
 *    session rows (input is already `ORDER BY updated_at DESC`);
 *  - a session already bound to a live tab (`openInTabId` matches an open
 *    tabId) dedupes into that tab's row instead of appearing twice;
 *  - `sessions === null` = still loading → open tabs still render, no resumable
 *    rows (fail-soft).
 */
export function buildSidebarGroups(
  tabs: readonly TabInfo[],
  sessions: readonly SessionSummary[] | null,
  now?: number,
): SidebarGroup[] {
  const liveTabIds = new Set(tabs.map((t) => t.tabId));

  // First-seen workspace order: tabs first (open workspaces float up), then sessions.
  const order: string[] = [];
  const seen = new Set<string>();
  const remember = (workspace: string): void => {
    if (!seen.has(workspace)) {
      seen.add(workspace);
      order.push(workspace);
    }
  };
  for (const tab of tabs) {
    remember(tab.projectRoot ?? tab.workspace);
  }
  for (const session of sessions ?? []) {
    remember(session.projectRoot ?? session.workspace);
  }

  const groups: SidebarGroup[] = [];
  for (const workspace of order) {
    const openRows: SidebarRow[] = tabs
      .filter((t) => (t.projectRoot ?? t.workspace) === workspace)
      .map((t) => ({
        kind: "open" as const,
        key: t.tabId,
        title: t.title ?? UNTITLED,
        age: null,
        hostExited: t.hostExited,
        tabId: t.tabId,
        ...(t.worktree !== undefined ? { worktree: t.worktree } : {}),
      }));

    const resumableRows: SidebarRow[] = (sessions ?? [])
      .filter(
        (s) =>
          (s.projectRoot ?? s.workspace) === workspace &&
          // Dedupe: a session already open in a live tab is represented by that tab's open row.
          !(s.openInTabId !== undefined && liveTabIds.has(s.openInTabId)),
      )
      .map((s) => ({
        kind: "resumable" as const,
        key: s.id,
        title: s.title ?? UNTITLED,
        age: formatAge(s.updatedAt, now),
        sessionId: s.id,
        ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
      }));

    const rows = [...openRows, ...resumableRows];
    if (rows.length > 0) {
      groups.push({ workspace, label: basename(workspace), rows });
    }
  }

  return groups;
}

export interface FilteredSidebarRow {
  row: SidebarRow;
  /** Title match ranges for <mark> highlighting; [] = no title highlight. */
  ranges: readonly MatchRange[];
}

export interface FilteredSidebarGroup {
  workspace: string;
  label: string;
  /** Workspace-label match ranges; [] = no label highlight. */
  labelRanges: readonly MatchRange[];
  rows: readonly FilteredSidebarRow[];
}

/**
 * Inline sidebar filter (ui-roadmap §4-R9) — structure-preserving, in
 * deliberate contrast to the palette's buildSessionRows, which re-ranks flat.
 * Groups and rows keep buildSidebarGroups order (open-first, then
 * resumable-by-recency); fuzzy scores are computed and IGNORED — the sidebar
 * filter hides non-matches, it never reorders.
 *
 * Semantics ("fuzzy match over title+workspace", roadmap):
 *  - empty query → every group/row passes through, all ranges empty;
 *  - a row is kept when fuzzyMatch(query, row.title) hits (ranges attached);
 *  - a group whose LABEL matches keeps ALL its rows — the query names the
 *    workspace, so its sessions are the result set; non-title-matching rows
 *    carry empty ranges (highlight sits on the label);
 *  - a group with no label match and zero kept rows is dropped.
 * The label is the displayed basename (palette parity) — full paths are not
 * matched (highlighting invisible path segments is impossible). The query is
 * used verbatim (no trim); the component treats `query !== ""` as
 * filter-active.
 */
export function filterSidebarGroups(groups: readonly SidebarGroup[], query: string): FilteredSidebarGroup[] {
  if (query.length === 0) {
    return groups.map((g) => ({
      workspace: g.workspace,
      label: g.label,
      labelRanges: [],
      rows: g.rows.map((row) => ({ row, ranges: [] })),
    }));
  }
  const out: FilteredSidebarGroup[] = [];
  for (const group of groups) {
    const labelMatch = fuzzyMatch(query, group.label);
    const rows: FilteredSidebarRow[] = [];
    for (const row of group.rows) {
      const titleMatch = fuzzyMatch(query, row.title);
      if (titleMatch) {
        rows.push({ row, ranges: titleMatch.ranges });
      } else if (labelMatch) {
        rows.push({ row, ranges: [] });
      }
    }
    if (rows.length > 0) {
      out.push({
        workspace: group.workspace,
        label: group.label,
        labelRanges: labelMatch?.ranges ?? [],
        rows,
      });
    }
  }
  return out;
}

/**
 * Drops user-hidden projects from the sidebar groups (design slice-GUI-P1 §2F.2).
 * A group is removed iff its `workspace` is in `hidden` AND it has zero
 * `kind:"open"` rows — a project with a live session always stays visible, even
 * if its workspace momentarily lingers in the hidden set (belt-and-suspenders

 * the Sidebar component, between `buildSidebarGroups` and `filterSidebarGroups`,
 * so the palette (which builds its own groups) keeps listing hidden projects =

 */
export function applyHiddenProjects(groups: readonly SidebarGroup[], hidden: readonly string[]): SidebarGroup[] {
  if (hidden.length === 0) {
    return groups.slice();
  }
  const hiddenSet = new Set(hidden);
  return groups.filter((group) => !(hiddenSet.has(group.workspace) && !group.rows.some((row) => row.kind === "open")));
}

/**
 * Clamps a fixed-position popover's `left` so it never overflows either viewport

 * right edge by `menuWidth + margin`, and never sits closer to the left edge than
 * `margin`. Pure — exported for unit testing.
 */
export function clampMenuLeft(triggerLeft: number, menuWidth: number, viewportWidth: number, margin = 8): number {
  const maxLeft = viewportWidth - menuWidth - margin;
  return Math.max(margin, Math.min(triggerLeft, maxLeft));
}

/** The project menu's two items (New session / Remove) — the roving-focus modulus. */
const PROJECT_MENU_ITEM_COUNT = 2;

/** Nominal project-menu width (px) used only for right-edge clamping before the popover measures itself. */
const PROJECT_MENU_WIDTH = 224;

/**
 * Fetches the persisted-session index for the sidebar (design §2.3):
 * `window.anycode.listSessions()` on mount, on window focus, and whenever the
 * `tabs` array identity changes (the simplest re-fetch trigger — App replaces
 * the tabs array on every create/close, so this covers post-`onTabCreated`/
 * `onCloseTab` refreshes). Fail-soft: a rejected list surfaces `error = true`
 * and leaves `sessions` null so open tabs still render.
 */
function useSessionIndex(tabs: readonly TabInfo[]): { sessions: SessionSummary[] | null; error: boolean } {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);
  // Monotonic request id: focus + tabs-change refetches can overlap, and
  // `listSessions()` gives no ordering guarantee — apply only the latest call's
  // result so a slow earlier response can't clobber fresher data.
  const latestReq = useRef(0);

  const refetch = useCallback(async () => {
    const reqId = ++latestReq.current;
    try {
      const list = await window.anycode.listSessions();
      if (reqId !== latestReq.current) return;
      setSessions(list);
      setError(false);
    } catch {
      if (reqId !== latestReq.current) return;
      setSessions(null);
      setError(true);
    }
  }, []);

  // Mount + tabs-identity change. The tabs-store replaces the array on ANY tab
  // mutation (create/close, but also title/sessionId/host-exit/terminal flips),
  // so this refetches a bit more than strictly needed — harmless (result only
  // feeds Sidebar-local state, never back into `tabs`, so no loop).
  useEffect(() => {
    void refetch();
  }, [tabs, refetch]);

  // Re-fetch when the window regains focus — sessions may have changed elsewhere.
  useEffect(() => {
    function onFocus(): void {
      void refetch();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return { sessions, error };
}

export interface SidebarProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSelectTab(tabId: string): void;
  onCloseTab(tabId: string): void;
  onTabCreated(r: { tabId: string; workspace: string; title?: string }): void;
  onFocusTab(tabId: string): void;
  onOpenSettings(): void;
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function Sidebar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onTabCreated,
  onFocusTab,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const { sessions, error } = useSessionIndex(tabs);
  // R10: one subscription to the whole mirror map. Its identity changes ONLY
  // on a real coarse flip (applyCoarse's storm guard), so this re-renders the
  // Sidebar at human cadence — never per transcript delta.
  const statuses = useTabStatusStore((state) => state.statuses);
  const [notice, setNotice] = useState<string | null>(null);
  // W10-FIX F1: a `connection_missing` resume becomes actionable — when set, the
  // notice toast offers a "Resume on the current connection" button that re-invokes
  // resume with this replacement id (an explicit user choice, never an auto-switch).
  const [noticeAction, setNoticeAction] = useState<{ sessionId: string; replacementConnectionId: string } | null>(null);
  // The current default connection to re-pin onto (F1). Undefined = none configured
  // (fresh install / env-override) — the notice then points to Settings, no button.
  const activeConnectionId = useSettingsStore((state) => state.snapshot?.settings.provider.activeConnectionId);
  // R9 filter state. `query !== ""` = filter active: groups force-expand,
  // chevrons hide, zero-match empty state arms Enter-to-create.
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(readCollapsedGroups);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Hidden-project set lives in the tabs-store (two consumers: this Sidebar +
  // the automation snapshot) — subscribe directly since App.tsx is locked (L5).
  const hiddenWorkspaces = useTabsStore((state) => state.hiddenWorkspaces);
  // Project `…` menu (design slice-GUI-P1 §2F.2): a single fixed-position popover
  // — exactly one open at a time — anchored to the trigger it was summoned from.
  const [menuFor, setMenuFor] = useState<{ workspace: string; top: number; left: number } | null>(null);
  const [menuFocusIndex, setMenuFocusIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Design §2.3: the × close affordance matches main's last-tab refusal — a
  // window with zero hosts is a state we don't introduce.
  const canClose = tabs.length > 1;

  /** Slice P7.12 (§4.6): opens the start-screen draft instead of firing the folder dialog directly. */
  const createNewSession = useCallback(() => {
    useTabsStore.getState().openDraft();
  }, []);

  /**
   * Resume a persisted session (design §2.3). Always routes through
   * `createTab({kind:"resume"})` + the shared `handleCreateTabResult`
   * (already_open → onFocusTab with main's authoritative focus target,
   * failures → notice). A rendered resumable row is only ever one whose
   * `openInTabId` is unset or points at a NON-live tab (`buildSidebarGroups`
   * dedupes any session bound to a live tab into that tab's own row), so a
   * client-side `openInTabId` shortcut here would only ever fire for a stale
   * bind — where focusing the dead tabId is a no-op that also swallows the
   * real resume; hence it is intentionally omitted. The resumed session's own
   * `title` (possibly undefined) is forwarded so the tab row keeps its label —
   * NOT the "Untitled task" display fallback.
   */
  const resumeSession = useCallback(
    async (sessionId: string, replacementConnectionId?: string) => {
      const session = sessions?.find((s) => s.id === sessionId);
      if (!session) {
        return;
      }
      try {
        const result = await window.anycode.createTab({
          kind: "resume",
          sessionId: session.id,
          // W10-FIX F1: explicit re-pin target (only ever set by the notice button).
          ...(replacementConnectionId !== undefined ? { replacementConnectionId } : {}),
        });
        const message = handleCreateTabResult(result, { onTabCreated, onFocusTab }, { title: session.title });
        setNotice(message);
        // W10-FIX F1: arm the re-pin button ONLY for connection_missing AND when a
        // current connection exists to re-pin onto; null on every other outcome.
        setNoticeAction(resolveConnectionMissingAction(result, session.id, activeConnectionId));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Failed to resume task.");
        setNoticeAction(null);
      }
    },
    [sessions, onTabCreated, onFocusTab, activeConnectionId],
  );

  const closeProjectMenu = useCallback((returnFocus: boolean) => {
    setMenuFor(null);
    if (returnFocus) {
      menuTriggerRef.current?.focus();
    }
  }, []);

  const openProjectMenu = useCallback((workspace: string, trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    menuTriggerRef.current = trigger;
    setMenuFocusIndex(0);
    setMenuFor({
      workspace,
      top: rect.bottom + 4,
      left: clampMenuLeft(rect.left, PROJECT_MENU_WIDTH, window.innerWidth),
    });
  }, []);

  const toggleProjectMenu = useCallback(
    (workspace: string, trigger: HTMLButtonElement) => {
      if (menuFor?.workspace === workspace) {
        closeProjectMenu(false);
      } else {
        openProjectMenu(workspace, trigger);
      }
    },
    [menuFor, closeProjectMenu, openProjectMenu],
  );

  /** Menu item 1 — `createNewSession` verbatim (design §2F.2) plus the group's workspace. */
  const createSessionInProject = useCallback(
    async (workspace: string) => {
      try {
        const result = await window.anycode.createTab({ kind: "new", workspace });
        const message = handleCreateTabResult(result, { onTabCreated, onFocusTab });
        if (message) {
          setNotice(message);
          setNoticeAction(null); // a fresh notice supersedes any armed re-pin action
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Failed to create a new task.");
        setNoticeAction(null);
      }
    },
    [onTabCreated, onFocusTab],
  );

  /* */
  const removeProjectFromList = useCallback((workspace: string) => {
    if (!useTabsStore.getState().hideWorkspace(workspace)) {
      setNotice("Close this project's open tasks first");
      setNoticeAction(null);
    }
  }, []);


  // trigger is excluded so its own click stays a toggle), any scroll of the
  // sidebar list (capture phase — fixed coords go stale), and window resize.
  useEffect(() => {
    if (!menuFor) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      const node = event.target as Node;
      if (menuRef.current?.contains(node) || menuTriggerRef.current?.contains(node)) {
        return;
      }
      setMenuFor(null);
    }
    function onDismiss(): void {
      setMenuFor(null);
    }
    const scrollEl = scrollRef.current;
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onDismiss);
    scrollEl?.addEventListener("scroll", onDismiss, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onDismiss);
      scrollEl?.removeEventListener("scroll", onDismiss, { capture: true });
    };
  }, [menuFor]);

  // Roving focus: move DOM focus to the active item whenever it changes while open.
  useEffect(() => {
    if (menuFor) {
      menuItemRefs.current[menuFocusIndex]?.focus();
    }
  }, [menuFor, menuFocusIndex]);

  // Persist the collapsed-group set (App's SIDEBAR_COLLAPSED_KEY effect idiom;
  // the mount-time write-back of what was just read is harmless).
  useEffect(() => {
    try {
      localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      /* ignore — won't survive a reload, not worth surfacing */
    }
  }, [collapsedGroups]);

  // R9 focus seam: ⌘F (App runner) and the palette's "Filter sessions…" row
  // land here. select() so a repeated ⌘F lets typing replace the old query —
  // the find-field convention.
  useEffect(() => {
    function onSearchRequest(): void {
      const el = searchRef.current;
      if (!el) {
        return;
      }
      el.focus();
      el.select();
    }
    window.addEventListener(SIDEBAR_SEARCH_EVENT, onSearchRequest);
    return () => window.removeEventListener(SIDEBAR_SEARCH_EVENT, onSearchRequest);
  }, []);

  const toggleGroupCollapsed = useCallback((workspace: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  }, []);

  // Compose the hidden-project filter BETWEEN grouping and the search filter

  const visibleGroups = applyHiddenProjects(buildSidebarGroups(tabs, sessions), hiddenWorkspaces);
  const filtering = query !== "";
  const filtered = filterSidebarGroups(visibleGroups, query);
  // "Remove project" is disabled while the open menu's project still has a live
  // tab — the same condition hideWorkspace enforces (§2F.2).
  const menuHasOpenRow = menuFor !== null && tabs.some((t) => t.workspace === menuFor.workspace);

  /** Rendered row buttons in DOM order — collapsed-group and filtered-out rows are unmounted, so this IS the visible list. */
  function visibleRows(): HTMLButtonElement[] {
    return Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>(".sidebar-row") ?? []);
  }

  function focusSearchInput(): void {
    const el = searchRef.current;
    if (!el) {
      return;
    }
    el.focus();
    // Caret to the end — returning from the list resumes typing, not replacing.
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // IME commits fire Enter/Escape with isComposing — let the composition own
    // them (CommandPalette/App keydown discipline).
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      visibleRows()[0]?.focus();
      return;
    }
    if (event.key === "Escape") {
      // BOTH branches preventDefault: App's window-level Esc interrupts the
      // running turn unless defaultPrevented — a search-field Esc must never
      // cancel a turn (slice-R9-cut ruling 5).
      event.preventDefault();
      if (query !== "") {
        setQuery("");
      } else {
        event.currentTarget.blur();
      }
      return;
    }
    if (event.key === "Enter" && filtering && filtered.length === 0) {
      // The empty state's "⏎ to start one" — armed ONLY while that state is
      // visible; Enter with matches is a deliberate no-op (ruling 6).
      event.preventDefault();
      void createNewSession();
    }
  }

  function onProjectMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setMenuFocusIndex((i) => nextRovingIndex(i, 1, PROJECT_MENU_ITEM_COUNT));
        break;
      case "ArrowUp":
        event.preventDefault();
        setMenuFocusIndex((i) => nextRovingIndex(i, -1, PROJECT_MENU_ITEM_COUNT));
        break;
      case "Escape":
        // preventDefault: App's window-level Esc interrupts a running turn unless

        // cancel a turn. Focus returns to the trigger.
        event.preventDefault();
        closeProjectMenu(true);
        break;
      case "Tab":
        // Let focus leave naturally; just drop the popover (ModeMenu idiom).
        setMenuFor(null);
        break;
    }
    // Enter/Space fall through to the focused menuitem's native button click.
  }

  function onProjectMenuButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>, workspace: string): void {
    // ArrowDown/Up on the trigger opens the menu and drops focus into it
    // (ModeMenu chip idiom).
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menuFor?.workspace !== workspace) {
        openProjectMenu(workspace, event.currentTarget);
      }
    }
  }

  function onScrollKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".sidebar-row") : null;
    if (!target) {
      return;
    }
    const rows = visibleRows();
    const index = rows.indexOf(target);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") {
      rows[index + 1]?.focus(); // clamp at the end — no wrap (ruling 4)
    } else if (index === 0) {
      focusSearchInput();
    } else {
      rows[index - 1]?.focus();
    }
  }

  return (
    <nav className={`sidebar${filtering ? " sidebar-filtering" : ""}`} aria-label="Tasks">
      <div className="sidebar-titlebar" aria-hidden="true" />
      <div className="sidebar-top">
        <button type="button" className="sidebar-new-session" onClick={() => void createNewSession()}>
          <Plus className="sidebar-new-session-icon" />
          <span className="sidebar-new-session-label">New Task</span>
          <ArrowUp className="sidebar-new-session-enter" />
        </button>
        <div className="sidebar-search">
          <Search className="sidebar-search-icon" />
          <input
            ref={searchRef}
            className="sidebar-search-input"
            type="text"
            placeholder="Filter tasks…"
            aria-label="Filter tasks"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {filtering && (
            <button
              type="button"
              className="sidebar-search-clear"
              aria-label="Clear filter"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X className="sidebar-search-clear-icon" />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll" ref={scrollRef} onKeyDown={onScrollKeyDown}>
        {error && (
          <div className="sidebar-error" role="status">
            Couldn&apos;t load saved tasks
          </div>
        )}
        {!error && !filtering && visibleGroups.length === 0 && (
          <div className="sidebar-empty">No tasks yet — start one above.</div>
        )}
        {filtering && filtered.length === 0 && (
          <div className="sidebar-empty sidebar-search-empty" role="status">
            No tasks match — ⏎ to start one
          </div>
        )}

        {filtered.map((group, groupIndex) => {
          const headingId = `sidebar-group-${groupIndex}`;
          // Active filter force-expands (matches must be visible); the
          // persisted set is untouched and reasserts when the filter clears.
          const expanded = filtering || !collapsedGroups.has(group.workspace);
          return (
            <section key={group.workspace} className="sidebar-group" aria-labelledby={headingId}>
              <h2 id={headingId} className="sidebar-group-label" title={group.workspace}>
                <button
                  type="button"
                  className="sidebar-group-toggle"
                  aria-expanded={expanded}
                  // R17 a11y: while filtering the toggle is a no-op and CSS-hidden
                  // (groups force-expand), so it must not remain a tab stop.
                  tabIndex={filtering ? -1 : undefined}
                  onClick={() => {
                    if (!filtering) {
                      toggleGroupCollapsed(group.workspace);
                    }
                  }}
                >
                  <Folder className="sidebar-group-icon" />
                  <span className="sidebar-group-name">{highlight(group.label, group.labelRanges)}</span>
                  <Chevron className="sidebar-group-chevron" />
                </button>
                <button
                  type="button"
                  className="sidebar-group-menu-button"
                  aria-haspopup="menu"
                  aria-expanded={menuFor?.workspace === group.workspace}
                  aria-label={`Project actions: ${group.label}`}
                  onClick={(event) => toggleProjectMenu(group.workspace, event.currentTarget)}
                  onKeyDown={(event) => onProjectMenuButtonKeyDown(event, group.workspace)}
                >
                  <Ellipsis />
                </button>
              </h2>

              {expanded &&
                group.rows.map(({ row, ranges }) => {
                  if (row.kind === "open") {
                    // R10: mirror read by tabId — survives filterSidebarGroups
                    // because open rows carry tabId through the wrapper.
                    const statusKind = rowStatusKind(statuses.get(row.tabId!), row.hostExited === true);
                    return (
                      <div key={row.key} className="sidebar-row-wrap">
                        <button
                          type="button"
                          className={`sidebar-row sidebar-row-open${row.hostExited ? " sidebar-row-host-exited" : ""}`}
                          aria-current={row.tabId === activeTabId ? "true" : undefined}
                          aria-label={statusKind !== null ? `${row.title}, ${ROW_STATUS_LABEL[statusKind]}` : undefined}
                          onClick={() => onSelectTab(row.tabId!)}
                        >
                          <span className="sidebar-row-title">{highlight(row.title, ranges)}</span>
                          {row.worktree && (
                            <span
                              className="sidebar-row-worktree"
                              title={`${row.worktree.branch}\n${row.worktree.path}`}
                              aria-label={`Worktree ${row.worktree.id}, branch ${row.worktree.branch}`}
                            >
                              WT · {row.worktree.id}
                            </span>
                          )}
                          <RowStatusIndicator kind={statusKind} />
                        </button>
                        <button
                          type="button"
                          className="sidebar-row-close"
                          aria-label={`Close ${row.title}`}
                          disabled={!canClose}
                          onClick={() => onCloseTab(row.tabId!)}
                        >
                          <X />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={row.key} className="sidebar-row-wrap">
                      <button
                        type="button"
                        className="sidebar-row sidebar-row-resumable"
                        onClick={() => void resumeSession(row.sessionId!)}
                      >
                        <span className="sidebar-row-title">{highlight(row.title, ranges)}</span>
                        {row.worktree && (
                          <span
                            className="sidebar-row-worktree"
                            title={`${row.worktree.branch}\n${row.worktree.path}`}
                            aria-label={`Worktree ${row.worktree.id}, branch ${row.worktree.branch}`}
                          >
                            WT · {row.worktree.id}
                          </span>
                        )}
                        {row.age && <span className="sidebar-row-age">{row.age}</span>}
                      </button>
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>

      <div className="sidebar-footer">
        {notice && (
          <div className="notice-toast sidebar-notice" role="status">
            <span className="notice-toast-text">{notice}</span>
            {noticeAction && (
              <button
                type="button"
                className="notice-toast-action"
                onClick={() => {
                  const action = noticeAction;
                  setNotice(null);
                  setNoticeAction(null);
                  void resumeSession(action.sessionId, action.replacementConnectionId);
                }}
              >
                Resume on the current connection
              </button>
            )}
            <button
              type="button"
              className="notice-toast-dismiss"
              aria-label="Dismiss notice"
              onClick={() => {
                setNotice(null);
                setNoticeAction(null);
              }}
            >
              <X />
            </button>
          </div>
        )}
        <button type="button" className="sidebar-settings" onClick={onOpenSettings}>
          <Gear className="sidebar-settings-icon" />
          <span>Settings</span>
        </button>
        <button
          type="button"
          className="sidebar-collapse"
          aria-label="Collapse sidebar"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <Collapse />
        </button>
      </div>

      {menuFor && (
        <div
          ref={menuRef}
          className="sidebar-project-menu"
          role="menu"
          aria-label={`Project actions: ${basename(menuFor.workspace)}`}
          style={{ top: menuFor.top, left: menuFor.left }}
          onKeyDown={onProjectMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            ref={(el) => {
              menuItemRefs.current[0] = el;
            }}
            tabIndex={menuFocusIndex === 0 ? 0 : -1}
            className="sidebar-project-menu-item"
            onClick={() => {
              const workspace = menuFor.workspace;
              closeProjectMenu(false);
              void createSessionInProject(workspace);
            }}
          >
            New task in this project
          </button>
          <button
            type="button"
            role="menuitem"
            ref={(el) => {
              menuItemRefs.current[1] = el;
            }}
            tabIndex={menuFocusIndex === 1 ? 0 : -1}
            className="sidebar-project-menu-item"
            disabled={menuHasOpenRow}
            title={menuHasOpenRow ? "Close this project's open tasks first" : undefined}
            onClick={() => {
              const workspace = menuFor.workspace;
              closeProjectMenu(false);
              removeProjectFromList(workspace);
            }}
          >
            Remove project from list
          </button>
        </div>
      )}
    </nav>
  );
}

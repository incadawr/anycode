/**
 * Root tab list + active-tab selection (design phase-2.md §2.4/§4.3). Deliberately
 * thin: one entry per open tab, keyed by tabId. Per-tab AGENT state (transcript,
 * turn, connection phase, permission, notice, ...) lives in its own DesktopStore
 * instance, one per tab, owned by tab-registry.ts — this store only tracks what
 * the shell needs to render the TabBar and pick which tab's store to mount
 * (TabContext.Provider around the active tab).
 *
 * Factory-plus-singleton, same shape as store.ts's `createDesktopStore`/
 * `useDesktopStore`: `createTabsStore` for test isolation, `useTabsStore` for
 * the app.
 */
import { create } from "zustand";
import type { PermissionMode } from "@anycode/core";

/** One open tab's shell-level metadata (design §4.3: "id, workspace, sessionId?, title?, host-exited flag"). */
export interface TabInfo {
  tabId: string;
  workspace: string;
  /** Bound once `host_ready.sessionId` lands for this tab (§3.3); null before the handshake completes. */
  sessionId: string | null;
  /**
   * Session title, if known. Unset in this slice: title derivation lives on
   * the host (design §4.2) and surfacing it to the tab list (e.g. via the
   * session-picker's `SessionSummary.title` on resume) is task 2.1.5's wiring —
   * `setTitle` is provided now so that wiring has somewhere to land.
   */
  title?: string;
  /**
   * Mirrors this tab's own store `connection === "host_exited"` for the
   * TabBar's banner dot. The full connection lifecycle (awaiting_port /
   * awaiting_host_ready / ready / host_exited) still lives on the tab's own
   * DesktopStore (design §2.4) — this is a cheap read for TabBar so it doesn't
   * need to subscribe to every background tab's full store just to render a dot.
   */
  hostExited: boolean;
  /**
   * Whether this tab's collapsible terminal panel is open (design
   * slice-2.4-cut.md §4/§7-U2). Per-tab, not global: switching to a tab that
   * never opened its terminal shows the panel closed even if another tab's is
   * open. Defaults closed — the PTY shell is spawned lazily on first open
   * (design §1), never eagerly for every tab.
   */
  terminalOpen: boolean;
  /** Whether this tab's read-only LSP status drawer is open. */
  lspPanelOpen: boolean;
  /** Whether this tab's read-only command-hooks drawer is open. */
  hooksPanelOpen: boolean;
  /** Whether this tab's checkpoint-timeline drawer is open (slice P7.26/R2). */
  timelinePanelOpen: boolean;
}

/** Renderer-only New Session draft (slice P7.12): lives beside tabs[], never in it. */
export interface SessionDraft {
  workspace: string | null;
  prompt: string;
  /** Task-scoped model pick (slice F5#1b, D3): `null` = provider default (not persisted as a setting). */
  model: string | null;
  /** Permission mode for the first turn. New sessions begin in the safe build mode. */
  mode: PermissionMode;
}

export interface TabsState {
  tabs: TabInfo[];
  activeTabId: string | null;
  /** At most one parked New Session draft (§4.1) — never a `TabInfo` row, so the automation snapshot stays byte-identical. */
  draft: SessionDraft | null;
  /** Invariant: `draftActive` implies `draft !== null`. Whether the start screen is the thing currently shown. */
  draftActive: boolean;

  /**
   * Registers a newly-seen tab. Idempotent: re-adding an already-known tabId
   * is a no-op (covers both the initial registration from `registerPort` and
   * a reconnect that happens to race it). The very first tab registered
   * becomes active automatically; later tabs don't steal focus.
   */
  addTab(tab: { tabId: string; workspace: string }): void;
  /** Removes a tab entirely. Assumes the caller (tab-registry's disposeTab) has already torn down its store/connection. */
  removeTab(tabId: string): void;
  /** No-op if `tabId` isn't a known tab (defensive — a stale click after the tab closed); activating a real tab also parks (not destroys) any live draft. */
  setActiveTab(tabId: string): void;
  /** Create-or-focus the New Session draft (§3-D7): an existing draft keeps its prompt/workspace; a given `workspace` overwrites either way. */
  openDraft(workspace?: string): void;
  /** No-op while `draft === null`. */
  setDraftWorkspace(workspace: string): void;
  /** No-op while `draft === null`. */
  setDraftPrompt(prompt: string): void;
  /** No-op while `draft === null`. `null` clears back to "provider default" (slice F5#1b, D3). */
  setDraftModel(model: string | null): void;
  /** No-op while `draft === null`. The selected mode is applied before the first message. */
  setDraftMode(mode: PermissionMode): void;
  /** Discards the draft entirely (Cancel affordance / successful submit). */
  discardDraft(): void;
  setSessionId(tabId: string, sessionId: string): void;
  setTitle(tabId: string, title: string): void;
  setHostExited(tabId: string, exited: boolean): void;
  /** Flips the tab's terminal-panel visibility flag (tab-registry.ts's `openTerminal` sets it true; the panel-close affordance sets it false directly — closing never has a connection side-effect). */
  setTerminalOpen(tabId: string, open: boolean): void;
  /** Opens/closes the tab's LSP status drawer. */
  setLspPanelOpen(tabId: string, open: boolean): void;
  /** Opens/closes the tab's command-hooks drawer. */
  setHooksPanelOpen(tabId: string, open: boolean): void;
  /** Opens/closes the tab's checkpoint-timeline drawer. */
  setTimelinePanelOpen(tabId: string, open: boolean): void;

  /**

   * `readonly string[]` (not a `Set`) so the automation snapshot round-trips as
   * JSON; initialized from injectable storage, fail-soft to `[]`.
   */
  hiddenWorkspaces: readonly string[];
  /**
   * Hides `workspace` from the sidebar. Returns `false` and leaves state
   * untouched while any open tab lives in that workspace (the project must be

   * fail-soft, and returns `true`.
   */
  hideWorkspace(workspace: string): boolean;
}

/**

 * `environment: "node"`, which has no `localStorage` global, so the persisted
 * hidden-workspace list must not reach for a global directly — the store takes an
 * injectable storage. In the app the default resolves to `localStorage`; tests
 * pass a fake (or accept the node default `null` = in-memory only).
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/* */
export const HIDDEN_WORKSPACES_KEY = "anycode.sidebar.hiddenWorkspaces";

/** The real backing store when a DOM `localStorage` exists, else `null` (node/test, or a locked-down context). */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    /* access to localStorage can throw in sandboxed contexts — treat as absent */
  }
  return null;
}

/* */
function readHiddenWorkspaces(storage: StorageLike | null): string[] {
  if (storage === null) {
    return [];
  }
  try {
    const raw = storage.getItem(HIDDEN_WORKSPACES_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/* */
function persistHiddenWorkspaces(storage: StorageLike | null, hidden: readonly string[]): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(HIDDEN_WORKSPACES_KEY, JSON.stringify(hidden));
  } catch {
    /* ignore — an unpersisted hide won't survive a reload, not worth surfacing */
  }
}

/**
 * Builds a tabs-store instance; the factory exists so tests get an isolated
 * store instead of sharing the singleton. `storage` is injectable so the hidden
 * set can persist through `localStorage` in the app while staying testable under

 * existing zero-arg `createTabsStore()` call source-compatible.
 */
export function createTabsStore(storage: StorageLike | null = defaultStorage()) {
  return create<TabsState>()((set, get) => ({
    tabs: [],
    activeTabId: null,
    draft: null,
    draftActive: false,
    hiddenWorkspaces: readHiddenWorkspaces(storage),

    addTab({ tabId, workspace }): void {
      if (get().tabs.some((t) => t.tabId === tabId)) {
        return;
      }
      set((state) => {

        // see the project — drop it from the hidden set and persist.
        const hiddenWorkspaces = state.hiddenWorkspaces.includes(workspace)
          ? state.hiddenWorkspaces.filter((w) => w !== workspace)
          : state.hiddenWorkspaces;
        if (hiddenWorkspaces !== state.hiddenWorkspaces) {
          persistHiddenWorkspaces(storage, hiddenWorkspaces);
        }
        return {
          tabs: [
            ...state.tabs,
            {
              tabId,
              workspace,
              sessionId: null,
              hostExited: false,
              terminalOpen: false,
              lspPanelOpen: false,
              hooksPanelOpen: false,
              timelinePanelOpen: false,
            },
          ],
          activeTabId: state.activeTabId ?? tabId,
          hiddenWorkspaces,
        };
      });
    },

    removeTab(tabId): void {
      set((state) => {
        const removedIndex = state.tabs.findIndex((t) => t.tabId === tabId);
        if (removedIndex === -1) {
          return state;
        }
        const tabs = state.tabs.filter((t) => t.tabId !== tabId);
        const activeTabId =
          state.activeTabId === tabId ? (tabs[Math.min(removedIndex, tabs.length - 1)]?.tabId ?? null) : state.activeTabId;
        return { tabs, activeTabId };
      });
    },

    setActiveTab(tabId): void {
      if (get().tabs.some((t) => t.tabId === tabId)) {
        set({ activeTabId: tabId, draftActive: false });
      }
    },

    openDraft(workspace): void {
      set((state) => ({
        draft: {
          workspace: workspace ?? state.draft?.workspace ?? null,
          prompt: state.draft?.prompt ?? "",
          model: state.draft?.model ?? null,
          mode: state.draft?.mode ?? "build",
        },
        draftActive: true,
      }));
    },

    setDraftWorkspace(workspace): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, workspace } }));
    },

    setDraftPrompt(prompt): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, prompt } }));
    },

    setDraftModel(model): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, model } }));
    },

    setDraftMode(mode): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, mode } }));
    },

    discardDraft(): void {
      set({ draft: null, draftActive: false });
    },

    setSessionId(tabId, sessionId): void {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, sessionId } : t)),
      }));
    },

    setTitle(tabId, title): void {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, title } : t)),
      }));
    },

    setHostExited(tabId, exited): void {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, hostExited: exited } : t)),
      }));
    },

    setTerminalOpen(tabId, open): void {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, terminalOpen: open } : t)),
      }));
    },

    setLspPanelOpen(tabId, open): void {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? { ...t, lspPanelOpen: open, ...(open ? { hooksPanelOpen: false, timelinePanelOpen: false } : {}) }
            : t,
        ),
      }));
    },

    setHooksPanelOpen(tabId, open): void {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? { ...t, hooksPanelOpen: open, ...(open ? { lspPanelOpen: false, timelinePanelOpen: false } : {}) }
            : t,
        ),
      }));
    },

    setTimelinePanelOpen(tabId, open): void {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? { ...t, timelinePanelOpen: open, ...(open ? { lspPanelOpen: false, hooksPanelOpen: false } : {}) }
            : t,
        ),
      }));
    },

    hideWorkspace(workspace): boolean {
      const { tabs, hiddenWorkspaces } = get();

      // with any open session can't be hidden.
      if (tabs.some((t) => t.workspace === workspace)) {
        return false;
      }
      // Idempotent: an already-hidden workspace advances no state but still
      // reports success.
      if (!hiddenWorkspaces.includes(workspace)) {
        const next = [...hiddenWorkspaces, workspace];
        set({ hiddenWorkspaces: next });
        persistHiddenWorkspaces(storage, next);
      }
      return true;
    },
  }));
}

export type TabsStoreApi = ReturnType<typeof createTabsStore>;

export const useTabsStore = createTabsStore();

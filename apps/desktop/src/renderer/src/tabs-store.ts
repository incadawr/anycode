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
import type { EngineId } from "../../shared/engines.js";
import type { WorktreeProjection } from "../../shared/protocol.js";
import type { QueuedPromptImage } from "./store.js";

/** One open tab's shell-level metadata (design §4.3: "id, workspace, sessionId?, title?, host-exited flag"). */
export interface TabInfo {
  tabId: string;
  workspace: string;
  /** Stable grouping identity; defaults to workspace for legacy sessions. */
  projectRoot?: string;
  /** Active worktree identity, restored by host_ready before the first turn. */
  worktree?: WorktreeProjection;
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
  /** Static engine selection for a new tab; Core remains the compatibility default. */
  engine: EngineId;
  /** Task-scoped model pick (slice F5#1b, D3): `null` = provider default (not persisted as a setting). */
  model: string | null;
  /** Permission mode for the first turn. New sessions begin in the safe build mode. */
  mode: PermissionMode;
  /**
   * Codex-only permission-preset pick for a new session's first turn (W3
   * join, TASK.39 wire-up). Absent until the user actually touches the
   * Codex draft's preset picker — mirrors `TabInfo.title`'s "unset in this
   * slice" convention rather than `model`'s always-present `null` sentinel,
   * since there is no analogous "explicit clear" affordance for a preset.
   * Never read for a Core draft.
   */
  enginePreset?: string;
  /**
   * Codex account-profile pick for a new session (codex-profiles cut §3.3,
   * W3-F) — an opaque id from main's profile registry. Absent until the user
   * touches the chip (mirrors `enginePreset`'s "unset in this slice"
   * convention): absent ⇒ the `system` pseudo-profile (today's ambient
   * CODEX_HOME, unchanged). Never read for a Core draft.
   */
  codexProfileId?: string;
  /**
   * Core-only provider-connection pin for a new session (TASK.106 cut-1
   * stage A): an opaque connection id from main's live registry, set when
   * the New Session model picker's chosen model belongs to a connection
   * other than the active one. Absent until the user picks a cross-connection
   * model (mirrors `codexProfileId`'s "unset in this slice" convention) ⇒
   * the session pins to `activeConnectionId()`, today's behavior. Never read
   * for a non-core draft; picking this never changes
   * `settings.provider.activeConnectionId` itself — it is a session-scoped
   * pin, not a default switch.
   */
  connectionId?: string;
  /**
   * Image attachments for the first turn (TASK.81, Composer.tsx parity —
   * `attachedImages`, projected through the SAME `QueuedPromptImage` shape a
   * queued prompt's images already use so `queueInitialPrompt`/
   * `dispatchInitialPrompt` in tab-registry.ts can forward them without a
   * third image type). Absent until the first successful attach/paste —
   * mirrors `enginePreset`'s "unset in this slice" convention rather than
   * `prompt`'s always-present-string one: an empty list and "never touched"
   * are observably the same "nothing to send" state, so there is no reason
   * to force the key present at `[]`. Once set it holds the CURRENT
   * attachment list (not a touch-history flag) — removing the last image
   * legitimately writes `[]` back.
   */
  images?: readonly QueuedPromptImage[];
  /**
   * Non-core engine reasoning-effort pick for the first turn (TASK.81,
   * Composer.tsx parity — `handleEngineEffortPick`/`EngineModelMenu`'s
   * `effort` prop). A free-form per-model string, never core's
   * `ReasoningEffort` enum (codex/claude advertise their own vocabulary —
   * shared/protocol.ts's `EngineModelChoice.efforts`), so this cannot reuse
   * `model`'s always-present `null` = "provider default" sentinel: there is
   * no draft-time catalog of per-model effort defaults to fall back to (main
   * never projects `reasoning`/`effortLevels` into the renderer's provider-
   * catalog summary — shared/settings.ts's `CatalogSummaryEntry` deliberately
   * strips them, "renderer never imports core"), and the CORE engine has no
   * draft-time effort data at all (its own `set_reasoning_effort` path needs
   * a live host-resolved `availableEffortLevels`, which does not exist before
   * a host boots). Absent until the user opens the draft's effort row and
   * picks one — mirrors `enginePreset`/`codexProfileId`'s "unset in this
   * slice" convention. Never read for a Core draft.
   */
  engineEffort?: string;
}

export interface TabsState {
  tabs: TabInfo[];
  activeTabId: string | null;
  /** At most one parked New Session draft (§4.1) — never a `TabInfo` row, so the automation snapshot stays byte-identical. */
  draft: SessionDraft | null;
  /** Invariant: `draftActive` implies `draft !== null`. Whether the start screen is the thing currently shown. */
  draftActive: boolean;
  /**
   * Engine ids main has confirmed spawnable right now (TASK.41, design/
   * slice-codex-fixes-cut.md §2(g)/§5.5). This store is a passive setter, not
   * a fetcher — the New Session UI still reads `listAvailableEngines()` on
   * its own mount; `setAvailableEngines` exists so any caller can push a
   * fresh main-confirmed list here after an event that could change it (the
   * Codex onboarding pane does, on the `anycode:engines-changed` push) WITHOUT
   * that caller needing to know anything about tab-creation UI. Defaults to
   * `["core"]` (Core never depends on external diagnosis) so a reader before
   * the first fetch still sees a safe, non-empty list.
   */
  availableEngines: readonly EngineId[];
  setAvailableEngines(engines: readonly EngineId[]): void;

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
  /** No-op while `draft === null`. Changing engines never mutates an open tab. */
  setDraftEngine(engine: EngineId): void;
  /** No-op while `draft === null`. `null` clears back to "provider default" (slice F5#1b, D3). */
  setDraftModel(model: string | null): void;
  /** No-op while `draft === null`. The selected mode is applied before the first message. */
  setDraftMode(mode: PermissionMode): void;
  /** No-op while `draft === null`. Codex-only; a Core draft never calls this. */
  setDraftEnginePreset(presetId: string): void;
  /**
   * No-op while `draft === null`. Codex-only; a Core draft never calls this.
   * `undefined` clears back to the `system` pseudo-profile (R3-2 facet i: the
   * options-refresh effect calls this when the picked profile disappeared
   * from a fresh catalog, mirroring `setDraftModel`'s `null`-clears
   * convention).
   */
  setDraftCodexProfileId(profileId: string | undefined): void;
  /**
   * No-op while `draft === null`. Core-only pin (mirrors
   * `setDraftCodexProfileId`, TASK.106 cut-1 stage A). `undefined` clears
   * back to the active-connection default.
   */
  setDraftConnectionId(connectionId: string | undefined): void;
  /**
   * No-op while `draft === null`. Full replace (mirrors `setDraftPrompt`) —
   * the caller (StartScreen's attach/paste/remove handlers) computes the
   * next attachment list and writes it whole, so this stays the single write
   * path an automation facade could also drive.
   */
  setDraftImages(images: readonly QueuedPromptImage[]): void;
  /**
   * No-op while `draft === null`. Non-core only; a Core draft never calls
   * this (mirrors `setDraftEnginePreset`). `undefined` clears the pick.
   */
  setDraftEngineEffort(effort: string | undefined): void;
  /** Discards the draft entirely (Cancel affordance / successful submit). */
  discardDraft(): void;
  setSessionId(tabId: string, sessionId: string): void;
  setWorkspaceIdentity(
    tabId: string,
    identity: { workspace: string; projectRoot?: string; worktree?: WorktreeProjection },
  ): void;
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
    availableEngines: ["core"],

    setAvailableEngines(engines): void {
      set({ availableEngines: engines });
    },

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
          engine: state.draft?.engine ?? "core",
          model: state.draft?.model ?? null,
          mode: state.draft?.mode ?? "build",
          ...(state.draft?.enginePreset !== undefined ? { enginePreset: state.draft.enginePreset } : {}),
          ...(state.draft?.codexProfileId !== undefined ? { codexProfileId: state.draft.codexProfileId } : {}),
          ...(state.draft?.connectionId !== undefined ? { connectionId: state.draft.connectionId } : {}),
          ...(state.draft?.images !== undefined ? { images: state.draft.images } : {}),
          ...(state.draft?.engineEffort !== undefined ? { engineEffort: state.draft.engineEffort } : {}),
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

    setDraftEngine(engine): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, engine } }));
    },

    setDraftModel(model): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, model } }));
    },

    setDraftMode(mode): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, mode } }));
    },

    setDraftEnginePreset(presetId): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, enginePreset: presetId } }));
    },

    setDraftCodexProfileId(profileId): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, codexProfileId: profileId } }));
    },

    setDraftConnectionId(connectionId): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, connectionId } }));
    },

    setDraftImages(images): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, images } }));
    },

    setDraftEngineEffort(effort): void {
      set((state) => (state.draft === null ? state : { draft: { ...state.draft, engineEffort: effort } }));
    },

    discardDraft(): void {
      set({ draft: null, draftActive: false });
    },

    setSessionId(tabId, sessionId): void {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, sessionId } : t)),
      }));
    },

    setWorkspaceIdentity(tabId, identity): void {
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.tabId !== tabId) return tab;
          const projectRoot = identity.projectRoot ?? identity.workspace;
          return {
            ...tab,
            workspace: identity.workspace,
            ...(projectRoot !== identity.workspace ? { projectRoot } : { projectRoot: undefined }),
            ...(identity.worktree !== undefined ? { worktree: identity.worktree } : { worktree: undefined }),
          };
        }),
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

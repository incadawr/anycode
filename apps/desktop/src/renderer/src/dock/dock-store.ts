/**
 * Dock state (Taskana 4703): the tabs, the active tab, the ONE persisted
 * width, and the hidden toggle. Zustand, tabs-store.ts factory-plus-
 * singleton precedent: `createDockStore` for test isolation, `useDockStore`
 * for the app. Tab algebra lives in dock-layout.ts (pure); this store only
 * wires it to state + persistence.
 *
 * `open`/`close`/`focus` operate on tab IDs with the dock-layout semantics
 * (open focuses; close picks the right/left neighbor only when the ACTIVE
 * tab was closed). `setWidth` persists to `localStorage` — callers pass the
 * storage so tests stay jsdom-free (App.test.ts header precedent).
 */
import { create } from "zustand";
import {
  DOCK_WIDTH_STORAGE_KEY,
  closeTab as closeTabAlgebra,
  openTab as openTabAlgebra,
  openTabInBackground as openTabInBackgroundAlgebra,
  readDockWidth,
  type DockStorage,
  type DockTab,
} from "./dock-layout.js";

/**
 * The pinned split tab is never the active (primary) tab: focusing it
 * unpins it (its content would otherwise render twice, and two publishers
 * would race the one main-side bounds channel — cross-review D1).
 */
function focusPatch(state: Pick<DockStoreState, "splitTabId">, activeTabId: string | null): { activeTabId: string | null; splitTabId: string | null } {
  return { activeTabId, splitTabId: state.splitTabId !== null && state.splitTabId === activeTabId ? null : state.splitTabId };
}

export interface DockStoreState {
  tabs: DockTab[];
  activeTabId: string | null;
  width: number;
  /** Toggle flag (⌘\) — NOT persisted: a fresh window shows the dock. */
  hidden: boolean;
  /**
   * Stage 2 (§3): the tab PINNED to the dock's secondary pane, else null.
   * NOT persisted — a boot never restores a split that the window may no
   * longer afford; `splitRight` itself refuses when !canSplit(available).
   */
  splitTabId: string | null;
  /**
   * Taskana 4738: the conversation tab that OWNS `tabs`/`activeTabId`/
   * `splitTabId` right now. The store is a singleton across conversation
   * tabs, so without an owner marker a tab switch would render the previous
   * tab's dock items for one frame (ActiveTabBody's derivation effects run
   * only after the first commit). `adopt` re-owns; render-time reads go
   * through `selectDockView(state, tabId)` which gates on this field.
   * `width`/`hidden` stay global (one persisted width, one hide toggle).
   */
  ownerTabId: string | null;
  /**
   * Taskana 4738: become the owner (ActiveTabBody's layout effect, BEFORE
   * its derivation effects and before paint). Same id → no-op (the same
   * state object, no re-render); new id → synchronously reset the owned
   * triple. Renderer state ONLY — the per-tab sources of truth
   * (previewPanel/childLayoutStore/git panel) are untouched and re-derive.
   */
  adopt(tabId: string): void;
  open(tab: DockTab): void;
  /** Appends a tab WITHOUT moving focus (cross-review D3). */
  openBackground(tab: DockTab): void;
  close(id: string): void;
  focus(id: string): void;
  setWidth(width: number): void;
  toggleHidden(): void;
  /** Pin `id` to the secondary pane (Stage 2). NO-OP unless `allowed`. */
  splitRight(id: string, allowed: boolean): void;
  /** Unpin the secondary pane (Stage 2). */
  mergeSplit(): void;
}

export type DockStoreApi = ReturnType<typeof createDockStore>;

const noopStorage: DockStorage = {
  getItem: () => null,
  setItem: () => {},
};

/** Builds a dock store; `storage` defaults to `window.localStorage` in the app and a no-op shim in tests. */
export function createDockStore(storage: DockStorage = typeof window === "undefined" ? noopStorage : window.localStorage) {
  return create<DockStoreState>()((set) => ({
    tabs: [],
    activeTabId: null,
    width: readDockWidth(storage),
    hidden: false,
    splitTabId: null,
    ownerTabId: null,

    adopt(tabId): void {
      set((state) =>
        state.ownerTabId === tabId
          ? state // same owner — no-op, same object, no re-render
          : { ownerTabId: tabId, tabs: [], activeTabId: null, splitTabId: null },
      );
    },

    open(tab): void {
      set((state) => {
        const next = openTabAlgebra(state.tabs, tab);
        return { tabs: next.tabs, ...focusPatch(state, next.activeTabId) };
      });
    },

    openBackground(tab): void {
      set((state) => openTabInBackgroundAlgebra(state.tabs, state.activeTabId, tab));
    },

    close(id): void {
      set((state) => {
        const { tabs, activeTabId } = closeTabAlgebra(state.tabs, state.activeTabId, id);
        // A closed tab can never stay pinned; neighbour focus may land on the pinned tab.
        const pinned = state.splitTabId === id ? null : state.splitTabId;
        return { tabs, activeTabId, splitTabId: pinned === activeTabId ? null : pinned };
      });
    },

    focus(id): void {
      set((state) => (state.tabs.some((tab) => tab.id === id) ? focusPatch(state, id) : state));
    },

    setWidth(width): void {
      try {
        storage.setItem(DOCK_WIDTH_STORAGE_KEY, String(width));
      } catch {
        // A read-only/private-mode storage must never break resizing.
      }
      set({ width });
    },

    toggleHidden(): void {
      set((state) => ({ hidden: !state.hidden }));
    },

    splitRight(id, allowed): void {
      set((state) =>
        allowed && state.tabs.some((tab) => tab.id === id) ? { splitTabId: id } : state,
      );
    },

    mergeSplit(): void {
      set({ splitTabId: null });
    },
  }));
}

export const useDockStore = createDockStore();

/**
 * Taskana 4738: the owner-gated view of the dock for one conversation tab.
 * Frozen module singleton for every NON-owner (zustand selectors must not
 * allocate per call — callers compare by reference); the live triple for the
 * owner. This is the ONLY render-time read path for `tabs`/`activeTabId`/
 * `splitTabId` in App.tsx/DockPanel.tsx, so a freshly switched tab renders
 * an empty dock even in the frame BEFORE its `adopt` layout effect runs.
 */
export const EMPTY_DOCK_VIEW: Readonly<{ tabs: readonly DockTab[]; activeTabId: string | null; splitTabId: string | null }> = Object.freeze({
  tabs: Object.freeze([] as readonly DockTab[]),
  activeTabId: null,
  splitTabId: null,
});

/** The owner-gated triple App.tsx/DockPanel.tsx render from (Taskana 4738). */
export function selectDockView(
  state: DockStoreState,
  tabId: string,
): { tabs: readonly DockTab[]; activeTabId: string | null; splitTabId: string | null } {
  return state.ownerTabId === tabId
    ? { tabs: state.tabs, activeTabId: state.activeTabId, splitTabId: state.splitTabId }
    : EMPTY_DOCK_VIEW;
}

/** `selectDockOpen`, owner-scoped (Taskana 4738): the mount gate per tab. */
export function selectDockOpenFor(state: DockStoreState, tabId: string): boolean {
  return selectDockView(state, tabId).tabs.length > 0 && !state.hidden;
}

/** Whether the dock region renders at all (App.tsx's mount gate). */
export function selectDockOpen(state: DockStoreState): boolean {
  return state.tabs.length > 0 && !state.hidden;
}

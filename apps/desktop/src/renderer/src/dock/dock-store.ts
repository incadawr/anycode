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
  readDockWidth,
  type DockStorage,
  type DockTab,
} from "./dock-layout.js";

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
  open(tab: DockTab): void;
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

    open(tab): void {
      set((state) => openTabAlgebra(state.tabs, tab));
    },

    close(id): void {
      set((state) => {
        const { tabs, activeTabId } = closeTabAlgebra(state.tabs, state.activeTabId, id);
        // A closed tab can never stay pinned to the secondary pane.
        return state.splitTabId === id ? { tabs, activeTabId, splitTabId: null } : { tabs, activeTabId };
      });
    },

    focus(id): void {
      set((state) => (state.tabs.some((tab) => tab.id === id) ? { activeTabId: id } : state));
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

/** Whether the dock region renders at all (App.tsx's mount gate). */
export function selectDockOpen(state: DockStoreState): boolean {
  return state.tabs.length > 0 && !state.hidden;
}

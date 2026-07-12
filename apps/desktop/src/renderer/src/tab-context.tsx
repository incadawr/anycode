/**
 * React context resolving the ACTIVE tab's store + sender without threading
 * props through every migrated component (design phase-2.md §2.4/§4.3).
 * App.tsx wraps only the active tab's subtree in a single
 * `<TabContext.Provider>` — background tabs are never mounted; their state
 * lives purely in their own store instance, kept alive by tab-registry.ts
 * independent of React, so switching tabs is a pure re-render, not a
 * reconnect.
 *
 * `useTabStore`/`useTabSend` are the migrated equivalents of the old
 * single-tab `useDesktopStore`/`sendToHost` — mechanically swapped into every
 * component that used to import those directly (Composer, StatusBar,
 * PermissionModal, NoticeToast).
 */
import { createContext, useCallback, useContext } from "react";
import { useStore } from "zustand";
import type { DesktopState } from "./store.js";
import type { DesktopStoreApi } from "./tab-registry.js";
import { tabRegistry } from "./tab-registry.js";
import type { UiToHostMessage } from "../../shared/protocol.js";

export interface TabContextValue {
  tabId: string;
  store: DesktopStoreApi;
}

export const TabContext = createContext<TabContextValue | null>(null);

function useTabContextValue(): TabContextValue {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useTabStore/useTabSend must be used within a <TabContext.Provider>");
  }
  return ctx;
}

/** Resolves `selector` against the ACTIVE tab's store — drop-in replacement for `useDesktopStore(selector)`. */
export function useTabStore<T>(selector: (state: DesktopState) => T): T {
  const { store } = useTabContextValue();
  return useStore(store, selector);
}

/**
 * The ACTIVE tab's raw store instance, for components that need to call an
 * action imperatively (e.g. outside a render, via `.getState().action(...)`)
 * rather than just read a selected value — drop-in replacement for the old
 * `useDesktopStore.getState()` singleton access pattern.
 */
export function useTabStoreApi(): DesktopStoreApi {
  return useTabContextValue().store;
}

/** Sends a message to the active tab's host connection — drop-in replacement for `sendToHost(message)`. */
export function useTabSend(): (message: UiToHostMessage) => void {
  const { tabId } = useTabContextValue();
  return useCallback((message: UiToHostMessage) => tabRegistry.sendToTab(tabId, message), [tabId]);
}

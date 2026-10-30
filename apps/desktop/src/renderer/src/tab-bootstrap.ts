import type { TabBootstrap } from "../../shared/tabs.js";
import type { TabRegistry } from "./tab-registry.js";
import type { TabsStoreApi } from "./tabs-store.js";

/** Restore the main-owned selection while allowing later user choices to win. */
export function startTabBootstrap(
  api: { tabBootstrap(): Promise<TabBootstrap>; selectTab(tabId: string): void },
  store: TabsStoreApi,
  registry: TabRegistry,
): () => void {
  let alive = true;
  let ready = false;
  const revision = store.getState().selectionRevision;
  const unsubscribe = store.subscribe((state, previous) => {
    if (ready && state.activeTabId && state.activeTabId !== previous.activeTabId) api.selectTab(state.activeTabId);
  });
  void api.tabBootstrap().then((snapshot) => {
    if (!alive) return;
    store.getState().applyBootstrap({ ...snapshot, tabs: snapshot.tabs.filter((tab) => !registry.isClosed(tab.tabId)) }, revision);
    ready = true;
    const active = store.getState().activeTabId;
    if (active) api.selectTab(active);
  }).catch((error: unknown) => console.warn("[App] tab bootstrap failed", error));
  return () => { alive = false; unsubscribe(); };
}

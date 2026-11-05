import { create } from "zustand";
import type { AccountSourceCandidateView, AccountSourcesSnapshot } from "../../shared/account-sources.js";
import { useSettingsStore } from "./settings-store.js";

interface State { snapshot: AccountSourcesSnapshot; candidates: AccountSourceCandidateView[]; load(): Promise<void> }
export const useAccountSourcesStore = create<State>((set) => ({
  snapshot: { revision: 0, sources: [] }, candidates: [],
  async load() {
    try { const value = await window.anycode.accountSources.get(); set(value); } catch { /* optional bridge */ }
  },
}));
let unsubscribe: (() => void) | undefined;
export function startAccountSourcesStore(): () => void {
  if (!unsubscribe && window.anycode.accountSources) {
    const a = window.anycode.accountSources.onChanged(() => { void useAccountSourcesStore.getState().load(); });
    const b = window.anycode.accountSources.onCatalogChanged(() => { void useSettingsStore.getState().load(); });
    unsubscribe = () => { a(); b(); };
    void useAccountSourcesStore.getState().load();
  }
  return () => { unsubscribe?.(); unsubscribe = undefined; };
}

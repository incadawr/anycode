/**
 * SPIKE (TASK.99 CUT.md GAP 1, M3 scope item 1): the md-preview WINDOW's root
 * component, spike form — mounted by main.tsx instead of `<App/>` when
 * `location.search` carries `?view=md-preview&tabId=...&previewId=...`.
 * Proves the second-BrowserWindow mechanism end to end (preload under a
 * second window, packaged `loadFile`+query, theme boot, full-bundle side
 * effects) with a STATIC PLACEHOLDER instead of the real
 * `MarkdownPreviewView` integration — CUT.md's own spike-first mandate: "M3
 * opens with a spike commit — bare window renders static text under
 * `?view=md-preview` in dev AND `package:dir` before any transfer wiring."
 * The full version (MarkdownPreviewView + mdPreview.read) lands in this
 * slice's main commit, once this spike is live-verified in both
 * environments.
 *
 * Theme boot mirrors App.tsx's own (investigated, not guessed —
 * App.tsx:628/636): one `useSettingsStore.getState().load()` on mount, then
 * `applyThemePreference` in an effect keyed on the resolved snapshot.
 * `index.html`'s pre-boot `data-theme="dark"` covers the flash-free default
 * for THIS window too (the same static HTML file is served to both
 * windows).
 *
 * `TabContext.Provider` is wired even at spike stage (CUT.md M3 scope item 1
 * names it explicitly) — `store` only needs to satisfy `TabContextValue`'s
 * shape; a disconnected `createDesktopStore()` instance (never fed a port,
 * never touched) is a correct, zero-behavior stub.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { useSettingsStore } from "../settings-store.js";
import { applyThemePreference } from "../theme.js";

export function MdPreviewWindowApp() {
  const [target] = useState(() => {
    const params = new URLSearchParams(location.search);
    const tabId = params.get("tabId") ?? "";
    const previewId = params.get("previewId") ?? "";
    return tabId !== "" && previewId !== "" ? { tabId, previewId } : null;
  });
  // Type-satisfying stub (module doc) — never fed a port, never subscribed to.
  const store = useMemo(() => createDesktopStore(), []);
  const settingsSnapshot = useStore(useSettingsStore, (state) => state.snapshot);

  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  useEffect(() => {
    applyThemePreference(settingsSnapshot?.settings.ui.theme ?? "dark");
  }, [settingsSnapshot]);

  if (target === null) {
    return <div className="md-preview-window-empty">No preview target — this window was opened without a valid tabId/previewId.</div>;
  }

  return (
    <TabContext.Provider value={{ tabId: target.tabId, store }}>
      <div className="md-preview-window-spike">TASK.99 M3 spike — md-preview window OK (tabId={target.tabId}, previewId={target.previewId})</div>
    </TabContext.Provider>
  );
}

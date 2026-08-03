/**
 * Root component of the md-preview WINDOW (TASK.99 CUT.md GAP 1 + CONTRACTS,
 * M3): mounted by main.tsx instead of `<App/>` when `location.search` carries
 * `?view=md-preview&tabId=...&previewId=...` — a second real `BrowserWindow`
 * loading the SAME renderer bundle the main window loads (main/index.ts's
 * `loadMdPreviewWindow`), never a second entry point (electron.vite.config.ts
 * stays single-entry, the LAW of GAP 1). Live-verified as a bare-boot spike
 * (this slice's spike commit) before this full version was written.
 *
 * Stays a THIN, logic-free shell (RISK REGISTER §5 — same discipline as
 * `MarkdownPreviewView.tsx`, which this component wraps): query parsing
 * (`parseMdWindowTarget`) and the sourcePath lookup (`findPreviewSourcePath`)
 * are pure functions in `preview/md-view-state.ts`, unit-tested there.
 *
 * Theme boot mirrors App.tsx's own (investigated, not guessed — App.tsx:628/636):
 * one `useSettingsStore.getState().load()` on mount, then `applyThemePreference`
 * in an effect keyed on the resolved snapshot. `index.html`'s pre-boot
 * `data-theme="dark"` covers the flash-free default for THIS window too (the
 * same static HTML file is served to both windows).
 *
 * `TabContext.Provider` wraps `MarkdownPreviewView` because the reused
 * `Markdown` component (chat's renderer, RECON §1) reads `TabContext.tabId`
 * for its OWN artifact-plane calls (doc-relative image reads via
 * `artifacts.readImage`, Reveal/Open buttons) — `store` only needs to satisfy
 * `TabContextValue`'s shape: nothing in this window's render tree ever calls
 * `useTabStore`/`useTabSend`/`useTabStoreApi`, so a disconnected
 * `createDesktopStore()` instance (never fed a port, never touched) is a
 * correct, zero-behavior stub, not a live chat connection.
 *
 * PREVIEW_CHANGED-push decision (CUT.md M3 scope item 5, investigated):
 * main's `onPreviewsChanged` (main/index.ts) sends `PREVIEW_CHANGED_CHANNEL`
 * to exactly ONE `webContents` — the MAIN window's (`win?.webContents.send`).
 * This window is a SEPARATE `BrowserWindow`/`webContents` main never targets,
 * so a docVersion bump made elsewhere (e.g. the SAME previewId edited from
 * another surface, which cannot actually happen while it is window-owned) or
 * a navigate committed by ANOTHER window instance never reaches here — a
 * boot-time-read-only surface. This is the CUT-sanctioned "boot-read
 * fallback": `docVersion` below is a constant, so `MarkdownPreviewView`'s own
 * refetch effect (keyed on it) runs exactly once, at mount; the header's
 * manual Reload button is the only way to pick up an external change. Content
 * this window navigates ITSELF (a local `.md` link click) still updates
 * instantly — `onOpenMdLink` dispatches `NAVIGATE_OK` directly from the
 * NAVIGATE invoke's own return value, independent of any push (see
 * MarkdownPreviewView.tsx's own doc comment).
 *
 * Owner smoke-test fix (window titlebar showing generic "AnyCode"): the
 * native titlebar was reading index.html's static `<title>AnyCode</title>` —
 * Electron syncs a `BrowserWindow`'s title to `document.title` on page load,
 * overriding the adapter's initial `"Markdown Preview"` option
 * (main/preview/md-window-adapter.ts, a main-process file this fix does not
 * touch) — and this window never set `document.title` itself. The effect
 * below does, keyed on `sourcePath` once it resolves (`mdWindowTitle`,
 * md-view-state.ts, a pure basename derivation with a generic fallback
 * before `sourcePath` has hydrated); the SAME string is also handed to
 * `MarkdownPreviewView` as `title` so its own in-header title span and the
 * OS titlebar always agree.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { useSettingsStore } from "../settings-store.js";
import { applyThemePreference } from "../theme.js";
import { findPreviewSourcePath, mdWindowTitle, parseMdWindowTarget } from "../preview/md-view-state.js";
import { MarkdownPreviewView } from "./MarkdownPreviewView.js";

/** Constant refetch key (see module doc's PREVIEW_CHANGED-push decision) — this window never receives a pushed docVersion bump, so `MarkdownPreviewView`'s fetch effect runs once, at mount. */
const WINDOW_DOC_VERSION = 0;

export function MdPreviewWindowApp() {
  const target = useMemo(() => parseMdWindowTarget(location.search), []);
  // Type-satisfying stub (module doc) — never fed a port, never subscribed to.
  const store = useMemo(() => createDesktopStore(), []);
  const settingsSnapshot = useStore(useSettingsStore, (state) => state.snapshot);
  const [sourcePath, setSourcePath] = useState("");

  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  useEffect(() => {
    applyThemePreference(settingsSnapshot?.settings.ui.theme ?? "dark");
  }, [settingsSnapshot]);

  useEffect(() => {
    if (target === null) {
      return;
    }
    let cancelled = false;
    window.anycode.previewPanel
      .list(target.tabId)
      .then((payload) => {
        if (!cancelled) {
          setSourcePath(findPreviewSourcePath(payload.previews, target.previewId));
        }
      })
      .catch((error: unknown) => {
        console.warn("[MdPreviewWindowApp] previewPanel.list failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Owner smoke-test fix: keeps the OS titlebar in sync with `sourcePath` as
  // it hydrates (boot-time "Markdown Preview" fallback -> the real file
  // name) — see this module's own doc comment for why this is needed at all.
  useEffect(() => {
    document.title = mdWindowTitle(sourcePath);
  }, [sourcePath]);

  if (target === null) {
    return <div className="md-preview-window-empty">No preview target — this window was opened without a valid tabId/previewId.</div>;
  }

  function handleClose(): void {
    window.close();
  }

  function handleTransfer(): void {
    if (target === null) {
      return;
    }
    window.anycode.previewPanel.setContainer(target.tabId, target.previewId, "panel").catch((error: unknown) => {
      console.warn("[MdPreviewWindowApp] setContainer failed", error);
    });
  }

  return (
    <TabContext.Provider value={{ tabId: target.tabId, store }}>
      <MarkdownPreviewView
        tabId={target.tabId}
        previewId={target.previewId}
        container="window"
        sourcePath={sourcePath}
        docVersion={WINDOW_DOC_VERSION}
        onClose={handleClose}
        onTransfer={handleTransfer}
        title={mdWindowTitle(sourcePath)}
      />
    </TabContext.Provider>
  );
}

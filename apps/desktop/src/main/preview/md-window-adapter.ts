/**
 * Production Electron adapter for the md-preview WINDOW container (
 * CUT.md GAP 1 + CONTRACTS, M3): the third file (after electron-adapter.ts's
 * preview window and panel-adapter.ts's WebContentsView) that touches real
 * Electron primitives for previews — and the first that creates a
 * `BrowserWindow` loading the app's OWN trusted renderer bundle rather than
 * an agent-authored page. Because the page is trusted, this adapter needs
 * NONE of `wireWindow`'s security wiring (no request gate, no will-navigate
 * policy, no console capture) — `MdPreviewWindowLike` (preview-host.ts) is
 * deliberately a much slimmer surface than `PreviewWindowLike`, with no
 * `webContents` at all: preview-host.ts never runs its security-invariant
 * wiring against this window, by construction (it has nothing typed for it
 * to wire).
 *
 * webPreferences are the MAIN window's exact triple (CUT.md GAP 1 decision):
 * same `preload` path, `sandbox:true`, `contextIsolation:true`,
 * `nodeIntegration:false` — `deps.preloadPath` is resolved once at the wiring
 * site (main/index.ts) and passed in, mirroring how `createElectronPanelView`
 * takes its `getWindow` accessor rather than reaching for main's module state
 * directly. `deps.loadRenderer` is the OTHER half closed over at the wiring
 * site (CUT.md CONTRACTS: "renderer-URL/query construction closed over at
 * the wiring site") — dev vs packaged URL construction belongs in
 * main/index.ts, which already owns that decision for the main window
 * (`resolveRendererIndex`/`ELECTRON_RENDERER_URL`), not duplicated here.
 *
 * `setWindowOpenHandler` deny is wired as hygiene only (CUT.md M3 scope item
 * 2) — our own renderer bundle never calls `window.open`, so this is
 * defense-in-depth, not a load-bearing invariant the way it is for an
 * agent-authored page in electron-adapter.ts.
 */

import { BrowserWindow } from "electron";
import { addIpcGuardTrustedWindow, removeIpcGuardTrustedWindow } from "../ipc-guard.js";
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, wrapCapturedImage } from "./electron-adapter.js";
import type { MdPreviewWindowLike } from "./preview-host.js";

export interface MdWindowAdapterDeps {
  /** The main window's own resolved preload path (main/index.ts's `resolvePreloadPath()`) — CUT.md GAP 1's "same preload path" requirement. */
  preloadPath: string;
  rendererUrl: string;
  /**
   * Loads the SAME renderer bundle `win` should show under
   * `?view=md-preview&tabId=...&previewId=...` (CUT.md GAP 1: dev
   * `ELECTRON_RENDERER_URL + query`, packaged `loadFile(resolveRendererIndex(),
   * { query })`) — dev-vs-packaged URL construction is decided at the wiring
   * site (main/index.ts), never here.
   */
  loadRenderer(win: BrowserWindow, opts: { previewId: string; tabId: string }): void;
}

/** Real `BrowserWindow`-backed `MdPreviewWindowLike` (CUT.md GAP 1's frozen webPreferences triple). */
export function createMdPreviewWindow(
  opts: { previewId: string; tabId: string },
  deps: MdWindowAdapterDeps,
): MdPreviewWindowLike {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    // stage 4 («Этап 4»: always-on-top для
    // превью-окон): a dom-md window is the same passive artifact viewer as
    // electron-adapter.ts's preview window — same constructor option, same
    // rationale ('floating' above the main window without fighting focus).
    alwaysOnTop: true,
    title: "Markdown Preview",
    webPreferences: {
      preload: deps.preloadPath,
      additionalArguments: [`--anycode-renderer-url=${deps.rendererUrl}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Capture the webContents ONCE while the window is alive: in the "closed"
  // handler the BrowserWindow is already destroyed, and reading `.webContents`
  // off a destroyed window throws "Object has been destroyed" — the exact
  // main-process modal the owner saw at app shutdown when closeAll() destroys
  // an open popout. The allow-list entry is keyed by this same identity.
  const contents = win.webContents;
  // Hygiene only (module doc) — our own trusted bundle never calls window.open.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The popout is the ONE non-main window with the preload bridge, and it
  // loads the app's own renderer bundle (same trust domain as the main
  // window), so it is allow-listed as a trusted IPC sender for its whole
  // lifetime — window-level, not per-channel; narrower per-channel policies
  // can extend the same seam later. That "same trust domain" holds only while
  // this window shows the app's OWN bundle: unlike the main window it has NO
  // main-navigation protection (protectMainNavigation is wired on the main
  // window's webContents only), so a later navigation-hardening task must
  // re-check this trust (or narrow it per-channel) before anything here can
  // navigate away from our renderer. Dropped on close so a dead window can
  // never keep a stale trust entry alive.
  addIpcGuardTrustedWindow(contents);
  win.once("closed", () => {
    removeIpcGuardTrustedWindow(contents);
  });
  deps.loadRenderer(win, opts);

  return {
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    show: () => win.show(),
    showInactive: () => win.showInactive(),
    onClosed: (listener) => {
      win.once("closed", listener);
    },
    capturePage: async () => wrapCapturedImage(await win.webContents.capturePage()),
    setBackgroundThrottling: (enabled) => win.webContents.setBackgroundThrottling(enabled),
    getContentSize: () => {
      // Electron's BrowserWindow.getContentSize() always returns exactly
      // [width, height] — the non-null assertions just satisfy
      // noUncheckedIndexedAccess, they do not paper over a real gap.
      const size = win.getContentSize();
      return { width: size[0]!, height: size[1]! };
    },
  };
}

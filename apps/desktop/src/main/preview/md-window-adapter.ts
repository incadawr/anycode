/**
 * Production Electron adapter for the md-preview WINDOW container (
 * CUT.md GAP 1 + CONTRACTS, M3): the third file (after electron-adapter.ts's
 * preview window and panel-adapter.ts's WebContentsView) that touches real
 * Electron primitives for previews — and the first that creates a
 * `BrowserWindow` loading the app's OWN trusted renderer bundle rather than
 * an agent-authored page. Because the page is trusted, this adapter needs
 * none of `wireWindow`'s security wiring (no request gate, no console
 * capture) — `MdPreviewWindowLike` (preview-host.ts) is deliberately a much
 * slimmer surface than `PreviewWindowLike`, with no `webContents` at all:
 * preview-host.ts never runs its security-invariant wiring against this
 * window, by construction (it has nothing typed for it to wire). What it
 * DOES get is the app's own navigation guard: a trusted bundle is still a
 * renderer that must never leave its own URL (preview-ipc-risk F2), so
 * `protectMainNavigation` — the SAME shared guard the main window uses, not
 * a fork — blocks foreign will-navigate/will-redirect, restores the renderer
 * on `did-navigate`, and denies `window.open`.
 *
 * webPreferences are the MAIN window's triple plus TWO deliberate deltas
 * (CUT.md GAP 1, narrowed by the preview-ipc-risk F2 hardening): `preload`
 * is still the main window's resolved path (main/index.ts resolves it once
 * and passes it in, mirroring how `createElectronPanelView` takes its
 * `getWindow` accessor rather than reaching for main's module state
 * directly) with sandbox:true, contextIsolation:true, nodeIntegration:false.
 * The deltas: `partition` is a dedicated IN-MEMORY session (`md-preview`,
 * never the default session the main window uses), and `additionalArguments`
 * carries `MD_PREVIEW_WINDOW_ARGV_FLAG` so the shared preload exposes the
 * NARROW document bridge (preload/md-preview-bridge.ts) in this window
 * instead of the full app bridge — no settings/plugins/trust/tab/proxy
 * method even exists here. `deps.loadRenderer` is the OTHER half closed over
 * at the wiring site (CUT.md CONTRACTS: "renderer-URL/query construction
 * closed over at the wiring site") — dev vs packaged URL construction
 * belongs in main/index.ts, which already owns that decision for the main
 * window (`resolveRendererIndex`/`ELECTRON_RENDERER_URL`), not duplicated
 * here.
 *
 * The guard allow-list entry is channel-scoped (`MD_WINDOW_CHANNELS`): even
 * from its own top frame, this window can invoke ONLY its document channels.
 * Main-side, each of those channels is additionally bound to the concrete
 * preview via md-window-targets.ts (registered here, keyed on the captured
 * webContents), so a compromised popout cannot read or steer another tab's
 * preview.
 */

import { BrowserWindow, shell } from "electron";
import { addIpcGuardTrustedWindow, removeIpcGuardTrustedWindow } from "../ipc-guard.js";
import { protectMainNavigation } from "../main-navigation.js";
import {
  ARTIFACT_ALLOW_CHANNEL,
  ARTIFACT_OPEN_CHANNEL,
  ARTIFACT_PREVIEWABLE_CHANNEL,
  ARTIFACT_PREVIEW_CHANNEL,
  ARTIFACT_READ_IMAGE_CHANNEL,
  ARTIFACT_REVEAL_CHANNEL,
} from "../artifacts-ipc.js";
import { MD_PREVIEW_NAVIGATE_CHANNEL, MD_PREVIEW_READ_CHANNEL, MD_PREVIEW_WINDOW_ARGV_FLAG } from "../../shared/md-preview.js";
import { PREVIEW_LIST_CHANNEL, PREVIEW_SET_CONTAINER_CHANNEL } from "../../shared/preview-panel.js";
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, wrapCapturedImage } from "./electron-adapter.js";
import { registerMdWindowTarget, unregisterMdWindowTarget } from "./md-window-targets.js";
import type { MdPreviewWindowLike } from "./preview-host.js";

/**
 * A dedicated IN-MEMORY session partition (no `persist:` prefix): the popout
 * never shares cookies/storage/cache with the main window's default session
 * (preview-ipc-risk F2). One partition serves every live popout — they are
 * all the app's own trusted bundle in the same trust domain, unlike the
 * agent-authored web previews which get one partition per preview.
 */
const MD_PREVIEW_PARTITION = "md-preview";

/**
 * The ONLY channels this window may invoke, enforced by the IPC guard's
 * channel-scoped allow-list (ipc-guard.ts). This is the document plane the
 * popout's renderer actually drives (MdPreviewWindowApp + MarkdownPreviewView
 * + Markdown's artifact UI): read/reload and local-md navigation, the
 * preview-list lookup and the transfer back to the panel, and the artifact
 * image/open/reveal/allow/preview/previewable family. Everything else —
 * settings, plugins, trust, secrets, tabs, proxy — is refused even from this
 * window's own top frame. Channel literals are imported from their
 * registration sites so the allow-list can never silently drift from what
 * main actually registers.
 */
const MD_WINDOW_CHANNELS = [
  MD_PREVIEW_READ_CHANNEL,
  MD_PREVIEW_NAVIGATE_CHANNEL,
  PREVIEW_LIST_CHANNEL,
  PREVIEW_SET_CONTAINER_CHANNEL,
  ARTIFACT_READ_IMAGE_CHANNEL,
  ARTIFACT_OPEN_CHANNEL,
  ARTIFACT_REVEAL_CHANNEL,
  ARTIFACT_ALLOW_CHANNEL,
  ARTIFACT_PREVIEW_CHANNEL,
  ARTIFACT_PREVIEWABLE_CHANNEL,
] as const;

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
      additionalArguments: [`--anycode-renderer-url=${deps.rendererUrl}`, MD_PREVIEW_WINDOW_ARGV_FLAG],
      // Dedicated in-memory session — never the main window's default session (module doc).
      partition: MD_PREVIEW_PARTITION,
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
  // The same shared navigation guard the main window carries (module doc):
  // foreign will-navigate/will-redirect are prevented (http(s)/mailto ride
  // out through the OS opener), did-navigate restores the renderer, and
  // window.open is denied — this popout must never leave its own renderer.
  protectMainNavigation(contents, deps.rendererUrl, (url) => shell.openExternal(url));
  // The popout is the ONE non-main window with the preload bridge, and it
  // loads the app's own renderer bundle (same trust domain as the main
  // window). Its allow-list entry is CHANNEL-SCOPED to its document plane
  // (MD_WINDOW_CHANNELS): unlike the main window it does NOT get the whole
  // privileged surface — a call on any other channel is refused even from
  // its own top frame. Main-side, its document calls are further bound to
  // the concrete (tabId, previewId) it was created for. Both entries die on
  // close so a dead window can never keep stale trust/target state alive.
  addIpcGuardTrustedWindow(contents, MD_WINDOW_CHANNELS);
  registerMdWindowTarget(contents, { tabId: opts.tabId, previewId: opts.previewId });
  win.once("closed", () => {
    removeIpcGuardTrustedWindow(contents);
    unregisterMdWindowTarget(contents);
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

/**
 * Production Electron adapter for the PANEL container (panel-track CUT.md
 * §2.2/§3 96-P1, TASK.96 stages 2+3): the second (and only other) file that
 * touches real Electron primitives for previews. A `WebContentsView` is an
 * embeddable "view" attached to a `BrowserWindow`'s `contentView` — there is
 * no native top-level window here, so unlike `createElectronPreviewWindow`
 * there is no native "closed" event, no native show()/showInactive(), and
 * teardown is manual (`removeChildView` + `webContents.close()`).
 *
 * D1 (no second security-wiring copy) + D3 (one adapter mapping): this module
 * constructs the view with the BYTE-IDENTICAL frozen webPreferences and
 * per-preview partition scheme `createElectronPreviewWindow` uses (D2 — a
 * divergent partition scheme here would silently leak cross-preview
 * permission grants and request-gate state through session sharing, since
 * `setPermissionRequestHandler`/`webRequest.onBeforeRequest` are SESSION-
 * scoped, not per-webContents), then adapts its real webContents onto
 * `PreviewWebContentsLike` via the SAME `wrapWebContents` the window adapter
 * uses (electron-adapter.ts) — `preview-host.ts`'s `wireWindow` therefore
 * runs unchanged against a panel's contents, with zero second copy.
 *
 * D6 (no-flash): the view is created with `setVisible(false)` — the host's
 * `applyPanel()` reconciler decides visibility (and applies bounds BEFORE
 * ever showing it) from the very first mutation onward.
 *
 * `onClosed` is synthesized: `destroy()` runs the security-wiring cleanup
 * (CDP debugger detach, via the SAME `registerCleanup` hook `wrapWebContents`
 * takes), removes the view from its window, closes its webContents, then
 * fires every registered `onClosed` listener exactly once — so
 * `preview-host.ts`'s `destroyRecord`/`wireWindow`'s `onClosed`-driven cleanup
 * path stays uniform across both containers (D1).
 */

import { WebContentsView, type BrowserWindow } from "electron";
import { wrapWebContents } from "./electron-adapter.js";
import type { CreateWindowOpts, PreviewPanelViewLike } from "./preview-host.js";
import type { PreviewPanelBounds } from "../../shared/preview-panel.js";

export interface PanelAdapterDeps {
  /**
   * Accessor mirroring window-ipc.ts's own `getWindow` seam (read fresh per
   * call, never closed over stale): the main window the panel view attaches
   * to / detaches from.
   */
  getWindow: () => BrowserWindow | null;
}

/** Real `WebContentsView`-backed `PreviewPanelViewLike` (CUT.md §2.2's frozen container abstraction). */
export function createElectronPanelView(opts: CreateWindowOpts, deps: PanelAdapterDeps): PreviewPanelViewLike {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Byte-identical scheme to createElectronPreviewWindow (D2): same
      // partition naming keeps the session-scoped permission handler +
      // request gate correctly isolated per preview, and lets a future
      // transfer (96-P3) reuse the SAME partition string across containers.
      partition: `preview-${opts.previewId}`,
    },
  });
  // D6, no-flash: created hidden — the host's applyPanel() reconciler is the
  // only thing that ever calls setVisible(true), and only after setBounds.
  view.setVisible(false);
  deps.getWindow()?.contentView.addChildView(view);

  let destroyed = false;
  const closedListeners: Array<() => void> = [];
  const cleanups: Array<() => void> = [];

  const webContentsLike = wrapWebContents(view.webContents, (fn) => {
    cleanups.push(fn);
  });

  return {
    webContents: webContentsLike,
    isDestroyed: () => destroyed,
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      const win = deps.getWindow();
      if (win !== null && !win.isDestroyed()) {
        try {
          win.contentView.removeChildView(view);
        } catch {
          // Main window mid-teardown — nothing left to detach from.
        }
      }
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // Best-effort CDP detach — a double-detach or a torn-down debugger is not an error.
        }
      }
      try {
        view.webContents.close();
      } catch {
        // Already closed/destroyed.
      }
      // WebContentsView has no native "closed" event — synthesized here,
      // exactly once, so preview-host.ts's onClosed-driven cleanup path stays
      // uniform across both containers (D1).
      for (const listener of closedListeners) {
        listener();
      }
    },
    // The host's panel paths never call show()/showInactive() directly (D13
    // handles the screenshot case explicitly via the visible-slot map +
    // applyPanel()) — mapped honestly to setVisible(true) regardless, per
    // §2.2's PreviewPanelViewLike contract.
    show: () => view.setVisible(true),
    showInactive: () => view.setVisible(true),
    onClosed: (listener) => {
      closedListeners.push(listener);
    },
    setBounds: (bounds: PreviewPanelBounds) => {
      view.setBounds(bounds);
    },
    setVisible: (visible: boolean) => {
      view.setVisible(visible);
    },
  };
}

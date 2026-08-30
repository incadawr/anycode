/**
 * One guarded push from main to the main window's renderer.
 *
 * `win?.webContents.send(...)` — the shape every call site in `index.ts` used
 * before this module — guards the NULL window only. There is a window in which
 * the module-level `win` is non-null while the native object behind it is
 * already gone: Electron fires `closed`, the handler runs teardown, and only
 * afterwards does the reference get nulled. Reading `.webContents` off a
 * destroyed BrowserWindow throws `TypeError: Object has been destroyed`, and in
 * the main process an uncaught throw is a modal error dialog on the way out.
 *
 * `previewHost.closeAll()` runs inside exactly that window and calls back here
 * through `onPreviewsChanged` for every preview it destroys, so closing the app
 * with a preview open raised the dialog.
 *
 * Every channel routed through here carries window-shell-level state the
 * renderer re-reads on load, never a delivery-critical message — so a window
 * that is gone (or whose renderer died) is a silent no-op, not an error.
 */

/**
 * Structural view of `BrowserWindow` — the two predicates and the send. Keeps
 * this module (and its test) free of a real Electron window.
 */
export interface MainWindowLike {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export function sendToMainWindow(win: MainWindowLike | null, channel: string, ...args: unknown[]): void {
  // Ordered: `isDestroyed()` is the one member a destroyed window still
  // answers, so it is asked BEFORE `.webContents` is ever touched.
  if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  win.webContents.send(channel, ...args);
}

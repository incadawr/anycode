/**
 * Custom-titlebar / window-control contract between main and renderer
 * (design/ui-track/design/custom-titlebar.md §4). Same value-only shape as
 * shared/tabs.ts / shared/updates.ts: channel-name constants + wire types only,
 * ZERO runtime imports, so it is safe to import from preload (sandboxed CJS),
 * the renderer web bundle, AND main alike without dragging any Electron runtime
 * into a bundle that cannot afford it.
 *
 * Four fixed invoke channels drive the OS caption buttons the renderer draws
 * itself (frameless window: `frame:false` / `titleBarStyle:"hidden"`), and one
 * PUSH channel forwards the live maximize/fullscreen state so the renderer can
 * flip its Maximize<->Restore glyph and its drag-region clearance. Every invoke
 * crosses the boundary with ZERO renderer-supplied arguments (main reads only
 * its own window), so — like the updater channels — there is nothing for a
 * compromised renderer to redirect and no zod validation is needed.
 */

/** invoke channel: minimize the window. */
export const WINDOW_MINIMIZE_CHANNEL = "anycode:window-minimize";

/** invoke channel: toggle maximize<->restore (main reads `isMaximized()` to decide). */
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "anycode:window-toggle-maximize";

/** invoke channel: close the window. */
export const WINDOW_CLOSE_CHANNEL = "anycode:window-close";

/** invoke channel: read the current `WindowState` once (renderer reads it on mount). */
export const WINDOW_STATE_GET_CHANNEL = "anycode:window-state-get";

/** push-event channel: main -> renderer, one `WindowState` per maximize/unmaximize/enter/leave-full-screen event. */
export const WINDOW_STATE_CHANNEL = "anycode:window-state";

/** The three desktop platforms whose chrome the renderer branches on; `process.platform` is clamped to this set in preload. */
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** Live window state pushed to the renderer: maximized flips the Maximize<->Restore glyph, fullscreen drops the macOS traffic-light clearance. */
export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
}

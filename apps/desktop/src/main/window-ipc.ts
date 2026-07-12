/**
 * Window control-plane IPC handlers (design/ui-track/design/custom-titlebar.md
 * §4): the four `ipcMain.handle` endpoints the renderer's custom caption
 * buttons drive, plus `wireWindowStateEvents` which forwards the live
 * maximize/fullscreen state as a PUSH event so the renderer can flip its
 * Maximize<->Restore glyph and its drag-region clearance.
 *
 * No zod (unlike tab-ipc.ts): every invoke here crosses the boundary with ZERO
 * renderer-supplied arguments — main reads only its own window — so there is no
 * payload to validate and nothing for a compromised renderer to redirect (same

 *
 * `getWindow` is an accessor mirroring the module-level nullable `win` in
 * index.ts (the exact seam tabs.ts / updater.ts use): the window may be null
 * mid-teardown, so every handler no-ops safely against a null window.
 */
import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_GET_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "../shared/window.js";
import type { WindowState } from "../shared/window.js";

export interface WindowIpcDeps {
  /** Accessor mirroring index.ts's module-level nullable `win` (read fresh per invoke). */
  getWindow: () => BrowserWindow | null;
}

/**
 * Computes the live `WindowState` from a window; a null window (mid-teardown or
 * pre-boot) reads as the neutral default. Reused by the `state-get` handler and
 * by every `wireWindowStateEvents` push so the two can never diverge.
 */
export function readWindowState(win: BrowserWindow | null): WindowState {
  if (win === null) {
    return { maximized: false, fullscreen: false };
  }
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}

/**
 * Registers the four invoke handlers on ipcMain (design §4). Matches the
 * non-idempotent registration of registerTabIpc / registerUpdater (called once
 * at boot); none of the handlers reads its ipc payload.
 */
export function registerWindowIpc(deps: WindowIpcDeps): void {
  ipcMain.handle(WINDOW_MINIMIZE_CHANNEL, () => {
    deps.getWindow()?.minimize();
  });

  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, () => {
    const win = deps.getWindow();
    if (win === null) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle(WINDOW_CLOSE_CHANNEL, () => {
    deps.getWindow()?.close();
  });

  ipcMain.handle(WINDOW_STATE_GET_CHANNEL, (): WindowState => readWindowState(deps.getWindow()));
}

/**
 * Pushes a fresh `WindowState` to the renderer on every
 * maximize/unmaximize/enter-full-screen/leave-full-screen transition (design
 * §4). Called from createWindow() right after the window is created; the state
 * is recomputed from the live window each time so it always matches reality.
 */
export function wireWindowStateEvents(win: BrowserWindow): void {
  const push = (): void => {
    win.webContents.send(WINDOW_STATE_CHANNEL, readWindowState(win));
  };
  win.on("maximize", push);
  win.on("unmaximize", push);
  win.on("enter-full-screen", push);
  win.on("leave-full-screen", push);
}

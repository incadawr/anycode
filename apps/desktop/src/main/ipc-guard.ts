/**
 * Sender/top-frame guard for every privileged `anycode:*` ipcMain
 * registration. Default deny: an IPC invoke is served only when the sender is
 * the app's main window webContents (or an explicitly allow-listed app
 * window's) AND the call originates from that sender's TOP frame — a subframe
 * of the renderer, a preview WebContentsView or any foreign window is
 * refused. The one non-main window that legitimately carries the preload
 * bridge (the detached Markdown popout, which loads the app's OWN renderer
 * bundle) is allow-listed by its creator (preview/md-window-adapter.ts) via
 * `addIpcGuardTrustedWindow` — restricted to exactly the document channels
 * that popout needs, so its trust does NOT extend to settings/plugins/tab or
 * any other privileged family even from its own top frame.
 *
 * Refusal style: `guardedIpcHandle` THROWS (so a renderer `invoke` rejects —
 * handlers keep their own result shapes and no fabricated refusal payload is
 * invented per channel); `guardedIpcOn` silently drops. A missing/undefined
 * event is refused too: real Electron always supplies one, and default deny
 * beats test convenience. Every module that registers IPC must be reachable
 * only through these wrappers — a source-scan test (ipc-guard.test.ts) bans
 * direct `ipcMain.handle(`/`ipcMain.on(` calls in main code so a new channel
 * cannot bypass the guard.
 *
 * Main-window wiring: index.ts calls `setIpcGuardMainWindow` once during boot
 * with a closure that reads the module-level nullable `win` live, BEFORE any
 * registration. Until that call the guard has no trusted source at all and
 * refuses everything.
 */
import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** Live accessor for the app's main window webContents; null until boot wires it. */
let mainWindowSource: (() => unknown) | null = null;
/**
 * Explicitly allow-listed app windows' webContents (the detached Markdown
 * popout today) with the channels each may invoke: `null` = the whole
 * privileged surface (the pre-channel-scoping default, still what an
 * allow-list call without a channel list gets), a `Set` = exactly those
 * channels. The main window never enters this map — its trust is the
 * closure above, over every channel.
 */
const trustedWindows = new Map<unknown, ReadonlySet<string> | null>();

/** Wires (or re-wires) the main-window source; the closure is read per event, never captured. */
export function setIpcGuardMainWindow(getter: () => unknown): void {
  mainWindowSource = getter;
}

/**
 * Adds an app window's webContents to the trusted allow-list. Without
 * `channels` the window is trusted for EVERY channel (window-level trust);
 * with a channel list it may invoke exactly those — a call on any other
 * channel is refused even from the window's own top frame.
 */
export function addIpcGuardTrustedWindow(webContents: unknown, channels?: readonly string[]): void {
  trustedWindows.set(webContents, channels === undefined ? null : new Set(channels));
}

/** Removes an allow-listed window's webContents (its creator does this on close). */
export function removeIpcGuardTrustedWindow(webContents: unknown): void {
  trustedWindows.delete(webContents);
}

/** True only when `sender` IS the main window's webContents or an allow-listed window's. */
export function isTrustedIpcSender(sender: unknown): boolean {
  if (typeof sender !== "object" || sender === null) return false;
  // Fail closed: the source closure may touch a window that died mid-event
  // (a throwing getter must refuse the call, not crash the listener).
  let main: unknown;
  try {
    main = mainWindowSource?.();
  } catch {
    return false;
  }
  if (sender === main) return true;
  return trustedWindows.has(sender);
}

/** True only when the event's frame is its own sender's top (main) frame. */
export function isTopFrameIpcEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  // Fail closed: Electron can deliver an event whose sender is already
  // destroyed, and `mainFrame`/`senderFrame` are native getters that THROW
  // on a destroyed object. Reading them must refuse the event — never let
  // the exception escape, because out of an `on` listener an uncaught throw
  // is a main-process crash (the owner-visible error modal), not a refusal.
  try {
    const { sender, senderFrame } = event as { sender?: unknown; senderFrame?: unknown };
    if (typeof sender !== "object" || sender === null) return false;
    const mainFrame = (sender as { mainFrame?: unknown }).mainFrame;
    return senderFrame !== undefined && senderFrame !== null && senderFrame === mainFrame;
  } catch {
    return false;
  }
}

/**
 * Trusted sender AND top frame AND — for an allow-listed window that was
 * registered WITH a channel list — a channel inside that list. A missing or
 * undefined event is never trusted; the main window and channel-less
 * allow-list entries are trusted on every channel.
 */
function isTrustedTopFrameIpcEvent(event: unknown, channel: string): boolean {
  if (typeof event !== "object" || event === null) return false;
  const sender = (event as { sender?: unknown }).sender;
  if (!isTrustedIpcSender(sender) || !isTopFrameIpcEvent(event)) return false;
  const channels = trustedWindows.get(sender);
  return channels === undefined || channels === null || channels.has(channel);
}

function ipcGuardRefusal(channel: string): Error {
  return new Error(`IPC channel "${channel}" refused a call from an untrusted sender or a non-top frame`);
}

/**
 * `ipcMain.handle` behind the guard: untrusted sender, non-top frame or a
 * missing event THROWS (the renderer's invoke rejects); a trusted main-frame
 * call reaches `handler` unchanged. `mainWindowOnly` excludes all auxiliary windows.
 */
export function guardedIpcHandle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  options: { mainWindowOnly?: boolean } = {},
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedTopFrameIpcEvent(event, channel)) throw ipcGuardRefusal(channel);
    if (options.mainWindowOnly) {
      let main: unknown;
      try { main = mainWindowSource?.(); } catch { throw ipcGuardRefusal(channel); }
      if (event.sender !== main) throw ipcGuardRefusal(channel);
    }
    return handler(event, ...args);
  });
}

/**
 * `ipcMain.on` behind the guard: untrusted senders are silently dropped
 * (fire-and-forget channels have no invoke promise to reject into).
 */
export function guardedIpcOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedTopFrameIpcEvent(event, channel)) return;
    listener(event, ...args);
  });
}

/** Clears the guard's module state so tests start from the default-deny baseline. */
export function resetIpcGuardForTests(): void {
  mainWindowSource = null;
  trustedWindows.clear();
}

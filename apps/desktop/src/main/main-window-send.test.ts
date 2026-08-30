/**
 * Regression pin for the quit-time crash: closing the app with a preview open
 * raised "A JavaScript error occurred in the main process — TypeError: Object
 * has been destroyed", thrown out of `onPreviewsChanged` under
 * `PreviewHost.closeAll()`.
 *
 * The fake below reproduces the ONE property that made the old `win?.` guard
 * insufficient: on a destroyed BrowserWindow the `webContents` GETTER itself
 * throws. A fake that merely returns a dead webContents object would pass
 * against the old code too and would pin nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { sendToMainWindow, type MainWindowLike } from "./main-window-send.js";

function fakeWindow(opts: { windowDestroyed: boolean; contentsDestroyed?: boolean }): {
  win: MainWindowLike;
  send: ReturnType<typeof vi.fn>;
  webContentsReads: () => number;
} {
  const send = vi.fn();
  let reads = 0;
  const win = {
    isDestroyed: () => opts.windowDestroyed,
    get webContents() {
      reads += 1;
      if (opts.windowDestroyed) {
        // Electron's own behaviour for a destroyed window.
        throw new TypeError("Object has been destroyed");
      }
      return { isDestroyed: () => opts.contentsDestroyed === true, send };
    },
  } as MainWindowLike;
  return { win, send, webContentsReads: () => reads };
}

describe("sendToMainWindow", () => {
  it("delivers channel and payload to a live window", () => {
    const { win, send } = fakeWindow({ windowDestroyed: false });
    sendToMainWindow(win, "anycode:previews-changed", { tabId: "t1" }, 7);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("anycode:previews-changed", { tabId: "t1" }, 7);
  });

  it("is a no-op for a null window", () => {
    expect(() => sendToMainWindow(null, "anycode:previews-changed", {})).not.toThrow();
  });

  it("never touches webContents on a destroyed window", () => {
    const { win, send, webContentsReads } = fakeWindow({ windowDestroyed: true });
    expect(() => sendToMainWindow(win, "anycode:previews-changed", {})).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    // The assertion that fails against `win?.webContents.send(...)`.
    expect(webContentsReads()).toBe(0);
  });

  it("skips a live window whose renderer is gone", () => {
    const { win, send } = fakeWindow({ windowDestroyed: false, contentsDestroyed: true });
    expect(() => sendToMainWindow(win, "anycode:engines-changed")).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

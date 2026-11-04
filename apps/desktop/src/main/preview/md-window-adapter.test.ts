/**
 * Tests for the md-preview WINDOW adapter's IPC-guard trust wiring.
 *
 * `electron`'s `BrowserWindow` is faked with a class whose `webContents`
 * getter THROWS `TypeError("Object has been destroyed")` once the window is
 * destroyed — exactly what the real Electron getter does. That is the
 * regression: the adapter used to read `win.webContents` INSIDE the
 * "closed" handler (fired by `destroy()` during app shutdown, e.g.
 * PreviewHost.closeAll -> destroyRecord), which threw "Object has been
 * destroyed" in the main process and popped the owner-visible Electron
 * error modal. The adapter must capture the webContents identity ONCE at
 * creation and use that captured identity for both the allow-list entry and
 * its removal, so the entry still dies with the window without ever
 * touching the destroyed window.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { capturedHandle, capturedOn, createdWindows } = vi.hoisted(() => ({
  capturedHandle: new Map<string, (...args: unknown[]) => unknown>(),
  capturedOn: new Map<string, (...args: unknown[]) => void>(),
  createdWindows: [] as Array<{
    webContents: unknown;
    once: (event: string, listener: () => void) => void;
    isDestroyed: () => boolean;
    destroy: () => void;
    fireClosed: () => void;
  }>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown): void => {
      capturedHandle.set(channel, listener);
    },
    on: (channel: string, listener: (...args: unknown[]) => void): void => {
      capturedOn.set(channel, listener);
    },
  },
  // The fake models the two real-Electron behaviors this regression is about:
  // `.webContents` THROWS on a destroyed window, and `destroy()` still fires
  // "closed" (Electron guarantees closed for destroy(); it skips close only).
  BrowserWindow: class FakeBrowserWindow {
    #destroyed = false;
    #closedListeners: Array<() => void> = [];
    #contents = { setWindowOpenHandler: vi.fn(), mainFrame: { frame: "md-popout" } };

    constructor() {
      createdWindows.push(this as unknown as (typeof createdWindows)[number]);
    }

    get webContents(): unknown {
      if (this.#destroyed) throw new TypeError("Object has been destroyed");
      return this.#contents;
    }

    once(event: string, listener: () => void): void {
      if (event === "closed") this.#closedListeners.push(listener);
    }

    isDestroyed(): boolean {
      return this.#destroyed;
    }

    destroy(): void {
      this.#destroyed = true;
      this.fireClosed();
    }

    fireClosed(): void {
      for (const listener of this.#closedListeners.splice(0)) listener();
    }
  },
}));

import { isTrustedIpcSender, resetIpcGuardForTests } from "../ipc-guard.js";
import { createMdPreviewWindow } from "./md-window-adapter.js";

beforeEach(() => {
  resetIpcGuardForTests();
  createdWindows.length = 0;
});

function rig() {
  const loadRenderer = vi.fn();
  const win = createMdPreviewWindow({ previewId: "p1", tabId: "t1" }, {
    preloadPath: "/fake/preload.cjs",
    rendererUrl: "http://127.0.0.1:5173/",
    loadRenderer,
  });
  const fake = createdWindows[0]!;
  return { win, fake, loadRenderer };
}

describe("md window adapter — guard trust wiring", () => {
  it("allow-lists the window's webContents at creation and loads the renderer", () => {
    const { win, fake, loadRenderer } = rig();
    const contents = fake.webContents;
    expect(contents).toBeDefined();
    expect(isTrustedIpcSender(contents)).toBe(true);
    expect(loadRenderer).toHaveBeenCalledTimes(1);
    expect(loadRenderer.mock.calls[0]![0]).toBe(fake);
    expect(loadRenderer.mock.calls[0]![1]).toEqual({ previewId: "p1", tabId: "t1" });
    expect(win.isDestroyed()).toBe(false);
  });

  it("removes the allow-list entry on 'closed' WITHOUT reading webContents off the destroyed window", () => {
    const { win, fake } = rig();
    const contents = fake.webContents;
    // destroy() fires "closed" synchronously; the old code read
    // `win.webContents` inside that handler and threw
    // TypeError("Object has been destroyed") straight into the main process.
    expect(() => win.destroy()).not.toThrow();
    expect(win.isDestroyed()).toBe(true);
    // The entry is still gone — the captured identity was removed.
    expect(isTrustedIpcSender(contents)).toBe(false);
  });

  it("the captured identity is stable: the closed handler removes exactly the entry added at creation", () => {
    const { win, fake } = rig();
    const contents = fake.webContents;
    win.destroy();
    // The entry added at creation is the one removed by the closed handler.
    expect(isTrustedIpcSender(contents)).toBe(false);
    // Re-reading webContents now throws, proving the handler never needed it.
    expect(() => fake.webContents).toThrow(/Object has been destroyed/);
  });
});

/**
 * Window control-plane IPC tests (design/ui-track/design/custom-titlebar.md §4).
 * `electron`'s `ipcMain` is mocked with a handler-capturing fake (there is no
 * Electron runtime under vitest), and the window is a fake `BrowserWindow` cast
 * through `unknown` — the same fake-primitive-cast pattern as boot-tree.test.ts
 * / tabs.test.ts. Covers: each handler drives the right window method,
 * toggle-maximize flips on `isMaximized()`, `state-get` returns the computed
 * state, `wireWindowStateEvents` pushes `WINDOW_STATE_CHANNEL` on all four
 * window events with the correct payload, and every handler no-ops against a
 * null window.
 */
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

// Capture every ipcMain.handle registration so a test can drive the handler
// directly (no ipc event is read by any handler, so calling it with none is
// faithful). `mock`-prefixed so vitest's hoisted vi.mock factory may close over it.
const { mockHandlers } = vi.hoisted(() => ({
  mockHandlers: new Map<string, () => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: () => unknown): void => {
      mockHandlers.set(channel, listener);
    },
  },
}));

import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_GET_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type WindowState,
} from "../shared/window.js";
import { readWindowState, registerWindowIpc, wireWindowStateEvents } from "./window-ipc.js";

type WindowEvent = "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen";

/** In-memory fake honouring the BrowserWindow surface window-ipc.ts touches; captures its `on` listeners so a test can fire them the way Electron would. */
class FakeWindow {
  maximized = false;
  fullscreen = false;
  readonly minimize = vi.fn();
  readonly maximize = vi.fn(() => {
    this.maximized = true;
  });
  readonly unmaximize = vi.fn(() => {
    this.maximized = false;
  });
  readonly close = vi.fn();
  readonly isMaximized = vi.fn(() => this.maximized);
  readonly isFullScreen = vi.fn(() => this.fullscreen);
  readonly webContents = { send: vi.fn() };
  private readonly listeners = new Map<WindowEvent, () => void>();

  on(event: WindowEvent, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  /** Fires a registered window event the way Electron would from its own event loop. */
  fire(event: WindowEvent): void {
    this.listeners.get(event)?.();
  }
}

/** registerWindowIpc against `win`, returning a thin invoker over the captured handlers. */
function register(win: BrowserWindow | null): (channel: string) => unknown {
  mockHandlers.clear();
  registerWindowIpc({ getWindow: () => win });
  return (channel: string) => mockHandlers.get(channel)?.();
}

function asWindow(win: FakeWindow): BrowserWindow {
  return win as unknown as BrowserWindow;
}

describe("registerWindowIpc — handlers drive the window", () => {
  it("minimize handler minimizes the window", () => {
    const win = new FakeWindow();
    const invoke = register(asWindow(win));
    invoke(WINDOW_MINIMIZE_CHANNEL);
    expect(win.minimize).toHaveBeenCalledTimes(1);
  });

  it("close handler closes the window", () => {
    const win = new FakeWindow();
    const invoke = register(asWindow(win));
    invoke(WINDOW_CLOSE_CHANNEL);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("toggle-maximize maximizes when restored and restores when maximized (flips on isMaximized)", () => {
    const win = new FakeWindow();
    const invoke = register(asWindow(win));

    // Restored -> maximize.
    invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.unmaximize).not.toHaveBeenCalled();
    expect(win.maximized).toBe(true);

    // Maximized -> unmaximize.
    invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.maximized).toBe(false);
  });

  it("state-get returns the state computed from the live window", () => {
    const win = new FakeWindow();
    win.maximized = true;
    win.fullscreen = true;
    const invoke = register(asWindow(win));
    expect(invoke(WINDOW_STATE_GET_CHANNEL)).toEqual({ maximized: true, fullscreen: true } satisfies WindowState);
  });
});

describe("registerWindowIpc — null window no-ops safely", () => {
  it("every handler is a safe no-op and state-get returns the neutral default when there is no window", () => {
    const invoke = register(null);
    expect(() => invoke(WINDOW_MINIMIZE_CHANNEL)).not.toThrow();
    expect(() => invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL)).not.toThrow();
    expect(() => invoke(WINDOW_CLOSE_CHANNEL)).not.toThrow();
    expect(invoke(WINDOW_STATE_GET_CHANNEL)).toEqual({ maximized: false, fullscreen: false } satisfies WindowState);
  });
});

describe("wireWindowStateEvents — pushes state on every transition", () => {
  it("sends WINDOW_STATE_CHANNEL with the live payload on all four window events", () => {
    const win = new FakeWindow();
    wireWindowStateEvents(asWindow(win));

    win.maximized = true;
    win.fire("maximize");
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_STATE_CHANNEL, {
      maximized: true,
      fullscreen: false,
    } satisfies WindowState);

    win.maximized = false;
    win.fire("unmaximize");
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_STATE_CHANNEL, {
      maximized: false,
      fullscreen: false,
    } satisfies WindowState);

    win.fullscreen = true;
    win.fire("enter-full-screen");
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_STATE_CHANNEL, {
      maximized: false,
      fullscreen: true,
    } satisfies WindowState);

    win.fullscreen = false;
    win.fire("leave-full-screen");
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_STATE_CHANNEL, {
      maximized: false,
      fullscreen: false,
    } satisfies WindowState);

    expect(win.webContents.send).toHaveBeenCalledTimes(4);
  });
});

describe("readWindowState — helper", () => {
  it("reads the live window state and treats a null window as the neutral default", () => {
    const win = new FakeWindow();
    win.maximized = true;
    expect(readWindowState(asWindow(win))).toEqual({ maximized: true, fullscreen: false } satisfies WindowState);
    expect(readWindowState(null)).toEqual({ maximized: false, fullscreen: false } satisfies WindowState);
  });
});

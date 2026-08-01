/**
 * Unit tests for the production Electron adapter (night-track wave-1 cut
 * §2.5, TASK.96 96-A). `electron` is mocked with a hand-written
 * `FakeBrowserWindow` (there is no Electron runtime under vitest — same
 * "mocked electron module" precedent as window-ipc.test.ts /
 * index.appVersion-wiring.test.ts), so this proves the ACTUAL wiring: the
 * literal `webPreferences`, the always-deny handlers, the per-preview
 * partition, and the CDP-debugger pageerror classification — none of which
 * preview-host.test.ts's Electron-free fakes can catch if this file's wiring
 * regresses.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";
import { RING_MAX_MSG_CHARS } from "./preview-host.js";

interface FakeDebugger {
  attachCalls: string[];
  sendCommandCalls: string[];
  detachCalls: number;
  messageListeners: Array<(event: unknown, method: string, params: unknown) => void>;
  attach(version: string): void;
  on(event: string, listener: (event: unknown, method: string, params: unknown) => void): void;
  sendCommand(method: string): Promise<unknown>;
  detach(): void;
}

function fakeDebugger(): FakeDebugger {
  return {
    attachCalls: [],
    sendCommandCalls: [],
    detachCalls: 0,
    messageListeners: [],
    attach(version) {
      this.attachCalls.push(version);
    },
    on(event, listener) {
      if (event === "message") this.messageListeners.push(listener);
    },
    sendCommand(method) {
      this.sendCommandCalls.push(method);
      return Promise.resolve({});
    },
    detach() {
      this.detachCalls += 1;
    },
  };
}

type OnBeforeRequestListener = (
  details: { url: string; resourceType: string },
  callback: (response: { cancel?: boolean }) => void,
) => void;

class FakeWebContents extends EventEmitter {
  loadURLCalls: string[] = [];
  executeJavaScriptCalls: string[] = [];
  backgroundThrottlingCalls: boolean[] = [];
  webRTCIPHandlingPolicyCalls: string[] = [];
  windowOpenHandler?: (details: { url: string }) => { action: string };
  permissionRequestHandler?: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void;
  capturePageResult: { toPNG(): Buffer; getSize(): { width: number; height: number }; isEmpty(): boolean } = {
    toPNG: () => Buffer.from("png-bytes"),
    getSize: () => ({ width: 42, height: 24 }),
    isEmpty: () => false,
  };
  onBeforeRequestCalls: unknown[][] = [];
  private onBeforeRequestListener?: OnBeforeRequestListener;
  session = {
    setPermissionRequestHandler: (handler: typeof this.permissionRequestHandler) => {
      this.permissionRequestHandler = handler;
    },
    webRequest: {
      onBeforeRequest: (...args: unknown[]) => {
        this.onBeforeRequestCalls.push(args);
        this.onBeforeRequestListener = args[args.length - 1] as OnBeforeRequestListener;
      },
    },
  };
  debugger = fakeDebugger();
  destroyedFlag = false;

  loadURL(url: string): Promise<void> {
    this.loadURLCalls.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyedFlag;
  }
  executeJavaScript(script: string): Promise<unknown> {
    this.executeJavaScriptCalls.push(script);
    return Promise.resolve(undefined);
  }
  capturePage(): Promise<unknown> {
    return Promise.resolve(this.capturePageResult);
  }
  setBackgroundThrottling(enabled: boolean): void {
    this.backgroundThrottlingCalls.push(enabled);
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
  setWebRTCIPHandlingPolicy(policy: string): void {
    this.webRTCIPHandlingPolicyCalls.push(policy);
  }
  /** Drives the LAST-registered `onBeforeRequest` listener (real Electron only ever expects one). */
  fireBeforeRequest(details: { url: string; resourceType: string }, callback: (response: { cancel?: boolean }) => void): void {
    this.onBeforeRequestListener?.(details, callback);
  }
}

const { createdWindows } = vi.hoisted(() => ({
  createdWindows: [] as FakeBrowserWindow[],
}));

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  shown = false;
  shownInactive = false;

  constructor(public readonly opts: BrowserWindowConstructorOptions) {
    super();
    createdWindows.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }
  show(): void {
    this.shown = true;
  }
  showInactive(): void {
    this.shownInactive = true;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
}));

const { createElectronPreviewWindow } = await import("./electron-adapter.js");

function latestWindow(): FakeBrowserWindow {
  return createdWindows.at(-1)!;
}

describe("createElectronPreviewWindow — webPreferences literal (cut §2.5, non-negotiable)", () => {
  it("creates the window with the frozen security webPreferences and no preload", () => {
    createElectronPreviewWindow({ previewId: "p1" });
    const win = latestWindow();
    expect(win.opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(win.opts.webPreferences).not.toHaveProperty("preload");
  });

  it("gives every preview its own partition, keyed by previewId", () => {
    createElectronPreviewWindow({ previewId: "alpha" });
    createElectronPreviewWindow({ previewId: "beta" });
    const [a, b] = createdWindows.slice(-2);
    expect(a!.opts.webPreferences?.partition).toBe("preview-alpha");
    expect(b!.opts.webPreferences?.partition).toBe("preview-beta");
    expect(a!.opts.webPreferences?.partition).not.toBe(b!.opts.webPreferences?.partition);
  });

  it("applies the cascade x/y when given, and a default size", () => {
    createElectronPreviewWindow({ previewId: "cascade", x: 200, y: 240 });
    const win = latestWindow();
    expect(win.opts).toMatchObject({ width: 1100, height: 800, x: 200, y: 240 });
  });
});

describe("createElectronPreviewWindow — handler passthrough (the deny POLICY itself is PreviewHost's, covered by preview-host.test.ts)", () => {
  it("setWindowOpenHandler passes the handler straight to the real webContents", () => {
    const win = createElectronPreviewWindow({ previewId: "p2" });
    const fake = latestWindow();
    const handler = (): { action: "deny" } => ({ action: "deny" });
    win.webContents.setWindowOpenHandler(handler);
    expect(fake.webContents.windowOpenHandler).toBe(handler);
    expect(fake.webContents.windowOpenHandler?.({ url: "https://evil.example" })).toEqual({ action: "deny" });
  });

  it("setPermissionRequestHandler adapts to the SESSION-scoped Electron API, not per-webContents", () => {
    const win = createElectronPreviewWindow({ previewId: "p3" });
    const fake = latestWindow();
    const handler = vi.fn((_permission: string, callback: (granted: boolean) => void) => callback(false));
    win.webContents.setPermissionRequestHandler(handler);

    const granted = vi.fn();
    fake.webContents.permissionRequestHandler?.({}, "camera", granted);

    expect(handler).toHaveBeenCalledWith("camera", expect.any(Function));
    expect(granted).toHaveBeenCalledWith(false);
  });
});

describe("createElectronPreviewWindow — event adaptation", () => {
  it("adapts did-finish-load / did-fail-load / render-process-gone / did-navigate", () => {
    const win = createElectronPreviewWindow({ previewId: "p4" });
    const fake = latestWindow();

    const finishSpy = vi.fn();
    win.webContents.onDidFinishLoad(finishSpy);
    fake.webContents.emit("did-finish-load");
    expect(finishSpy).toHaveBeenCalled();

    const failSpy = vi.fn();
    win.webContents.onDidFailLoad(failSpy);
    fake.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///x", true);
    expect(failSpy).toHaveBeenCalledWith(-6, "ERR_FILE_NOT_FOUND");

    const goneSpy = vi.fn();
    win.webContents.onRenderProcessGone(goneSpy);
    fake.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(goneSpy).toHaveBeenCalledWith("crashed");

    const navSpy = vi.fn();
    win.webContents.onDidNavigate(navSpy);
    fake.webContents.emit("did-navigate", {}, "https://example.com/", 200, "OK");
    expect(navSpy).toHaveBeenCalledWith("https://example.com/");
  });

  it("adapts will-navigate, wiring preventDefault through", () => {
    const win = createElectronPreviewWindow({ previewId: "p5" });
    const fake = latestWindow();
    const navSpy = vi.fn();
    win.webContents.onWillNavigate(navSpy);

    let prevented = false;
    fake.webContents.emit("will-navigate", { url: "https://x.example/", preventDefault: () => (prevented = true) });

    expect(navSpy).toHaveBeenCalledWith("https://x.example/", expect.any(Function));
    const [, preventDefaultArg] = navSpy.mock.calls[0]!;
    preventDefaultArg();
    expect(prevented).toBe(true);
  });

  it("classifies console-message levels (info/debug -> log, warning -> warn, error -> error)", () => {
    const win = createElectronPreviewWindow({ previewId: "p6" });
    const fake = latestWindow();
    const messages: Array<{ level: string; message: string }> = [];
    win.webContents.onConsoleMessage((level, message) => messages.push({ level, message }));

    fake.webContents.emit("console-message", { level: "info", message: "hi" });
    fake.webContents.emit("console-message", { level: "debug", message: "dbg" });
    fake.webContents.emit("console-message", { level: "warning", message: "careful" });
    fake.webContents.emit("console-message", { level: "error", message: "console.error() call" });

    expect(messages).toEqual([
      { level: "log", message: "hi" },
      { level: "log", message: "dbg" },
      { level: "warn", message: "careful" },
      { level: "error", message: "console.error() call" },
    ]);
  });

  it("classifies a CDP Runtime.exceptionThrown as a distinct pageerror, not error", () => {
    const win = createElectronPreviewWindow({ previewId: "p7" });
    const fake = latestWindow();
    const messages: Array<{ level: string; message: string }> = [];
    win.webContents.onConsoleMessage((level, message) => messages.push({ level, message }));

    expect(fake.webContents.debugger.attachCalls).toEqual(["1.3"]);
    expect(fake.webContents.debugger.sendCommandCalls).toEqual(["Runtime.enable"]);

    for (const listener of fake.webContents.debugger.messageListeners) {
      listener({}, "Runtime.exceptionThrown", {
        exceptionDetails: { exception: { description: "TypeError: boom" }, text: "Uncaught" },
      });
      listener({}, "Runtime.consoleAPICalled", { type: "error" }); // unrelated CDP event — ignored
    }

    expect(messages).toEqual([{ level: "pageerror", message: "TypeError: boom" }]);
  });

  it("detaches the debugger when the window closes", () => {
    const win = createElectronPreviewWindow({ previewId: "p8" });
    const fake = latestWindow();
    win.destroy();
    expect(fake.webContents.debugger.detachCalls).toBe(1);
  });
});

describe("createElectronPreviewWindow — passthrough methods", () => {
  it("loadURL/isDestroyed/executeJavaScript/capturePage/setBackgroundThrottling delegate to the real webContents", async () => {
    const win = createElectronPreviewWindow({ previewId: "p9" });
    const fake = latestWindow();

    await win.webContents.loadURL("file:///a.html");
    expect(fake.webContents.loadURLCalls).toEqual(["file:///a.html"]);

    expect(win.webContents.isDestroyed()).toBe(false);
    fake.webContents.destroyedFlag = true;
    expect(win.webContents.isDestroyed()).toBe(true);

    await win.webContents.executeJavaScript("1+1");
    expect(fake.webContents.executeJavaScriptCalls).toEqual(["1+1"]);

    win.webContents.setBackgroundThrottling(false);
    expect(fake.webContents.backgroundThrottlingCalls).toEqual([false]);

    const image = await win.webContents.capturePage();
    expect(image.getSize()).toEqual({ width: 42, height: 24 });
    expect(image.isEmpty()).toBe(false);
    expect(image.toPNG().toString()).toBe("png-bytes");
  });

  it("show/showInactive/destroy/isDestroyed/onClosed delegate to the real window", () => {
    const win = createElectronPreviewWindow({ previewId: "p10" });
    const fake = latestWindow();
    const closedSpy = vi.fn();
    win.onClosed(closedSpy);

    win.show();
    expect(fake.shown).toBe(true);
    win.showInactive();
    expect(fake.shownInactive).toBe(true);
    expect(win.isDestroyed()).toBe(false);

    win.destroy();
    expect(fake.destroyed).toBe(true);
    expect(win.isDestroyed()).toBe(true);
    expect(closedSpy).toHaveBeenCalled();
  });
});


describe("createElectronPreviewWindow — request gate (cut §1.1/F2)", () => {
  it("registers onBeforeRequest on the window's session webRequest with NO filter argument", () => {
    const win = createElectronPreviewWindow({ previewId: "gate-a" });
    const fake = latestWindow();
    win.webContents.setRequestGate(async () => true);
    expect(fake.webContents.onBeforeRequestCalls).toHaveLength(1);
    // A single argument (the listener) — no WebRequestFilter object precedes it.
    expect(fake.webContents.onBeforeRequestCalls[0]).toHaveLength(1);
  });

  it("deny path calls callback({cancel:true})", async () => {
    const win = createElectronPreviewWindow({ previewId: "gate-b" });
    const fake = latestWindow();
    win.webContents.setRequestGate(async () => false);
    const callback = vi.fn();
    fake.webContents.fireBeforeRequest({ url: "https://evil.example/", resourceType: "xhr" }, callback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it("allow path calls callback({cancel:false})", async () => {
    const win = createElectronPreviewWindow({ previewId: "gate-c" });
    const fake = latestWindow();
    win.webContents.setRequestGate(async () => true);
    const callback = vi.fn();
    fake.webContents.fireBeforeRequest({ url: "https://a.tld/", resourceType: "mainFrame" }, callback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalledWith({ cancel: false });
  });

  it("gate rejection/throw cancels the request — the Electron callback is always answered", async () => {
    const win = createElectronPreviewWindow({ previewId: "gate-d" });
    const fake = latestWindow();
    win.webContents.setRequestGate(() => Promise.reject(new Error("gate exploded")));
    const callback = vi.fn();
    fake.webContents.fireBeforeRequest({ url: "https://a.tld/", resourceType: "xhr" }, callback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });
});

describe("createElectronPreviewWindow — redirect gate + WebRTC hardening (cut §1.2/F1, §1.1/F2)", () => {
  it("subscribes to will-redirect and plumbs preventDefault through", () => {
    const win = createElectronPreviewWindow({ previewId: "redir-a" });
    const fake = latestWindow();
    const redirectSpy = vi.fn();
    win.webContents.onWillRedirect(redirectSpy);

    let prevented = false;
    fake.webContents.emit("will-redirect", {
      url: "https://evil.example/",
      preventDefault: () => (prevented = true),
    });

    expect(redirectSpy).toHaveBeenCalledWith("https://evil.example/", expect.any(Function));
    const [, preventDefaultArg] = redirectSpy.mock.calls[0]!;
    preventDefaultArg();
    expect(prevented).toBe(true);
  });

  it("calls setWebRTCIPHandlingPolicy('disable_non_proxied_udp') at construction", () => {
    createElectronPreviewWindow({ previewId: "webrtc-a" });
    const fake = latestWindow();
    expect(fake.webContents.webRTCIPHandlingPolicyCalls).toEqual(["disable_non_proxied_udp"]);
  });
});

describe("createElectronPreviewWindow — console/CDP string slicing (cut §1.3/F3)", () => {
  it("slices a console-message string to RING_MAX_MSG_CHARS before the listener", () => {
    const win = createElectronPreviewWindow({ previewId: "slice-a" });
    const fake = latestWindow();
    const messages: string[] = [];
    win.webContents.onConsoleMessage((_level, message) => messages.push(message));

    fake.webContents.emit("console-message", { level: "info", message: "x".repeat(2000) });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveLength(RING_MAX_MSG_CHARS);
  });

  it("slices a CDP exceptionDetails description to RING_MAX_MSG_CHARS before the listener", () => {
    const win = createElectronPreviewWindow({ previewId: "slice-b" });
    const fake = latestWindow();
    const messages: string[] = [];
    win.webContents.onConsoleMessage((level, message) => {
      if (level === "pageerror") messages.push(message);
    });

    for (const listener of fake.webContents.debugger.messageListeners) {
      listener({}, "Runtime.exceptionThrown", {
        exceptionDetails: { exception: { description: "E".repeat(2000) } },
      });
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveLength(RING_MAX_MSG_CHARS);
  });
});

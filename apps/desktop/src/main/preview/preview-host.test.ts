/**
 * Unit tests for PreviewHost (night-track wave-1 cut §2.5, TASK.96 96-A): the
 * security-invariant suite this slice OWNS. Every Electron primitive is a
 * hand-written fake implementing `PreviewWindowLike`/`PreviewWebContentsLike`
 * — no Electron runtime is ever involved (mirrors tabs.test.ts's fake-fork
 * pattern for the same reason). `deps.now` is an explicit, test-controlled
 * clock (bumped directly where a test cares about ordering/windowing);
 * `vi.useFakeTimers()` is used only for the real `setTimeout`-driven op
 * timeouts (open/read/screenshot's ≤15s/≤5s waits), which are independent of
 * the injected clock.
 */

import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_EVENT_TYPE,
  PREVIEW_RESPONSE_TYPE,
  type PreviewConsoleEntry,
  type PreviewEventMessage,
  type PreviewOp,
  type PreviewResponseMessage,
} from "../../shared/preview.js";
import {
  EXEC_JS_TIMEOUT_MS,
  PANEL_SCREENSHOT_RETRY_DELAY_MS,
  READ_RESULT_MAX_CHARS,
  clampPanelBounds,
  registerPreviewHost,
  type CreateWindowOpts,
  type MdPreviewWindowLike,
  type PreviewCapturedImage,
  type PreviewHostDeps,
  type PreviewHostHandle,
  type PreviewPanelViewLike,
  type PreviewWebContentsLike,
  type PreviewWindowLike,
} from "./preview-host.js";
// M4: the single source of truth for the dom-md read cap — imported here so
// the "too_large" test derives its fixture size from the SAME constant
// preview-host.ts's `readMarkdownSource` enforces, never a hand-copied number.
import { MD_PREVIEW_MAX_SOURCE_BYTES } from "./md-doc.js";
import type { PreviewChangedPayload, PreviewPanelBounds, PreviewPanelStatePayload } from "../../shared/preview-panel.js";

const TAB = "tab-1";
const WORKSPACE_ROOT = "/workspace";

function fakeImage(opts?: { empty?: boolean; width?: number; height?: number }): PreviewCapturedImage {
  return {
    toPNG: () => Buffer.from("fake-png-bytes"),
    getSize: () => ({ width: opts?.width ?? 800, height: opts?.height ?? 600 }),
    isEmpty: () => opts?.empty ?? false,
  };
}

class FakeWebContents implements PreviewWebContentsLike {
  destroyed = false;
  loadedUrls: string[] = [];
  executeJavaScriptCalls: string[] = [];
  executeJavaScriptImpl: (script: string) => Promise<unknown> = () => Promise.resolve(undefined);
  backgroundThrottlingCalls: boolean[] = [];
  windowOpenHandler?: (details: { url: string }) => { action: "deny" };
  permissionRequestHandler?: (permission: string, callback: (granted: boolean) => void) => void;
  capturePageImpl: () => Promise<PreviewCapturedImage> = () => Promise.resolve(fakeImage());
  /** D18: consumed in order — each queued error rejects the NEXT `capturePage()` call instead of running `capturePageImpl`. */
  captureRejections: Error[] = [];
  captureCalls = 0;
  /** Captured by `setRequestGate` — tests drive the F2 policy directly through this. */
  requestGate?: (req: { url: string; resourceType: string }) => Promise<boolean>;
  /** D14 (96-P3): back/forward stack a test pre-loads before triggering a transfer. */
  navigationHistoryEntries: Array<{ url: string; title: string }> = [];
  navigationHistoryIndex = 0;
  restoreNavigationHistoryCalls: Array<{ entries: Array<{ url: string; title: string }>; index: number }> = [];
  restoreNavigationHistoryImpl: (state: { entries: Array<{ url: string; title: string }>; index: number }) => Promise<void> =
    () => Promise.resolve();

  private didFinishLoad: Array<() => void> = [];
  private didFailLoad: Array<(code: number, desc: string, isMainFrame: boolean) => void> = [];
  private renderProcessGone: Array<(reason: string) => void> = [];
  private willNavigate: Array<(url: string, preventDefault: () => void) => void> = [];
  private willRedirect: Array<(url: string, preventDefault: () => void) => void> = [];
  private didNavigate: Array<(url: string) => void> = [];
  private consoleMessage: Array<(level: PreviewConsoleEntry["level"], message: string) => void> = [];

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  executeJavaScript<T>(script: string): Promise<T> {
    this.executeJavaScriptCalls.push(script);
    return this.executeJavaScriptImpl(script) as Promise<T>;
  }
  capturePage(): Promise<PreviewCapturedImage> {
    this.captureCalls += 1;
    const rejection = this.captureRejections.shift();
    if (rejection !== undefined) {
      return Promise.reject(rejection);
    }
    return this.capturePageImpl();
  }
  setBackgroundThrottling(enabled: boolean): void {
    this.backgroundThrottlingCalls.push(enabled);
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void {
    this.windowOpenHandler = handler;
  }
  setPermissionRequestHandler(handler: (permission: string, callback: (granted: boolean) => void) => void): void {
    this.permissionRequestHandler = handler;
  }
  onDidFinishLoad(listener: () => void): void {
    this.didFinishLoad.push(listener);
  }
  onDidFailLoad(listener: (errorCode: number, errorDescription: string, isMainFrame: boolean) => void): void {
    this.didFailLoad.push(listener);
  }
  onRenderProcessGone(listener: (reason: string) => void): void {
    this.renderProcessGone.push(listener);
  }
  onWillNavigate(listener: (url: string, preventDefault: () => void) => void): void {
    this.willNavigate.push(listener);
  }
  onWillRedirect(listener: (url: string, preventDefault: () => void) => void): void {
    this.willRedirect.push(listener);
  }
  onDidNavigate(listener: (url: string) => void): void {
    this.didNavigate.push(listener);
  }
  onConsoleMessage(listener: (level: PreviewConsoleEntry["level"], message: string) => void): void {
    this.consoleMessage.push(listener);
  }
  setRequestGate(gate: (req: { url: string; resourceType: string }) => Promise<boolean>): void {
    this.requestGate = gate;
  }
  getNavigationHistory(): { entries: Array<{ url: string; title: string }>; index: number } {
    return { entries: this.navigationHistoryEntries, index: this.navigationHistoryIndex };
  }
  restoreNavigationHistory(state: { entries: Array<{ url: string; title: string }>; index: number }): Promise<void> {
    this.restoreNavigationHistoryCalls.push(state);
    return this.restoreNavigationHistoryImpl(state);
  }

  // ── test drivers (simulate Electron firing these events) ──
  fireDidFinishLoad(): void {
    for (const l of this.didFinishLoad) l();
  }
  fireDidFailLoad(errorCode: number, errorDescription: string, isMainFrame = true): void {
    for (const l of this.didFailLoad) l(errorCode, errorDescription, isMainFrame);
  }
  fireRenderProcessGone(reason: string): void {
    for (const l of this.renderProcessGone) l(reason);
  }
  /** Returns whether `preventDefault` was invoked (Electron's real semantics: always call it ourselves, then decide). */
  fireWillNavigate(url: string): boolean {
    let prevented = false;
    for (const l of this.willNavigate) l(url, () => (prevented = true));
    return prevented;
  }
  /** Same semantics as `fireWillNavigate`, for the `will-redirect` layer (cut §1.2/F1). */
  fireWillRedirect(url: string): boolean {
    let prevented = false;
    for (const l of this.willRedirect) l(url, () => (prevented = true));
    return prevented;
  }
  fireConsoleMessage(level: PreviewConsoleEntry["level"], message: string): void {
    for (const l of this.consoleMessage) l(level, message);
  }
}

class FakeWindow implements PreviewWindowLike {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  shown = false;
  shownInactive = false;
  private closedListeners: Array<() => void> = [];

  constructor(public readonly previewId: string) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const l of this.closedListeners) l();
  }
  show(): void {
    this.shown = true;
  }
  showInactive(): void {
    this.shownInactive = true;
  }
  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }
  /** The user closes the window via native chrome — same observable effect as `destroy()`. */
  simulateExternalClose(): void {
    this.destroy();
  }
}

/**
 * Fake panel container (panel-track CUT.md §3 96-P1 test plan): records
 * ORDERED `setBounds`/`setVisible` calls (a single combined log, `calls`) so
 * the visibility-matrix tests can assert `setBounds` happens BEFORE
 * `setVisible(true)`, plus the plain `PreviewWindowLike` surface `wireWindow`
 * itself drives (webContents, destroy, onClosed) — reused unchanged from
 * `FakeWindow`'s pattern so the "same wireWindow ran against it" proof is
 * apples-to-apples with the window suite.
 */
class FakePanelView implements PreviewPanelViewLike {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  shown = false;
  shownInactive = false;
  calls: Array<{ kind: "setBounds"; bounds: PreviewPanelBounds } | { kind: "setVisible"; visible: boolean }> = [];
  private closedListeners: Array<() => void> = [];

  constructor(public readonly previewId: string) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const l of this.closedListeners) l();
  }
  show(): void {
    this.shown = true;
  }
  showInactive(): void {
    this.shownInactive = true;
  }
  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }
  setBounds(bounds: PreviewPanelBounds): void {
    this.calls.push({ kind: "setBounds", bounds });
  }
  setVisible(visible: boolean): void {
    this.calls.push({ kind: "setVisible", visible });
  }
  get visible(): boolean {
    const last = [...this.calls].reverse().find((c) => c.kind === "setVisible");
    return last !== undefined && last.kind === "setVisible" ? last.visible : false;
  }
}

/**
 * TASK.99 M3: fake `MdPreviewWindowLike` — deliberately much slimmer than
 * `FakeWindow`/`FakePanelView` above (no `webContents` at all, mirroring the
 * real contract: preview-host.ts never runs `wireWindow`'s security wiring
 * against a dom-md window, since it is typed with nothing for that to wire
 * against). `onClosed`/`simulateExternalClose` mirror `FakeWindow`'s own
 * shape exactly, for the "native window close destroys the record" tests.
 */
class FakeMdWindow implements MdPreviewWindowLike {
  destroyed = false;
  shown = false;
  shownInactive = false;
  backgroundThrottlingCalls: boolean[] = [];
  capturePageImpl: () => Promise<PreviewCapturedImage> = () => Promise.resolve(fakeImage());
  private closedListeners: Array<() => void> = [];

  constructor(
    public readonly previewId: string,
    public readonly tabId: string,
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const l of this.closedListeners) l();
  }
  show(): void {
    this.shown = true;
  }
  showInactive(): void {
    this.shownInactive = true;
  }
  onClosed(listener: () => void): void {
    this.closedListeners.push(listener);
  }
  capturePage(): Promise<PreviewCapturedImage> {
    return this.capturePageImpl();
  }
  setBackgroundThrottling(enabled: boolean): void {
    this.backgroundThrottlingCalls.push(enabled);
  }
  /** The user closes the window via native chrome — same observable effect as `destroy()`. */
  simulateExternalClose(): void {
    this.destroy();
  }
}

/** Everything a test needs to drive a `registerPreviewHost` instance + inspect its side effects. */
interface Rig {
  host: PreviewHostHandle;
  windows: FakeWindow[];
  /** Panel-container views (panel-track CUT.md §3 96-P1) — parallel to `windows` for the window container. */
  panelViews: FakePanelView[];
  /** TASK.99 M3: md-preview windows, parallel to `windows`/`panelViews` for `createMdWindow`. */
  mdWindows: FakeMdWindow[];
  posted: Array<{ tabId: string; message: PreviewResponseMessage | PreviewEventMessage }>;
  /** Every `onPreviewsChanged` push, in order (D7's main -> renderer CHANGED contract). */
  changed: PreviewChangedPayload[];
  clock: { time: number };
  autoOpen: { enabled: boolean };
  /** Mutable so a test can flip container mode mid-scenario; default "window" keeps the entire stage-1 suite byte-untouched. */
  displayModeValue: { value: "panel" | "window" };
  resolveArtifactImpl: (tabId: string, path: string) => Promise<{ realPath: string } | { failure: string }>;
  /**
   * D14 (96-P3) test hooks: `setContainer` creates the NEW container
   * synchronously (before its first `await`), so a test that needs to
   * pre-configure the fresh fake (e.g. make its `restoreNavigationHistory`
   * reject) has no window to reach INTO before calling `setContainer` —
   * these fire right after construction, closing that gap.
   */
  onWindowCreated?: (win: FakeWindow) => void;
  onPanelViewCreated?: (view: FakePanelView) => void;
  /** Same "fires right after construction" rationale as `onWindowCreated`/`onPanelViewCreated`. */
  onMdWindowCreated?: (win: FakeMdWindow) => void;
  /**
   * TASK.99 M4: in-memory dom-md source filesystem, keyed by REALPATH —
   * `statMdSource`/`readMdSourceNoFollow` read from this map; an absent key
   * is an honest stat failure (mirrors a deleted/missing file). `sizeOverride`
   * lets a test simulate `too_large` without allocating a real >2MB buffer.
   */
  mdSourceFiles: Map<string, { bytes: Buffer; sizeOverride?: number }>;
  /** M4: every `captureMainWindowRect` call, in order — asserts the EXACT rect the host passed. */
  captureMainWindowRectCalls: PreviewPanelBounds[];
  /** M4: mutable so a test can flip this to `async () => null` (no main window) or a custom image. */
  captureMainWindowRectImpl: (rect: PreviewPanelBounds) => Promise<PreviewCapturedImage | null>;
}

/** Default containment fake: anything under `/workspace` resolves; everything else is refused. */
async function defaultResolveArtifact(_tabId: string, path: string): Promise<{ realPath: string } | { failure: string }> {
  if (path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`)) {
    return { realPath: path };
  }
  return { failure: "outside_allowed_roots" };
}

function makeRig(overrides?: Partial<PreviewHostDeps>): Rig {
  const windows: FakeWindow[] = [];
  const panelViews: FakePanelView[] = [];
  const mdWindows: FakeMdWindow[] = [];
  const posted: Array<{ tabId: string; message: PreviewResponseMessage | PreviewEventMessage }> = [];
  const changed: PreviewChangedPayload[] = [];
  const clock = { time: 1_000_000 };
  const autoOpen = { enabled: true };
  // Default "window" (cut §3 96-P1): every one of the 18 pre-existing
  // describe blocks never touches this and stays the stage-1 window-mode
  // regression suite, byte-untouched.
  const displayModeValue: { value: "panel" | "window" } = { value: "window" };
  const mdSourceFiles = new Map<string, { bytes: Buffer; sizeOverride?: number }>();
  const captureMainWindowRectCalls: PreviewPanelBounds[] = [];
  const rig: Rig = {
    host: undefined as unknown as PreviewHostHandle,
    windows,
    panelViews,
    mdWindows,
    posted,
    changed,
    clock,
    autoOpen,
    displayModeValue,
    resolveArtifactImpl: defaultResolveArtifact,
    mdSourceFiles,
    captureMainWindowRectCalls,
    captureMainWindowRectImpl: async () => fakeImage(),
  };

  const deps: PreviewHostDeps = {
    createWindow: (opts: CreateWindowOpts) => {
      const win = new FakeWindow(opts.previewId);
      windows.push(win);
      rig.onWindowCreated?.(win);
      return win;
    },
    createPanelView: (opts: CreateWindowOpts) => {
      const view = new FakePanelView(opts.previewId);
      panelViews.push(view);
      rig.onPanelViewCreated?.(view);
      return view;
    },
    createMdWindow: (opts: { previewId: string; tabId: string }) => {
      const win = new FakeMdWindow(opts.previewId, opts.tabId);
      mdWindows.push(win);
      rig.onMdWindowCreated?.(win);
      return win;
    },
    displayMode: () => displayModeValue.value,
    onPreviewsChanged: (payload) => {
      changed.push(payload);
    },
    resolveArtifact: (tabId, path) => rig.resolveArtifactImpl(tabId, path),
    statMdSource: async (realPath) => {
      const file = mdSourceFiles.get(realPath);
      if (file === undefined) {
        return undefined;
      }
      return { size: file.sizeOverride ?? file.bytes.length, isFile: true };
    },
    readMdSourceNoFollow: async (realPath) => {
      const file = mdSourceFiles.get(realPath);
      if (file === undefined) {
        throw new Error(`ENOENT: ${realPath}`);
      }
      return file.bytes;
    },
    captureMainWindowRect: async (rect) => {
      captureMainWindowRectCalls.push(rect);
      return rig.captureMainWindowRectImpl(rect);
    },
    autoOpenEnabled: () => autoOpen.enabled,
    postToHost: (tabId, message) => {
      posted.push({ tabId, message });
      return true;
    },
    logger: { log() {}, warn() {}, error() {} },
    now: () => clock.time,
    ...overrides,
  };
  rig.host = registerPreviewHost(deps);
  return rig;
}

/** Drains pending microtasks (promise chains inside PreviewHost that aren't awaited by the caller). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("PreviewHost — window security invariants (cut §2.5, non-negotiable)", () => {
  it("wires setWindowOpenHandler to always deny", async () => {
    const rig = makeRig();
    void rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const win = rig.windows[0]!;
    expect(win.webContents.windowOpenHandler?.({ url: "https://evil.example/popup" })).toEqual({ action: "deny" });
  });

  it("wires setPermissionRequestHandler to deny every permission", async () => {
    const rig = makeRig();
    void rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const win = rig.windows[0]!;
    for (const permission of ["camera", "microphone", "geolocation", "notifications", "clipboard-read"]) {
      const granted = await new Promise<boolean>((resolve) => {
        win.webContents.permissionRequestHandler?.(permission, resolve);
      });
      expect(granted).toBe(false);
    }
  });
});

describe("PreviewHost — open enforces containment BEFORE the initial load (risk §5.2, layer 1)", () => {
  it("refuses a path outside the allowed roots and destroys the fresh window", async () => {
    const rig = makeRig();
    const result = await rig.host.openForTab(TAB, { path: "/etc/passwd" });
    expect(result).toEqual({ ok: false, error: expect.any(String), errorKind: "invalid_input" });
    expect(rig.windows[0]!.destroyed).toBe(true);
    expect(rig.windows[0]!.webContents.loadedUrls).toEqual([]);
  });

  it("refuses a remote URL without allowRemote and destroys the fresh window", async () => {
    const rig = makeRig();
    const result = await rig.host.openForTab(TAB, { url: "https://example.com/dashboard" });
    expect(result).toEqual({ ok: false, error: expect.any(String), errorKind: "invalid_input" });
    expect(rig.windows[0]!.destroyed).toBe(true);
    expect(rig.windows[0]!.webContents.loadedUrls).toEqual([]);
  });

  it("allows a localhost URL unconditionally", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "http://localhost:5173/" });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await openPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("localhost");
    }
  });

  it("allows a remote URL when allowRemote is true, recording per-origin consent", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "https://example.com/app", allowRemote: true });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await openPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("remote");
    }
  });

  it("does NOT destroy the existing window on a refused reuse-navigate (previewId given)", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const opened = await openPromise;
    expect(opened.ok).toBe(true);
    const previewId = opened.ok ? opened.value.previewId : "";

    const reused = await rig.host.openForTab(TAB, { path: "/etc/passwd", previewId });
    expect(reused).toEqual({ ok: false, error: expect.any(String), errorKind: "invalid_input" });
    expect(rig.windows[0]!.destroyed).toBe(false);
    expect(rig.windows).toHaveLength(1);
  });

  it("navigates the SAME window on a successful reuse (no second createWindow call)", async () => {
    const rig = makeRig();
    const first = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const opened = await first;
    const previewId = opened.ok ? opened.value.previewId : "";

    const second = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html`, previewId });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await second;

    expect(rig.windows).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(rig.windows[0]!.webContents.loadedUrls).toHaveLength(2);
  });
});

describe("PreviewHost — will-navigate matrix (risk §5.2, layer 2)", () => {
  async function openedRig(openReq: { path?: string; url?: string; allowRemote?: boolean } = { path: `${WORKSPACE_ROOT}/a.html` }) {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, openReq);
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    return rig;
  }

  it("allows in-page navigation to a file under an allowed root", async () => {
    const rig = await openedRig();
    const wc = rig.windows[0]!.webContents;
    const target = pathToFileURL(`${WORKSPACE_ROOT}/other.html`).href;
    const prevented = wc.fireWillNavigate(target);
    expect(prevented).toBe(true); // Electron semantics: always preventDefault first, then decide
    await flush();
    expect(wc.loadedUrls.at(-1)).toBe(target);
  });

  it("denies in-page navigation to a file outside the allowed roots", async () => {
    const rig = await openedRig();
    const wc = rig.windows[0]!.webContents;
    const before = wc.loadedUrls.length;
    wc.fireWillNavigate(pathToFileURL("/etc/passwd").href);
    await flush();
    expect(wc.loadedUrls).toHaveLength(before);
  });

  it("allows in-page navigation to localhost", async () => {
    const rig = await openedRig();
    const wc = rig.windows[0]!.webContents;
    wc.fireWillNavigate("http://localhost:8080/page2");
    await flush();
    expect(wc.loadedUrls.at(-1)).toBe("http://localhost:8080/page2");
  });

  it("allows in-page navigation to 127.0.0.1", async () => {
    const rig = await openedRig();
    const wc = rig.windows[0]!.webContents;
    wc.fireWillNavigate("http://127.0.0.1:3000/");
    await flush();
    expect(wc.loadedUrls.at(-1)).toBe("http://127.0.0.1:3000/");
  });

  it("denies in-page navigation to an un-consented remote origin", async () => {
    const rig = await openedRig();
    const wc = rig.windows[0]!.webContents;
    const before = wc.loadedUrls.length;
    wc.fireWillNavigate("https://not-consented.example/");
    await flush();
    expect(wc.loadedUrls).toHaveLength(before);
  });

  it("allows in-page navigation to the SAME origin the preview was opened with consent for", async () => {
    const rig = await openedRig({ url: "https://example.com/app", allowRemote: true });
    const wc = rig.windows[0]!.webContents;
    wc.fireWillNavigate("https://example.com/other-page");
    await flush();
    expect(wc.loadedUrls.at(-1)).toBe("https://example.com/other-page");
  });

  it("consent does NOT extend to a different origin than the one consented to", async () => {
    const rig = await openedRig({ url: "https://example.com/app", allowRemote: true });
    const wc = rig.windows[0]!.webContents;
    const before = wc.loadedUrls.length;
    wc.fireWillNavigate("https://other-origin.example/");
    await flush();
    expect(wc.loadedUrls).toHaveLength(before);
  });

  it("consent is per-preview: a second preview to the same remote origin without allowRemote is refused", async () => {
    const rig = await openedRig({ url: "https://example.com/app", allowRemote: true });
    const second = await rig.host.openForTab(TAB, { url: "https://example.com/other" });
    expect(second).toEqual({ ok: false, error: expect.any(String), errorKind: "invalid_input" });
  });
});

describe("PreviewHost — lifecycle: closeForTab / closeAll", () => {
  it("closeForTab destroys only that tab's previews", async () => {
    const rig = makeRig();
    const a = rig.host.openForTab("tab-a", { path: `${WORKSPACE_ROOT}/a.html` });
    const b = rig.host.openForTab("tab-b", { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    rig.windows[1]!.webContents.fireDidFinishLoad();
    await Promise.all([a, b]);

    rig.host.closeForTab("tab-a");

    expect(rig.windows[0]!.destroyed).toBe(true);
    expect(rig.windows[1]!.destroyed).toBe(false);
    expect(rig.host.listForTab("tab-a")).toEqual([]);
    expect(rig.host.listForTab("tab-b")).toHaveLength(1);
  });

  it("closeAll destroys every preview across every tab", async () => {
    const rig = makeRig();
    const a = rig.host.openForTab("tab-a", { path: `${WORKSPACE_ROOT}/a.html` });
    const b = rig.host.openForTab("tab-b", { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    rig.windows[1]!.webContents.fireDidFinishLoad();
    await Promise.all([a, b]);

    rig.host.closeAll();

    expect(rig.windows.every((w) => w.destroyed)).toBe(true);
    expect(rig.host.listForTab("tab-a")).toEqual([]);
    expect(rig.host.listForTab("tab-b")).toEqual([]);
  });

  it("a preview closed externally (native window close) is removed from listForTab", async () => {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await opened;
    expect(rig.host.listForTab(TAB)).toHaveLength(1);

    rig.windows[0]!.simulateExternalClose();

    expect(rig.host.listForTab(TAB)).toEqual([]);
  });

  it("closeForTab/closeAll are safe to call twice (idempotent)", async () => {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await opened;

    expect(() => {
      rig.host.closeForTab(TAB);
      rig.host.closeForTab(TAB);
      rig.host.closeAll();
    }).not.toThrow();
  });
});

describe("PreviewHost — open timeout / did-fail-load / render-process-gone -> honest errorKind", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out if the page never settles", async () => {
    const rig = makeRig();
    const resultPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: expect.any(String), errorKind: "timeout" });
  });

  it("did-fail-load (non-aborted) resolves load_failed with the honest description", async () => {
    const rig = makeRig();
    const resultPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFailLoad(-6, "ERR_FILE_NOT_FOUND");
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("load_failed");
      expect(result.error).toContain("ERR_FILE_NOT_FOUND");
    }
  });

  it("ignores a SUBFRAME did-fail-load — a blocked/failed subresource degrades the page, does not fail the preview", async () => {
    const rig = makeRig();
    const resultPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    // The request gate blocking a remote iframe surfaces as ERR_BLOCKED_BY_CLIENT
    // with isMainFrame=false; the main document still loaded.
    rig.windows[0]!.webContents.fireDidFailLoad(-20, "ERR_BLOCKED_BY_CLIENT", false);
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });

  it("ignores ERR_ABORTED (-3) — a superseded navigation is not a failure", async () => {
    const rig = makeRig();
    const resultPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFailLoad(-3, "ERR_ABORTED");
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
  });

  it("render-process-gone resolves crashed", async () => {
    const rig = makeRig();
    const resultPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireRenderProcessGone("crashed");
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("crashed");
    }
  });
});

describe("PreviewHost — console ring buffer + throttled event forwarding", () => {
  async function readyRig(): Promise<Rig> {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await opened;
    rig.posted.length = 0; // drop the open response so tests only see console events
    return rig;
  }

  it("caps the ring at 200 entries and increments the drop counter", async () => {
    const rig = await readyRig();
    const previewId = rig.windows[0]!.previewId;
    const wc = rig.windows[0]!.webContents;
    for (let i = 0; i < 205; i++) {
      wc.fireConsoleMessage("log", `entry-${i}`);
    }
    const console_ = rig.host.getConsole(TAB, previewId);
    expect("entries" in console_ ? console_.entries : []).toHaveLength(200);
    expect("dropped" in console_ ? console_.dropped : 0).toBe(5);
  });

  it("truncates a console message to 500 chars", async () => {
    const rig = await readyRig();
    const previewId = rig.windows[0]!.previewId;
    rig.windows[0]!.webContents.fireConsoleMessage("log", "x".repeat(2000));
    const console_ = rig.host.getConsole(TAB, previewId);
    const entries = "entries" in console_ ? console_.entries : [];
    expect(entries[0]!.message).toHaveLength(500);
  });

  it("forwards the first 20 messages in a 10s window individually, then suppresses", () => {
    const rig = makeRigReady();
    const wc = rig.windows[0]!.webContents;
    for (let i = 0; i < 25; i++) {
      wc.fireConsoleMessage("log", `m${i}`);
    }
    const forwarded = rig.posted.filter(
      (p): p is { tabId: string; message: PreviewEventMessage } => p.message.type === PREVIEW_EVENT_TYPE,
    );
    const withEntry = forwarded.filter((p) => p.message.entry !== undefined);
    const summaries = forwarded.filter((p) => p.message.entry === undefined);
    expect(withEntry).toHaveLength(20);
    expect(summaries).toHaveLength(0); // no summary yet — the window hasn't elapsed
  });

  it("emits ONE summary event carrying `suppressed` once the window elapses", () => {
    const rig = makeRigReady();
    const wc = rig.windows[0]!.webContents;
    for (let i = 0; i < 25; i++) {
      wc.fireConsoleMessage("log", `m${i}`);
    }
    rig.clock.time += 10_001; // roll past the 10s window
    wc.fireConsoleMessage("log", "next-window");

    const forwarded = rig.posted.filter(
      (p): p is { tabId: string; message: PreviewEventMessage } => p.message.type === PREVIEW_EVENT_TYPE,
    );
    const summaries = forwarded.filter((p) => p.message.entry === undefined);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.message.suppressed).toBe(5); // 25 - 20 forwarded
  });

  function makeRigReady(): Rig {
    const rig = makeRig();
    void rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    rig.windows[0]!.webContents.fireDidFinishLoad();
    rig.posted.length = 0;
    return rig;
  }
});

describe("PreviewHost — RPC request/response correlation", () => {
  it("posts a response with the same requestId as the request", async () => {
    const rig = makeRig();
    const handled = rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "req-42",
      op: { kind: "open", path: `${WORKSPACE_ROOT}/a.html` },
    });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await handled;

    expect(rig.posted).toHaveLength(1);
    const posted = rig.posted[0]!;
    expect(posted.message.type).toBe(PREVIEW_RESPONSE_TYPE);
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.requestId).toBe("req-42");
      expect(posted.message.result.ok).toBe(true);
    }
  });

  it("unknown previewId on read/screenshot -> ok:false unavailable, posted with the correlating requestId", async () => {
    const rig = makeRig();
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "req-read",
      op: { kind: "read", previewId: "no-such-preview" },
    });
    expect(rig.posted).toHaveLength(1);
    const posted = rig.posted[0]!;
    expect(posted.message.type).toBe(PREVIEW_RESPONSE_TYPE);
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.requestId).toBe("req-read");
      expect(posted.message.result).toEqual({
        ok: false,
        error: expect.any(String),
        errorKind: "unavailable",
      });
    }
  });

  it("screenshot with an unknown previewId behaves the same way", async () => {
    const rig = makeRig();
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "req-shot",
      op: { kind: "screenshot", previewId: "ghost" },
    });
    const posted = rig.posted[0]!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.result).toMatchObject({ ok: false, errorKind: "unavailable" });
    }
  });

  it("no preview open at all -> the exact 'no preview open — use BrowserOpen' message", async () => {
    const rig = makeRig();
    const result = await rig.host.screenshotFor(TAB);
    expect(result).toEqual({
      ok: false,
      error: "no preview open — use BrowserOpen",
      errorKind: "unavailable",
    });
  });
});

describe("PreviewHost — auto-open (turn-end artifacts, cut §1(a))", () => {
  it("does nothing when the setting is off", () => {
    const rig = makeRig();
    rig.autoOpen.enabled = false;
    rig.host.handleArtifacts(TAB, { type: "anycode:preview-artifacts" as const, paths: [`${WORKSPACE_ROOT}/out.html`] });
    expect(rig.windows).toHaveLength(0);
  });

  it("opens a new preview for a fresh artifact path", async () => {
    const rig = makeRig();
    rig.host.handleArtifacts(TAB, { type: "anycode:preview-artifacts" as const, paths: [`${WORKSPACE_ROOT}/out.html`] });
    await flush();
    expect(rig.windows).toHaveLength(1);
  });

  it("dedups by realpath: does not stack a second window on an already-open file", async () => {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/out.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await opened;

    rig.host.handleArtifacts(TAB, { type: "anycode:preview-artifacts" as const, paths: [`${WORKSPACE_ROOT}/out.html`] });
    await flush();

    expect(rig.windows).toHaveLength(1);
  });

  it("silently skips a path outside the allowed roots", async () => {
    const rig = makeRig();
    rig.host.handleArtifacts(TAB, { type: "anycode:preview-artifacts" as const, paths: ["/etc/passwd"] });
    await flush();
    expect(rig.windows).toHaveLength(0);
  });
});

describe("PreviewHost — read op", () => {
  async function readyRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("text format reads document.body.innerText", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      expect(script).toContain("innerText");
      return "hello world";
    };
    const result = await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r1",
      op: { kind: "read", previewId, format: "text" },
    });
    void result;
    const posted = rig.posted.at(-1)!;
    expect(posted.message.type).toBe(PREVIEW_RESPONSE_TYPE);
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      expect(posted.message.result.value).toMatchObject({ text: "hello world" });
    }
  });

  it("html format reads document.documentElement.outerHTML", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      expect(script).toContain("outerHTML");
      return "<html></html>";
    };
    const response = await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r2",
      op: { kind: "read", previewId, format: "html" },
    });
    void response;
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      expect(posted.message.result.value).toMatchObject({ text: "<html></html>" });
    }
  });

  it("selector reads querySelectorAll join + matches count", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      expect(script).toContain("querySelectorAll");
      return { text: "a\nb", matches: 2 };
    };
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r3",
      op: { kind: "read", previewId, selector: ".item" },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      expect(posted.message.result.value).toMatchObject({ text: "a\nb", matches: 2 });
    }
  });

  it("waitForSelector polls until found", async () => {
    const { rig, previewId } = await readyRig();
    let calls = 0;
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      if (script.includes("querySelector(")) {
        calls += 1;
        return calls >= 2; // false the first poll, true the second
      }
      return "done";
    };
    const result = await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r4",
      op: { kind: "read", previewId, waitForSelector: "#ready", waitMs: 1000 },
    });
    void result;
    const posted = rig.posted.at(-1)!;
    expect(posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("waitForSelector never found -> timeout", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      if (script.includes("querySelector(")) return false;
      return "";
    };
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r5",
      op: { kind: "read", previewId, waitForSelector: "#never", waitMs: 300 },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.result).toMatchObject({ ok: false, errorKind: "timeout" });
    }
  });

  it("includeConsole default true attaches console + consoleDropped", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.fireConsoleMessage("warn", "careful");
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => "text";
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r6",
      op: { kind: "read", previewId },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      const value = posted.message.result.value as { console?: PreviewConsoleEntry[]; consoleDropped?: number };
      expect(value.console).toEqual([{ level: "warn", message: "careful", at: expect.any(String) }]);
      expect(value.consoleDropped).toBe(0);
    }
  });

  it("includeConsole:false omits console fields", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => "text";
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r7",
      op: { kind: "read", previewId, includeConsole: false },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      const value = posted.message.result.value as { console?: unknown };
      expect(value.console).toBeUndefined();
    }
  });

  it("previewId omitted picks the most-recently-opened preview", async () => {
    const rig = makeRig();
    const first = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await first;
    rig.clock.time += 10;
    const second = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.windows[1]!.webContents.fireDidFinishLoad();
    const secondResult = await second;
    const secondId = secondResult.ok ? secondResult.value.previewId : "";

    rig.windows[1]!.webContents.executeJavaScriptImpl = async () => "second-page";
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r8",
      op: { kind: "read" },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      expect((posted.message.result.value as { previewId: string }).previewId).toBe(secondId);
    }
  });

  it("no preview open produces the exact honest error", async () => {
    const rig = makeRig();
    const result = await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r9",
      op: { kind: "read" },
    });
    void result;
    const posted = rig.posted[0]!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.result).toEqual({
        ok: false,
        error: "no preview open — use BrowserOpen",
        errorKind: "unavailable",
      });
    }
  });

  it("a still-loading preview waits up to 5s then answers with an honest timeout", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      void rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` }); // never settles
      await flush();
      const previewId = rig.windows[0]!.previewId;

      const resultPromise = rig.host.handleRequest(TAB, {
        type: "anycode:preview-request" as const,
        requestId: "r10",
        op: { kind: "read", previewId },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await resultPromise;
      const posted = rig.posted.find(
        (p) => p.message.type === PREVIEW_RESPONSE_TYPE && p.message.requestId === "r10",
      )!;
      if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
        expect(posted.message.result).toMatchObject({ ok: false, errorKind: "timeout" });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreviewHost — screenshot op", () => {
  async function readyRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("shows inactive + disables throttling before capture, restores throttling after", async () => {
    const { rig, previewId } = await readyRig();
    const wc = rig.windows[0]!.webContents;
    await rig.host.screenshotFor(TAB, previewId);
    expect(rig.windows[0]!.shownInactive).toBe(true);
    expect(wc.backgroundThrottlingCalls).toEqual([false, true]);
  });

  it("escalates to show() + a second capture only when the first is empty", async () => {
    const { rig, previewId } = await readyRig();
    const wc = rig.windows[0]!.webContents;
    let calls = 0;
    wc.capturePageImpl = async () => {
      calls += 1;
      return fakeImage({ empty: calls === 1 });
    };
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(rig.windows[0]!.shown).toBe(true);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("never escalates to show() when the first capture is non-empty", async () => {
    const { rig, previewId } = await readyRig();
    await rig.host.screenshotFor(TAB, previewId);
    expect(rig.windows[0]!.shown).toBe(false);
  });

  it("returns the expected PNG result shape", async () => {
    const { rig, previewId } = await readyRig();
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result).toEqual({
      ok: true,
      value: {
        previewId,
        url: expect.any(String),
        mediaType: "image/png",
        data: expect.any(String),
        width: 800,
        height: 600,
      },
    });
  });
});

/**
 * TASK.99 M1 (CUT.md Gap 3 + CONTRACTS): opening a `.md` path no longer runs
 * the old tmpdir HTML-render pipeline at all — it creates a
 * `viewKind:"dom-md"` record synchronously (no window/panelView, no
 * loadURL, no settle wait). These tests REPLACE the pre-M1 "markdown: never
 * load plaintext" and "reuse-navigate temp file cleanup" describe blocks
 * (removed below): those exercised the OLD `.md` -> render-to-HTML ->
 * tmpdir -> loadURL path, which CUT.md Gap 3 made UNREACHABLE from M1 on,
 * and which M5 deletes outright (the render module + the `PreviewHostDeps`
 * dep that drove it are gone — grep-gated, CUT.md Gap 3). The M1-era test
 * asserting that dep was never invoked even when provided is REMOVED (not
 * repointed) in M5: its whole premise — a dep that exists but is
 * deliberately unreachable — no longer has a subject once the dep itself is
 * deleted from `PreviewHostDeps`; `makeRig`'s deps object contains no such
 * field to (not) pass anymore.
 */
describe("PreviewHost — markdown: dom-md record creation (TASK.99 M1, CUT.md Gap 3 + CONTRACTS)", () => {
  it("creates a ready dom-md record synchronously — no window/panelView, no loadURL", async () => {
    const rig = makeRig();
    // TASK.99 M3 (CUT-mandated flip): this test's intent is the OPEN
    // mechanics (synchronous, no Electron container of the web kind), not
    // the displayMode/container relationship — pinned explicitly to "panel"
    // now that M3 honors displayMode for md too (rig defaults to "window",
    // which would otherwise put this record straight into a live mdWindow;
    // that path is covered by its own describe block below).
    rig.displayModeValue.value = "panel";
    const result = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.renderedFrom).toBe(`${WORKSPACE_ROOT}/doc.md`);
      expect(result.value.url).toBe(pathToFileURL(`${WORKSPACE_ROOT}/doc.md`).href);
    }
    expect(rig.windows).toHaveLength(0);
    expect(rig.panelViews).toHaveLength(0);
    expect(rig.mdWindows).toHaveLength(0);
    const listed = rig.host.listForPanel(TAB).previews;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ viewKind: "dom-md", status: "ready", container: "panel", docVersion: 0 });
  });

  it("refuses honestly on containment failure, without creating any record", async () => {
    const rig = makeRig();
    const result = await rig.host.openForTab(TAB, { path: "/etc/passwd.md" });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("outside_allowed_roots"),
      errorKind: "invalid_input",
    });
    expect(rig.host.listForPanel(TAB).previews).toHaveLength(0);
  });

  it("TASK.99 M3 (CUT-mandated flip of the M1 interim): displayMode 'window' opens DIRECTLY into a live window container, no forcing, no warning", async () => {
    const warn = vi.fn();
    const rig = makeRig({ logger: { log: vi.fn(), warn, error: vi.fn() } });
    rig.displayModeValue.value = "window";
    const result = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    expect(result.ok).toBe(true);
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ container: "window", viewKind: "dom-md" });
    expect(rig.mdWindows).toHaveLength(1);
    expect(rig.mdWindows[0]!.shown).toBe(true);
    // A window-container dom-md record never touches the panel visible slot.
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reuse-navigate .md -> .md mutates the SAME record in place and bumps docVersion", async () => {
    const rig = makeRig();
    const first = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = first.ok ? first.value.previewId : "";

    const second = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc2.md`, previewId });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.previewId).toBe(previewId);
      expect(second.value.renderedFrom).toBe(`${WORKSPACE_ROOT}/doc2.md`);
    }
    const listed = rig.host.listForPanel(TAB).previews;
    expect(listed).toHaveLength(1); // same record, not a second one
    expect(listed[0]).toMatchObject({ previewId, docVersion: 1, sourcePath: `${WORKSPACE_ROOT}/doc2.md` });
  });

  it("cross-viewKind flip .html -> .md (reuse-navigate): destroys the OLD web container, previewId stays valid", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const openHtml = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const first = await openHtml;
    const previewId = first.ok ? first.value.previewId : "";
    expect(rig.panelViews[0]!.destroyed).toBe(false);

    const second = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md`, previewId });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.previewId).toBe(previewId);
    }
    expect(rig.panelViews[0]!.destroyed).toBe(true); // the old web container is torn down
    expect(rig.panelViews).toHaveLength(1); // dom-md never creates a container of its own
    const listed = rig.host.listForPanel(TAB).previews;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ previewId, viewKind: "dom-md" });
  });

  it("cross-viewKind flip .md -> .html (reuse-navigate): creates a FRESH web container under the SAME previewId", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const first = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = first.ok ? first.value.previewId : "";
    expect(rig.panelViews).toHaveLength(0); // dom-md owned no container

    const openHtml = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html`, previewId });
    await flush();
    expect(rig.panelViews).toHaveLength(1); // a fresh container was created for the flip
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const second = await openHtml;
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.previewId).toBe(previewId);
    }
    const listed = rig.host.listForPanel(TAB).previews;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ previewId, viewKind: "web", container: "panel" });
  });

  it("cross-viewKind flip .md -> .html while the md record owns a live window: destroys the OLD mdWindow (no orphan)", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    const first = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = first.ok ? first.value.previewId : "";
    const oldMdWindow = rig.mdWindows[0]!;
    expect(oldMdWindow.destroyed).toBe(false);

    const openHtml = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html`, previewId });
    await flush();
    expect(oldMdWindow.destroyed).toBe(true); // no orphan window left behind by the flip
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const second = await openHtml;
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.previewId).toBe(previewId);
    }
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, viewKind: "web" });
  });
});

/**
 * TASK.99 M3 (CUT.md GAP 1 + CONTRACTS): the window container itself —
 * displayMode-honored direct opens, setContainer transfer both directions,
 * teardown (closeForTab/closeAll/native onClosed), and the epoch guard on a
 * dom-md record's `mdWindow`. Fake `MdPreviewWindowLike` throughout
 * (`FakeMdWindow`) — no Electron runtime, same discipline as the rest of
 * this suite.
 */
describe("PreviewHost — markdown: window container (TASK.99 M3, CUT.md GAP 1 + CONTRACTS)", () => {
  async function openedMdWindowRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    return { rig, previewId: opened.ok ? opened.value.previewId : "" };
  }

  async function openedMdPanelRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    return { rig, previewId: opened.ok ? opened.value.previewId : "" };
  }

  it("setContainer panel->window: creates a live mdWindow, flips containerKind, clears the panel slot, reloaded:true", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewId);

    const result = await rig.host.setContainer(TAB, previewId, "window");
    expect(result).toEqual({ ok: true, reloaded: true });
    expect(rig.mdWindows).toHaveLength(1);
    expect(rig.mdWindows[0]!.previewId).toBe(previewId);
    expect(rig.mdWindows[0]!.shown).toBe(true);
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "window" });
    // The record held the visible slot (it was the only panel preview) -> the slot clears (no survivor).
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBeNull();
  });

  it("setContainer panel->window: promotes the most-recently-opened surviving panel preview's visible slot", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const a = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.md` });
    const previewIdA = a.ok ? a.value.previewId : "";
    rig.clock.time += 10;
    const b = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.md` });
    const previewIdB = b.ok ? b.value.previewId : "";
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewIdB); // D5: newest wins

    const result = await rig.host.setContainer(TAB, previewIdB, "window");
    expect(result).toEqual({ ok: true, reloaded: true });
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewIdA); // survivor promoted
  });

  it("setContainer window->panel: destroys the old mdWindow, flips containerKind, takes the visible slot, reloaded:true", async () => {
    const { rig, previewId } = await openedMdWindowRig();
    const oldMdWindow = rig.mdWindows[0]!;

    const result = await rig.host.setContainer(TAB, previewId, "panel");
    expect(result).toEqual({ ok: true, reloaded: true });
    expect(oldMdWindow.destroyed).toBe(true);
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "panel" });
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewId);
  });

  it("setContainer same-container (window->window / panel->panel) is a zero-churn no-op for dom-md", async () => {
    const { rig: winRig, previewId: winId } = await openedMdWindowRig();
    const sameWindow = await winRig.host.setContainer(TAB, winId, "window");
    expect(sameWindow).toEqual({ ok: true, reloaded: false });
    expect(winRig.mdWindows).toHaveLength(1); // no second window created

    const { rig: panelRig, previewId: panelId } = await openedMdPanelRig();
    const samePanel = await panelRig.host.setContainer(TAB, panelId, "panel");
    expect(samePanel).toEqual({ ok: true, reloaded: false }); // delegates to selectPanelPreview
    expect(panelRig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(panelId);
  });

  it("round trip panel->window->panel: record fields and container kind settle back to the original panel state", async () => {
    const { rig, previewId } = await openedMdPanelRig();

    const toWindow = await rig.host.setContainer(TAB, previewId, "window");
    expect(toWindow).toEqual({ ok: true, reloaded: true });
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "window", viewKind: "dom-md" });
    const mdWindow = rig.mdWindows[0]!;
    expect(mdWindow.destroyed).toBe(false);

    const toPanel = await rig.host.setContainer(TAB, previewId, "panel");
    expect(toPanel).toEqual({ ok: true, reloaded: true });
    expect(mdWindow.destroyed).toBe(true); // the window-leg container is torn down
    expect(rig.host.listForPanel(TAB).previews).toHaveLength(1); // same record survives, not a second one
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "panel", viewKind: "dom-md" });
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewId);
  });

  it("no orphans: closeForTab destroys a live mdWindow", async () => {
    const { rig, previewId } = await openedMdWindowRig();
    const mdWindow = rig.mdWindows[0]!;
    rig.host.closeForTab(TAB);
    expect(mdWindow.destroyed).toBe(true);
    expect(rig.host.listForTab(TAB)).toEqual([]);
    void previewId;
  });

  it("no orphans: closeAll destroys a live mdWindow across every tab", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    await rig.host.openForTab("tab-a", { path: `${WORKSPACE_ROOT}/a.md` });
    await rig.host.openForTab("tab-b", { path: `${WORKSPACE_ROOT}/b.md` });
    expect(rig.mdWindows).toHaveLength(2);

    rig.host.closeAll();
    expect(rig.mdWindows.every((w) => w.destroyed)).toBe(true);
    expect(rig.host.listForTab("tab-a")).toEqual([]);
    expect(rig.host.listForTab("tab-b")).toEqual([]);
  });

  it("a preview closed externally (native window close) is removed from listForTab", async () => {
    const { rig, previewId } = await openedMdWindowRig();
    expect(rig.host.listForTab(TAB)).toHaveLength(1);

    rig.mdWindows[0]!.simulateExternalClose();

    expect(rig.host.listForTab(TAB)).toEqual([]);
    void previewId;
  });

  it("epoch guard: a late close from the OLD mdWindow after a window->panel transfer does not corrupt the surviving record", async () => {
    const { rig, previewId } = await openedMdWindowRig();
    const oldMdWindow = rig.mdWindows[0]!;

    const result = await rig.host.setContainer(TAB, previewId, "panel");
    expect(result).toEqual({ ok: true, reloaded: true });
    expect(rig.host.listForPanel(TAB).previews.map((p) => p.previewId)).toContain(previewId);

    // The old window is already destroyed (setContainer did it), but its
    // onClosed listener can still fire late — the epoch guard (record.mdWindow
    // no longer === oldMdWindow, it's undefined now) must no-op this, not
    // re-enter destroyRecord for a record that is still very much alive.
    oldMdWindow.destroy(); // idempotent — already destroyed; fires listeners again if not guarded

    expect(rig.host.listForPanel(TAB).previews.map((p) => p.previewId)).toContain(previewId);
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "panel" });
  });

  it("epoch guard: a late close from the OLD mdWindow after a panel->window transfer does not corrupt the surviving record", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    const toWindow = await rig.host.setContainer(TAB, previewId, "window");
    expect(toWindow.ok).toBe(true);
    const firstMdWindow = rig.mdWindows[0]!;

    // Transfer straight back out to a SECOND window (panel->window->panel is
    // covered above; this exercises window->window's own churn instead, to
    // get a second live mdWindow whose predecessor's stale close must no-op).
    await rig.host.setContainer(TAB, previewId, "panel");
    await rig.host.setContainer(TAB, previewId, "window");
    const secondMdWindow = rig.mdWindows[1]!;
    expect(secondMdWindow).not.toBe(firstMdWindow);

    firstMdWindow.destroy(); // already-destroyed predecessor fires late

    expect(rig.host.listForPanel(TAB).previews.map((p) => p.previewId)).toContain(previewId);
    expect(rig.host.listForPanel(TAB).previews[0]).toMatchObject({ previewId, container: "window" });
    expect(secondMdWindow.destroyed).toBe(false);
  });
});

/**
 * TASK.99 M2 (CUT.md CONTRACTS): `commitMdNavigate` is the record-mutation
 * half of MD_PREVIEW_NAVIGATE — `md-doc.ts`'s `navigateMdDoc` closes over it
 * (main/index.ts wiring) and calls it ONLY after its own fresh containment/
 * read already succeeded. These tests exercise the REAL `PreviewHost`
 * implementation directly (md-doc.test.ts's own suite stubs this dep as a
 * plain fake, proving `navigateMdDoc`'s call shape but not this method's own
 * mutation/refusal logic).
 */
describe("PreviewHost — commitMdNavigate (TASK.99 M2, CUT.md CONTRACTS)", () => {
  async function openedMdRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = opened.ok ? opened.value.previewId : "";
    return { rig, previewId };
  }

  it("mutates sourcePath/realSourcePath/docDir/title in place, derives url, syncs renderedFrom, and bumps docVersion by exactly one", async () => {
    const { rig, previewId } = await openedMdRig();
    const before = rig.host.listForPanel(TAB).previews[0]!;
    expect(before.docVersion).toBe(0);
    // Pre-navigate: renderedFrom is still the OPEN-time source (CUT invariant "renderedFrom = sourcePath").
    expect(rig.host.getMdDocRef(TAB, previewId)).toMatchObject({ renderedFrom: `${WORKSPACE_ROOT}/doc.md` });

    const newDocVersion = rig.host.commitMdNavigate(TAB, previewId, {
      sourcePath: `${WORKSPACE_ROOT}/docs/other.md`,
      realSourcePath: `${WORKSPACE_ROOT}/docs/other.md`,
      docDir: `${WORKSPACE_ROOT}/docs`,
      title: "other.md",
    });

    expect(newDocVersion).toBe(1);
    const listed = rig.host.listForPanel(TAB).previews;
    expect(listed).toHaveLength(1); // same record, no second preview created (no recursive preview trees)
    expect(listed[0]).toMatchObject({
      previewId,
      sourcePath: `${WORKSPACE_ROOT}/docs/other.md`,
      title: "other.md",
      docVersion: 1,
      url: pathToFileURL(`${WORKSPACE_ROOT}/docs/other.md`).href,
    });
    // M4 residual: navigate previously left renderedFrom stale at its
    // open-time value — it must now track the CURRENT source.
    expect(rig.host.getMdDocRef(TAB, previewId)).toMatchObject({ renderedFrom: `${WORKSPACE_ROOT}/docs/other.md` });
  });

  it("bumps lastOpenedAt to the current clock time", async () => {
    // lastOpenedAt is not surfaced on PreviewSummary; assert indirectly via
    // promoteMostRecentPanelSurvivor's own ordering (D5), which picks the
    // surviving panel record with the HIGHEST lastOpenedAt: A is opened
    // first (oldest), B and C after it, then A alone is navigated (bumping
    // ONLY its own lastOpenedAt to the newest timestamp) before the current
    // visible-slot occupant (C) is closed. If the bump had NOT happened, B
    // (opened after A, before the navigate) would win the promoted slot
    // instead of A — this discriminates the bump from a no-op.
    // TASK.99 M3 (CUT-mandated flip): pinned to "panel" — this test's D5
    // panel-slot-promotion assertions require a panel container, which the
    // rig's default displayMode no longer guarantees for md now that M3
    // honors it (a "window" default would put every one of these three
    // opens into its own live mdWindow instead, never touching the panel
    // visible slot at all).
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const a = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.md` });
    const previewIdA = a.ok ? a.value.previewId : "";
    rig.clock.time += 100;
    await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.md` });
    rig.clock.time += 100;
    const c = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/c.md` });
    const previewIdC = c.ok ? c.value.previewId : "";

    rig.clock.time += 100;
    rig.host.commitMdNavigate(TAB, previewIdA, {
      sourcePath: `${WORKSPACE_ROOT}/a2.md`,
      realSourcePath: `${WORKSPACE_ROOT}/a2.md`,
      docDir: WORKSPACE_ROOT,
      title: "a2.md",
    });

    rig.host.closePreview(TAB, previewIdC); // C was the visible slot occupant (D5: newest wins on open)
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewIdA);
  });

  it("pushes the change (D7) after committing", async () => {
    const { rig, previewId } = await openedMdRig();
    const changedBefore = rig.changed.length;
    rig.host.commitMdNavigate(TAB, previewId, {
      sourcePath: `${WORKSPACE_ROOT}/other.md`,
      realSourcePath: `${WORKSPACE_ROOT}/other.md`,
      docDir: WORKSPACE_ROOT,
      title: "other.md",
    });
    expect(rig.changed.length).toBe(changedBefore + 1);
    expect(rig.changed[rig.changed.length - 1]!.previews[0]).toMatchObject({ previewId, docVersion: 1 });
  });

  it("returns undefined for no such preview", async () => {
    const rig = makeRig();
    const result = rig.host.commitMdNavigate(TAB, "no-such-preview", {
      sourcePath: "x.md",
      realSourcePath: "/workspace/x.md",
      docDir: "/workspace",
      title: "x.md",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for the wrong tab", async () => {
    const { rig, previewId } = await openedMdRig();
    const result = rig.host.commitMdNavigate("other-tab", previewId, {
      sourcePath: "x.md",
      realSourcePath: "/workspace/x.md",
      docDir: "/workspace",
      title: "x.md",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a destroyed record", async () => {
    const { rig, previewId } = await openedMdRig();
    rig.host.closePreview(TAB, previewId);
    const result = rig.host.commitMdNavigate(TAB, previewId, {
      sourcePath: "x.md",
      realSourcePath: "/workspace/x.md",
      docDir: "/workspace",
      title: "x.md",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a 'web' record (md-only channel)", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const openHtml = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const opened = await openHtml;
    const previewId = opened.ok ? opened.value.previewId : "";

    const result = rig.host.commitMdNavigate(TAB, previewId, {
      sourcePath: "x.md",
      realSourcePath: "/workspace/x.md",
      docDir: "/workspace",
      title: "x.md",
    });
    expect(result).toBeUndefined();
  });
});

describe("PreviewHost — request gate (cut §1.1/F2, GATE-MATRIX)", () => {
  async function openedRig(openReq: { path?: string; url?: string; allowRemote?: boolean }): Promise<Rig> {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, openReq);
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    return rig;
  }

  function gateOf(rig: Rig): (req: { url: string; resourceType: string }) => Promise<boolean> {
    const gate = rig.windows[0]!.webContents.requestGate;
    if (gate === undefined) {
      throw new Error("request gate was never installed by wireWindow");
    }
    return gate;
  }

  it("file-kind preview: contained file: subresource ALLOW", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    const url = pathToFileURL(`${WORKSPACE_ROOT}/style.css`).href;
    await expect(gate({ url, resourceType: "stylesheet" })).resolves.toBe(true);
  });

  it("file-kind preview: uncontained file: subresource DENY", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    const url = pathToFileURL("/etc/passwd").href;
    await expect(gate({ url, resourceType: "image" })).resolves.toBe(false);
  });

  it("file-kind preview: about:/data:/blob: ALLOW", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    await expect(gate({ url: "about:blank", resourceType: "subFrame" })).resolves.toBe(true);
    await expect(gate({ url: "data:text/plain,hi", resourceType: "xhr" })).resolves.toBe(true);
    await expect(gate({ url: "blob:https://example.com/some-uuid", resourceType: "xhr" })).resolves.toBe(true);
  });

  it("file-kind preview: localhost xhr+ws ALLOW", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    await expect(gate({ url: "http://localhost:5173/api", resourceType: "xhr" })).resolves.toBe(true);
    await expect(gate({ url: "ws://localhost:5173/socket", resourceType: "webSocket" })).resolves.toBe(true);
  });

  it("file-kind preview: remote script|img|xhr|webSocket|subFrame DENY (consentedOrigins empty)", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    const cases: Array<[string, string]> = [
      ["https://cdn.example/app.js", "script"],
      ["https://cdn.example/logo.png", "image"],
      ["https://api.example/data", "xhr"],
      ["wss://api.example/socket", "webSocket"],
      ["https://embed.example/frame", "subFrame"],
    ];
    for (const [url, resourceType] of cases) {
      await expect(gate({ url, resourceType })).resolves.toBe(false);
    }
  });

  it("localhost-kind preview: same-origin ALLOW, second localhost port ALLOW, remote DENY, contained file: subresource DENY", async () => {
    const rig = await openedRig({ url: "http://localhost:5173/" });
    const gate = gateOf(rig);
    await expect(gate({ url: "http://localhost:5173/api", resourceType: "xhr" })).resolves.toBe(true);
    await expect(gate({ url: "http://localhost:9000/ws", resourceType: "webSocket" })).resolves.toBe(true);
    await expect(gate({ url: "https://evil.tld/", resourceType: "xhr" })).resolves.toBe(false);
    const fileUrl = pathToFileURL(`${WORKSPACE_ROOT}/a.html`).href;
    await expect(gate({ url: fileUrl, resourceType: "image" })).resolves.toBe(false);
  });

  it("remote-kind preview (consented https://a.tld): own origin ALLOW incl. wss://a.tld, other remote DENY, localhost DENY, file: DENY", async () => {
    const rig = await openedRig({ url: "https://a.tld/app", allowRemote: true });
    const gate = gateOf(rig);
    await expect(gate({ url: "https://a.tld/script.js", resourceType: "script" })).resolves.toBe(true);
    await expect(gate({ url: "wss://a.tld/socket", resourceType: "webSocket" })).resolves.toBe(true);
    await expect(gate({ url: "https://other.tld/", resourceType: "xhr" })).resolves.toBe(false);
    await expect(gate({ url: "http://localhost:3000/", resourceType: "xhr" })).resolves.toBe(false);
    const fileUrl = pathToFileURL(`${WORKSPACE_ROOT}/a.html`).href;
    await expect(gate({ url: fileUrl, resourceType: "image" })).resolves.toBe(false);
  });

  it("unparseable URL and devtools: scheme DENY", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    const gate = gateOf(rig);
    await expect(gate({ url: "not a url", resourceType: "xhr" })).resolves.toBe(false);
    await expect(
      gate({ url: "devtools://devtools/bundled/inspector.html", resourceType: "mainFrame" }),
    ).resolves.toBe(false);
  });

  it("answers deny (not throw) when the artifact resolver rejects", async () => {
    const rig = await openedRig({ path: `${WORKSPACE_ROOT}/a.html` });
    rig.resolveArtifactImpl = () => Promise.reject(new Error("resolver exploded"));
    const gate = gateOf(rig);
    await expect(
      gate({ url: pathToFileURL(`${WORKSPACE_ROOT}/b.html`).href, resourceType: "image" }),
    ).resolves.toBe(false);
  });
});

describe("PreviewHost — request gate legibility (cut §1.1, GATE-LEGIBILITY)", () => {
  it("records exactly one deduped ring entry per denied origin/path for subresource denials", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const gate = wc.requestGate!;
    const previewId = rig.windows[0]!.previewId;

    await gate({ url: "https://evil.tld/a.js", resourceType: "script" });
    await gate({ url: "https://evil.tld/b.js", resourceType: "script" });
    await gate({ url: "https://evil.tld/c.png", resourceType: "image" });

    const console_ = rig.host.getConsole(TAB, previewId);
    const entries = "entries" in console_ ? console_.entries : [];
    const blocked = entries.filter((e) => e.message.includes("blocked by security policy"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ level: "warn" });
    expect(blocked[0]!.message).toContain("evil.tld");
  });

  it("a denied mainFrame request logs via deps.logger.warn, not a ring entry", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const previewId = rig.windows[0]!.previewId;

    await wc.requestGate!({ url: "https://evil.tld/", resourceType: "mainFrame" });

    const console_ = rig.host.getConsole(TAB, previewId);
    const entries = "entries" in console_ ? console_.entries : [];
    expect(entries).toEqual([]);
  });
});

describe("PreviewHost — redirect gate (cut §1.2/F1, REDIRECT)", () => {
  it("denies a redirect to a non-consented origin; consentedOrigins does NOT widen", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "https://a.tld/app", allowRemote: true });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;

    const prevented = wc.fireWillRedirect("https://evil.tld/");
    expect(prevented).toBe(true);

    // Consent must not have widened to evil.tld — the gate still denies its origin.
    await expect(wc.requestGate!({ url: "https://evil.tld/", resourceType: "mainFrame" })).resolves.toBe(false);
  });

  it("does not prevent a redirect to the already-consented origin", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "https://a.tld/app", allowRemote: true });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const prevented = wc.fireWillRedirect("https://a.tld/other-page");
    expect(prevented).toBe(false);
  });

  it("does not prevent a redirect to localhost", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "https://a.tld/app", allowRemote: true });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const prevented = wc.fireWillRedirect("http://localhost:8080/");
    expect(prevented).toBe(false);
  });

  it("localhost-kind record: a redirect to a remote origin IS prevented (zero-consent open-redirect path)", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "http://localhost:5173/" });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const prevented = wc.fireWillRedirect("https://evil.tld/");
    expect(prevented).toBe(true);
  });

  it("gate-side: a mainFrame request for the redirect's non-consented origin is denied (doubles as the redirect-leg proof)", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "http://localhost:5173/" });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    await expect(wc.requestGate!({ url: "https://evil.tld/", resourceType: "mainFrame" })).resolves.toBe(false);
  });
});

describe("PreviewHost — read op bounds + exec timeout (cut §1.3/F3)", () => {
  async function readyRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("selectorReadScript literal caps the joined text at READ_RESULT_MAX_CHARS", async () => {
    const { rig, previewId } = await readyRig();
    let capturedScript = "";
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      capturedScript = script;
      return { text: "hi", matches: 1 };
    };
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-1",
      op: { kind: "read", previewId, selector: ".item" },
    });
    expect(capturedScript).toContain(`.slice(0, ${READ_RESULT_MAX_CHARS})`);
  });

  it("whole-document read scripts (text + html) both carry the cap", async () => {
    const { rig, previewId } = await readyRig();
    const scripts: string[] = [];
    rig.windows[0]!.webContents.executeJavaScriptImpl = async (script) => {
      scripts.push(script);
      return "ok";
    };
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-2",
      op: { kind: "read", previewId, format: "text" },
    });
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-3",
      op: { kind: "read", previewId, format: "html" },
    });
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script).toContain(`.slice(0, ${READ_RESULT_MAX_CHARS})`);
    }
  });

  it("executeJavaScript resolving a non-string whole-doc result -> load_failed, not a crash", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => 12345 as unknown;
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-4",
      op: { kind: "read", previewId, format: "text" },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.result).toMatchObject({ ok: false, errorKind: "load_failed" });
    }
  });

  it("a selector read resolving a non-conforming shape -> load_failed", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ text: 123, matches: "one" }) as unknown;
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-5",
      op: { kind: "read", previewId, selector: ".item" },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
      expect(posted.message.result).toMatchObject({ ok: false, errorKind: "load_failed" });
    }
  });

  it("an oversize string result is re-sliced main-side to READ_RESULT_MAX_CHARS", async () => {
    const { rig, previewId } = await readyRig();
    const oversized = "x".repeat(READ_RESULT_MAX_CHARS + 500);
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => oversized;
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "f3-6",
      op: { kind: "read", previewId, format: "text" },
    });
    const posted = rig.posted.at(-1)!;
    if (posted.message.type === PREVIEW_RESPONSE_TYPE && posted.message.result.ok) {
      const value = posted.message.result.value as { text: string };
      expect(value.text).toHaveLength(READ_RESULT_MAX_CHARS);
    }
  });

  it("an executeJavaScript that never resolves -> honest timeout within EXEC_JS_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const { rig, previewId } = await readyRig();
      rig.windows[0]!.webContents.executeJavaScriptImpl = () => new Promise(() => {}); // never resolves
      const resultPromise = rig.host.handleRequest(TAB, {
        type: "anycode:preview-request" as const,
        requestId: "f3-7",
        op: { kind: "read", previewId, format: "text" },
      });
      await vi.advanceTimersByTimeAsync(EXEC_JS_TIMEOUT_MS);
      await resultPromise;
      const posted = rig.posted.find(
        (p) => p.message.type === PREVIEW_RESPONSE_TYPE && p.message.requestId === "f3-7",
      )!;
      if (posted.message.type === PREVIEW_RESPONSE_TYPE) {
        expect(posted.message.result).toMatchObject({ ok: false, errorKind: "timeout" });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreviewHost — TOCTOU realpath load on navigate (cut §1.5/F8a)", () => {
  it("loads the resolved REALPATH on will-navigate, never the raw navUrl", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;

    const rawPath = `${WORKSPACE_ROOT}/link.html`;
    const realPath = `${WORKSPACE_ROOT}/real-target.html`;
    rig.resolveArtifactImpl = async (tabId, path) => {
      if (path === rawPath) {
        return { realPath }; // simulates a symlink resolving somewhere else under root
      }
      return defaultResolveArtifact(tabId, path);
    };

    const wc = rig.windows[0]!.webContents;
    const navUrl = pathToFileURL(rawPath).href;
    wc.fireWillNavigate(navUrl);
    await flush();

    const expectedLoadUrl = pathToFileURL(realPath).href;
    expect(wc.loadedUrls).toContain(expectedLoadUrl);
    expect(wc.loadedUrls).not.toContain(navUrl);
  });
});

describe("PreviewHost — IPv6 loopback normalize (cut §1.6)", () => {
  it("opens http://[::1]:port as kind localhost", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "http://[::1]:3000/" });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await openPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("localhost");
    }
  });

  it("the request gate treats [::1] as local for a mainFrame request", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "http://[::1]:3000/" });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    await expect(wc.requestGate!({ url: "http://[::1]:4000/", resourceType: "mainFrame" })).resolves.toBe(true);
  });

  it("in-page navigation to [::1] is allowed", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    wc.fireWillNavigate("http://[::1]:3000/page2");
    await flush();
    expect(wc.loadedUrls.at(-1)).toBe("http://[::1]:3000/page2");
  });

  it("a redirect to [::1] is not prevented", async () => {
    const rig = makeRig();
    const openPromise = rig.host.openForTab(TAB, { url: "https://a.tld/app", allowRemote: true });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;
    const wc = rig.windows[0]!.webContents;
    const prevented = wc.fireWillRedirect("http://[::1]:9000/");
    expect(prevented).toBe(false);
  });
});

describe("PreviewHost — panel container: displayMode chooses the container (D4), wireWindow runs unchanged (D1)", () => {
  it("displayMode 'panel' creates a panel view (not a window) for a new record", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    expect(rig.panelViews).toHaveLength(1);
    expect(rig.windows).toHaveLength(0);
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    expect(result.ok).toBe(true);
  });

  it("wireWindow ran against the panel view — same security wiring surface as a window (no second copy)", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    expect(view.webContents.windowOpenHandler?.({ url: "https://evil.example/popup" })).toEqual({ action: "deny" });
    const granted = await new Promise<boolean>((resolve) => {
      view.webContents.permissionRequestHandler?.("camera", resolve);
    });
    expect(granted).toBe(false);
    expect(view.webContents.requestGate).toBeDefined();
    view.webContents.fireDidFinishLoad();
    await opened;
    const before = view.webContents.loadedUrls.length;
    const prevented = view.webContents.fireWillNavigate("https://not-consented.example/");
    expect(prevented).toBe(true); // Electron semantics: always preventDefault first, then decide
    await flush();
    expect(view.webContents.loadedUrls).toHaveLength(before); // denied — will-navigate matrix applies unchanged
  });

  it("the panel view stays hidden until every visibility gate is satisfied (D6, applyPanel's default)", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    void rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    expect(rig.panelViews[0]!.visible).toBe(false);
  });
});

describe("PreviewHost — panel visibility reconciler (D6, applyPanel)", () => {
  async function openPanelRecord(tabId = TAB): Promise<{ rig: Rig; previewId: string; view: FakePanelView }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(tabId, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";
    return { rig, previewId, view };
  }

  const FULL_BOUNDS: PreviewPanelBounds = { x: 10, y: 20, width: 300, height: 400 };

  it("each gate false independently forces setVisible(false)", async () => {
    const cases: Array<{ label: string; apply: (rig: Rig, tabId: string) => void }> = [
      {
        label: "panelMounted=false",
        apply: (rig, tabId) => {
          rig.host.setPanelState({ activeTabId: tabId, panelMounted: false, overlayOpen: false });
          rig.host.setPanelBounds(FULL_BOUNDS);
        },
      },
      {
        label: "overlayOpen=true",
        apply: (rig, tabId) => {
          rig.host.setPanelState({ activeTabId: tabId, panelMounted: true, overlayOpen: true });
          rig.host.setPanelBounds(FULL_BOUNDS);
        },
      },
      {
        label: "wrong activeTabId",
        apply: (rig) => {
          rig.host.setPanelState({ activeTabId: "some-other-tab", panelMounted: true, overlayOpen: false });
          rig.host.setPanelBounds(FULL_BOUNDS);
        },
      },
      {
        label: "bounds=null",
        apply: (rig, tabId) => {
          rig.host.setPanelState({ activeTabId: tabId, panelMounted: true, overlayOpen: false });
          rig.host.setPanelBounds(null);
        },
      },
      {
        label: "zero-size bounds",
        apply: (rig, tabId) => {
          rig.host.setPanelState({ activeTabId: tabId, panelMounted: true, overlayOpen: false });
          rig.host.setPanelBounds({ x: 0, y: 0, width: 0, height: 0 });
        },
      },
    ];

    for (const { apply } of cases) {
      const { rig, view } = await openPanelRecord();
      apply(rig, TAB);
      expect(view.visible).toBe(false);
    }
  });

  it("all-true shows exactly the visible-slot record; setBounds (rounded, clamped) is called BEFORE setVisible(true)", async () => {
    const { rig, view } = await openPanelRecord();
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    const rawBounds: PreviewPanelBounds = { x: 10.4, y: 20.6, width: 99_999, height: 400.2 };
    rig.host.setPanelBounds(rawBounds);

    expect(view.visible).toBe(true);
    const setBoundsIdx = view.calls.findIndex((c) => c.kind === "setBounds");
    const setVisibleTrueIdx = view.calls.findIndex((c) => c.kind === "setVisible" && c.visible === true);
    expect(setBoundsIdx).toBeGreaterThanOrEqual(0);
    expect(setVisibleTrueIdx).toBeGreaterThan(setBoundsIdx);
    const boundsCall = view.calls[setBoundsIdx];
    if (boundsCall !== undefined && boundsCall.kind === "setBounds") {
      expect(boundsCall.bounds).toEqual(clampPanelBounds(rawBounds));
    }
  });
});

describe("PreviewHost — panel D5: one visible slot per tab", () => {
  async function openTwoPanels(): Promise<{ rig: Rig; first: string; second: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const firstOpen = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const firstResult = await firstOpen;
    const first = firstResult.ok ? firstResult.value.previewId : "";

    rig.clock.time += 10;
    const secondOpen = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    const secondResult = await secondOpen;
    const second = secondResult.ok ? secondResult.value.previewId : "";

    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds({ x: 0, y: 0, width: 300, height: 400 });
    return { rig, first, second };
  }

  it("first opened is hidden, second (most recent) is visible", async () => {
    const { rig } = await openTwoPanels();
    expect(rig.panelViews[0]!.visible).toBe(false);
    expect(rig.panelViews[1]!.visible).toBe(true);
  });

  it("selectPanelPreview flips the visible slot", async () => {
    const { rig, first } = await openTwoPanels();
    const result = rig.host.selectPanelPreview(TAB, first);
    expect(result).toEqual({ ok: true });
    expect(rig.panelViews[0]!.visible).toBe(true);
    expect(rig.panelViews[1]!.visible).toBe(false);
  });

  it("closing the visible one promotes the most-recently-opened survivor", async () => {
    const { rig, second } = await openTwoPanels();
    expect(rig.panelViews[1]!.visible).toBe(true); // second is visible before close

    const result = rig.host.closePreview(TAB, second);
    expect(result).toEqual({ ok: true });
    expect(rig.panelViews[0]!.visible).toBe(true); // promoted survivor
  });

  it("PreviewChangedPayload is correct at each step (open/select/close)", async () => {
    const { rig, first, second } = await openTwoPanels();
    const afterOpen = rig.host.listForPanel(TAB);
    expect(afterOpen.previews.map((p) => p.previewId).sort()).toEqual([first, second].sort());
    expect(afterOpen.visiblePanelPreviewId).toBe(second);

    rig.host.selectPanelPreview(TAB, first);
    const afterSelect = rig.host.listForPanel(TAB);
    expect(afterSelect.visiblePanelPreviewId).toBe(first);

    rig.host.closePreview(TAB, first);
    const afterClose = rig.host.listForPanel(TAB);
    expect(afterClose.previews.map((p) => p.previewId)).toEqual([second]);
    expect(afterClose.visiblePanelPreviewId).toBe(second);
  });
});

describe("PreviewHost — panel D13: screenshot promotes a hidden panel preview", () => {
  it("promotes the target to the visible slot", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    // Not mounted — applyPanel keeps it hidden regardless of the promotion.
    expect(view.visible).toBe(false);

    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot.ok).toBe(true);
    // The visible-slot map now points at this preview (the promotion itself
    // happened) even though applyPanel still kept it hidden (panelMounted
    // was never set) — the overlay/tab/mount gates are never bypassed.
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewId);
  });

  it("honest 'unavailable' when the capture is empty AND an overlay keeps it hidden — never bypasses the gate", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.capturePageImpl = async () => fakeImage({ empty: true });
    view.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    // Mounted + active tab, but an overlay is open — applyPanel keeps it hidden.
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: true });
    rig.host.setPanelBounds({ x: 0, y: 0, width: 300, height: 400 });

    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
    expect(view.visible).toBe(false); // never forced visible to satisfy the capture
    expect(view.shown).toBe(false); // show() must never be called for a panel container
  });
});

describe("PreviewHost — panel D18: UnknownVizError retry on promote-then-capture (CUT.md §6)", () => {
  async function readyPanelRecord(): Promise<{ rig: Rig; previewId: string; view: FakePanelView }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";
    return { rig, previewId, view };
  }

  it("panel: one UnknownVizError then success ⇒ ok:true, and the retry actually waited for the paint delay", async () => {
    vi.useFakeTimers();
    try {
      const { rig, previewId, view } = await readyPanelRecord();
      view.webContents.captureRejections = [new Error("UnknownVizError: not ready")];

      const shotPromise = rig.host.screenshotFor(TAB, previewId);
      await flush();
      await flush();
      // The first capturePage() has rejected and the retry is parked behind
      // `sleep(PANEL_SCREENSHOT_RETRY_DELAY_MS)` — the second call must NOT
      // have happened yet (proof the retry actually waited, not fired eagerly).
      expect(view.webContents.captureCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_RETRY_DELAY_MS);
      const result = await shotPromise;

      expect(result.ok).toBe(true);
      expect(view.webContents.captureCalls).toBe(2); // exactly one retry
    } finally {
      vi.useRealTimers();
    }
  });

  it("panel: two UnknownVizError rejections ⇒ honest 'unavailable' with the remediation hint", async () => {
    vi.useFakeTimers();
    try {
      const { rig, previewId, view } = await readyPanelRecord();
      view.webContents.captureRejections = [
        new Error("UnknownVizError: not ready"),
        new Error("UnknownVizError: still not ready"),
      ];

      const shotPromise = rig.host.screenshotFor(TAB, previewId);
      await flush();
      await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_RETRY_DELAY_MS);
      const result = await shotPromise;

      expect(result).toMatchObject({ ok: false, errorKind: "unavailable" });
      if (!result.ok) {
        expect(result.error).toContain("switch to the tab or move the preview to a window");
      }
      expect(view.webContents.captureCalls).toBe(2); // retried exactly once, no further attempts
    } finally {
      vi.useRealTimers();
    }
  });

  it("panel: a non-Viz rejection is NOT retried — existing generic load_failed catch, unchanged", async () => {
    const { rig, previewId, view } = await readyPanelRecord();
    view.webContents.captureRejections = [new Error("NS_BINDING_ABORTED: some other capture failure")];

    const result = await rig.host.screenshotFor(TAB, previewId);

    expect(result).toMatchObject({ ok: false, errorKind: "load_failed" });
    if (!result.ok) {
      expect(result.error).toContain("some other capture failure");
    }
    expect(view.webContents.captureCalls).toBe(1); // no retry for a non-Viz rejection
  });

  it("window: an UnknownVizError rejection is NOT retried — existing generic behavior, exactly one capturePage call", async () => {
    const rig = makeRig(); // default displayMode "window" (byte-untouched stage-1 path)
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const win = rig.windows[0]!;
    win.webContents.fireDidFinishLoad();
    const openResult = await opened;
    const previewId = openResult.ok ? openResult.value.previewId : "";

    win.webContents.captureRejections = [new Error("UnknownVizError: not ready")];
    const result = await rig.host.screenshotFor(TAB, previewId);

    expect(result).toMatchObject({ ok: false, errorKind: "load_failed" });
    expect(win.webContents.captureCalls).toBe(1); // no panel-only retry semantics on a window container
  });
});

describe("PreviewHost — panel F1: empty-first-capture retry gated on `promoted` (D18 race class, TASK.99 M1 dom-md slot handoff)", () => {
  /** Two panel previews on one tab (D5): opening `second` moves the visible slot off `first`, so screenshotting `first` afterwards is a `promoted` call; screenshotting `second` is not. */
  async function openTwoPanelRecords(): Promise<{
    rig: Rig;
    first: string;
    second: string;
    firstView: FakePanelView;
    secondView: FakePanelView;
  }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const firstOpen = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const firstView = rig.panelViews[0]!;
    firstView.webContents.fireDidFinishLoad();
    const firstResult = await firstOpen;
    const first = firstResult.ok ? firstResult.value.previewId : "";

    const secondOpen = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    const secondView = rig.panelViews[1]!;
    secondView.webContents.fireDidFinishLoad();
    const secondResult = await secondOpen;
    const second = secondResult.ok ? secondResult.value.previewId : "";

    return { rig, first, second, firstView, secondView };
  }

  it("promoted + empty first capture ⇒ retries once after the paint delay and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { rig, first, firstView } = await openTwoPanelRecords();
      // `first` is currently hidden (second holds the slot) — screenshotting it re-promotes it.
      firstView.webContents.capturePageImpl = async () =>
        fakeImage({ empty: firstView.webContents.captureCalls === 1 });

      const shotPromise = rig.host.screenshotFor(TAB, first);
      await flush();
      await flush();
      // First capturePage() has resolved empty and the retry is parked behind
      // sleep(PANEL_SCREENSHOT_RETRY_DELAY_MS) — proof it actually waited.
      expect(firstView.webContents.captureCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_RETRY_DELAY_MS);
      const result = await shotPromise;

      expect(result.ok).toBe(true);
      expect(firstView.webContents.captureCalls).toBe(2); // exactly one retry
    } finally {
      vi.useRealTimers();
    }
  });

  it("NOT promoted (slot already held by the target) + empty capture ⇒ honest refusal, zero retry", async () => {
    const { rig, second, secondView } = await openTwoPanelRecords();
    // `second` already holds the visible slot from its own open — screenshotting it promotes nothing.
    secondView.webContents.capturePageImpl = async () => fakeImage({ empty: true });

    const result = await rig.host.screenshotFor(TAB, second);

    expect(result).toMatchObject({ ok: false, errorKind: "unavailable" });
    if (!result.ok) {
      expect(result.error).toContain("screenshot unavailable while the panel preview is hidden");
    }
    expect(secondView.webContents.captureCalls).toBe(1); // zero retry — no promote happened
  });

  it("promoted + the retry is ALSO empty ⇒ honest refusal, exactly 2 capturePage calls", async () => {
    vi.useFakeTimers();
    try {
      const { rig, first, firstView } = await openTwoPanelRecords();
      firstView.webContents.capturePageImpl = async () => fakeImage({ empty: true });

      const shotPromise = rig.host.screenshotFor(TAB, first);
      await flush();
      await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_RETRY_DELAY_MS);
      const result = await shotPromise;

      expect(result).toMatchObject({ ok: false, errorKind: "unavailable" });
      if (!result.ok) {
        expect(result.error).toContain("screenshot unavailable while the panel preview is hidden");
      }
      expect(firstView.webContents.captureCalls).toBe(2); // retried exactly once, no further attempts
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreviewHost — panel lifecycle: closeForTab/closeAll destroy panel views; reload reset hides all", () => {
  it("closeForTab destroys panel views for that tab only", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const a = rig.host.openForTab("tab-a", { path: `${WORKSPACE_ROOT}/a.html` });
    const b = rig.host.openForTab("tab-b", { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    await Promise.all([a, b]);

    rig.host.closeForTab("tab-a");

    expect(rig.panelViews[0]!.destroyed).toBe(true);
    expect(rig.panelViews[1]!.destroyed).toBe(false);
  });

  it("closeAll destroys every panel view across every tab", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const a = rig.host.openForTab("tab-a", { path: `${WORKSPACE_ROOT}/a.html` });
    const b = rig.host.openForTab("tab-b", { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    await Promise.all([a, b]);

    rig.host.closeAll();

    expect(rig.panelViews.every((v) => v.destroyed)).toBe(true);
  });

  it("renderer-reload reset (setPanelState all-hidden + setPanelBounds(null)) hides every panel", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.fireDidFinishLoad();
    await opened;
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds({ x: 0, y: 0, width: 300, height: 400 });
    expect(view.visible).toBe(true);

    // main/index.ts's did-finish-load reset (D7).
    rig.host.setPanelState({ activeTabId: null, panelMounted: false, overlayOpen: false });
    rig.host.setPanelBounds(null);

    expect(view.visible).toBe(false);
  });
});

describe("PreviewHost — panel container: security regression (invariant 7, same policy as windows, zero assert changes)", () => {
  async function openedPanelRig(
    openReq: { path?: string; url?: string; allowRemote?: boolean } = { path: `${WORKSPACE_ROOT}/a.html` },
  ): Promise<{ rig: Rig; view: FakePanelView }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const openPromise = rig.host.openForTab(TAB, openReq);
    await flush();
    const view = rig.panelViews[0]!;
    view.webContents.fireDidFinishLoad();
    await openPromise;
    return { rig, view };
  }

  it("wires setWindowOpenHandler to always deny", async () => {
    const { view } = await openedPanelRig();
    expect(view.webContents.windowOpenHandler?.({ url: "https://evil.example/popup" })).toEqual({ action: "deny" });
  });

  it("wires setPermissionRequestHandler to deny every permission", async () => {
    const { view } = await openedPanelRig();
    for (const permission of ["camera", "microphone", "geolocation", "notifications", "clipboard-read"]) {
      const granted = await new Promise<boolean>((resolve) => {
        view.webContents.permissionRequestHandler?.(permission, resolve);
      });
      expect(granted).toBe(false);
    }
  });

  it("will-navigate: allows a file under an allowed root, denies one outside", async () => {
    const { view } = await openedPanelRig();
    const target = pathToFileURL(`${WORKSPACE_ROOT}/other.html`).href;
    const prevented = view.webContents.fireWillNavigate(target);
    expect(prevented).toBe(true);
    await flush();
    expect(view.webContents.loadedUrls.at(-1)).toBe(target);

    const before = view.webContents.loadedUrls.length;
    view.webContents.fireWillNavigate(pathToFileURL("/etc/passwd").href);
    await flush();
    expect(view.webContents.loadedUrls).toHaveLength(before);
  });

  it("will-navigate: allows localhost, denies an un-consented remote origin", async () => {
    const { view } = await openedPanelRig();
    view.webContents.fireWillNavigate("http://localhost:8080/page2");
    await flush();
    expect(view.webContents.loadedUrls.at(-1)).toBe("http://localhost:8080/page2");

    const before = view.webContents.loadedUrls.length;
    view.webContents.fireWillNavigate("https://not-consented.example/");
    await flush();
    expect(view.webContents.loadedUrls).toHaveLength(before);
  });

  it("request gate: file-kind panel denies an uncontained file: subresource, allows a contained one", async () => {
    const { view } = await openedPanelRig();
    const gate = view.webContents.requestGate!;
    await expect(
      gate({ url: pathToFileURL(`${WORKSPACE_ROOT}/style.css`).href, resourceType: "stylesheet" }),
    ).resolves.toBe(true);
    await expect(gate({ url: pathToFileURL("/etc/passwd").href, resourceType: "image" })).resolves.toBe(false);
  });

  it("request gate: remote script/xhr denied with empty consentedOrigins", async () => {
    const { view } = await openedPanelRig();
    const gate = view.webContents.requestGate!;
    await expect(gate({ url: "https://cdn.example/app.js", resourceType: "script" })).resolves.toBe(false);
    await expect(gate({ url: "https://api.example/data", resourceType: "xhr" })).resolves.toBe(false);
  });

  it("open refuses a remote URL without allowRemote and destroys the fresh panel view", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const result = await rig.host.openForTab(TAB, { url: "https://example.com/dashboard" });
    expect(result).toEqual({ ok: false, error: expect.any(String), errorKind: "invalid_input" });
    expect(rig.panelViews[0]!.destroyed).toBe(true);
    expect(rig.panelViews[0]!.webContents.loadedUrls).toEqual([]);
  });
});

describe("PreviewHost — setContainer: unknown preview (96-P3)", () => {
  it("unknown previewId -> ok:false, no container churn", async () => {
    const rig = makeRig();
    const result = await rig.host.setContainer(TAB, "ghost", "panel");
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(rig.windows).toHaveLength(0);
    expect(rig.panelViews).toHaveLength(0);
  });

  it("wrong tabId -> ok:false", async () => {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    const transfer = await rig.host.setContainer("some-other-tab", previewId, "panel");
    expect(transfer).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("PreviewHost — setContainer: same-container is a zero-churn no-op (96-P3)", () => {
  it("window -> window is a pure no-op ({ok:true, reloaded:false}), zero create/destroy calls", async () => {
    const rig = makeRig();
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    const transfer = await rig.host.setContainer(TAB, previewId, "window");
    expect(transfer).toEqual({ ok: true, reloaded: false });
    expect(rig.windows).toHaveLength(1);
    expect(rig.panelViews).toHaveLength(0);
    expect(rig.windows[0]!.destroyed).toBe(false);
  });

  it("panel -> panel delegates to selectPanelPreview, zero create/destroy calls", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const first = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const firstResult = await first;
    const firstId = firstResult.ok ? firstResult.value.previewId : "";

    rig.clock.time += 10;
    const second = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    await second;
    // second is the visible slot (most-recently-opened, D5).
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).not.toBe(firstId);

    const transfer = await rig.host.setContainer(TAB, firstId, "panel");
    expect(transfer).toEqual({ ok: true, reloaded: false });
    expect(rig.panelViews).toHaveLength(2);
    expect(rig.panelViews.every((v) => !v.destroyed)).toBe(true);
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(firstId);
  });
});

describe("PreviewHost — setContainer: D14 transfer window -> panel (96-P3)", () => {
  async function openedWindowRig(
    openReq: { path?: string; url?: string; allowRemote?: boolean } = { path: `${WORKSPACE_ROOT}/a.html` },
  ): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig(); // default displayMode "window" — untouched by this describe's setup
    const opened = rig.host.openForTab(TAB, openReq);
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("creates a panel view with the SAME previewId (partition continuity), destroys the old window, and the record SURVIVES", async () => {
    const { rig, previewId } = await openedWindowRig();
    const oldWindow = rig.windows[0]!;

    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    expect(rig.panelViews).toHaveLength(1);
    expect(rig.panelViews[0]!.previewId).toBe(previewId); // same previewId => same partition upstream (D2)
    expect(oldWindow.destroyed).toBe(true); // old container torn down as part of the transfer

    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await transferPromise;

    expect(result).toEqual({ ok: true, reloaded: true });
    // Epoch-guarded onClosed proof: the OLD window's onClosed already fired
    // (via destroy() above) yet the record is still in the map.
    expect(rig.host.listForPanel(TAB).previews.map((p) => p.previewId)).toContain(previewId);
  });

  it("re-wires the new panel contents with the SAME security wiring (no second copy)", async () => {
    const { rig, previewId } = await openedWindowRig();
    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    const view = rig.panelViews[0]!;

    expect(view.webContents.windowOpenHandler?.({ url: "https://evil.example/popup" })).toEqual({ action: "deny" });
    const granted = await new Promise<boolean>((resolve) => {
      view.webContents.permissionRequestHandler?.("camera", resolve);
    });
    expect(granted).toBe(false);
    expect(view.webContents.requestGate).toBeDefined();

    view.webContents.fireDidFinishLoad();
    const result = await transferPromise;
    expect(result.ok).toBe(true);
  });

  it("captures history from the OLD contents and calls restoreNavigationHistory with it on the NEW contents", async () => {
    const { rig, previewId } = await openedWindowRig();
    const history = {
      entries: [
        { url: pathToFileURL(`${WORKSPACE_ROOT}/a.html`).href, title: "A" },
        { url: pathToFileURL(`${WORKSPACE_ROOT}/other.html`).href, title: "Other" },
      ],
      index: 1,
    };
    rig.windows[0]!.webContents.navigationHistoryEntries = history.entries;
    rig.windows[0]!.webContents.navigationHistoryIndex = history.index;

    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    expect(rig.panelViews[0]!.webContents.restoreNavigationHistoryCalls).toEqual([history]);

    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    await transferPromise;
  });

  it("empty history falls back to loadURL(record.url), never calling restoreNavigationHistory", async () => {
    const { rig, previewId } = await openedWindowRig();
    // navigationHistoryEntries defaults to [] on the fake — no history captured for this preview.
    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();

    expect(rig.panelViews[0]!.webContents.restoreNavigationHistoryCalls).toEqual([]);
    expect(rig.panelViews[0]!.webContents.loadedUrls).toContain(pathToFileURL(`${WORKSPACE_ROOT}/a.html`).href);

    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await transferPromise;
    expect(result).toEqual({ ok: true, reloaded: true });
  });

  it("consoleRing and consentedOrigins survive the transfer, and the NEW contents' request gate honors prior consent (security continuity)", async () => {
    const { rig, previewId } = await openedWindowRig({ url: "https://a.tld/app", allowRemote: true });
    rig.windows[0]!.webContents.fireConsoleMessage("log", "hello-from-old-container");

    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    await transferPromise;

    const console_ = rig.host.getConsole(TAB, previewId);
    const entries = "entries" in console_ ? console_.entries : [];
    expect(entries.some((e) => e.message === "hello-from-old-container")).toBe(true);

    const gate = rig.panelViews[0]!.webContents.requestGate!;
    await expect(gate({ url: "https://a.tld/script.js", resourceType: "script" })).resolves.toBe(true);
    await expect(gate({ url: "https://other-origin.example/", resourceType: "xhr" })).resolves.toBe(false);
  });

  it("late old-contents events after the swap (did-fail-load / render-process-gone) leave record status untouched", async () => {
    const { rig, previewId } = await openedWindowRig();
    const oldWindow = rig.windows[0]!;

    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    await transferPromise;

    expect(rig.host.listForPanel(TAB).previews.find((p) => p.previewId === previewId)?.status).toBe("ready");

    // The old window is already destroyed, but its FakeWebContents can still
    // fire late-arriving events synchronously — the epoch guard must no-op them.
    oldWindow.webContents.fireDidFailLoad(-6, "ERR_FILE_NOT_FOUND");
    oldWindow.webContents.fireRenderProcessGone("crashed");

    expect(rig.host.listForPanel(TAB).previews.find((p) => p.previewId === previewId)?.status).toBe("ready");
  });

  it("restoreNavigationHistory rejecting -> honest {ok:false} + status 'failed'", async () => {
    const rig = makeRig();
    rig.onPanelViewCreated = (view) => {
      view.webContents.restoreNavigationHistoryImpl = () => Promise.reject(new Error("restore exploded"));
    };
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const openedResult = await opened;
    const previewId = openedResult.ok ? openedResult.value.previewId : "";
    rig.windows[0]!.webContents.navigationHistoryEntries = [{ url: "https://x.example/", title: "x" }];

    const result = await rig.host.setContainer(TAB, previewId, "panel");
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(rig.host.listForPanel(TAB).previews.find((p) => p.previewId === previewId)?.status).toBe("failed");
  });

  it("a settle failure on the new container after a successful restore -> honest {ok:false} + status 'failed'", async () => {
    const { rig, previewId } = await openedWindowRig();
    const transferPromise = rig.host.setContainer(TAB, previewId, "panel");
    await flush();
    rig.panelViews[0]!.webContents.fireDidFailLoad(-6, "ERR_FILE_NOT_FOUND");
    const result = await transferPromise;

    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(rig.host.listForPanel(TAB).previews.find((p) => p.previewId === previewId)?.status).toBe("failed");
  });
});

describe("PreviewHost — setContainer: D14 transfer panel -> window (96-P3)", () => {
  async function openedPanelRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("creates a window, destroys the old panel view, clears the visible slot, and show()s the new window", async () => {
    const { rig, previewId } = await openedPanelRig();
    const oldView = rig.panelViews[0]!;
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(previewId);

    const transferPromise = rig.host.setContainer(TAB, previewId, "window");
    await flush();
    expect(rig.windows).toHaveLength(1);
    expect(oldView.destroyed).toBe(true);

    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await transferPromise;

    expect(result).toEqual({ ok: true, reloaded: true });
    expect(rig.windows[0]!.shown).toBe(true);
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBeNull();
  });

  it("promotes the most-recently-opened surviving panel preview's visible slot when the transferred-out preview held it", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const first = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const firstResult = await first;
    const firstId = firstResult.ok ? firstResult.value.previewId : "";

    rig.clock.time += 10;
    const second = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    const secondResult = await second;
    const secondId = secondResult.ok ? secondResult.value.previewId : "";
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(secondId);

    const transferPromise = rig.host.setContainer(TAB, secondId, "window");
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await transferPromise;

    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(firstId);
  });

  it("transferring a HIDDEN (non-visible-slot) panel preview out leaves the visible slot untouched", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const first = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.panelViews[0]!.webContents.fireDidFinishLoad();
    const firstResult = await first;
    const firstId = firstResult.ok ? firstResult.value.previewId : "";

    rig.clock.time += 10;
    const second = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.html` });
    await flush();
    rig.panelViews[1]!.webContents.fireDidFinishLoad();
    const secondResult = await second;
    const secondId = secondResult.ok ? secondResult.value.previewId : "";
    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(secondId); // first is hidden

    const transferPromise = rig.host.setContainer(TAB, firstId, "window");
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await transferPromise;

    expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(secondId); // untouched
  });
});

/**
 * TASK.99 M4 (CUT.md GAP 2): BrowserRead for a dom-md preview — raw markdown
 * source (no rendering machinery), honest selector refusal, custody mirrors
 * md-doc.ts's own MD_PREVIEW_READ handler (fresh containment + size cap +
 * O_NOFOLLOW read) via the SAME `resolveArtifact`/`statMdSource`/
 * `readMdSourceNoFollow` deps `main/index.ts` binds to the identical
 * underlying primitives. Web-record read behavior is UNCHANGED — covered by
 * the pre-existing "PreviewHost — read op" describe block above, untouched.
 */
describe("PreviewHost — markdown: BrowserRead (TASK.99 M4, CUT.md GAP 2)", () => {
  async function openedMdPanelRig(sourceText = "# Hello\n\nSome *markdown*.\n"): Promise<{ rig: Rig; previewId: string; realPath: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const realPath = `${WORKSPACE_ROOT}/doc.md`;
    rig.mdSourceFiles.set(realPath, { bytes: Buffer.from(sourceText, "utf8") });
    const opened = await rig.host.openForTab(TAB, { path: realPath });
    const previewId = opened.ok ? opened.value.previewId : "";
    return { rig, previewId, realPath };
  }

  async function readMd(
    rig: Rig,
    previewId: string,
    op: Omit<Extract<PreviewOp, { kind: "read" }>, "kind" | "previewId">,
  ): Promise<unknown> {
    await rig.host.handleRequest(TAB, {
      type: "anycode:preview-request" as const,
      requestId: "r",
      op: { kind: "read", previewId, ...op },
    });
    const posted = rig.posted.at(-1)!;
    return posted.message.type === PREVIEW_RESPONSE_TYPE ? posted.message.result : undefined;
  }

  it("plain read returns the raw markdown source, console:[] consoleDropped:0", async () => {
    const { rig, previewId } = await openedMdPanelRig("# Hello\n\nSome *markdown*.\n");
    const result = await readMd(rig, previewId, {});
    expect(result).toMatchObject({
      ok: true,
      value: {
        previewId,
        text: "# Hello\n\nSome *markdown*.\n",
        console: [],
        consoleDropped: 0,
      },
    });
  });

  it('format:"html" ALSO returns the raw source (no server-rendered HTML exists for a dom-md preview)', async () => {
    const { rig, previewId } = await openedMdPanelRig("# H\n");
    const result = await readMd(rig, previewId, { format: "html" });
    expect(result).toMatchObject({ ok: true, value: { text: "# H\n" } });
  });

  it("includeConsole:false omits console fields (same convention as the web branch)", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    const result = await readMd(rig, previewId, { includeConsole: false });
    expect(result).toMatchObject({ ok: true });
    const value = (result as { ok: true; value: { console?: unknown } }).value;
    expect(value.console).toBeUndefined();
  });

  it("selector present -> invalid_input with the mandated refusal wording, verbatim", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    const result = await readMd(rig, previewId, { selector: ".item" });
    expect(result).toEqual({
      ok: false,
      errorKind: "invalid_input",
      error: "this is a markdown preview rendered natively; selectors are not supported — read returns the markdown source",
    });
  });

  it("waitForSelector present -> the SAME mandated refusal wording, verbatim", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    const result = await readMd(rig, previewId, { waitForSelector: "#ready" });
    expect(result).toEqual({
      ok: false,
      errorKind: "invalid_input",
      error: "this is a markdown preview rendered natively; selectors are not supported — read returns the markdown source",
    });
  });

  it("too-large (over MD_PREVIEW_MAX_SOURCE_BYTES) -> honest 'unavailable' refusal", async () => {
    const { rig, previewId, realPath } = await openedMdPanelRig();
    rig.mdSourceFiles.get(realPath)!.sizeOverride = MD_PREVIEW_MAX_SOURCE_BYTES + 1;
    const result = await readMd(rig, previewId, {});
    expect(result).toMatchObject({ ok: false, errorKind: "unavailable" });
  });

  it("deleted file (stat fails since open) -> honest 'load_failed' refusal", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.mdSourceFiles.clear(); // statMdSource now returns undefined — simulates deletion
    const result = await readMd(rig, previewId, {});
    expect(result).toMatchObject({ ok: false, errorKind: "load_failed" });
  });

  it("outside allowed roots since open (moved workspace / symlink swap) -> honest 'invalid_input' refusal", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.resolveArtifactImpl = async () => ({ failure: "outside_allowed_roots" });
    const result = await readMd(rig, previewId, {});
    expect(result).toMatchObject({ ok: false, errorKind: "invalid_input" });
  });

  it("truncates the returned text at READ_RESULT_MAX_CHARS (oversized-but-under-cap source)", async () => {
    const longText = "x".repeat(READ_RESULT_MAX_CHARS + 50_000);
    const { rig, previewId } = await openedMdPanelRig(longText);
    const result = await readMd(rig, previewId, {});
    expect(result).toMatchObject({ ok: true });
    const text = (result as { ok: true; value: { text: string } }).value.text;
    expect(text).toHaveLength(READ_RESULT_MAX_CHARS);
    expect(text).toBe(longText.slice(0, READ_RESULT_MAX_CHARS));
  });

  it("re-reads from disk on every call — no cache (mirrors a renderer Reload)", async () => {
    const { rig, previewId, realPath } = await openedMdPanelRig("version 1");
    const first = await readMd(rig, previewId, {});
    expect(first).toMatchObject({ ok: true, value: { text: "version 1" } });

    rig.mdSourceFiles.set(realPath, { bytes: Buffer.from("version 2", "utf8") });
    const second = await readMd(rig, previewId, {});
    expect(second).toMatchObject({ ok: true, value: { text: "version 2" } });
  });
});

/**
 * TASK.99 M4 (CUT.md GAP 2): BrowserScreenshot for a dom-md preview.
 * PANEL leg: `deps.captureMainWindowRect(rect)` gated EXACTLY like
 * `applyPanel()`'s own visibility predicate, promote-then-unconditional-delay
 * on a slot handoff (never retry-driven, unlike D18's web-only UVE retry).
 * WINDOW leg: the record's own `MdPreviewWindowLike` — showInactive +
 * throttling-off + capturePage, mirroring the web window branch's own
 * empty-image show()+recapture fallback. Web-record screenshot behavior is
 * UNCHANGED — covered by the pre-existing "PreviewHost — screenshot op" /
 * D13 / D18 / F1 describe blocks above, untouched.
 */
describe("PreviewHost — markdown: BrowserScreenshot (TASK.99 M4, CUT.md GAP 2)", () => {
  const MD_FULL_BOUNDS: PreviewPanelBounds = { x: 10, y: 20, width: 300, height: 400 };

  async function openedMdPanelRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig();
    rig.displayModeValue.value = "panel";
    const realPath = `${WORKSPACE_ROOT}/doc.md`;
    rig.mdSourceFiles.set(realPath, { bytes: Buffer.from("# doc", "utf8") });
    const opened = await rig.host.openForTab(TAB, { path: realPath });
    const previewId = opened.ok ? opened.value.previewId : "";
    return { rig, previewId };
  }

  /** Same record, but the panel gates are all satisfied (mounted, no overlay, active tab, real bounds). */
  async function openedMdPanelRigVisible(): Promise<{ rig: Rig; previewId: string }> {
    const { rig, previewId } = await openedMdPanelRig();
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds(MD_FULL_BOUNDS);
    return { rig, previewId };
  }

  it("visible-slot: captureMainWindowRect called with EXACTLY the host's panelBounds, no delay (no slot change)", async () => {
    vi.useFakeTimers();
    try {
      const { rig, previewId } = await openedMdPanelRigVisible();
      // openForTab already made this record the visible slot occupant (D5) — no promotion needed.
      const shotPromise = rig.host.screenshotFor(TAB, previewId);
      await flush();
      // Proof of "no delay": captureMainWindowRect already ran after mere
      // microtask flushes, with ZERO fake-timer advance — a promote-driven
      // sleep(PANEL_SCREENSHOT_RETRY_DELAY_MS) would still be pending here.
      expect(rig.captureMainWindowRectCalls).toEqual([MD_FULL_BOUNDS]);
      const shot = await shotPromise;
      expect(shot).toMatchObject({ ok: true, value: { previewId, mediaType: "image/png" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hidden-but-promotable: slot change -> unconditional delay observed -> capture", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      rig.displayModeValue.value = "panel";
      rig.mdSourceFiles.set(`${WORKSPACE_ROOT}/a.md`, { bytes: Buffer.from("a", "utf8") });
      rig.mdSourceFiles.set(`${WORKSPACE_ROOT}/b.md`, { bytes: Buffer.from("b", "utf8") });
      const first = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.md` });
      const firstId = first.ok ? first.value.previewId : "";
      rig.clock.time += 10;
      await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/b.md` }); // D5: second now holds the visible slot
      rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
      rig.host.setPanelBounds(MD_FULL_BOUNDS);
      expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).not.toBe(firstId);

      const shotPromise = rig.host.screenshotFor(TAB, firstId);
      await flush();
      // Promoted already (slot-map + pushChanged happen synchronously before
      // the delay), but the capture itself is parked behind the sleep.
      expect(rig.host.listForPanel(TAB).visiblePanelPreviewId).toBe(firstId);
      expect(rig.captureMainWindowRectCalls).toEqual([]);

      await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_RETRY_DELAY_MS);
      const shot = await shotPromise;

      expect(shot).toMatchObject({ ok: true });
      expect(rig.captureMainWindowRectCalls).toEqual([MD_FULL_BOUNDS]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlay open -> honest refusal, captureMainWindowRect NOT called", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: true });
    rig.host.setPanelBounds(MD_FULL_BOUNDS);
    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({
      ok: false,
      errorKind: "unavailable",
      error: expect.stringContaining("switch to the tab or move the preview to a window"),
    });
    expect(rig.captureMainWindowRectCalls).toEqual([]);
  });

  it("inactive tab (wrong activeTabId) -> honest refusal, captureMainWindowRect NOT called", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.host.setPanelState({ activeTabId: "some-other-tab", panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds(MD_FULL_BOUNDS);
    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
    expect(rig.captureMainWindowRectCalls).toEqual([]);
  });

  it("panel not mounted -> honest refusal, captureMainWindowRect NOT called", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: false, overlayOpen: false });
    rig.host.setPanelBounds(MD_FULL_BOUNDS);
    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
    expect(rig.captureMainWindowRectCalls).toEqual([]);
  });

  it("no panel bounds (null / zero-size) -> honest refusal, captureMainWindowRect NOT called", async () => {
    const { rig, previewId } = await openedMdPanelRig();
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds(null);
    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
    expect(rig.captureMainWindowRectCalls).toEqual([]);
  });

  it("captureMainWindowRect returns null (no live main window) -> honest refusal", async () => {
    const { rig, previewId } = await openedMdPanelRigVisible();
    rig.captureMainWindowRectImpl = async () => null;
    const shot = await rig.host.screenshotFor(TAB, previewId);
    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
  });

  it("window-container: showInactive + throttling off during capture (restored after) + capturePage called, real PNG shape", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    rig.mdSourceFiles.set(`${WORKSPACE_ROOT}/doc.md`, { bytes: Buffer.from("# doc", "utf8") });
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = opened.ok ? opened.value.previewId : "";
    const mdWindow = rig.mdWindows[0]!;

    const shot = await rig.host.screenshotFor(TAB, previewId);

    expect(shot).toMatchObject({ ok: true, value: { previewId, mediaType: "image/png" } });
    expect(mdWindow.shownInactive).toBe(true);
    expect(mdWindow.backgroundThrottlingCalls).toEqual([false, true]); // off during capture, restored in `finally`
  });

  it("window-container: empty first capture -> show() + recapture fallback (mirrors the web window branch)", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = opened.ok ? opened.value.previewId : "";
    const mdWindow = rig.mdWindows[0]!;
    let calls = 0;
    mdWindow.capturePageImpl = async () => {
      calls += 1;
      return fakeImage({ empty: calls === 1 });
    };

    const shot = await rig.host.screenshotFor(TAB, previewId);

    expect(shot).toMatchObject({ ok: true });
    expect(mdWindow.shown).toBe(true); // forced-visible fallback
    expect(calls).toBe(2);
  });

  it("window-container: destroyed mdWindow -> honest refusal", async () => {
    const rig = makeRig();
    rig.displayModeValue.value = "window";
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = opened.ok ? opened.value.previewId : "";
    rig.mdWindows[0]!.destroy();

    const shot = await rig.host.screenshotFor(TAB, previewId);

    expect(shot).toMatchObject({ ok: false, errorKind: "unavailable" });
  });
});

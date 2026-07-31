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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_EVENT_TYPE,
  PREVIEW_RESPONSE_TYPE,
  type PreviewConsoleEntry,
  type PreviewEventMessage,
  type PreviewResponseMessage,
} from "../../shared/preview.js";
import {
  registerPreviewHost,
  type CreateWindowOpts,
  type PreviewCapturedImage,
  type PreviewHostDeps,
  type PreviewHostHandle,
  type PreviewWebContentsLike,
  type PreviewWindowLike,
} from "./preview-host.js";

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

  private didFinishLoad: Array<() => void> = [];
  private didFailLoad: Array<(code: number, desc: string) => void> = [];
  private renderProcessGone: Array<(reason: string) => void> = [];
  private willNavigate: Array<(url: string, preventDefault: () => void) => void> = [];
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
  onDidFailLoad(listener: (errorCode: number, errorDescription: string) => void): void {
    this.didFailLoad.push(listener);
  }
  onRenderProcessGone(listener: (reason: string) => void): void {
    this.renderProcessGone.push(listener);
  }
  onWillNavigate(listener: (url: string, preventDefault: () => void) => void): void {
    this.willNavigate.push(listener);
  }
  onDidNavigate(listener: (url: string) => void): void {
    this.didNavigate.push(listener);
  }
  onConsoleMessage(listener: (level: PreviewConsoleEntry["level"], message: string) => void): void {
    this.consoleMessage.push(listener);
  }

  // ── test drivers (simulate Electron firing these events) ──
  fireDidFinishLoad(): void {
    for (const l of this.didFinishLoad) l();
  }
  fireDidFailLoad(errorCode: number, errorDescription: string): void {
    for (const l of this.didFailLoad) l(errorCode, errorDescription);
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

/** Everything a test needs to drive a `registerPreviewHost` instance + inspect its side effects. */
interface Rig {
  host: PreviewHostHandle;
  windows: FakeWindow[];
  posted: Array<{ tabId: string; message: PreviewResponseMessage | PreviewEventMessage }>;
  clock: { time: number };
  autoOpen: { enabled: boolean };
  resolveArtifactImpl: (tabId: string, path: string) => Promise<{ realPath: string } | { failure: string }>;
  renderMarkdownImpl?: (realPath: string) => Promise<{ htmlPath: string } | { error: string }>;
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
  const posted: Array<{ tabId: string; message: PreviewResponseMessage | PreviewEventMessage }> = [];
  const clock = { time: 1_000_000 };
  const autoOpen = { enabled: true };
  const rig: Rig = {
    host: undefined as unknown as PreviewHostHandle,
    windows,
    posted,
    clock,
    autoOpen,
    resolveArtifactImpl: defaultResolveArtifact,
  };

  const deps: PreviewHostDeps = {
    createWindow: (opts: CreateWindowOpts) => {
      const win = new FakeWindow(opts.previewId);
      windows.push(win);
      return win;
    },
    resolveArtifact: (tabId, path) => rig.resolveArtifactImpl(tabId, path),
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

describe("PreviewHost — markdown: never load plaintext (cut §1(g))", () => {
  it("refuses honestly when renderMarkdown is absent, without ever calling loadURL", async () => {
    const rig = makeRig();
    const result = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    expect(result).toEqual({
      ok: false,
      error: "markdown preview not available yet",
      errorKind: "unavailable",
    });
    expect(rig.windows[0]!.webContents.loadedUrls).toEqual([]);
    expect(rig.windows[0]!.destroyed).toBe(true);
  });

  it("renders via renderMarkdown and loads the returned HTML, tracking renderedFrom", async () => {
    const rig = makeRig({
      renderMarkdown: async (realPath) => ({ htmlPath: `${realPath}.rendered.html` }),
    });
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await openPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.renderedFrom).toBe(`${WORKSPACE_ROOT}/doc.md`);
    }
    expect(rig.windows[0]!.webContents.loadedUrls[0]).toContain(".rendered.html");
  });

  it("renderMarkdown returning {error} resolves load_failed", async () => {
    const rig = makeRig({
      renderMarkdown: async () => ({ error: "sanitize failed" }),
    });
    const result = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    expect(result).toEqual({ ok: false, error: "sanitize failed", errorKind: "load_failed" });
  });

  it("unlinks the rendered temp file (best-effort) when the preview is destroyed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview-host-test-"));
    const htmlPath = join(dir, "rendered.html");
    await writeFile(htmlPath, "<html></html>");

    const rig = makeRig({
      renderMarkdown: async () => ({ htmlPath }),
    });
    const openPromise = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    await openPromise;

    rig.host.closeForTab(TAB);
    // Cleanup is deliberately fire-and-forget (best-effort) in production —
    // give the real fs unlink a beat to land instead of only flushing microtasks.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(readFile(htmlPath)).rejects.toThrow();
  });
});

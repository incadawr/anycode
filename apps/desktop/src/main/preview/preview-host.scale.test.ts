/**
 * TASK.198 slice G: CSS-viewport-size (DIP) threading tests for PreviewHost's
 * three screenshot capture legs — `screenshotFor` (web preview,
 * window.innerWidth/innerHeight via executeJavaScript), `screenshotMdWindow`
 * (dom-md window leg, MdPreviewWindowLike.getContentSize), and
 * `screenshotMdPanel` (dom-md panel leg, the host's own panelBounds). Kept in
 * its own file rather than `preview-host.test.ts` per the slice plan — that
 * file is already 174 tests and is out of this slice's scope to edit. The
 * fakes below are purpose-built and minimal, NOT a reuse of that file's
 * fakes (a separate implementation of the same interfaces).
 */

import { describe, expect, it } from "vitest";
import {
  registerPreviewHost,
  type CreateWindowOpts,
  type MdPreviewWindowLike,
  type PreviewCapturedImage,
  type PreviewHostDeps,
  type PreviewWebContentsLike,
  type PreviewWindowLike,
} from "./preview-host.js";
import type { PreviewPanelBounds } from "../../shared/preview-panel.js";

const TAB = "tab-1";
const WORKSPACE_ROOT = "/workspace";

function fakeImage(opts?: { width?: number; height?: number }): PreviewCapturedImage {
  return {
    toPNG: () => Buffer.from("fake-png-bytes"),
    getSize: () => ({ width: opts?.width ?? 800, height: opts?.height ?? 600 }),
    isEmpty: () => false,
  };
}

/** Drains pending microtasks (mirrors preview-host.test.ts's own `flush` helper). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Minimal full `PreviewWebContentsLike` — only `executeJavaScript` is exercised by these tests. */
class FakeWebContents implements PreviewWebContentsLike {
  executeJavaScriptImpl: (script: string) => Promise<unknown> = () => Promise.resolve(undefined);
  executeJavaScriptCalls: string[] = [];
  private didFinishLoad: Array<() => void> = [];

  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return false;
  }
  executeJavaScript<T>(script: string): Promise<T> {
    this.executeJavaScriptCalls.push(script);
    return this.executeJavaScriptImpl(script) as Promise<T>;
  }
  capturePage(): Promise<PreviewCapturedImage> {
    return Promise.resolve(fakeImage());
  }
  setBackgroundThrottling(): void {}
  setWindowOpenHandler(): void {}
  setPermissionRequestHandler(): void {}
  onDidFinishLoad(listener: () => void): void {
    this.didFinishLoad.push(listener);
  }
  onDidFailLoad(): void {}
  onRenderProcessGone(): void {}
  onWillNavigate(): void {}
  onWillRedirect(): void {}
  onDidNavigate(): void {}
  onConsoleMessage(): void {}
  setRequestGate(): void {}
  getNavigationHistory(): { entries: Array<{ url: string; title: string }>; index: number } {
    return { entries: [], index: -1 };
  }
  restoreNavigationHistory(): Promise<void> {
    return Promise.resolve();
  }

  fireDidFinishLoad(): void {
    for (const l of this.didFinishLoad) l();
  }
}

class FakeWindow implements PreviewWindowLike {
  readonly webContents = new FakeWebContents();
  isDestroyed(): boolean {
    return false;
  }
  destroy(): void {}
  show(): void {}
  showInactive(): void {}
  onClosed(): void {}
}

/**
 * `getContentSize` absent entirely (not merely returning undefined) — this
 * is the SAME shape as preview-host.test.ts's own `FakeMdWindow`, which this
 * slice must not edit. Proves the interface's optionality (preview-host.ts's
 * doc comment on `MdPreviewWindowLike.getContentSize`) actually holds: this
 * fake still satisfies `MdPreviewWindowLike` and the capture path degrades
 * to "no CSS size" rather than throwing.
 */
class FakeMdWindowNoSize implements MdPreviewWindowLike {
  isDestroyed(): boolean {
    return false;
  }
  destroy(): void {}
  show(): void {}
  showInactive(): void {}
  onClosed(): void {}
  capturePage(): Promise<PreviewCapturedImage> {
    return Promise.resolve(fakeImage());
  }
  setBackgroundThrottling(): void {}
}

/** Opts INTO the new capability — configurable to throw, mirroring a window mid-teardown. */
class FakeMdWindowWithSize implements MdPreviewWindowLike {
  size: { width: number; height: number } = { width: 900, height: 700 };
  shouldThrow = false;

  isDestroyed(): boolean {
    return false;
  }
  destroy(): void {}
  show(): void {}
  showInactive(): void {}
  onClosed(): void {}
  capturePage(): Promise<PreviewCapturedImage> {
    return Promise.resolve(fakeImage());
  }
  setBackgroundThrottling(): void {}
  getContentSize(): { width: number; height: number } {
    if (this.shouldThrow) {
      throw new Error("window destroyed mid-capture");
    }
    return this.size;
  }
}

interface Rig {
  host: ReturnType<typeof registerPreviewHost>;
  windows: FakeWindow[];
  mdWindows: MdPreviewWindowLike[];
  captureMainWindowRectCalls: PreviewPanelBounds[];
  captureMainWindowRectImpl: (rect: PreviewPanelBounds) => Promise<PreviewCapturedImage | null>;
  mdSourceFiles: Map<string, Buffer>;
  /** Test hook: overrides what the next `createMdWindow` call returns. */
  nextMdWindow: () => MdPreviewWindowLike;
}

function makeRig(opts: { displayMode: "panel" | "window" }): Rig {
  const windows: FakeWindow[] = [];
  const mdWindows: MdPreviewWindowLike[] = [];
  const captureMainWindowRectCalls: PreviewPanelBounds[] = [];
  const mdSourceFiles = new Map<string, Buffer>();
  const rig: Rig = {
    host: undefined as unknown as ReturnType<typeof registerPreviewHost>,
    windows,
    mdWindows,
    captureMainWindowRectCalls,
    captureMainWindowRectImpl: async () => fakeImage(),
    mdSourceFiles,
    nextMdWindow: () => new FakeMdWindowNoSize(),
  };

  const deps: PreviewHostDeps = {
    createWindow: (createOpts: CreateWindowOpts) => {
      const win = new FakeWindow();
      windows.push(win);
      void createOpts;
      return win;
    },
    createPanelView: () => {
      throw new Error("not exercised by these tests");
    },
    createMdWindow: () => {
      const win = rig.nextMdWindow();
      mdWindows.push(win);
      return win;
    },
    displayMode: () => opts.displayMode,
    resolveArtifact: async (_tabId, path) => {
      if (path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`)) {
        return { realPath: path };
      }
      return { failure: "outside_allowed_roots" };
    },
    statMdSource: async (realPath) => {
      const bytes = mdSourceFiles.get(realPath);
      return bytes === undefined ? undefined : { size: bytes.length, isFile: true };
    },
    readMdSourceNoFollow: async (realPath) => {
      const bytes = mdSourceFiles.get(realPath);
      if (bytes === undefined) throw new Error(`ENOENT: ${realPath}`);
      return bytes;
    },
    captureMainWindowRect: async (rect) => {
      captureMainWindowRectCalls.push(rect);
      return rig.captureMainWindowRectImpl(rect);
    },
    autoOpenEnabled: () => true,
    postToHost: () => true,
    logger: { log() {}, warn() {}, error() {} },
    now: () => 1_000_000,
  };
  rig.host = registerPreviewHost(deps);
  return rig;
}

describe("PreviewHost — TASK.198 slice G, web preview leg (screenshotFor)", () => {
  async function readyRig(): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig({ displayMode: "window" });
    const opened = rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/a.html` });
    await flush();
    rig.windows[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    return { rig, previewId: result.ok ? result.value.previewId : "" };
  }

  it("forwards window.innerWidth/innerHeight as cssWidth/cssHeight", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ width: 550, height: 400 });
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result).toMatchObject({ ok: true, value: { cssWidth: 550, cssHeight: 400 } });
    // Decision 3 pin: the read runs against window.inner{Width,Height}, not
    // some other geometry accessor.
    const script = rig.windows[0]!.webContents.executeJavaScriptCalls.at(-1);
    expect(script).toContain("window.innerWidth");
    expect(script).toContain("window.innerHeight");
  });

  it("additivity pin: the default fake (no CSS size ever configured) reproduces today's EXACT result shape — no cssWidth/cssHeight keys at all", async () => {
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

  it("best-effort: an executeJavaScript rejection (unresponsive page) omits the CSS size WITHOUT failing the screenshot", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => {
      throw new Error("page did not respond");
    };
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });

  it("best-effort: a malformed executeJavaScript result (non-numeric) omits the CSS size WITHOUT failing the screenshot", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ width: "550", height: null });
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });

  // A CSS size is only ever CONSUMED as a divisor (recognizer.ts's buildPrompt
  // tells the model to divide the pixel size by it to recover the device pixel
  // ratio), so a zero or non-finite dimension is not a smaller number — it is a
  // hint that cannot be used at all. `typeof x === "number"` admits every one of
  // these, which is why the guard has to be about the VALUE, not the type.
  it("a zero dimension is not a usable CSS size — it is omitted, not forwarded as a divisor of zero", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ width: 0, height: 400 });
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });

  it("a non-finite dimension (NaN/Infinity) is not a usable CSS size — it is omitted", async () => {
    const { rig, previewId } = await readyRig();
    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ width: Number.NaN, height: 400 });
    const nan = await rig.host.screenshotFor(TAB, previewId);
    expect(nan.ok).toBe(true);
    expect(nan.ok && "cssWidth" in nan.value).toBe(false);

    rig.windows[0]!.webContents.executeJavaScriptImpl = async () => ({ width: 550, height: Number.POSITIVE_INFINITY });
    const inf = await rig.host.screenshotFor(TAB, previewId);
    expect(inf.ok).toBe(true);
    expect(inf.ok && "cssWidth" in inf.value).toBe(false);
  });
});

describe("PreviewHost — TASK.198 slice G, dom-md WINDOW leg (screenshotMdWindow)", () => {
  async function openedRig(mdWindow: MdPreviewWindowLike): Promise<{ rig: Rig; previewId: string }> {
    const rig = makeRig({ displayMode: "window" });
    rig.nextMdWindow = () => mdWindow;
    rig.mdSourceFiles.set(`${WORKSPACE_ROOT}/doc.md`, Buffer.from("# doc", "utf8"));
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    return { rig, previewId: opened.ok ? opened.value.previewId : "" };
  }

  it("forwards MdPreviewWindowLike.getContentSize() as cssWidth/cssHeight", async () => {
    const mdWindow = new FakeMdWindowWithSize();
    const { rig, previewId } = await openedRig(mdWindow);
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result).toMatchObject({ ok: true, value: { cssWidth: 900, cssHeight: 700 } });
  });

  it("optional-interface pin: a fake with NO getContentSize method at all (preview-host.test.ts's own FakeMdWindow shape) still succeeds, with no CSS size", async () => {
    const mdWindow = new FakeMdWindowNoSize();
    const { rig, previewId } = await openedRig(mdWindow);
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });

  it("best-effort: getContentSize() throwing (window mid-teardown) omits the CSS size WITHOUT failing the screenshot", async () => {
    const mdWindow = new FakeMdWindowWithSize();
    mdWindow.shouldThrow = true;
    const { rig, previewId } = await openedRig(mdWindow);
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });

  // Electron's BrowserWindow.getContentSize() reports 0x0 for a minimized or
  // not-yet-laid-out window — a real state this leg can be called in, and the
  // same unusable-divisor case the web leg is pinned for above.
  it("a 0x0 content size (minimized window) is omitted rather than forwarded as a divisor of zero", async () => {
    const mdWindow = new FakeMdWindowWithSize();
    mdWindow.size = { width: 0, height: 0 };
    const { rig, previewId } = await openedRig(mdWindow);
    const result = await rig.host.screenshotFor(TAB, previewId);
    expect(result.ok).toBe(true);
    expect(result.ok && "cssWidth" in result.value).toBe(false);
  });
});

describe("PreviewHost — TASK.198 slice G, dom-md PANEL leg (screenshotMdPanel)", () => {
  const BOUNDS: PreviewPanelBounds = { x: 10, y: 20, width: 550, height: 400 };

  it("forwards the host's own panelBounds (already documented as CSS px) as cssWidth/cssHeight", async () => {
    const rig = makeRig({ displayMode: "panel" });
    rig.mdSourceFiles.set(`${WORKSPACE_ROOT}/doc.md`, Buffer.from("# doc", "utf8"));
    const opened = await rig.host.openForTab(TAB, { path: `${WORKSPACE_ROOT}/doc.md` });
    const previewId = opened.ok ? opened.value.previewId : "";
    rig.host.setPanelState({ activeTabId: TAB, panelMounted: true, overlayOpen: false });
    rig.host.setPanelBounds(BOUNDS);

    const result = await rig.host.screenshotFor(TAB, previewId);

    expect(result).toMatchObject({ ok: true, value: { cssWidth: 550, cssHeight: 400 } });
    expect(rig.captureMainWindowRectCalls).toEqual([BOUNDS]);
  });
});

/**
 * Unit tests for panel-ipc.ts (panel-track CUT.md §3 96-P1 test plan):
 * `electron`'s `ipcMain` is mocked with a handler-capturing fake (same
 * "mocked electron module" precedent as window-ipc.test.ts — there is no
 * Electron runtime under vitest), capturing BOTH `.handle` (SET_STATE/
 * SELECT/CLOSE/LIST) and `.on` (SET_BOUNDS, D9's deliberate one-way
 * deviation) registrations so a test can drive either kind directly.
 *
 * Zod-refusal shapes and bounds clamping are tested against a stubbed
 * `PreviewHostHandle` (fast, isolates panel-ipc.ts's own boundary logic);
 * tab-scoping is tested against the REAL `registerPreviewHost` (Electron-free
 * per preview-host.ts's own design) so the "wrong tabId -> ok:false" proof is
 * the actual end-to-end behavior, not a stub echoing back whatever it's told.
 */
import { describe, expect, it, vi } from "vitest";

const { mockHandlers, mockOnListeners } = vi.hoisted(() => ({
  mockHandlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  mockOnListeners: new Map<string, (event: unknown, raw: unknown) => void>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
      mockHandlers.set(channel, listener);
    },
    on: (channel: string, listener: (event: unknown, raw: unknown) => void): void => {
      mockOnListeners.set(channel, listener);
    },
  },
}));

import {
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_LIST_CHANNEL,
  PREVIEW_PANEL_SELECT_CHANNEL,
  PREVIEW_PANEL_SET_BOUNDS_CHANNEL,
  PREVIEW_PANEL_SET_STATE_CHANNEL,
  PREVIEW_SET_CONTAINER_CHANNEL,
  type PreviewChangedPayload,
} from "../../shared/preview-panel.js";
import { registerPreviewPanelIpc } from "./panel-ipc.js";
import {
  registerPreviewHost,
  type PreviewHostHandle,
  type PreviewPanelViewLike,
  type PreviewWebContentsLike,
  type PreviewWindowLike,
} from "./preview-host.js";

/** A fake PreviewHostHandle (mirrors automation/handlers.test.ts's own fake) — every panel method is a spy so a test can assert exactly what panel-ipc.ts forwarded. */
function fakeHost(overrides: Partial<PreviewHostHandle> = {}): PreviewHostHandle {
  return {
    openForTab: vi.fn(async () => ({ ok: true as const, value: { previewId: "p", url: "", kind: "file" as const } })),
    handleRequest: vi.fn(async () => {}),
    handleArtifacts: vi.fn(),
    closeForTab: vi.fn(),
    closeAll: vi.fn(),
    listForTab: vi.fn(() => []),
    getConsole: vi.fn(() => ({ entries: [], dropped: 0 })),
    screenshotFor: vi.fn(async () => ({ ok: false as const, error: "n/a", errorKind: "unavailable" as const })),
    setPanelState: vi.fn(),
    setPanelBounds: vi.fn(),
    selectPanelPreview: vi.fn(() => ({ ok: true as const })),
    closePreview: vi.fn(() => ({ ok: true as const })),
    listForPanel: vi.fn((tabId: string) => ({ tabId, previews: [], visiblePanelPreviewId: null })),
    setContainer: vi.fn(async () => ({ ok: true as const, reloaded: true })),
    getMdDocRef: vi.fn(() => undefined),
    // TASK.99 M2: type-level fake addition only — this suite exercises the
    // panel IPC, not md-doc navigate (covered by preview-host.test.ts's own
    // "commitMdNavigate" suite).
    commitMdNavigate: vi.fn(() => undefined),
    ...overrides,
  };
}

/** Registers against a fresh handler map, returning thin invokers over the captured handlers. */
function register(host: PreviewHostHandle): { invoke: (channel: string, raw: unknown) => unknown; send: (channel: string, raw: unknown) => void } {
  mockHandlers.clear();
  mockOnListeners.clear();
  registerPreviewPanelIpc({ host });
  return {
    invoke: (channel, raw) => mockHandlers.get(channel)?.({}, raw),
    send: (channel, raw) => mockOnListeners.get(channel)?.({}, raw),
  };
}

describe("registerPreviewPanelIpc — SET_CONTAINER (invoke, 96-P3)", () => {
  it("is registered (lands in 96-P3, unlike the 96-P1 checkpoint)", () => {
    register(fakeHost());
    expect(mockHandlers.has(PREVIEW_SET_CONTAINER_CHANNEL)).toBe(true);
  });

  it("valid payload forwards to host.setContainer and returns its result verbatim", async () => {
    const host = fakeHost({ setContainer: vi.fn(async () => ({ ok: true as const, reloaded: true })) });
    const invoke = register(host);
    const response = await invoke.invoke(PREVIEW_SET_CONTAINER_CHANNEL, {
      tabId: "tab-a",
      previewId: "p1",
      container: "panel",
    });
    expect(host.setContainer).toHaveBeenCalledWith("tab-a", "p1", "panel");
    expect(response).toEqual({ ok: true, reloaded: true });
  });

  it("forwards a 'window' container request the same way", async () => {
    const host = fakeHost({ setContainer: vi.fn(async () => ({ ok: true as const, reloaded: false })) });
    const invoke = register(host);
    await invoke.invoke(PREVIEW_SET_CONTAINER_CHANNEL, { tabId: "tab-a", previewId: "p1", container: "window" });
    expect(host.setContainer).toHaveBeenCalledWith("tab-a", "p1", "window");
  });

  it("malformed payload (bad container enum) refuses without calling the host", async () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = await invoke.invoke(PREVIEW_SET_CONTAINER_CHANNEL, {
      tabId: "tab-a",
      previewId: "p1",
      container: "tab",
    });
    expect(host.setContainer).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });

  it("malformed payload (missing field) refuses without calling the host", async () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = await invoke.invoke(PREVIEW_SET_CONTAINER_CHANNEL, { tabId: "tab-a", container: "panel" });
    expect(host.setContainer).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });

  it("non-object payload refuses without calling the host", async () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = await invoke.invoke(PREVIEW_SET_CONTAINER_CHANNEL, "not-an-object");
    expect(host.setContainer).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("registerPreviewPanelIpc — SET_STATE (invoke)", () => {
  it("valid payload forwards exactly to host.setPanelState", () => {
    const host = fakeHost();
    const invoke = register(host);
    const payload = { activeTabId: "tab-a", panelMounted: true, overlayOpen: false };
    invoke.invoke(PREVIEW_PANEL_SET_STATE_CHANNEL, payload);
    expect(host.setPanelState).toHaveBeenCalledWith(payload);
  });

  it("activeTabId: null is accepted (no active tab surface)", () => {
    const host = fakeHost();
    const invoke = register(host);
    const payload = { activeTabId: null, panelMounted: false, overlayOpen: false };
    invoke.invoke(PREVIEW_PANEL_SET_STATE_CHANNEL, payload);
    expect(host.setPanelState).toHaveBeenCalledWith(payload);
  });

  it("malformed payload (missing field) is dropped — never reaches the host", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.invoke(PREVIEW_PANEL_SET_STATE_CHANNEL, { activeTabId: "tab-a", panelMounted: true });
    expect(host.setPanelState).not.toHaveBeenCalled();
  });

  it("malformed payload (wrong type) is dropped", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.invoke(PREVIEW_PANEL_SET_STATE_CHANNEL, { activeTabId: 42, panelMounted: true, overlayOpen: false });
    expect(host.setPanelState).not.toHaveBeenCalled();
  });

  it("non-object payload is dropped", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.invoke(PREVIEW_PANEL_SET_STATE_CHANNEL, "not-an-object");
    expect(host.setPanelState).not.toHaveBeenCalled();
  });
});

describe("registerPreviewPanelIpc — SET_BOUNDS (ipcMain.on, D9 one-way deviation)", () => {
  it("clamps + rounds before calling host.setPanelBounds (x,y >= 0, w,h 0..32768)", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.send(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, { x: -5.4, y: 10.6, width: 99_999.9, height: -20 });
    expect(host.setPanelBounds).toHaveBeenCalledWith({ x: 0, y: 11, width: 32_768, height: 0 });
  });

  it("rounds fractional in-range values without clamping them", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.send(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, { x: 10.4, y: 20.6, width: 300.5, height: 400.2 });
    expect(host.setPanelBounds).toHaveBeenCalledWith({ x: 10, y: 21, width: 301, height: 400 });
  });

  it("malformed payload (non-finite number) is silently dropped — no reply channel to refuse on", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.send(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, { x: Number.NaN, y: 0, width: 100, height: 100 });
    expect(host.setPanelBounds).not.toHaveBeenCalled();
  });

  it("malformed payload (missing field) is silently dropped", () => {
    const host = fakeHost();
    const invoke = register(host);
    invoke.send(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, { x: 0, y: 0, width: 100 });
    expect(host.setPanelBounds).not.toHaveBeenCalled();
  });
});

describe("registerPreviewPanelIpc — SELECT/CLOSE (invoke)", () => {
  it("SELECT forwards to host.selectPanelPreview and returns its result verbatim", () => {
    const host = fakeHost({ selectPanelPreview: vi.fn(() => ({ ok: true as const })) });
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_PANEL_SELECT_CHANNEL, { tabId: "tab-a", previewId: "p1" });
    expect(host.selectPanelPreview).toHaveBeenCalledWith("tab-a", "p1");
    expect(response).toEqual({ ok: true });
  });

  it("SELECT with a malformed payload refuses without calling the host", () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_PANEL_SELECT_CHANNEL, { tabId: "tab-a" });
    expect(host.selectPanelPreview).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });

  it("CLOSE forwards to host.closePreview and returns its result verbatim", () => {
    const host = fakeHost({ closePreview: vi.fn(() => ({ ok: false as const, error: "no such preview: p1" })) });
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_CLOSE_CHANNEL, { tabId: "tab-a", previewId: "p1" });
    expect(host.closePreview).toHaveBeenCalledWith("tab-a", "p1");
    expect(response).toEqual({ ok: false, error: "no such preview: p1" });
  });

  it("CLOSE with a malformed payload (wrong type) refuses without calling the host", () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_CLOSE_CHANNEL, { tabId: 123, previewId: "p1" });
    expect(host.closePreview).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("registerPreviewPanelIpc — LIST (invoke)", () => {
  it("forwards to host.listForPanel and returns its result verbatim", () => {
    const payload: PreviewChangedPayload = { tabId: "tab-a", previews: [], visiblePanelPreviewId: null };
    const host = fakeHost({ listForPanel: vi.fn(() => payload) });
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_LIST_CHANNEL, { tabId: "tab-a" });
    expect(host.listForPanel).toHaveBeenCalledWith("tab-a");
    expect(response).toBe(payload);
  });

  it("malformed payload -> empty payload, never calls the host", () => {
    const host = fakeHost();
    const invoke = register(host);
    const response = invoke.invoke(PREVIEW_LIST_CHANNEL, {});
    expect(host.listForPanel).not.toHaveBeenCalled();
    expect(response).toEqual({ tabId: "", previews: [], visiblePanelPreviewId: null });
  });
});

// ── tab-scoping, against the REAL (Electron-free) PreviewHost ──

interface FakeWc extends PreviewWebContentsLike {
  fireDidFinishLoad(): void;
}

function makeFakeWc(): FakeWc {
  const finishListeners: Array<() => void> = [];
  return {
    loadURL: async () => {},
    isDestroyed: () => false,
    executeJavaScript: <T = unknown>(): Promise<T> => Promise.resolve(undefined as T),
    capturePage: async () => ({
      toPNG: () => Buffer.from(""),
      getSize: () => ({ width: 0, height: 0 }),
      isEmpty: () => true,
    }),
    setBackgroundThrottling: () => {},
    setWindowOpenHandler: () => {},
    setPermissionRequestHandler: () => {},
    onDidFinishLoad: (listener) => {
      finishListeners.push(listener);
    },
    onDidFailLoad: () => {},
    onRenderProcessGone: () => {},
    onWillNavigate: () => {},
    onWillRedirect: () => {},
    onDidNavigate: () => {},
    onConsoleMessage: () => {},
    setRequestGate: () => {},
    getNavigationHistory: () => ({ entries: [], index: 0 }),
    restoreNavigationHistory: async () => {},
    fireDidFinishLoad: () => {
      for (const listener of finishListeners) listener();
    },
  };
}

interface FakePanel extends PreviewPanelViewLike {
  webContents: FakeWc;
}

function makeFakePanel(): FakePanel {
  const closedListeners: Array<() => void> = [];
  return {
    webContents: makeFakeWc(),
    isDestroyed: () => false,
    destroy: () => {
      for (const listener of closedListeners) listener();
    },
    show: () => {},
    showInactive: () => {},
    onClosed: (listener) => {
      closedListeners.push(listener);
    },
    setBounds: () => {},
    setVisible: () => {},
  };
}

function makeFakeWindow(): PreviewWindowLike {
  return {
    webContents: makeFakeWc(),
    isDestroyed: () => false,
    destroy: () => {},
    show: () => {},
    showInactive: () => {},
    onClosed: () => {},
  };
}

function makeRealHost(): { host: PreviewHostHandle; panelViews: FakePanel[] } {
  const panelViews: FakePanel[] = [];
  const host = registerPreviewHost({
    createWindow: () => makeFakeWindow(),
    createPanelView: () => {
      const view = makeFakePanel();
      panelViews.push(view);
      return view;
    },
    // TASK.99 M3: this suite never opens a dom-md preview, so no test here
    // exercises this dep — a minimal fake satisfies PreviewHostDeps' shape.
    createMdWindow: () => ({
      isDestroyed: () => false,
      destroy: () => {},
      show: () => {},
      showInactive: () => {},
      onClosed: () => {},
      capturePage: () => Promise.resolve({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }), isEmpty: () => true }),
      setBackgroundThrottling: () => {},
    }),
    displayMode: () => "panel",
    resolveArtifact: async (_tabId, path) => ({ realPath: path }),
    // TASK.99 M4: this suite never exercises dom-md read/screenshot either —
    // minimal fakes satisfying PreviewHostDeps' shape, same posture as
    // `createMdWindow` above.
    statMdSource: async () => undefined,
    readMdSourceNoFollow: async () => Buffer.alloc(0),
    captureMainWindowRect: async () => null,
    autoOpenEnabled: () => true,
    postToHost: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    now: () => Date.now(),
  });
  return { host, panelViews };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerPreviewPanelIpc — tab-scoping (integration against the real PreviewHost)", () => {
  it("SELECT with the wrong tabId refuses ok:false", async () => {
    const { host, panelViews } = makeRealHost();
    const invoke = register(host);
    const opened = host.openForTab("tab-a", { path: "/workspace/a.html" });
    await flush();
    panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    const response = invoke.invoke(PREVIEW_PANEL_SELECT_CHANNEL, { tabId: "tab-b", previewId });
    expect(response).toEqual({ ok: false, error: expect.any(String) });
  });

  it("CLOSE with the wrong tabId refuses ok:false and does not destroy the preview", async () => {
    const { host, panelViews } = makeRealHost();
    const invoke = register(host);
    const opened = host.openForTab("tab-a", { path: "/workspace/a.html" });
    await flush();
    panelViews[0]!.webContents.fireDidFinishLoad();
    const result = await opened;
    const previewId = result.ok ? result.value.previewId : "";

    const response = invoke.invoke(PREVIEW_CLOSE_CHANNEL, { tabId: "tab-b", previewId });
    expect(response).toEqual({ ok: false, error: expect.any(String) });
    expect(host.listForPanel("tab-a").previews).toHaveLength(1);
  });

  it("LIST scopes to the given tabId (a different tab's previews never leak in)", async () => {
    const { host, panelViews } = makeRealHost();
    const invoke = register(host);
    const openedA = host.openForTab("tab-a", { path: "/workspace/a.html" });
    const openedB = host.openForTab("tab-b", { path: "/workspace/b.html" });
    await flush();
    panelViews[0]!.webContents.fireDidFinishLoad();
    panelViews[1]!.webContents.fireDidFinishLoad();
    await Promise.all([openedA, openedB]);

    const response = invoke.invoke(PREVIEW_LIST_CHANNEL, { tabId: "tab-a" }) as PreviewChangedPayload;
    expect(response.tabId).toBe("tab-a");
    expect(response.previews).toHaveLength(1);
  });
});

/**
 * F10 regression (CUT-S2 §2.5, review wave R): preload's
 * `PORT_ENVELOPE_TYPE` forwarding must not drop the `child` field main
 * stamps for a child-session tab's port delivery (`deliverTabPort`,
 * main/tabs.ts). Before this fix, the `ipcRenderer.on(PORT_ENVELOPE_TYPE,
 * ...)` handler re-posted only `{tabId, workspace, connectionId?,
 * providerId?}` — `child` never crossed the bridge, so
 * `tab-registry.ts`'s `registerPort` (gated on `classifyPortEnvelope`,
 * `child-sessions.ts`) always saw `child === undefined` and registered
 * EVERY child session as an ordinary root tab: added to the tabs-store,
 * visible in the Sidebar/StartScreen/CommandPalette, and never entered into
 * the child-relation store — a direct violation of the design's §0.4
 * skip-hide contract and the "children are never visible" invariant.
 *
 * `electron` is mocked the same way main/*.test.ts already do (there is no
 * Electron runtime under vitest, e.g. window-ipc.test.ts's `ipcMain.handle`
 * capturing fake): `ipcRenderer.on` is a channel-capturing fake so the test
 * can drive the registered `PORT_ENVELOPE_TYPE` listener directly, the same
 * way that file drives `ipcMain.handle`. `window.postMessage` is stubbed on
 * `globalThis.window` (this file's test environment is plain node, not
 * jsdom) so the handler's re-post is observable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListeners } = vi.hoisted(() => ({
  mockListeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void): void => {
      mockListeners.set(channel, listener);
    },
    invoke: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { PORT_ENVELOPE_TYPE, HOST_EXITED_ENVELOPE_TYPE } from "../shared/envelopes.js";

it("does not expose the bridge or forward ports in an untrusted document", async () => {
  const { contextBridge } = await import("electron");
  vi.mocked(contextBridge.exposeInMainWorld).mockClear();
  mockListeners.clear();
  vi.resetModules();
  vi.stubGlobal("window", { location: { href: "about:blank" } });
  vi.stubGlobal("process", { ...process, argv: ["--anycode-renderer-url=file:///app/index.html"] });
  await import("./index.js");
  expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);
});

/** The exact shape `deliverTabPort` (main/tabs.ts) stamps for a child-session tab's port delivery. */
const CHILD_FIELD = {
  parentTabId: "tab-master",
  parentSessionId: "session-master",
  spawnToolCallId: "call-1",
  childSessionId: "session-child-1",
};

describe("preload PORT_ENVELOPE_TYPE forwarding", () => {
  beforeEach(async () => {
    mockListeners.clear();
    vi.resetModules();
    vi.stubGlobal("window", { postMessage: vi.fn(), location: { href: "file:///app/index.html" } });
    vi.stubGlobal("process", { ...process, argv: ["--anycode-renderer-url=file:///app/index.html"] });
    await import("./index.js");
  });

  function postedEnvelope(): Record<string, unknown> {
    const win = globalThis.window as unknown as { postMessage: ReturnType<typeof vi.fn> };
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const [posted] = win.postMessage.mock.calls[0] as [Record<string, unknown>, string, unknown[]];
    return posted;
  }

  it("forwards terminal reasons on both delivery paths", () => {
    const failure = { code: "per_tab_crash_loop", message: "Stopped." };
    mockListeners.get(PORT_ENVELOPE_TYPE)?.({ ports: [] }, { tabId: "tab", workspace: "/ws", hostFailure: failure });
    expect(postedEnvelope().hostFailure).toEqual(failure);
    const win = globalThis.window as unknown as { postMessage: ReturnType<typeof vi.fn> };
    win.postMessage.mockClear();
    mockListeners.get(HOST_EXITED_ENVELOPE_TYPE)?.({}, { tabId: "tab", hostFailure: failure });
    expect(postedEnvelope().hostFailure).toEqual(failure);
  });

  it("forwards the `child` field untouched for a child-session tab's port envelope", () => {
    const listener = mockListeners.get(PORT_ENVELOPE_TYPE);
    expect(listener).toBeDefined();

    listener?.({ ports: [] }, { tabId: "tab-child-1", workspace: "/ws", child: CHILD_FIELD });

    const posted = postedEnvelope();
    expect(posted.child).toEqual(CHILD_FIELD);
    expect(posted.tabId).toBe("tab-child-1");
    expect(posted.workspace).toBe("/ws");
  });

  it("omits `child` for an ordinary root-tab envelope (no regression on the unchanged legacy shape)", () => {
    const listener = mockListeners.get(PORT_ENVELOPE_TYPE);

    listener?.({ ports: [] }, { tabId: "tab-root-1", workspace: "/ws" });

    const posted = postedEnvelope();
    expect(posted.child).toBeUndefined();
    expect("child" in posted).toBe(false);
  });

  it("still forwards connectionId/providerId for a pinned root tab, alongside a present child field (both additive fields coexist)", () => {
    const listener = mockListeners.get(PORT_ENVELOPE_TYPE);

    listener?.({ ports: [] }, {
      tabId: "tab-child-2",
      workspace: "/ws",
      connectionId: "conn-1",
      providerId: "anthropic",
      child: CHILD_FIELD,
    });

    const posted = postedEnvelope();
    expect(posted.connectionId).toBe("conn-1");
    expect(posted.providerId).toBe("anthropic");
    expect(posted.child).toEqual(CHILD_FIELD);
  });
});

/**
 * preview-ipc-risk F2: the detached md popout (argv-flagged by
 * main/md-window-adapter.ts) must NOT receive the full app surface — it gets
 * the narrow document bridge of md-preview-bridge.ts instead, and only while
 * it shows the app's own renderer URL (same gate as the full bridge).
 */
describe("preload narrow bridge for the detached md popout", () => {
  it("exposes ONLY the narrow document surface (platform/mdPreview/previewPanel/artifacts) and no port listeners", async () => {
    const { contextBridge } = await import("electron");
    vi.mocked(contextBridge.exposeInMainWorld).mockClear();
    mockListeners.clear();
    vi.resetModules();
    vi.stubGlobal("window", { location: { href: "file:///app/index.html" } });
    vi.stubGlobal("process", {
      ...process,
      argv: ["--anycode-renderer-url=file:///app/index.html", "--anycode-md-preview-window"],
    });
    await import("./index.js");
    // The full bridge's port-forwarding listeners must not exist in this window.
    expect(mockListeners.size).toBe(0);
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(key).toBe("anycode");
    expect(Object.keys(api).sort()).toEqual(["artifacts", "mdPreview", "platform", "previewPanel"]);
    expect(Object.keys(api["mdPreview"] as object).sort()).toEqual(["navigate", "read"]);
    expect(Object.keys(api["previewPanel"] as object).sort()).toEqual(["list", "setContainer"]);
    expect(Object.keys(api["artifacts"] as object).sort()).toEqual([
      "allow",
      "open",
      "preview",
      "previewable",
      "readImage",
      "reveal",
    ]);
    // The privileged families are not even nameable from this window.
    for (const absent of ["settings", "secrets", "plugins", "trust", "tabBootstrap", "tabs", "proxy", "windowState", "getPathForFile", "automation"]) {
      expect(api[absent]).toBeUndefined();
    }
  });

  it("exposes NOTHING when the md window navigated away from the app renderer", async () => {
    const { contextBridge } = await import("electron");
    vi.mocked(contextBridge.exposeInMainWorld).mockClear();
    mockListeners.clear();
    vi.resetModules();
    vi.stubGlobal("window", { location: { href: "https://evil.example/" } });
    vi.stubGlobal("process", {
      ...process,
      argv: ["--anycode-renderer-url=file:///app/index.html", "--anycode-md-preview-window"],
    });
    await import("./index.js");
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
    expect(mockListeners.size).toBe(0);
  });

  it("without the flag the full app surface is unchanged (privilege families still present)", async () => {
    const { contextBridge } = await import("electron");
    vi.mocked(contextBridge.exposeInMainWorld).mockClear();
    mockListeners.clear();
    vi.resetModules();
    vi.stubGlobal("window", { postMessage: vi.fn(), location: { href: "file:///app/index.html" } });
    vi.stubGlobal("process", { ...process, argv: ["--anycode-renderer-url=file:///app/index.html"] });
    await import("./index.js");
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(key).toBe("anycode");
    // The full surface keeps its privileged families (sampling, not exhaustive).
    for (const present of ["settings", "tabBootstrap", "previewPanel", "mdPreview", "artifacts"]) {
      expect(api[present]).toBeDefined();
    }
    expect(Object.keys(api).length).toBeGreaterThan(10);
  });
});

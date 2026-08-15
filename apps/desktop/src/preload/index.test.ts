/**
 * F10 regression (TASK.102 CUT-S2 §2.5, review wave R): preload's
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

import { PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";

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
    (globalThis as unknown as { window?: { postMessage: ReturnType<typeof vi.fn> } }).window = { postMessage: vi.fn() };
    await import("./index.js");
  });

  function postedEnvelope(): Record<string, unknown> {
    const win = globalThis.window as unknown as { postMessage: ReturnType<typeof vi.fn> };
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const [posted] = win.postMessage.mock.calls[0] as [Record<string, unknown>, string, unknown[]];
    return posted;
  }

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

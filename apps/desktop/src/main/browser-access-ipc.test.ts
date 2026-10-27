/**
 * "Full browser access" IPC and notifier (Taskana 4759): brief tests 45(b), 46, 47.
 * Pure handlers over a fake deps bag (no ipcMain), like communication-ipc.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserAccessNotifier,
  effectiveTabState,
  handleBrowserAccessGet,
  handleBrowserAccessSet,
  type BrowserAccessIpcDeps,
} from "./browser-access-ipc.js";
import { createBrowserAccessStore, type BrowserAccessStore } from "./browser-access.js";

const MAIN = { name: "main-window-webcontents" };
const PREVIEW = { name: "preview-webcontents" };

function rig(options: { trust?: Record<string, unknown>; onChanged?: (tabId: string) => void } = {}) {
  const on = new Set<string>();
  const trust = new Map<string, unknown>(Object.entries(options.trust ?? {}));
  const store: BrowserAccessStore = {
    isOn: (sessionId) => on.has(sessionId),
    register: () => {},
    remove: () => {},
    set: (sessionId, value) => {
      if (value) on.add(sessionId); else on.delete(sessionId);
      return true;
    },
  };
  const deps: BrowserAccessIpcDeps = {
    store,
    tabs: () => [{ tabId: "tab-1", sessionId: "sess-1" }, { tabId: "tab-2", sessionId: "sess-2" }],
    trustPendingFor: (tabId) => trust.get(tabId) ?? "no_pending",
    isMainWindowSender: (sender) => sender === MAIN,
    ...(options.onChanged !== undefined ? { onChanged: options.onChanged } : {}),
  };
  return { deps, on, trust };
}

describe("browser access IPC (Taskana 4759) — test 45(b): only the main window may call it", () => {
  it("refuses a preview webContents, an undefined sender, and does not mutate", () => {
    const { deps, on } = rig();
    expect(handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: true }, PREVIEW)).toEqual({ ok: false, reason: "not_main_window" });
    expect(handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: true }, undefined)).toEqual({ ok: false, reason: "not_main_window" });
    expect(handleBrowserAccessGet(deps, {}, PREVIEW)).toEqual({ ok: false, reason: "not_main_window" });
    expect(on.size).toBe(0);
  });
});

describe("browser access IPC (Taskana 4759) — test 46", () => {
  it("refuses extra keys, an empty or oversized tabId, and a non-boolean enabled", () => {
    const { deps, on } = rig();
    expect(handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: true, extra: 1 }, MAIN)).toEqual({ ok: false, reason: "invalid" });
    expect(handleBrowserAccessSet(deps, { tabId: "", enabled: true }, MAIN)).toEqual({ ok: false, reason: "invalid" });
    expect(handleBrowserAccessSet(deps, { tabId: "x".repeat(201), enabled: true }, MAIN)).toEqual({ ok: false, reason: "invalid" });
    expect(handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: "yes" }, MAIN)).toEqual({ ok: false, reason: "invalid" });
    expect(handleBrowserAccessGet(deps, { any: true }, MAIN)).toEqual({ ok: false, reason: "invalid" });
    expect(on.size).toBe(0);
  });

  it("an unknown tabId is unknown_tab", () => {
    const { deps } = rig();
    expect(handleBrowserAccessSet(deps, { tabId: "nope", enabled: true }, MAIN)).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("a successful set persists, answers the effective value, and notifies the change once", () => {
    const onChanged = vi.fn();
    const { deps, on } = rig({ onChanged });
    const result = handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: true }, MAIN);
    expect(result).toEqual({ ok: true, tab: { tabId: "tab-1", fullAccess: true } });
    expect(on.has("sess-1")).toBe(true);
    expect(onChanged).toHaveBeenCalledWith("tab-1");
  });

  it("get lists every live tab's effective value", () => {
    const { deps } = rig();
    handleBrowserAccessSet(deps, { tabId: "tab-2", enabled: true }, MAIN);
    expect(handleBrowserAccessGet(deps, {}, MAIN)).toEqual({
      ok: true,
      tabs: [
        { tabId: "tab-1", fullAccess: false },
        { tabId: "tab-2", fullAccess: true },
      ],
    });
  });

  it("the notifier pushes the effective value exactly once per change (dedupes a repeat)", () => {
    const pushed: unknown[] = [];
    let current = false;
    const notifier = createBrowserAccessNotifier({
      effective: (tabId) => ({ tabId, fullAccess: current }),
      push: (state) => pushed.push(state),
    });
    notifier.seed("tab-1", false);
    current = true;
    notifier.refresh("tab-1");
    notifier.refresh("tab-1");
    current = false;
    notifier.refresh("tab-1");
    expect(pushed).toEqual([{ tabId: "tab-1", fullAccess: true }, { tabId: "tab-1", fullAccess: false }]);
  });
});

describe("browser access IPC (Taskana 4759) — test 47: untrusted folders are always OFF", () => {
  it("a pending or unknown trust decision shows OFF with reason trust, even when stored ON", () => {
    const { deps, on } = rig({ trust: { "tab-1": { workspace: "/ws", hash: "a".repeat(64) } } });
    on.add("sess-1");
    expect(effectiveTabState(deps, "tab-1")).toEqual({ tabId: "tab-1", fullAccess: false, reason: "trust" });
    const unknown = rig({ trust: { "tab-1": "unknown_tab" } });
    unknown.on.add("sess-1");
    expect(effectiveTabState(unknown.deps, "tab-1")).toEqual({ tabId: "tab-1", fullAccess: false, reason: "trust" });
  });

  it("set(true) for an untrusted tab is accepted into the store; the response and the list show OFF with reason trust", () => {
    const onChanged = vi.fn();
    const { deps, on } = rig({ trust: { "tab-1": { workspace: "/ws", hash: "a".repeat(64) } }, onChanged });
    expect(handleBrowserAccessSet(deps, { tabId: "tab-1", enabled: true }, MAIN)).toEqual({
      ok: true,
      tab: { tabId: "tab-1", fullAccess: false, reason: "trust" },
    });
    expect(on.has("sess-1")).toBe(true);
    expect(handleBrowserAccessGet(deps, {}, MAIN)).toMatchObject({ ok: true, tabs: expect.arrayContaining([{ tabId: "tab-1", fullAccess: false, reason: "trust" }]) });
  });

  it("once trust is decided the effective value turns ON and the notifier pushes it", () => {
    const pushed: unknown[] = [];
    const { deps, on, trust } = rig({ trust: { "tab-1": { workspace: "/ws", hash: "a".repeat(64) } } });
    on.add("sess-1");
    const notifier = createBrowserAccessNotifier({
      effective: (tabId) => effectiveTabState(deps, tabId),
      push: (state) => pushed.push(state),
    });
    notifier.seed("tab-1", false);
    trust.set("tab-1", "no_pending");
    notifier.refresh("tab-1");
    expect(pushed).toEqual([{ tabId: "tab-1", fullAccess: true }]);
  });

  it("a failed persist makes set return false, so the IPC reports io_error and nothing turns ON", () => {
    const store = createBrowserAccessStore({ file: "/nonexistent-dir-for-test/browser-access.json", defaultOn: () => false });
    store.register({ sessionId: "s" });
    expect(store.set("s", true)).toBe(false);
    expect(store.isOn("s")).toBe(false);
  });
});

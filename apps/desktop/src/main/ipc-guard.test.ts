/**
 * Tests for the IPC sender/top-frame guard (ipc-guard.ts), in two halves:
 *
 * 1. ENUMERATION: a source scan over every non-test main module asserting
 * ZERO direct `ipcMain.handle(` / `ipcMain.on(` registrations. This is the
 * regression ban: a NEW privileged channel cannot bypass the guard without
 * this test failing (driving all 159 live registrations at runtime would
 * need every module's full deps bag, so the scan is the cheaper airtight
 * half; the behavioral half below proves the wrapper semantics on four
 * real registration surfaces).
 *
 * 2. BEHAVIOR: `electron`'s `ipcMain` is mocked with a capturing fake and the
 * REAL window-ipc, preview/panel-ipc, preview/md-doc-ipc and tab-ipc modules
 * register through the guard. For EVERY captured channel: a foreign sender is
 * refused, a main-window SUBFRAME is refused, and a missing event is refused
 * (default deny). Delegation is proven per module through a deps spy (window
 * state-get, panel LIST, md-doc READ, tab BOOTSTRAP), plus the allow-list
 * half: the detached Markdown popout's window is added via
 * `addIpcGuardTrustedWindow` and its top-frame calls are served.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { capturedHandle, capturedOn } = vi.hoisted(() => ({
  capturedHandle: new Map<string, (...args: unknown[]) => unknown>(),
  capturedOn: new Map<string, (...args: unknown[]) => void>(),
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
}));

import {
  WINDOW_STATE_GET_CHANNEL,
} from "../shared/window.js";
import {
  PREVIEW_LIST_CHANNEL,
  PREVIEW_PANEL_SET_BOUNDS_CHANNEL,
} from "../shared/preview-panel.js";
import { MD_PREVIEW_READ_CHANNEL } from "../shared/md-preview.js";
import { TAB_BOOTSTRAP_CHANNEL } from "../shared/tabs.js";
import {
  addIpcGuardTrustedWindow,
  guardedIpcHandle,
  guardedIpcOn,
  isTopFrameIpcEvent,
  isTrustedIpcSender,
  removeIpcGuardTrustedWindow,
  resetIpcGuardForTests,
  setIpcGuardMainWindow,
} from "./ipc-guard.js";
import { registerWindowIpc } from "./window-ipc.js";
import { registerPreviewPanelIpc } from "./preview/panel-ipc.js";
import { registerMdDocIpc } from "./preview/md-doc-ipc.js";
import { registerTabIpc } from "./tab-ipc.js";
import type { PreviewHostHandle } from "./preview/preview-host.js";
import type { TabIpcDeps } from "./tab-ipc.js";

// ── shared fakes ──

const MAIN_FRAME = { frame: "main" };
/** The app's main window webContents fake (what index.ts wires as the guard source). */
const MAIN_SENDER = { mainFrame: MAIN_FRAME };
/** A trusted main-window TOP-frame event — exactly what Electron delivers for a renderer invoke. */
const MAIN_EVENT = { sender: MAIN_SENDER, senderFrame: MAIN_FRAME };
const FOREIGN_SENDER = { mainFrame: { frame: "foreign" } };
const FOREIGN_EVENT = { sender: FOREIGN_SENDER, senderFrame: FOREIGN_SENDER.mainFrame };
/** Same trusted sender, but the call comes from a SUBFRAME (e.g. a renderer iframe). */
const SUBFRAME_EVENT = { sender: MAIN_SENDER, senderFrame: { frame: "subframe" } };

/** The detached Markdown popout's webContents fake (what md-window-adapter allow-lists). */
const MD_SENDER = { mainFrame: { frame: "md-popout" } };
const MD_EVENT = { sender: MD_SENDER, senderFrame: MD_SENDER.mainFrame };

function invokeHandle(channel: string, event: unknown, ...args: unknown[]): unknown {
  const wrapper = capturedHandle.get(channel);
  if (wrapper === undefined) throw new Error(`no registered handler for ${channel}`);
  return wrapper(event, ...args);
}

function fireOn(channel: string, event: unknown, ...args: unknown[]): void {
  const wrapper = capturedOn.get(channel);
  if (wrapper === undefined) throw new Error(`no registered listener for ${channel}`);
  wrapper(event, ...args);
}

// ── 1. enumeration: no direct ipcMain registrations outside the guard ──

function collectMainSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMainSources(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "ipc-guard.ts") {
      out.push(full);
    }
  }
  return out;
}

/**
 * The ban covers every way to reach ipcMain, not just the two literal calls:
 * handleOnce/once variants, computed member access, the import/destructure of
 * ipcMain itself, destructuring or aliasing of its registration methods, and
 * passing it as an argument. Any hit in non-test main source means a channel
 * can bypass the guard.
 */
const IPC_MAIN_BAN_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /ipcMain\s*\.\s*(handleOnce|handle|once|on|addListener)\s*\(/, why: "direct ipcMain registration call" },
  { pattern: /ipcMain\s*\[/, why: "computed ipcMain member access" },
  { pattern: /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from/, why: "ipcMain import outside ipc-guard.ts" },
  { pattern: /\{\s*ipcMain\s*[,}]/, why: "destructuring ipcMain out of a namespace" },
  { pattern: /\{[^}]*\b(handleOnce|handle|once|on)\b[^}]*\}\s*=\s*ipcMain\b/, why: "destructuring ipcMain's registration methods" },
  { pattern: /=\s*ipcMain\s*[.;,)\s]/, why: "aliasing ipcMain" },
  { pattern: /\(\s*ipcMain\b/, why: "passing ipcMain as an argument" },
];

describe("ipc guard enumeration — every privileged registration goes through the guard", () => {
  it("no main module (tests and ipc-guard.ts excluded) reaches ipcMain in any form", () => {
    const mainDir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];
    for (const file of collectMainSources(mainDir)) {
      const text = readFileSync(file, "utf8");
      for (const { pattern, why } of IPC_MAIN_BAN_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${file}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── 2. pure helpers ──

describe("ipc guard helpers", () => {
  it("isTrustedIpcSender is identity-based: only the wired source or an allow-listed window", () => {
    resetIpcGuardForTests();
    expect(isTrustedIpcSender(MAIN_SENDER)).toBe(false);
    setIpcGuardMainWindow(() => MAIN_SENDER);
    expect(isTrustedIpcSender(MAIN_SENDER)).toBe(true);
    expect(isTrustedIpcSender(FOREIGN_SENDER)).toBe(false);
    expect(isTrustedIpcSender(undefined)).toBe(false);
    expect(isTrustedIpcSender(null)).toBe(false);
    addIpcGuardTrustedWindow(MD_SENDER);
    expect(isTrustedIpcSender(MD_SENDER)).toBe(true);
    removeIpcGuardTrustedWindow(MD_SENDER);
    expect(isTrustedIpcSender(MD_SENDER)).toBe(false);
  });

  it("isTopFrameIpcEvent requires senderFrame to BE the sender's mainFrame", () => {
    expect(isTopFrameIpcEvent(MAIN_EVENT)).toBe(true);
    expect(isTopFrameIpcEvent(SUBFRAME_EVENT)).toBe(false);
    expect(isTopFrameIpcEvent({ sender: MAIN_SENDER, senderFrame: undefined })).toBe(false);
    expect(isTopFrameIpcEvent({ sender: MAIN_SENDER })).toBe(false);
    expect(isTopFrameIpcEvent({})).toBe(false);
    expect(isTopFrameIpcEvent(undefined)).toBe(false);
    expect(isTopFrameIpcEvent(null)).toBe(false);
  });

  it("a THROWING getter (destroyed sender) fails closed instead of throwing out of the guard", () => {
    // Electron's destroyed webContents throws from its native accessors.
    const destroyedSender = {};
    Object.defineProperty(destroyedSender, "mainFrame", {
      get: () => {
        throw new TypeError("Object has been destroyed");
      },
    });
    expect(isTopFrameIpcEvent({ sender: destroyedSender, senderFrame: {} })).toBe(false);
    // The event object itself can carry the throwing getter (destructuring).
    const throwingEvent = {};
    Object.defineProperty(throwingEvent, "senderFrame", {
      get: () => {
        throw new TypeError("Object has been destroyed");
      },
    });
    expect(isTopFrameIpcEvent(throwingEvent)).toBe(false);
    // Wrapper level: the event is refused with the guard's refusal, not the
    // destroyed-object TypeError leaking out of the wrapper.
    setIpcGuardMainWindow(() => destroyedSender);
    guardedIpcHandle("anycode:guard-destroyed-sender", () => "served");
    expect(() => invokeHandle("anycode:guard-destroyed-sender", { sender: destroyedSender, senderFrame: {} })).toThrow(/refused/);
    // ...and an `on` wrapper DROPS the event: no exception escapes the listener.
    capturedOn.clear();
    guardedIpcOn("anycode:guard-destroyed-sender-on", () => {
      throw new Error("listener must not run");
    });
    expect(() => fireOn("anycode:guard-destroyed-sender-on", { sender: destroyedSender, senderFrame: {} })).not.toThrow();
    expect(() => fireOn("anycode:guard-destroyed-sender-on", throwingEvent)).not.toThrow();
  });

  it("a THROWING guard source fails closed: refuse on handle, silent drop on on", () => {
    setIpcGuardMainWindow(() => {
      throw new TypeError("Object has been destroyed");
    });
    guardedIpcHandle("anycode:guard-throwing-source", () => "served");
    expect(() => invokeHandle("anycode:guard-throwing-source", MAIN_EVENT)).toThrow(/refused/);
    capturedOn.clear();
    guardedIpcOn("anycode:guard-throwing-source-on", () => {
      throw new Error("listener must not run");
    });
    expect(() => fireOn("anycode:guard-throwing-source-on", MAIN_EVENT, { tabId: "t" })).not.toThrow();
  });
});

// ── 3. behavior: four real registration surfaces behind the guard ──

/** Minimal panel host: every channel the module registers touches exactly one of these spies. */
function fakePanelHost(): PreviewHostHandle {
  return {
    setPanelState: vi.fn(),
    setPanelBounds: vi.fn(),
    selectPanelPreview: vi.fn(() => ({ ok: true })),
    closePreview: vi.fn(() => ({ ok: true })),
    listForPanel: vi.fn(() => ({ previews: [], activePreviewId: null })),
    setContainer: vi.fn(async () => ({ ok: true as const })),
  } as unknown as PreviewHostHandle;
}

beforeEach(() => {
  resetIpcGuardForTests();
  capturedHandle.clear();
  capturedOn.clear();
  setIpcGuardMainWindow(() => MAIN_SENDER);
  registerWindowIpc({ getWindow: () => null });
  registerPreviewPanelIpc({ host: fakePanelHost() });
  registerMdDocIpc({
    getRecordRef: vi.fn(() => undefined),
    resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })),
    stat: vi.fn(async () => ({ size: 0, isFile: true, mtimeMs: 0 })),
    readFileNoFollow: vi.fn(async () => Buffer.from("")),
    commitNavigate: vi.fn(() => 1),
  });
  const listTabs = vi.fn(() => []);
  registerTabIpc({ manager: { listTabs } } as unknown as TabIpcDeps);
});

describe("ipc guard behavior — every captured channel refuses untrusted events", () => {
  it("a foreign sender is refused on every registered channel", () => {
    for (const channel of capturedHandle.keys()) {
      expect(() => invokeHandle(channel, FOREIGN_EVENT)).toThrow(/refused/);
    }
    // `on` channels have no reply channel: the refusal is a silent drop, and
    // SET_BOUNDS's listener never reaches the panel host.
    for (const channel of capturedOn.keys()) {
      expect(() => fireOn(channel, FOREIGN_EVENT, { tabId: "t", x: 1, y: 1, width: 2, height: 2 })).not.toThrow();
    }
  });

  it("a main-window SUBFRAME is refused on every registered channel", () => {
    for (const channel of capturedHandle.keys()) {
      expect(() => invokeHandle(channel, SUBFRAME_EVENT)).toThrow(/refused/);
    }
    for (const channel of capturedOn.keys()) {
      expect(() => fireOn(channel, SUBFRAME_EVENT, { tabId: "t", x: 1, y: 1, width: 2, height: 2 })).not.toThrow();
    }
  });

  it("a missing/undefined event is refused too (default deny, even for a trusted-looking call)", () => {
    for (const channel of capturedHandle.keys()) {
      expect(() => invokeHandle(channel, undefined)).toThrow(/refused/);
    }
  });
});

describe("ipc guard behavior — a trusted main-window top-frame call reaches the real handler", () => {
  it("window state-get computes from the live window", () => {
    expect(invokeHandle(WINDOW_STATE_GET_CHANNEL, MAIN_EVENT)).toEqual({ maximized: false, fullscreen: false });
  });

  it("panel LIST forwards to the host spy", () => {
    const host = fakePanelHost();
    capturedHandle.clear();
    registerPreviewPanelIpc({ host });
    const result = invokeHandle(PREVIEW_LIST_CHANNEL, MAIN_EVENT, { tabId: "t" }) as { previews: unknown[] };
    expect(result.previews).toEqual([]);
    expect(host.listForPanel).toHaveBeenCalledTimes(1);
  });

  it("md-doc READ forwards to the deps spy", async () => {
    const getRecordRef = vi.fn(() => undefined);
    capturedHandle.clear();
    registerMdDocIpc({
      getRecordRef,
      resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })),
      stat: vi.fn(async () => ({ size: 0, isFile: true, mtimeMs: 0 })),
      readFileNoFollow: vi.fn(async () => Buffer.from("")),
      commitNavigate: vi.fn(() => 1),
    });
    const result = (await invokeHandle(MD_PREVIEW_READ_CHANNEL, MAIN_EVENT, { tabId: "t", previewId: "p" })) as { reason?: string };
    // getRecordRef found nothing -> the handler's own no_preview refusal, NOT the guard's throw.
    expect(result).toEqual({ ok: false, reason: "no_preview" });
    expect(getRecordRef).toHaveBeenCalledTimes(1);
  });

  it("tab BOOTSTRAP forwards to the manager spy", () => {
    const listTabs = vi.fn(() => []);
    capturedHandle.clear();
    registerTabIpc({ manager: { listTabs } } as unknown as TabIpcDeps);
    expect(invokeHandle(TAB_BOOTSTRAP_CHANNEL, MAIN_EVENT)).toEqual({ tabs: [], activeTabId: null });
    expect(listTabs).toHaveBeenCalledTimes(1);
  });
});

describe("ipc guard behavior — the allow-listed Markdown popout is served from its top frame", () => {
  it("md-doc channels serve an allow-listed window's top-frame call and drop its subframe", async () => {
    const getRecordRef = vi.fn(() => undefined);
    capturedHandle.clear();
    registerMdDocIpc({
      getRecordRef,
      resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })),
      stat: vi.fn(async () => ({ size: 0, isFile: true, mtimeMs: 0 })),
      readFileNoFollow: vi.fn(async () => Buffer.from("")),
      commitNavigate: vi.fn(() => 1),
    });
    addIpcGuardTrustedWindow(MD_SENDER);
    const result = (await invokeHandle(MD_PREVIEW_READ_CHANNEL, MD_EVENT, { tabId: "t", previewId: "p" })) as { reason?: string };
    expect(result).toEqual({ ok: false, reason: "no_preview" });
    expect(getRecordRef).toHaveBeenCalledTimes(1);
    // Subframe of the SAME allow-listed window: still refused (top-frame rule).
    expect(() => invokeHandle(MD_PREVIEW_READ_CHANNEL, { sender: MD_SENDER, senderFrame: { frame: "md-sub" } }, { tabId: "t", previewId: "p" })).toThrow(/refused/);
    // Removed from the allow-list: refused again.
    removeIpcGuardTrustedWindow(MD_SENDER);
    expect(() => invokeHandle(MD_PREVIEW_READ_CHANNEL, MD_EVENT, { tabId: "t", previewId: "p" })).toThrow(/refused/);
  });

  it("the `on` channel drops an untrusted sender without reaching the host", () => {
    const host = fakePanelHost();
    capturedOn.clear();
    registerPreviewPanelIpc({ host });
    fireOn(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, FOREIGN_EVENT, { tabId: "t", x: 1, y: 1, width: 2, height: 2 });
    expect(host.setPanelBounds).not.toHaveBeenCalled();
    fireOn(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, MAIN_EVENT, { tabId: "t", x: 1, y: 1, width: 2, height: 2 });
    expect(host.setPanelBounds).toHaveBeenCalledTimes(1);
  });
});

describe("ipc guard behavior — default deny before any wiring", () => {
  it("an unwired guard refuses everything, even a well-formed trusted-looking event", () => {
    resetIpcGuardForTests();
    expect(() => invokeHandle(WINDOW_STATE_GET_CHANNEL, MAIN_EVENT)).toThrow(/refused/);
    expect(() => invokeHandle(WINDOW_STATE_GET_CHANNEL, FOREIGN_EVENT)).toThrow(/refused/);
  });
});

// ── 4. the wrappers really sit on ipcMain (mock capture proves the delegation) ──

describe("ipc guard wrappers delegate to ipcMain", () => {
  it("guardedIpcHandle/guardedIpcOn register through ipcMain.handle/on", () => {
    capturedHandle.clear();
    capturedOn.clear();
    guardedIpcHandle("anycode:guard-test-handle", () => "served");
    guardedIpcOn("anycode:guard-test-on", () => {});
    expect(capturedHandle.has("anycode:guard-test-handle")).toBe(true);
    expect(capturedOn.has("anycode:guard-test-on")).toBe(true);
    expect(invokeHandle("anycode:guard-test-handle", MAIN_EVENT)).toBe("served");
  });
});

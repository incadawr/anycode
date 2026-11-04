/**
 * Tests for the md-preview WINDOW adapter's security wiring (IPC-guard trust
 * + preview-ipc-risk F2 narrowing).
 *
 * `electron`'s `BrowserWindow` is faked with a class whose `webContents`
 * getter THROWS `TypeError("Object has been destroyed")` once the window is
 * destroyed — exactly what the real Electron getter does. That is one
 * regression this suite pins: the adapter used to read `win.webContents`
 * INSIDE the "closed" handler (fired by `destroy()` during app shutdown,
 * e.g. PreviewHost.closeAll -> destroyRecord), which threw "Object has been
 * destroyed" in the main process and popped the owner-visible Electron error
 * modal. The adapter must capture the webContents identity ONCE at creation
 * and use that captured identity for the guard entry, the target registry,
 * and their removal, so both entries still die with the window without ever
 * touching the destroyed window.
 *
 * The F2 hardening is pinned behaviorally through the SAME fakes: the
 * webPreferences carry the dedicated in-memory partition and the
 * narrow-bridge argv flag; the guard allow-list entry is CHANNEL-SCOPED
 * (a privileged channel is refused even from the popout's own top frame);
 * the popout is registered as the owner of exactly its (tabId, previewId);
 * and `protectMainNavigation` — the shared main-navigation guard — is wired
 * on the captured webContents (will-navigate/will-redirect/did-navigate/
 * did-start-navigation listeners + the window-open handler).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { capturedHandle, capturedOn, createdWindows } = vi.hoisted(() => ({
  capturedHandle: new Map<string, (...args: unknown[]) => unknown>(),
  capturedOn: new Map<string, (...args: unknown[]) => void>(),
  createdWindows: [] as Array<{
    opts: { webPreferences?: Record<string, unknown> };
    contentsEvents: Map<string, Array<(...args: unknown[]) => void>>;
    webContents: unknown;
    once: (event: string, listener: () => void) => void;
    isDestroyed: () => boolean;
    destroy: () => void;
    fireClosed: () => void;
  }>,
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
  // The fake models the two real-Electron behaviors this regression is about:
  // `.webContents` THROWS on a destroyed window, and `destroy()` still fires
  // "closed" (Electron guarantees closed for destroy(); it skips close only).
  BrowserWindow: class FakeBrowserWindow {
    #destroyed = false;
    #closedListeners: Array<() => void> = [];
    #contentsEvents = new Map<string, Array<(...args: unknown[]) => void>>();
    opts: { webPreferences?: Record<string, unknown> };
    #contents: unknown;

    constructor(opts: { webPreferences?: Record<string, unknown> }) {
      this.opts = opts ?? {};
      this.#contents = {
        mainFrame: { frame: "md-popout" },
        on: (event: string, listener: (...args: unknown[]) => void): void => {
          const list = this.#contentsEvents.get(event) ?? [];
          list.push(listener);
          this.#contentsEvents.set(event, list);
        },
        setWindowOpenHandler: vi.fn(),
      };
      createdWindows.push(this as unknown as (typeof createdWindows)[number]);
    }

    get webContents(): unknown {
      if (this.#destroyed) throw new TypeError("Object has been destroyed");
      return this.#contents;
    }

    get contentsEvents(): Map<string, Array<(...args: unknown[]) => void>> {
      return this.#contentsEvents;
    }

    once(event: string, listener: () => void): void {
      if (event === "closed") this.#closedListeners.push(listener);
    }

    isDestroyed(): boolean {
      return this.#destroyed;
    }

    destroy(): void {
      this.#destroyed = true;
      this.fireClosed();
    }

    fireClosed(): void {
      for (const listener of this.#closedListeners.splice(0)) listener();
    }
  },
  shell: {
    openExternal: vi.fn(async () => {}),
  },
}));

import {
  MD_PREVIEW_NAVIGATE_CHANNEL,
  MD_PREVIEW_READ_CHANNEL,
  MD_PREVIEW_WINDOW_ARGV_FLAG,
} from "../../shared/md-preview.js";
import { PREVIEW_LIST_CHANNEL, PREVIEW_SET_CONTAINER_CHANNEL } from "../../shared/preview-panel.js";
import {
  ARTIFACT_ALLOW_CHANNEL,
  ARTIFACT_OPEN_CHANNEL,
  ARTIFACT_PREVIEWABLE_CHANNEL,
  ARTIFACT_PREVIEW_CHANNEL,
  ARTIFACT_READ_IMAGE_CHANNEL,
  ARTIFACT_REVEAL_CHANNEL,
} from "../artifacts-ipc.js";
import { guardedIpcHandle, isTrustedIpcSender, resetIpcGuardForTests, setIpcGuardMainWindow } from "../ipc-guard.js";
import { mdWindowTargetOf, resetMdWindowTargetsForTests } from "./md-window-targets.js";
import { createMdPreviewWindow, MD_WINDOW_CHANNELS } from "./md-window-adapter.js";

const MAIN_SENDER = { mainFrame: { frame: "main" } };

beforeEach(() => {
  resetIpcGuardForTests();
  resetMdWindowTargetsForTests();
  createdWindows.length = 0;
  capturedHandle.clear();
  capturedOn.clear();
});

function rig() {
  const loadRenderer = vi.fn();
  const win = createMdPreviewWindow({ previewId: "p1", tabId: "t1" }, {
    preloadPath: "/fake/preload.cjs",
    rendererUrl: "http://127.0.0.1:5173/",
    loadRenderer,
  });
  const fake = createdWindows[0]!;
  return { win, fake, loadRenderer };
}

/** The document plane, spelled out literal by literal — the exact content the popout's allow-list must have. */
const DOCUMENT_PLANE_CHANNELS = [
  MD_PREVIEW_READ_CHANNEL,
  MD_PREVIEW_NAVIGATE_CHANNEL,
  PREVIEW_LIST_CHANNEL,
  PREVIEW_SET_CONTAINER_CHANNEL,
  ARTIFACT_READ_IMAGE_CHANNEL,
  ARTIFACT_OPEN_CHANNEL,
  ARTIFACT_REVEAL_CHANNEL,
  ARTIFACT_ALLOW_CHANNEL,
  ARTIFACT_PREVIEW_CHANNEL,
  ARTIFACT_PREVIEWABLE_CHANNEL,
];

/**
 * The channels the NARROW BRIDGE actually invokes, extracted from
 * preload/md-preview-bridge.ts's own source: the identifier passed to each
 * `ipcRenderer.invoke` call, resolved to its literal (locally defined
 * artifact literals parsed from the file; the shared-module imports resolved
 * through the same constants the bridge imports).
 */
function narrowBridgeInvokeChannels(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../../preload/md-preview-bridge.ts", import.meta.url)), "utf8");
  const localDefs = new Map<string, string>();
  for (const match of source.matchAll(/const\s+([A-Z_]+)\s*=\s*"(anycode:[^"]+)"/g)) {
    localDefs.set(match[1]!, match[2]!);
  }
  const imported = new Map<string, string>([
    ["MD_PREVIEW_READ_CHANNEL", MD_PREVIEW_READ_CHANNEL],
    ["MD_PREVIEW_NAVIGATE_CHANNEL", MD_PREVIEW_NAVIGATE_CHANNEL],
    ["PREVIEW_LIST_CHANNEL", PREVIEW_LIST_CHANNEL],
    ["PREVIEW_SET_CONTAINER_CHANNEL", PREVIEW_SET_CONTAINER_CHANNEL],
  ]);
  const names = [...source.matchAll(/ipcRenderer\.invoke\(\s*([A-Z_]+)/g)].map((match) => match[1]!);
  // An identifier that resolves to neither the file's own literals nor the
  // known imports stays as its own name — the equality assertion below then
  // fails loudly instead of the scan silently dropping the channel.
  return [...new Set(names)].map((name) => localDefs.get(name) ?? imported.get(name) ?? name).sort();
}

describe("md window adapter — guard trust wiring", () => {
  it("allow-lists the window's webContents at creation and loads the renderer", () => {
    const { win, fake, loadRenderer } = rig();
    const contents = fake.webContents;
    expect(contents).toBeDefined();
    expect(isTrustedIpcSender(contents)).toBe(true);
    expect(loadRenderer).toHaveBeenCalledTimes(1);
    expect(loadRenderer.mock.calls[0]![0]).toBe(fake);
    expect(loadRenderer.mock.calls[0]![1]).toEqual({ previewId: "p1", tabId: "t1" });
    expect(win.isDestroyed()).toBe(false);
  });

  it("removes the allow-list entry on 'closed' WITHOUT reading webContents off the destroyed window", () => {
    const { win, fake } = rig();
    const contents = fake.webContents;
    // destroy() fires "closed" synchronously; the old code read
    // `win.webContents` inside that handler and threw
    // TypeError("Object has been destroyed") straight into the main process.
    expect(() => win.destroy()).not.toThrow();
    expect(win.isDestroyed()).toBe(true);
    // The entry is still gone — the captured identity was removed.
    expect(isTrustedIpcSender(contents)).toBe(false);
  });

  it("the captured identity is stable: the closed handler removes exactly the entry added at creation", () => {
    const { win, fake } = rig();
    const contents = fake.webContents;
    win.destroy();
    // The entry added at creation is the one removed by the closed handler.
    expect(isTrustedIpcSender(contents)).toBe(false);
    // Re-reading webContents now throws, proving the handler never needed it.
    expect(() => fake.webContents).toThrow(/Object has been destroyed/);
  });
});

describe("md window adapter — F2 webPreferences narrowing", () => {
  it("runs in a dedicated in-memory session partition, never the default session", () => {
    const { fake } = rig();
    const prefs = fake.opts.webPreferences ?? {};
    expect(prefs["partition"]).toBe("md-preview");
    expect(String(prefs["partition"])).not.toMatch(/^persist:/);
  });

  it("stamps the narrow-bridge argv flag beside the renderer-url argument", () => {
    const { fake } = rig();
    const prefs = fake.opts.webPreferences ?? {};
    const args = prefs["additionalArguments"] as string[];
    expect(args).toContain(`--anycode-renderer-url=http://127.0.0.1:5173/`);
    expect(args).toContain(MD_PREVIEW_WINDOW_ARGV_FLAG);
    // The frozen triple is untouched.
    expect(prefs["sandbox"]).toBe(true);
    expect(prefs["contextIsolation"]).toBe(true);
    expect(prefs["nodeIntegration"]).toBe(false);
    expect(prefs["preload"]).toBe("/fake/preload.cjs");
  });
});

describe("md window adapter — channel-scoped guard allow-list", () => {
  it("serves the popout's document channels from its top frame but refuses a privileged channel", () => {
    setIpcGuardMainWindow(() => MAIN_SENDER);
    const { fake } = rig();
    const contents = fake.webContents;
    capturedHandle.clear();
    guardedIpcHandle(MD_PREVIEW_READ_CHANNEL, () => "doc");
    guardedIpcHandle("anycode:settings-get", () => "settings");
    guardedIpcHandle(ARTIFACT_READ_IMAGE_CHANNEL, () => "image");
    const mdEvent = { sender: contents, senderFrame: (contents as { mainFrame: unknown }).mainFrame };
    expect(capturedHandle.get(MD_PREVIEW_READ_CHANNEL)?.(mdEvent)).toBe("doc");
    expect(capturedHandle.get(ARTIFACT_READ_IMAGE_CHANNEL)?.(mdEvent)).toBe("image");
    // Even from its own top frame: no settings/plugins/trust/tab/proxy family.
    expect(() => capturedHandle.get("anycode:settings-get")?.(mdEvent)).toThrow(/refused/);
    // The main window is still served everywhere.
    const mainEvent = { sender: MAIN_SENDER, senderFrame: MAIN_SENDER.mainFrame };
    expect(capturedHandle.get("anycode:settings-get")?.(mainEvent)).toBe("settings");
  });

  it("allow-lists exactly the document plane (read/navigate/list/artifacts), nothing else", () => {
    const served = [MD_PREVIEW_READ_CHANNEL, MD_PREVIEW_NAVIGATE_CHANNEL, PREVIEW_LIST_CHANNEL, ARTIFACT_READ_IMAGE_CHANNEL, ARTIFACT_REVEAL_CHANNEL];
    const refused = ["anycode:settings-get", "anycode:settings-set", "anycode:secret-set", "anycode:tab-create", "anycode:plugins-list", "anycode:proxy-profile-upsert", "anycode:workspace-trust-decide", "anycode:window-minimize"];
    setIpcGuardMainWindow(() => MAIN_SENDER);
    capturedHandle.clear();
    for (const channel of [...served, ...refused]) guardedIpcHandle(channel, () => "served");
    const { fake } = rig();
    const contents = fake.webContents;
    const mdEvent = { sender: contents, senderFrame: (contents as { mainFrame: unknown }).mainFrame };
    for (const channel of served) {
      expect(capturedHandle.get(channel)?.(mdEvent)).toBe("served");
    }
    for (const channel of refused) {
      expect(() => capturedHandle.get(channel)?.(mdEvent)).toThrow(/refused/);
    }
  });

  it("the exported allow-list IS the document plane — and exactly what the narrow bridge invokes", () => {
    // The behavioral test above registers its OWN channel list, so appending
    // e.g. anycode:settings-get to MD_WINDOW_CHANNELS would keep it green.
    // Exact equality against the spelled-out document plane closes that gap.
    expect([...MD_WINDOW_CHANNELS]).toEqual(DOCUMENT_PLANE_CHANNELS);
    // Cross-check with the bridge: the allow-list must name exactly the
    // channels the popout's renderer can actually invoke — drift on either
    // side (a channel appended or removed) fails here.
    expect(narrowBridgeInvokeChannels()).toEqual([...MD_WINDOW_CHANNELS].sort());
  });
});

describe("md window adapter — main-side target binding", () => {
  it("registers the popout's webContents as owner of exactly its (tabId, previewId)", () => {
    const { fake } = rig();
    expect(mdWindowTargetOf(fake.webContents)).toEqual({ tabId: "t1", previewId: "p1" });
  });

  it("the target registration dies with the window (same captured identity, on 'closed')", () => {
    const { win, fake } = rig();
    const contents = fake.webContents;
    win.destroy();
    // The captured identity — not a fresh .webContents read (which now
    // throws, exactly like real Electron) — proves the entry is gone.
    expect(mdWindowTargetOf(contents)).toBeUndefined();
    expect(() => fake.webContents).toThrow(/Object has been destroyed/);
  });
});

describe("md window adapter — shared navigation guard is wired", () => {
  it("wires protectMainNavigation on the captured webContents (not a bare deny-only handler)", () => {
    const { fake } = rig();
    const events = fake.contentsEvents;
    // The shared guard registers exactly these four listeners...
    expect(events.has("did-start-navigation")).toBe(true);
    expect(events.has("did-navigate")).toBe(true);
    expect(events.has("will-navigate")).toBe(true);
    expect(events.has("will-redirect")).toBe(true);
    // ...and its own window-open handler (replacing the old deny-only one).
    expect((fake.webContents as { setWindowOpenHandler: ReturnType<typeof vi.fn> }).setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it("recovery after a slipped navigation reloads the window's own document (loadRenderer), not the bare renderer URL", () => {
    // The popout's document identity lives in its query
    // (?view=md-preview&tabId&previewId); a recovery that reloads the bare
    // renderer URL would bring the full app shell back inside the narrowed
    // bridge — a permanently non-functional window. The adapter supplies
    // loadRenderer as the guard's recovery loader, with the SAME opts.
    const { fake, loadRenderer } = rig();
    expect(loadRenderer).toHaveBeenCalledTimes(1);
    for (const listener of fake.contentsEvents.get("did-navigate") ?? []) {
      listener({}, "https://evil.example/");
    }
    expect(loadRenderer).toHaveBeenCalledTimes(2);
    expect(loadRenderer.mock.calls[1]![0]).toBe(fake);
    expect(loadRenderer.mock.calls[1]![1]).toEqual({ previewId: "p1", tabId: "t1" });
  });
});

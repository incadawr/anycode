/**
 * Production Electron adapter for PreviewHost (night-track wave-1 cut §2.5,
 * TASK.96 96-A): the ONLY file in this slice that touches real Electron
 * primitives. `preview-host.ts` never imports "electron" — every test there
 * runs against the fakes in its own test file. This module's job is narrow:
 * construct a `BrowserWindow` with the frozen security webPreferences and
 * adapt its real events/methods onto `PreviewWindowLike`/`PreviewWebContentsLike`.
 *
 * Console/pageerror capture: Electron's public `console-message` webContents
 * event reports BOTH `console.error()` calls AND uncaught exceptions at the
 * same `"error"` level — it cannot distinguish them. Chromium's own DevTools
 * protocol can: `Runtime.consoleAPICalled` vs `Runtime.exceptionThrown` are
 * separate CDP events. Attaching `webContents.debugger` and listening for
 * `Runtime.exceptionThrown` gets the real distinction the `PreviewConsoleEntry`
 * contract (`"pageerror"` as its own level) needs, WITHOUT a preload script —
 * the "no preload" security invariant (preview-host.ts's header) stays intact.
 *
 * Wave-1 security fix cut additions (night-track wave1-security-fix-cut.md
 * §1.1/§1.2/§1.3): `setRequestGate` maps to `session.webRequest.onBeforeRequest`
 * registered with NO url filter (the keystone F2 fix — it must see every
 * resource type, not a pattern-matched subset); `onWillRedirect` maps to
 * `will-redirect` (F1's belt-and-braces layer); `setWebRTCIPHandlingPolicy`
 * closes the STUN/UDP exfil channel `onBeforeRequest` cannot see; both
 * console-message and CDP exception strings are sliced to `RING_MAX_MSG_CHARS`
 * BEFORE they ever reach preview-host.ts (F3) — the size bound this module
 * enforces is defense-in-depth on top of preview-host.ts's own re-slice.
 *
 * panel-track CUT.md §1 D3 (TASK.96 96-P1): `wrapWebContents` takes a raw
 * `Electron.WebContents` + a `registerCleanup` hook instead of owning a
 * `BrowserWindow` directly, so the SAME adapter mapping (it only ever touches
 * `webContents`, never the owning window) is shared by this file's window
 * adapter AND `panel-adapter.ts`'s new `WebContentsView` adapter — one copy
 * of the event-adaptation/security-mapping logic for both containers (D1's
 * "one wiring copy" invariant lives in preview-host.ts; this is the matching
 * "one adapter mapping" invariant). `attachPageErrorCapture` generalizes its
 * `win.once("closed", ...)` detach to the same `registerCleanup` hook —
 * `createElectronPreviewWindow` passes `(fn) => win.once("closed", fn)`, so
 * window behavior is byte-identical to before this refactor.
 */

import { BrowserWindow, Menu, type NativeImage, type WebContents } from "electron";
import type { PreviewConsoleEntry } from "../../shared/preview.js";
import { isReturnShortcut, popoutTitle, returnMenuTemplate } from "./popout.js";
import {
  RING_MAX_MSG_CHARS,
  type CreateWindowOpts,
  type PreviewCapturedImage,
  type PreviewWebContentsLike,
  type PreviewWindowLike,
} from "./preview-host.js";

/** Exported: md-window-adapter.ts (TASK.99 M3) reuses the SAME default preview-window sizing for the md-preview window (CUT.md M3 scope: "match electron-adapter.ts's preview-window conventions"). */
export const DEFAULT_WIDTH = 1100;
export const DEFAULT_HEIGHT = 800;
/** CDP protocol version for `webContents.debugger.attach` (pageerror capture). */
const DEBUGGER_PROTOCOL_VERSION = "1.3";

function classifyConsoleLevel(level: "info" | "warning" | "error" | "debug"): PreviewConsoleEntry["level"] {
  if (level === "error") return "error";
  if (level === "warning") return "warn";
  return "log"; // "info" | "debug"
}

/**
 * Electron's OWN security warnings are not the page's console output. In a dev
 * build Electron writes them into the same `console-message` channel with a
 * literal `%c` formatting marker at the very START of the string
 * ("%cElectron Security Warning (…)") and at the warning level; fed through as
 * preview-console rows they looked like the page logging a warning and put raw
 * console text into the conversation. They say nothing about the user's
 * document, so they are dropped at capture time — the page's real warnings keep
 * flowing, including a page message that merely QUOTES the phrase (in the
 * middle of a warning, or inside a page error), which is the page's own
 * diagnostic output. Exported for the adapter's own wiring test.
 */
export const ELECTRON_INTERNAL_WARNING_PREFIX = "%cElectron Security Warning";

export function isElectronInternalWarning(message: string, level?: string): boolean {
  if (level !== undefined && level !== "warning") {
    return false;
  }
  return message.startsWith(ELECTRON_INTERNAL_WARNING_PREFIX);
}

/** Exported: md-window-adapter.ts (TASK.99 M3) reuses this for the md-preview window's own `capturePage()` — same `PreviewCapturedImage` wrapping, zero duplication. */
export function wrapCapturedImage(image: NativeImage): PreviewCapturedImage {
  return {
    toPNG: () => image.toPNG(),
    getSize: () => image.getSize(),
    isEmpty: () => image.isEmpty(),
  };
}

/** Taskana 4759: a CDP command that never answers must not hang a tool past its own timeout. */
export const CDP_SEND_TIMEOUT_MS = 10_000;

function withCdpTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP command timed out")), CDP_SEND_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Adapts one real `Electron.WebContents` onto `PreviewWebContentsLike` (D3):
 * shared verbatim by the window adapter (`createElectronPreviewWindow`,
 * below) and the panel adapter (`panel-adapter.ts`'s `createElectronPanelView`)
 * — the ONE place the security event wiring is mapped onto real Electron, for
 * either container. `onConsoleMessage` is settable exactly once by
 * `preview-host.ts`'s wiring (right after construction) — a single mutable
 * closure variable feeds BOTH the CDP pageerror capture (attached here,
 * before the caller ever calls `onConsoleMessage`) and the ordinary
 * `console-message` listener, so a pageerror is never lost to a
 * registration-order race.
 */
export function wrapWebContents(wc: WebContents, registerCleanup: (fn: () => void) => void): PreviewWebContentsLike {
  let consoleListener: (level: PreviewConsoleEntry["level"], message: string) => void = () => {};
  // Taskana 4759: ONE debugger message handler fans CDP events out to the
  // browser-control driver; the pageerror logic above stays first and unchanged.
  const cdpListeners: Array<(method: string, params: unknown) => void> = [];
  let attached = false;
  let messageWired = false;

  // Kills the common STUN/UDP exfil path that `onBeforeRequest` cannot see
  // (cut §1.1/F2, "one cheap adapter hardening that IS in scope"); the
  // TURN-over-TCP edge is a recorded residual (R2), not closed here.
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");

  const wireMessages = (): void => {
    if (messageWired) {
      return;
    }
    messageWired = true;
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Runtime.exceptionThrown") {
        const details = (params as { exceptionDetails?: { exception?: { description?: string }; text?: string } })
          .exceptionDetails;
        const message = (details?.exception?.description ?? details?.text ?? "uncaught exception").slice(
          0,
          RING_MAX_MSG_CHARS,
        );
        consoleListener("pageerror", message);
      }
      for (const listener of cdpListeners) {
        try {
          listener(method, params);
        } catch {
          // A control-driver listener must never break pageerror capture.
        }
      }
    });
  };

  /** Attaches the debugger once (idempotent while attached); never throws. */
  const attachDebugger = (): boolean => {
    if (attached) {
      return true;
    }
    try {
      wc.debugger.attach(DEBUGGER_PROTOCOL_VERSION);
    } catch {
      return false;
    }
    attached = true;
    wireMessages();
    wc.debugger.sendCommand("Runtime.enable").catch((error: unknown) => {
      console.warn("[preview] failed to enable CDP Runtime domain", error);
    });
    return true;
  };

  // DevTools (or a crashed page process) can detach us at any time; the next
  // CDP use re-attaches (ensureAttached below).
  wc.debugger.on("detach", () => {
    attached = false;
  });

  if (attachDebugger()) {
    registerCleanup(() => {
      try {
        wc.debugger.detach();
      } catch {
        // Already detached (e.g. DevTools attached to the same target instead).
      }
    });
  } else {
    console.warn("[preview] debugger attach failed; pageerror capture degraded to console-message only");
  }
  wc.on("console-message", (event) => {
    // Electron's own security warning is not a page console message (see
    // isElectronInternalWarning) — never surface it in the transcript. The
    // check needs BOTH the message's own `%c` marker at the start and the
    // warning level, so a page warning/error that merely contains the phrase
    // still reaches the transcript.
    if (isElectronInternalWarning(event.message, event.level)) {
      return;
    }
    // Sliced BEFORE the listener (cut §1.3/F3) — the giant string still
    // arrives in main once (Chromium delivers it; unavoidable) but is never
    // re-serialized host-ward at size. preview-host.ts's own slice at
    // recordConsole-time stays as defense-in-depth.
    consoleListener(classifyConsoleLevel(event.level), event.message.slice(0, RING_MAX_MSG_CHARS));
  });

  return {
    loadURL: (url) => wc.loadURL(url),
    // Taskana 4100 stage 4 (live-reload): reverts the page to its current
    // URL's on-disk bytes — the subsequent did-finish-load settles the
    // record "ready" exactly like an ordinary load (preview-host.ts's
    // scheduleLiveReload owns the debounce + status guards).
    reload: async () => {
      await wc.reload();
    },
    isDestroyed: () => wc.isDestroyed(),
    executeJavaScript: (script) => wc.executeJavaScript(script),
    capturePage: async () => wrapCapturedImage(await wc.capturePage()),
    setBackgroundThrottling: (enabled) => wc.setBackgroundThrottling(enabled),
    setWindowOpenHandler: (handler) => wc.setWindowOpenHandler(handler),
    setPermissionRequestHandler: (handler) => {
      // Session-scoped (Electron has no per-webContents permission handler); every
      // preview window gets its own partition (see createElectronPreviewWindow), so
      // this never touches the main app window's session.
      wc.session.setPermissionRequestHandler((_webContents, permission, callback) => handler(permission, callback));
    },
    onDidFinishLoad: (listener) => {
      wc.on("did-finish-load", () => listener());
    },
    onDidFailLoad: (listener) => {
      // Electron's did-fail-load fires for subframe/subresource failures too
      // (isMainFrame=false); forward it so the host can ignore non-main-frame
      // failures instead of failing the whole preview.
      wc.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        listener(errorCode, errorDescription, isMainFrame);
      });
    },
    onRenderProcessGone: (listener) => {
      wc.on("render-process-gone", (_event, details) => {
        listener(details.reason);
      });
    },
    onWillNavigate: (listener) => {
      wc.on("will-navigate", (event) => {
        listener(event.url, () => event.preventDefault());
      });
    },
    onWillRedirect: (listener) => {
      wc.on("will-redirect", (event) => {
        listener(event.url, () => event.preventDefault());
      });
    },
    onDidNavigate: (listener) => {
      wc.on("did-navigate", (_event, url) => {
        listener(url);
      });
    },
    onConsoleMessage: (listener) => {
      consoleListener = listener;
    },
    setRequestGate: (gate) => {
      // NO url filter (cut §1.1/F2): omitting it intercepts every scheme
      // incl. `file:`/`ws:` — `<all_urls>` pattern-matching is not relied on.
      wc.session.webRequest.onBeforeRequest((details, callback) => {
        gate({ url: details.url, resourceType: details.resourceType }).then(
          (allow) => callback({ cancel: !allow }),
          // Deny on gate rejection/throw; the Electron callback is ALWAYS answered.
          () => callback({ cancel: true }),
        );
      });
    },
    // D14 (96-P3): mapped verbatim to Electron 43's `navigationHistory` API —
    // asserted at typecheck (this file only compiles against the real
    // `electron.d.ts`), no runtime feature-sniff.
    getNavigationHistory: () => ({
      entries: wc.navigationHistory.getAllEntries().map((entry) => ({ url: entry.url, title: entry.title })),
      index: wc.navigationHistory.getActiveIndex(),
    }),
    restoreNavigationHistory: (state) => wc.navigationHistory.restore({ entries: state.entries, index: state.index }),
    // Taskana 4759: CDP access for the browser-control driver (main/preview/browser-control.ts).
    cdp: {
      send: (method, params) => {
        if (!attachDebugger()) {
          return Promise.reject(
            new Error("debugger unavailable (DevTools open on this preview, or the page process is gone)"),
          );
        }
        return withCdpTimeout(wc.debugger.sendCommand(method, params as object | undefined));
      },
      onEvent: (listener) => {
        cdpListeners.push(listener);
      },
      ensureAttached: () => attachDebugger(),
    },
    goToOffset: async (offset) => {
      wc.navigationHistory.goToOffset(offset);
    },
  };
}

/** Real `BrowserWindow`-backed `PreviewWindowLike` (§2.5's frozen security invariants). */
export function createElectronPreviewWindow(opts: CreateWindowOpts): PreviewWindowLike {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    // Taskana 4100 stage 4 (TASK.96 «Этап 4»: always-on-top для
    // превью-окон): a preview window is a passive artifact viewer the user
    // wants beside the app — 'floating' keeps it above the main window
    // without fighting the OS focus (macOS floating level; Windows/Linux
    // honor the flag best-effort).
    alwaysOnTop: true,
    ...(opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Unique, non-persistent session per preview: isolates cookies/storage
      // between previews and keeps `setPermissionRequestHandler` scoped away
      // from the main app window's (default) session.
      partition: `preview-${opts.previewId}`,
    },
  });

  // Taskana 4778: the window shows the page title (or host), never the app name,
  // and offers "Return to AnyCode" (menu bar on Windows/Linux, right-click menu and
  // Cmd/Ctrl+Shift+D everywhere) which re-docks the preview into the pane.
  const wc = win.webContents;
  const refreshTitle = (pageTitle?: string): void => {
    if (win.isDestroyed()) {
      return;
    }
    win.setTitle(popoutTitle(pageTitle ?? wc.getTitle(), wc.getURL()));
  };
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    refreshTitle(title);
  });
  wc.on("did-navigate", () => refreshTitle());
  wc.on("did-finish-load", () => refreshTitle());
  const onRedock = opts.onRedock;
  if (onRedock !== undefined) {
    const template = returnMenuTemplate(onRedock);
    if (process.platform !== "darwin") {
      win.setMenu(Menu.buildFromTemplate(template));
    }
    wc.on("context-menu", () => {
      Menu.buildFromTemplate(template).popup({ window: win });
    });
    wc.on("before-input-event", (event, input) => {
      if (isReturnShortcut(input)) {
        event.preventDefault();
        onRedock();
      }
    });
  }

  return {
    webContents: wrapWebContents(win.webContents, (fn) => win.once("closed", fn)),
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    show: () => win.show(),
    showInactive: () => win.showInactive(),
    onClosed: (listener) => {
      win.once("closed", listener);
    },
  };
}

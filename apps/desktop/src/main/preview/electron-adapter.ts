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

import { BrowserWindow, type NativeImage, type WebContents } from "electron";
import type { PreviewConsoleEntry } from "../../shared/preview.js";
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

/** Exported: md-window-adapter.ts (TASK.99 M3) reuses this for the md-preview window's own `capturePage()` — same `PreviewCapturedImage` wrapping, zero duplication. */
export function wrapCapturedImage(image: NativeImage): PreviewCapturedImage {
  return {
    toPNG: () => image.toPNG(),
    getSize: () => image.getSize(),
    isEmpty: () => image.isEmpty(),
  };
}

/**
 * Best-effort CDP attach for `Runtime.exceptionThrown` -> classified
 * "pageerror". Never throws. `registerCleanup` (D3) is the container-neutral
 * teardown hook — the window adapter wires it to `win.once("closed", fn)`,
 * the panel adapter (panel-adapter.ts) wires it to its own synthesized
 * `destroy()` cleanup list.
 */
function attachPageErrorCapture(
  wc: WebContents,
  registerCleanup: (fn: () => void) => void,
  onPageError: (message: string) => void,
): void {
  try {
    wc.debugger.attach(DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    console.warn("[preview] debugger attach failed; pageerror capture degraded to console-message only", error);
    return;
  }
  wc.debugger.on("message", (_event, method, params) => {
    if (method !== "Runtime.exceptionThrown") {
      return;
    }
    const details = (params as { exceptionDetails?: { exception?: { description?: string }; text?: string } })
      .exceptionDetails;
    const message = (details?.exception?.description ?? details?.text ?? "uncaught exception").slice(
      0,
      RING_MAX_MSG_CHARS,
    );
    onPageError(message);
  });
  wc.debugger.sendCommand("Runtime.enable").catch((error: unknown) => {
    console.warn("[preview] failed to enable CDP Runtime domain", error);
  });
  registerCleanup(() => {
    try {
      wc.debugger.detach();
    } catch {
      // Already detached (e.g. DevTools attached to the same target instead).
    }
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

  // Kills the common STUN/UDP exfil path that `onBeforeRequest` cannot see
  // (cut §1.1/F2, "one cheap adapter hardening that IS in scope"); the
  // TURN-over-TCP edge is a recorded residual (R2), not closed here.
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");

  attachPageErrorCapture(wc, registerCleanup, (message) => consoleListener("pageerror", message));
  wc.on("console-message", (event) => {
    // Sliced BEFORE the listener (cut §1.3/F3) — the giant string still
    // arrives in main once (Chromium delivers it; unavoidable) but is never
    // re-serialized host-ward at size. preview-host.ts's own slice at
    // recordConsole-time stays as defense-in-depth.
    consoleListener(classifyConsoleLevel(event.level), event.message.slice(0, RING_MAX_MSG_CHARS));
  });

  return {
    loadURL: (url) => wc.loadURL(url),
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
  };
}

/** Real `BrowserWindow`-backed `PreviewWindowLike` (§2.5's frozen security invariants). */
export function createElectronPreviewWindow(opts: CreateWindowOpts): PreviewWindowLike {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
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

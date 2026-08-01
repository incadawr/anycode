/**
 * PreviewHost (night-track wave-1 cut §2.5, TASK.96 96-A, the keystone slice):
 * owns every live "browser preview" window for every tab, the security
 * invariants that make loading an agent-authored HTML/markdown file or a
 * localhost/remote URL safe in a real BrowserWindow, and the main-side half
 * of the host<->main RPC transport (shared/preview.ts §2.3).
 *
 * Electron-free by construction, mirroring main/tabs.ts's own doc comment:
 * every Electron primitive (window creation, navigation, capture, console
 * capture) is INJECTED via `PreviewWindowLike`/`PreviewWebContentsLike` (this
 * file) with a real implementation in `preview/electron-adapter.ts`. That is
 * what lets the security-invariant suite (will-navigate matrix, permission
 * denial, teardown, throttling, RPC correlation) run under plain `vitest`
 * against hand-written fakes, with zero Electron runtime involved.
 *
 * THREAT MODEL (mirrors artifacts-ipc.ts's header, same shape, different
 * surface): a preview window RUNS the page it loads — scripts execute, unlike
 * the read-only image/text bytes artifacts-ipc.ts hands the renderer. The
 * containment invariant here is therefore about what the window may load and
 * navigate to, not what bytes reach it:
 *  - Local files: only realpaths under the tab's allowed artifact roots
 *    (workspace / `<home>/.anycode` / the OS temp dir — the SAME roots
 *    artifacts-ipc.ts defines; `deps.resolveArtifact` is main/index.ts's
 *    binding of that exact resolver) may ever be loaded or navigated to.
 *    Outside-root local files are refused outright — there is no click-
 *    through consent for a live script-running window the way there is for
 *    the read-only chat-artifact Open action (77-A is a DIFFERENT threat
 *    model: bytes-into-renderer vs a live page).
 *  - `localhost`/`127.0.0.1` origins (any port): always allowed — a local dev
 *    server the user is actively iterating on.
 *  - Any other remote origin: refused unless the OPEN request itself carries
 *    `allowRemote: true` (the 96-B tool's permission-engine approval IS the
 *    user's consent for that request); consent is recorded per-preview,
 *    per-origin and never widens to a different origin or a different
 *    preview window.
 *  - `will-navigate` enforces the identical policy for in-page navigation
 *    (a link clicked inside the loaded page): this is NOT redundant with the
 *    open-time check — `will-navigate` never fires for the initial
 *    `loadURL`, so the open path must independently enforce the same rule
 *    before the first navigation ever starts (risk §5.2).
 *  - Every preview window is created with `{sandbox:true, contextIsolation:
 *    true, nodeIntegration:false}` and NO preload; `setWindowOpenHandler`
 *    always denies (no `window.open` popups); the permission-request handler
 *    denies every browser permission (camera/mic/geolocation/notifications/…).
 *
 * WAVE-1 SECURITY FIX CUT (amends the invariants above, night-track
 * wave1-security-fix-cut.md §1.1/§1.2): `will-navigate` only ever covered the
 * top frame's OWN in-page navigation — never an `<iframe>`, an `<img>`, a
 * `fetch`/XHR/WebSocket, a `<script src>`, or a server-redirect leg (which
 * re-enters as a brand-new top-frame request, not a `will-navigate` event).
 * A per-partition `session.webRequest.onBeforeRequest` gate (installed once
 * at wiring time, adapter-mapped, NO url filter) is now the authoritative net
 * for every resource type and every redirect hop; a synchronous `will-
 * redirect` listener is a belt-and-braces second layer over the identical
 * policy (`preventDefault` must fire inside that event turn — an async gate
 * decision cannot arrive in time to stop the redirect from completing). A
 * denied subresource is legible: one deduplicated ring-buffer entry per
 * blocked origin/path, readable through `BrowserRead`'s console tail.
 *
 * R1 residual (recorded, owner sign-off pending — wave1-security-fix-cut.md
 * §2 R1): `localhost`/`127.0.0.1`/`::1` opens stay `needsApproval:false` (a
 * deliberate product choice — "the dev server the user just started") and
 * diverge from `packages/core/src/tools/web-fetch.ts`'s WebFetch tool, which
 * explicitly REFUSES loopback/RFC1918/link-local as an SSRF guard; the
 * approval text for a `url`-form open never names the host:port either. This
 * cut narrows, but does not close, that divergence: a REMOTE page can no
 * longer pivot into loopback (the request gate's rule 4 denies a loopback
 * subresource whenever `record.kind === "remote"`), so what remains is scoped
 * to "the model asks BrowserOpen for a loopback URL directly" — not "any
 * consented remote origin can reach loopback transitively".
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PREVIEW_EVENT_TYPE,
  PREVIEW_RESPONSE_TYPE,
  type PreviewArtifactsMessage,
  type PreviewConsoleEntry,
  type PreviewEventMessage,
  type PreviewOp,
  type PreviewOpenSuccess,
  type PreviewReadSuccess,
  type PreviewRequestMessage,
  type PreviewResponseMessage,
  type PreviewResult,
  type PreviewScreenshotSuccess,
} from "../../shared/preview.js";

// ── minimal Electron-free surfaces (prod impl: preview/electron-adapter.ts) ──

/** A captured frame, structurally matching the slice of Electron's NativeImage this module needs. */
export interface PreviewCapturedImage {
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
}

export interface PreviewWebContentsLike {
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  executeJavaScript<T = unknown>(script: string): Promise<T>;
  capturePage(): Promise<PreviewCapturedImage>;
  setBackgroundThrottling(enabled: boolean): void;
  /** Always wired to deny — no `window.open` popups from a preview page. */
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  /** Always wired to deny every permission (camera/mic/geolocation/notifications/…). */
  setPermissionRequestHandler(handler: (permission: string, callback: (granted: boolean) => void) => void): void;
  onDidFinishLoad(listener: () => void): void;
  onDidFailLoad(listener: (errorCode: number, errorDescription: string, isMainFrame: boolean) => void): void;
  onRenderProcessGone(listener: (reason: string) => void): void;
  /** Fires for in-page navigation only — NOT for the initial `loadURL` (risk §5.2). */
  onWillNavigate(listener: (url: string, preventDefault: () => void) => void): void;
  /**
   * Belt-and-braces layer for server redirects (cut §1.2/F1): the request
   * gate below is the authoritative net (every redirect leg re-enters it as
   * a fresh mainFrame request), but `preventDefault` on a redirect must run
   * SYNCHRONOUSLY inside this event — an async gate decision cannot arrive
   * back in time to stop the redirect from completing.
   */
  onWillRedirect(listener: (url: string, preventDefault: () => void) => void): void;
  onDidNavigate(listener: (url: string) => void): void;
  /** Pre-classified by the adapter (log/warn/error/pageerror) — this layer never parses Electron's raw event shape. */
  onConsoleMessage(listener: (level: PreviewConsoleEntry["level"], message: string) => void): void;
  /**
   * Installed once at wiring time (cut §1.1/F2, the keystone fix): the
   * adapter maps this to a per-partition `session.webRequest.onBeforeRequest`
   * registered with NO url filter, so it covers every resource type —
   * subframes, images, scripts, fetch/XHR, WebSocket — that `will-navigate`
   * never sees, including every hop of a server redirect. Answered `false`
   * on throw/reject; the adapter always answers the underlying Electron
   * callback exactly once.
   */
  setRequestGate(gate: (req: { url: string; resourceType: string }) => Promise<boolean>): void;
}

export interface PreviewWindowLike {
  webContents: PreviewWebContentsLike;
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  showInactive(): void;
  /** Covers a preview closed by the user via native window chrome, not just our own `closeForTab`/`closeAll`. */
  onClosed(listener: () => void): void;
}

export interface CreateWindowOpts {
  previewId: string;
  /** Cascade position (undefined for the first window of the batch — the adapter picks its own default placement). */
  x?: number;
  y?: number;
}

export interface PreviewLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * A tab-scoped artifact-path resolver bound at the wiring site (main/index.ts
 * binds this to `artifacts-ipc.ts`'s `resolveContainedPath`, closed over that
 * tab's workspace/home/tmpdir/fs deps): resolves + realpaths a model-supplied
 * path and reports containment as ONE fact — `{realPath}` on success (found
 * AND contained), `{failure}` for every other case (missing, no workspace,
 * outside the allowed roots). PreviewHost never needs to distinguish those
 * failure reasons: any of them is an honest, non-leaking refusal here.
 */
export type PreviewArtifactResolver = (
  tabId: string,
  path: string,
) => Promise<{ realPath: string } | { failure: string }>;

export interface PreviewHostDeps {
  createWindow(opts: CreateWindowOpts): PreviewWindowLike;
  resolveArtifact: PreviewArtifactResolver;
  /** Live read of the persisted auto-open setting (cut §1(e)/§2.7; default ON). */
  autoOpenEnabled(): boolean;
  /**
   * Posts one control-plane message to the tab's CURRENT host proc. Respawn-
   * safe by construction: the wiring at main/index.ts resolves `tab.proc`
   * fresh on every call rather than closing over a stale process reference.
   * Returns false when there is no live proc to post to (message dropped).
   */
  postToHost(tabId: string, message: PreviewResponseMessage | PreviewEventMessage): boolean;
  /**
   * `.md` -> sanitized static HTML render (96-F). Absent (this checkpoint,
   * before 96-F merges) makes every `.md` open refuse honestly with
   * `errorKind: "unavailable"` — the source is NEVER loaded as plaintext.
   */
  renderMarkdown?: (realPath: string) => Promise<{ htmlPath: string } | { error: string }>;
  logger: PreviewLogger;
  now: () => number;
}

export interface PreviewSummary {
  previewId: string;
  url: string;
  sourcePath?: string;
  status: "loading" | "ready" | "failed" | "crashed";
  title?: string;
  consoleCount: number;
  dropped: number;
}

export interface PreviewHostHandle {
  /** Direct callable used by the RPC dispatch, turn-end auto-open, and the 96-E automation open route alike. */
  openForTab(
    tabId: string,
    req: { path?: string; url?: string; previewId?: string; allowRemote?: boolean },
  ): Promise<PreviewResult<PreviewOpenSuccess>>;
  /** The RPC entrypoint: dispatches `message.op`, then posts the correlated response itself. Never rejects. */
  handleRequest(tabId: string, message: PreviewRequestMessage): Promise<void>;
  /** Turn-end auto-open (cut §1(a)): fire-and-forget, setting-gated, dedup'd by realpath. */
  handleArtifacts(tabId: string, message: PreviewArtifactsMessage): void;
  /** Tab closed (NOT a host respawn) — destroys every preview that belonged to it. */
  closeForTab(tabId: string): void;
  /** Main window closed / shutdownEverything / will-quit backstop. */
  closeAll(): void;
  listForTab(tabId: string): PreviewSummary[];
  getConsole(tabId: string, previewId: string, tail?: number): { entries: PreviewConsoleEntry[]; dropped: number } | { error: string };
  /** Direct callable used by the RPC dispatch and the 96-E automation screenshot route alike. */
  screenshotFor(tabId: string, previewId?: string): Promise<PreviewResult<PreviewScreenshotSuccess>>;
}

// ── tunables ──

const RING_MAX_ENTRIES = 200;
/** Exported: electron-adapter.ts slices console-message/CDP-exception strings to this BEFORE they ever reach preview-host.ts (cut §1.3/F3). */
export const RING_MAX_MSG_CHARS = 500;
const EVENT_WINDOW_MS = 10_000;
const EVENT_MAX_PER_WINDOW = 20;
const OPEN_TIMEOUT_MS = 15_000;
/** "ops on non-ready wait ≤5s then honest error" (cut §2.5) — read/screenshot on a still-loading preview. */
const READY_WAIT_MS = 5_000;
const DEFAULT_WAIT_FOR_SELECTOR_MS = 5_000;
const MAX_WAIT_FOR_SELECTOR_MS = 10_000;
const SELECTOR_POLL_MS = 250;
const CASCADE_OFFSET_PX = 32;
const BASE_WINDOW_X = 96;
const BASE_WINDOW_Y = 96;
/** Chromium's `-3` `ERR_ABORTED`: superseded by a subsequent navigation (e.g. our own reuse-navigate) — never a real failure on its own. */
const ERR_ABORTED = -3;
/** Hard cap on any page-controlled string crossing into main (cut §1.3/F3): bounded BEFORE the structured clone leaves the page (in-script `.slice`), and re-enforced main-side in case a hostile page monkey-patches its own DOM getters to dodge that cap. */
export const READ_RESULT_MAX_CHARS = 200_000;
/** A previewed page spinning in a loop must not hang a read/pollSelector op past the outer tool timeout (cut §1.3/F3). */
export const EXEC_JS_TIMEOUT_MS = 10_000;

type PreviewErrorKind = NonNullable<Extract<PreviewResult<unknown>, { ok: false }>["errorKind"]>;
type SettleStatus = "ready" | "failed" | "crashed";

interface PreviewRecord {
  previewId: string;
  tabId: string;
  window: PreviewWindowLike;
  status: "loading" | SettleStatus;
  url: string;
  kind: "file" | "localhost" | "remote";
  sourcePath?: string;
  /** realpath of `sourcePath` — used for auto-open dedup, independent of the raw string the model wrote. */
  realSourcePath?: string;
  renderedFrom?: string;
  /** Temp HTML path from `renderMarkdown`; unlinked (best-effort) when this preview is destroyed. */
  renderedHtmlPath?: string;
  title?: string;
  consentedOrigins: Set<string>;
  /** Per-record dedup for the request-gate/redirect-gate legibility ring entry (cut §1.1) — a retry loop cannot flood the ring. */
  gateDeniedKeys: Set<string>;
  consoleRing: PreviewConsoleEntry[];
  consoleDropped: number;
  eventWindowStart: number;
  eventSentInWindow: number;
  eventSuppressedInWindow: number;
  createdAt: number;
  lastOpenedAt: number;
  errorMessage?: string;
  settleWaiters: Array<() => void>;
  destroyed: boolean;
}

/** Bracket/case-normalizing (cut §1.6/IPv6 fix): `URL.hostname` keeps IPv6 literals bracketed (`"[::1]"`), which a raw literal comparison never matches — the ONE helper every open/nav/redirect/gate check reuses. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

function selectorReadScript(selector: string, format: "text" | "html"): string {
  const sel = JSON.stringify(selector);
  const prop = format === "html" ? "outerHTML" : "innerText";
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${sel}));
    const text = nodes.map((el) => el.${prop} ?? "").join("\\n").slice(0, ${READ_RESULT_MAX_CHARS});
    return { text, matches: nodes.length };
  })()`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Distinguishes an `executeJavaScript` deadline from every other rejection reason (cut §1.3/F3). */
class ExecTimeoutError extends Error {}

/** One outcome of resolving what an `open` op should actually load. */
type OpenTarget =
  | {
      ok: true;
      kind: "file" | "localhost" | "remote";
      url: string;
      origin?: string;
      sourcePath?: string;
      realSourcePath?: string;
      renderedFrom?: string;
      renderedHtmlPath?: string;
    }
  | { ok: false; errorKind: PreviewErrorKind; error: string };

class PreviewHost implements PreviewHostHandle {
  private readonly previews = new Map<string, PreviewRecord>();

  constructor(private readonly deps: PreviewHostDeps) {}

  private now(): number {
    return this.deps.now();
  }

  private fail<T>(errorKind: PreviewErrorKind, error: string): PreviewResult<T> {
    return { ok: false, error, errorKind };
  }

  /**
   * Races an `executeJavaScript` call against `EXEC_JS_TIMEOUT_MS` (cut
   * §1.3/F3) — a previewed page spinning in a loop must not hang a read/
   * pollSelector op past the outer tool timeout. Rejects with
   * `ExecTimeoutError` on the deadline; the underlying page-side call is left
   * to resolve/reject on its own (Electron has no cancellation for it), its
   * result simply discarded.
   */
  private execWithTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ExecTimeoutError("executeJavaScript timed out"));
      }, EXEC_JS_TIMEOUT_MS);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // ── open ──

  async openForTab(
    tabId: string,
    req: { path?: string; url?: string; previewId?: string; allowRemote?: boolean },
  ): Promise<PreviewResult<PreviewOpenSuccess>> {
    const hasPath = req.path !== undefined && req.path !== "";
    const hasUrl = req.url !== undefined && req.url !== "";
    if (hasPath === hasUrl) {
      return this.fail("invalid_input", "exactly one of path or url is required");
    }

    let record: PreviewRecord;
    let isNewWindow: boolean;
    if (req.previewId !== undefined) {
      const existing = this.previews.get(req.previewId);
      if (existing === undefined || existing.tabId !== tabId || existing.destroyed) {
        return this.fail("invalid_input", `no such preview: ${req.previewId}`);
      }
      record = existing;
      isNewWindow = false;
    } else {
      const previewId = randomUUID();
      const cascade = this.cascadePosition();
      const window = this.deps.createWindow({ previewId, x: cascade.x, y: cascade.y });
      record = this.newRecord(tabId, previewId, window);
      this.previews.set(previewId, record);
      this.wireWindow(record);
      isNewWindow = true;
    }

    const target = hasPath
      ? await this.resolveFileTarget(tabId, req.path!)
      : this.resolveUrlTarget(req.url!, req.allowRemote === true);

    if (!target.ok) {
      if (isNewWindow) {
        this.destroyRecord(record);
        this.previews.delete(record.previewId);
      }
      return this.fail(target.errorKind, target.error);
    }

    record.status = "loading";
    record.kind = target.kind;
    record.url = target.url;
    record.sourcePath = target.sourcePath;
    record.realSourcePath = target.realSourcePath;
    record.renderedFrom = target.renderedFrom;
    if (record.renderedHtmlPath !== undefined && record.renderedHtmlPath !== target.renderedHtmlPath) {
      // Reuse-navigate away from a rendered markdown temp file (cut §1.5/F8b):
      // unlink the ORPHANED previous render before this overwrite, same
      // best-effort semantics as `destroyRecord`'s own cleanup below.
      void unlink(record.renderedHtmlPath).catch(() => {
        // Best-effort temp-file cleanup — a missing/already-removed file is not an error.
      });
    }
    record.renderedHtmlPath = target.renderedHtmlPath;
    record.title = basename(target.sourcePath ?? target.url);
    record.lastOpenedAt = this.now();
    if (target.kind === "remote" && target.origin !== undefined) {
      record.consentedOrigins.add(target.origin);
    }

    try {
      void record.window.webContents.loadURL(target.url);
    } catch (error) {
      record.status = "failed";
      record.errorMessage = String(error);
      return this.fail("load_failed", `failed to start navigation: ${String(error)}`);
    }

    const settled = await this.waitForSettle(record, OPEN_TIMEOUT_MS);
    if (settled === "timeout") {
      return this.fail("timeout", "preview did not finish loading in time");
    }
    if (settled !== "ready") {
      return this.fail(
        settled === "crashed" ? "crashed" : "load_failed",
        record.errorMessage ?? "preview failed to load",
      );
    }
    return {
      ok: true,
      value: {
        previewId: record.previewId,
        url: record.url,
        title: record.title,
        kind: record.kind,
        ...(record.renderedFrom !== undefined ? { renderedFrom: record.renderedFrom } : {}),
      },
    };
  }

  private async resolveFileTarget(tabId: string, path: string): Promise<OpenTarget> {
    const resolved = await this.deps.resolveArtifact(tabId, path);
    if ("failure" in resolved) {
      return { ok: false, errorKind: "invalid_input", error: `cannot open ${path}: ${resolved.failure}` };
    }
    const realPath = resolved.realPath;
    if (isMarkdownPath(path)) {
      if (this.deps.renderMarkdown === undefined) {
        // Never load the raw markdown as plaintext HTML — refuse honestly instead (cut §1(g)).
        return { ok: false, errorKind: "unavailable", error: "markdown preview not available yet" };
      }
      const rendered = await this.deps.renderMarkdown(realPath);
      if ("error" in rendered) {
        return { ok: false, errorKind: "load_failed", error: rendered.error };
      }
      return {
        ok: true,
        kind: "file",
        url: pathToFileURL(rendered.htmlPath).href,
        sourcePath: path,
        realSourcePath: realPath,
        renderedFrom: path,
        renderedHtmlPath: rendered.htmlPath,
      };
    }
    return {
      ok: true,
      kind: "file",
      url: pathToFileURL(realPath).href,
      sourcePath: path,
      realSourcePath: realPath,
    };
  }

  private resolveUrlTarget(rawUrl: string, allowRemote: boolean): OpenTarget {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, errorKind: "invalid_input", error: `invalid url: ${rawUrl}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, errorKind: "invalid_input", error: `unsupported url scheme: ${parsed.protocol}` };
    }
    if (isLocalHost(parsed.hostname)) {
      return { ok: true, kind: "localhost", url: parsed.toString() };
    }
    if (!allowRemote) {
      return { ok: false, errorKind: "invalid_input", error: "remote URL requires explicit approval (allowRemote)" };
    }
    return { ok: true, kind: "remote", url: parsed.toString(), origin: parsed.origin };
  }

  // ── read ──

  private async readForTab(tabId: string, op: Extract<PreviewOp, { kind: "read" }>): Promise<PreviewResult<PreviewReadSuccess>> {
    const record = this.resolveTarget(tabId, op.previewId);
    if (record === undefined) {
      return this.fail(
        "unavailable",
        op.previewId !== undefined ? `no such preview: ${op.previewId}` : "no preview open — use BrowserOpen",
      );
    }
    const settled = await this.waitForSettle(record, READY_WAIT_MS);
    if (settled === "timeout") {
      return this.fail("timeout", "preview is not ready");
    }
    if (settled !== "ready") {
      return this.fail(settled === "crashed" ? "crashed" : "load_failed", record.errorMessage ?? "preview failed to load");
    }

    if (op.waitForSelector !== undefined) {
      const waitMs = Math.min(op.waitMs ?? DEFAULT_WAIT_FOR_SELECTOR_MS, MAX_WAIT_FOR_SELECTOR_MS);
      const found = await this.pollSelector(record, op.waitForSelector, waitMs);
      if (!found) {
        return this.fail("timeout", `selector not found: ${op.waitForSelector}`);
      }
    }

    const format = op.format ?? "text";
    let text: string;
    let matches: number | undefined;
    try {
      if (op.selector !== undefined) {
        const result = await this.execWithTimeout(
          record.window.webContents.executeJavaScript<unknown>(selectorReadScript(op.selector, format)),
        );
        // A hostile page can monkey-patch DOM getters to return an arbitrary
        // clonable value (cut §1.3/F3) — a non-conforming shape is an honest
        // load_failed, never a crash.
        if (
          typeof result !== "object" ||
          result === null ||
          typeof (result as { text: unknown }).text !== "string" ||
          typeof (result as { matches: unknown }).matches !== "number"
        ) {
          return this.fail("load_failed", "preview page returned an unexpected result shape");
        }
        const shaped = result as { text: string; matches: number };
        text = shaped.text.slice(0, READ_RESULT_MAX_CHARS);
        matches = shaped.matches;
      } else {
        const raw = await this.execWithTimeout(
          record.window.webContents.executeJavaScript<unknown>(
            format === "html"
              ? `document.documentElement.outerHTML.slice(0, ${READ_RESULT_MAX_CHARS})`
              : `(document.body ? document.body.innerText : '').slice(0, ${READ_RESULT_MAX_CHARS})`,
          ),
        );
        if (typeof raw !== "string") {
          return this.fail("load_failed", "preview page returned an unexpected result shape");
        }
        text = raw.slice(0, READ_RESULT_MAX_CHARS);
      }
    } catch (error) {
      if (error instanceof ExecTimeoutError) {
        return this.fail("timeout", "reading preview timed out");
      }
      return this.fail("load_failed", `failed to read preview: ${String(error)}`);
    }

    const includeConsole = op.includeConsole ?? true;
    return {
      ok: true,
      value: {
        previewId: record.previewId,
        url: record.url,
        text,
        ...(matches !== undefined ? { matches } : {}),
        ...(includeConsole ? { console: [...record.consoleRing], consoleDropped: record.consoleDropped } : {}),
      },
    };
  }

  /**
   * Polls by ATTEMPT COUNT, not the injected clock: `deps.now()` is a
   * bookkeeping clock for event-throttle windowing/ordering (test-controlled,
   * does not advance with real time), while this poll paces itself with a
   * REAL `setTimeout` (`sleep`) — mixing the two would let the deadline check
   * never trip in a test that does not also hand-advance `now()` in lockstep
   * with wall-clock time.
   */
  private async pollSelector(record: PreviewRecord, selector: string, waitMs: number): Promise<boolean> {
    const maxAttempts = Math.max(1, Math.ceil(waitMs / SELECTOR_POLL_MS));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const found = await this.execWithTimeout(
          record.window.webContents.executeJavaScript<boolean>(
            `document.querySelector(${JSON.stringify(selector)}) !== null`,
          ),
        );
        if (found) {
          return true;
        }
      } catch {
        return false;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(SELECTOR_POLL_MS);
      }
    }
    return false;
  }

  // ── screenshot ──

  async screenshotFor(tabId: string, previewId?: string): Promise<PreviewResult<PreviewScreenshotSuccess>> {
    const record = this.resolveTarget(tabId, previewId);
    if (record === undefined) {
      return this.fail(
        "unavailable",
        previewId !== undefined ? `no such preview: ${previewId}` : "no preview open — use BrowserOpen",
      );
    }
    const settled = await this.waitForSettle(record, READY_WAIT_MS);
    if (settled === "timeout") {
      return this.fail("timeout", "preview is not ready");
    }
    if (settled !== "ready") {
      return this.fail(settled === "crashed" ? "crashed" : "load_failed", record.errorMessage ?? "preview failed to load");
    }

    const wc = record.window.webContents;
    // macOS trap (risk §5.5): a backgrounded/occluded window can capture empty
    // unless shown first; `showInactive` avoids stealing focus from the main
    // window for what is otherwise an invisible, automatable operation.
    record.window.showInactive();
    wc.setBackgroundThrottling(false);
    try {
      let image = await wc.capturePage();
      if (image.isEmpty()) {
        record.window.show();
        image = await wc.capturePage();
      }
      const { width, height } = image.getSize();
      return {
        ok: true,
        value: {
          previewId: record.previewId,
          url: record.url,
          mediaType: "image/png",
          data: image.toPNG().toString("base64"),
          width,
          height,
        },
      };
    } catch (error) {
      return this.fail("load_failed", `screenshot failed: ${String(error)}`);
    } finally {
      wc.setBackgroundThrottling(true);
    }
  }

  // ── RPC dispatch ──

  async handleRequest(tabId: string, message: PreviewRequestMessage): Promise<void> {
    let result: PreviewResult<PreviewOpenSuccess | PreviewReadSuccess | PreviewScreenshotSuccess>;
    try {
      result = await this.dispatchOp(tabId, message.op);
    } catch (error) {
      // Every internal op already reports failure as a value; this is a pure
      // defense-in-depth net so a request can NEVER go unanswered.
      this.deps.logger.error(`[preview] unexpected error handling ${message.op.kind}`, error);
      result = this.fail("unavailable", "preview host failed unexpectedly");
    }
    this.deps.postToHost(tabId, { type: PREVIEW_RESPONSE_TYPE, requestId: message.requestId, result });
  }

  private dispatchOp(
    tabId: string,
    op: PreviewOp,
  ): Promise<PreviewResult<PreviewOpenSuccess | PreviewReadSuccess | PreviewScreenshotSuccess>> {
    switch (op.kind) {
      case "open":
        return this.openForTab(tabId, { path: op.path, url: op.url, previewId: op.previewId, allowRemote: op.allowRemote });
      case "read":
        return this.readForTab(tabId, op);
      case "screenshot":
        return this.screenshotFor(tabId, op.previewId);
    }
  }

  // ── auto-open (turn-end artifacts, cut §1(a)) ──

  handleArtifacts(tabId: string, message: PreviewArtifactsMessage): void {
    if (!this.deps.autoOpenEnabled()) {
      return;
    }
    for (const path of message.paths) {
      void this.autoOpenOne(tabId, path);
    }
  }

  private async autoOpenOne(tabId: string, path: string): Promise<void> {
    const resolved = await this.deps.resolveArtifact(tabId, path);
    if ("failure" in resolved) {
      return; // unresolvable/uncontained — silently skip, auto-open is best-effort
    }
    for (const record of this.previews.values()) {
      if (!record.destroyed && record.tabId === tabId && record.realSourcePath === resolved.realPath) {
        return; // already open in an existing preview — never stack a second window on the same file
      }
    }
    const result = await this.openForTab(tabId, { path });
    if (!result.ok) {
      this.deps.logger.warn(`[preview] auto-open failed for ${path}: ${result.error}`);
    }
  }

  // ── lifecycle ──

  closeForTab(tabId: string): void {
    for (const [id, record] of [...this.previews]) {
      if (record.tabId === tabId) {
        this.destroyRecord(record);
        this.previews.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [id, record] of [...this.previews]) {
      this.destroyRecord(record);
      this.previews.delete(id);
    }
  }

  private destroyRecord(record: PreviewRecord): void {
    if (record.destroyed) {
      return;
    }
    record.destroyed = true;
    this.flushEventSummary(record);
    if (record.status === "loading") {
      record.errorMessage = "preview was closed before it finished loading";
      record.status = "failed";
    }
    const waiters = record.settleWaiters;
    record.settleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
    if (!record.window.isDestroyed()) {
      try {
        record.window.destroy();
      } catch (error) {
        this.deps.logger.warn(`[preview] failed to destroy window for ${record.previewId}`, error);
      }
    }
    if (record.renderedHtmlPath !== undefined) {
      void unlink(record.renderedHtmlPath).catch(() => {
        // Best-effort temp-file cleanup — a missing/already-removed file is not an error.
      });
    }
  }

  // ── inspection (96-E automation probes) ──

  listForTab(tabId: string): PreviewSummary[] {
    const out: PreviewSummary[] = [];
    for (const record of this.previews.values()) {
      if (record.destroyed || record.tabId !== tabId) {
        continue;
      }
      out.push({
        previewId: record.previewId,
        url: record.url,
        ...(record.sourcePath !== undefined ? { sourcePath: record.sourcePath } : {}),
        status: record.status,
        ...(record.title !== undefined ? { title: record.title } : {}),
        consoleCount: record.consoleRing.length,
        dropped: record.consoleDropped,
      });
    }
    return out;
  }

  getConsole(
    tabId: string,
    previewId: string,
    tail?: number,
  ): { entries: PreviewConsoleEntry[]; dropped: number } | { error: string } {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId) {
      return { error: `no such preview: ${previewId}` };
    }
    const entries = tail !== undefined && tail > 0 ? record.consoleRing.slice(-tail) : [...record.consoleRing];
    return { entries, dropped: record.consoleDropped };
  }

  // ── internals ──

  private newRecord(tabId: string, previewId: string, window: PreviewWindowLike): PreviewRecord {
    const now = this.now();
    return {
      previewId,
      tabId,
      window,
      status: "loading",
      url: "",
      kind: "file",
      consentedOrigins: new Set(),
      gateDeniedKeys: new Set(),
      consoleRing: [],
      consoleDropped: 0,
      eventWindowStart: now,
      eventSentInWindow: 0,
      eventSuppressedInWindow: 0,
      createdAt: now,
      lastOpenedAt: now,
      settleWaiters: [],
      destroyed: false,
    };
  }

  /** Every live (non-destroyed) preview count, across all tabs — cascade is a global visual offset, not per-tab. */
  private cascadePosition(): { x: number; y: number } {
    let count = 0;
    for (const record of this.previews.values()) {
      if (!record.destroyed) {
        count += 1;
      }
    }
    return { x: BASE_WINDOW_X + count * CASCADE_OFFSET_PX, y: BASE_WINDOW_Y + count * CASCADE_OFFSET_PX };
  }

  /** `previewId` omitted -> the most-recently-opened LIVE preview of this tab (§2.2); none open -> undefined. */
  private resolveTarget(tabId: string, previewId: string | undefined): PreviewRecord | undefined {
    if (previewId !== undefined) {
      const record = this.previews.get(previewId);
      return record !== undefined && record.tabId === tabId && !record.destroyed ? record : undefined;
    }
    let best: PreviewRecord | undefined;
    for (const record of this.previews.values()) {
      if (record.destroyed || record.tabId !== tabId) {
        continue;
      }
      if (best === undefined || record.lastOpenedAt > best.lastOpenedAt) {
        best = record;
      }
    }
    return best;
  }

  private settle(record: PreviewRecord, status: SettleStatus): void {
    if (record.status !== "loading") {
      return; // already settled (e.g. a late did-fail-load after we already marked ready)
    }
    record.status = status;
    const waiters = record.settleWaiters;
    record.settleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private waitForSettle(record: PreviewRecord, timeoutMs: number): Promise<SettleStatus | "timeout"> {
    if (record.status !== "loading") {
      return Promise.resolve(record.status);
    }
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        resolve("timeout");
      }, timeoutMs);
      record.settleWaiters.push(() => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(record.status as SettleStatus);
      });
    });
  }

  // ── window wiring (security invariants live here) ──

  private wireWindow(record: PreviewRecord): void {
    const wc = record.window.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.setPermissionRequestHandler((_permission, callback) => callback(false));

    wc.onDidFinishLoad(() => {
      this.settle(record, "ready");
    });
    wc.onDidFailLoad((errorCode, errorDescription, isMainFrame) => {
      if (errorCode === ERR_ABORTED) {
        return;
      }
      // A subframe/subresource failure (e.g. the request gate blocking a
      // remote iframe, or a 404 image) must NOT fail the whole preview: the
      // main document loaded, the page renders degraded. Gate-blocked
      // subresources already surface as a "blocked by security policy" console
      // entry; other subresource failures are the page's own concern, visible
      // via BrowserRead. Only a main-frame failure settles the record.
      if (!isMainFrame) {
        return;
      }
      record.errorMessage = `${errorDescription} (${errorCode})`;
      this.settle(record, "failed");
    });
    wc.onRenderProcessGone((reason) => {
      record.errorMessage = `renderer process gone: ${reason}`;
      this.settle(record, "crashed");
    });
    wc.onWillNavigate((navUrl, preventDefault) => {
      preventDefault();
      void this.evaluateNavigation(record, navUrl).then((result) => {
        if (result.allow) {
          // F8a (TOCTOU): load the REALPATH the policy check already resolved,
          // never the raw `navUrl` a symlink could have repointed since.
          if (!record.window.isDestroyed() && !wc.isDestroyed()) {
            void wc.loadURL(result.loadUrl);
          }
        } else {
          this.deps.logger.warn(`[preview] denied navigation for ${record.previewId}: ${navUrl}`);
        }
      });
    });
    // F1 belt-and-braces layer: the request gate below is the authoritative
    // net (every redirect leg re-enters it as a fresh mainFrame request), but
    // `preventDefault` here is SYNCHRONOUS and therefore the only thing that
    // can actually stop this specific redirect from completing.
    wc.onWillRedirect((redirectUrl, preventDefault) => {
      if (this.evaluateRedirect(record, redirectUrl)) {
        return;
      }
      preventDefault();
      this.deps.logger.warn(`[preview] denied redirect for ${record.previewId}: ${redirectUrl}`);
      this.recordDeniedOnce(
        record,
        this.gateDedupeKeyForRedirect(redirectUrl),
        `[preview] blocked by security policy: redirect ${redirectUrl.slice(0, 200)}`,
        record.gateDeniedKeys,
      );
    });
    wc.onDidNavigate((navUrl) => {
      record.url = navUrl;
    });
    wc.onConsoleMessage((level, message) => {
      this.recordConsole(record, {
        level,
        message: message.slice(0, RING_MAX_MSG_CHARS),
        at: new Date(this.now()).toISOString(),
      });
    });
    // F2 keystone: per-partition request gate covering every resource type
    // (subframes, images, scripts, fetch/XHR, WebSocket) that will-navigate
    // never sees, and every redirect hop besides.
    wc.setRequestGate(this.makeRequestGate(record));
    record.window.onClosed(() => {
      this.destroyRecord(record);
      this.previews.delete(record.previewId);
    });
  }

  /**
   * Same policy as the open-time checks, applied to an in-page navigation
   * target (risk §5.2). Returns the URL to actually load rather than a bare
   * boolean (cut §1.5/F8a): for a `file:` target this is the REALPATH this
   * function already resolved via `deps.resolveArtifact` (mirrors
   * `openForTab`'s own `pathToFileURL(realPath)`), closing the TOCTOU window
   * a raw-`navUrl` load would leave between the containment check and the
   * load itself (a symlink repointed in between would otherwise land an
   * out-of-root file in the window).
   */
  private async evaluateNavigation(
    record: PreviewRecord,
    navUrl: string,
  ): Promise<{ allow: false } | { allow: true; loadUrl: string }> {
    if (navUrl.startsWith("file:")) {
      let filePath: string;
      try {
        filePath = fileURLToPath(navUrl);
      } catch {
        return { allow: false };
      }
      const resolved = await this.deps.resolveArtifact(record.tabId, filePath);
      if (!("realPath" in resolved)) {
        return { allow: false };
      }
      return { allow: true, loadUrl: pathToFileURL(resolved.realPath).href };
    }
    let parsed: URL;
    try {
      parsed = new URL(navUrl);
    } catch {
      return { allow: false };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allow: false };
    }
    if (isLocalHost(parsed.hostname) || record.consentedOrigins.has(parsed.origin)) {
      return { allow: true, loadUrl: parsed.toString() };
    }
    return { allow: false };
  }

  /**
   * Synchronous, http(s)-only redirect check (cut §1.2/F1): Chromium already
   * refuses unsafe schemes as a redirect target, so anything non-http(s) here
   * denies outright; no `file:` resolution is ever needed for a redirect
   * target. Synchronous is both required (`preventDefault` must run inside
   * the `will-redirect` event turn) and sufficient for that reason.
   */
  private evaluateRedirect(record: PreviewRecord, url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLocalHost(parsed.hostname) || record.consentedOrigins.has(parsed.origin);
  }

  private gateDedupeKeyForRedirect(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  /**
   * ONE gate policy function (cut §1.1/F2, the keystone fix), closed over the
   * LIVE `record` — `record.kind`/`record.consentedOrigins` are read at
   * request time, so a reuse-navigate kind change is honored automatically.
   * Exhaustive for every `(url, resourceType)`:
   *   1. Unparseable URL => deny.
   *   2. `about:`/`data:`/`blob:` => allow (no network egress).
   *   3. `file:` => resolve via `deps.resolveArtifact`; not contained =>
   *      deny; contained mainFrame => allow; contained subresource => allow
   *      only if `record.kind === "file"`.
   *   4. `http(s):`/`ws(s):` — normalize hostname (lowercase + de-bracket)
   *      and the origin's scheme (ws->http, wss->https) before comparing:
   *        - localhost (any port): mainFrame => allow; subresource => allow
   *          iff `record.kind !== "remote"` (a consented remote page must
   *          not be able to pivot into loopback).
   *        - any other origin => allow iff the normalized origin is in
   *          `record.consentedOrigins` — for BOTH mainFrame and subresource,
   *          which is exactly what closes the redirect-to-unconsented-origin
   *          hole (F1): a redirect leg re-enters here as a mainFrame request
   *          for the new origin, and consent never widens to it.
   *   5. Any other scheme (`devtools:`, `chrome:`, …) => deny.
   */
  private async classifyGateRequest(
    record: PreviewRecord,
    req: { url: string; resourceType: string },
  ): Promise<{ allowed: boolean; dedupeKey: string }> {
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      return { allowed: false, dedupeKey: req.url };
    }
    const scheme = parsed.protocol;
    if (scheme === "about:" || scheme === "data:" || scheme === "blob:") {
      return { allowed: true, dedupeKey: req.url };
    }
    if (scheme === "file:") {
      let filePath: string;
      try {
        filePath = fileURLToPath(parsed);
      } catch {
        return { allowed: false, dedupeKey: req.url };
      }
      const resolved = await this.deps.resolveArtifact(record.tabId, filePath);
      if (!("realPath" in resolved)) {
        return { allowed: false, dedupeKey: filePath };
      }
      if (req.resourceType === "mainFrame") {
        return { allowed: true, dedupeKey: filePath };
      }
      return { allowed: record.kind === "file", dedupeKey: filePath };
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:") {
      const normalizedScheme = scheme === "ws:" ? "http:" : scheme === "wss:" ? "https:" : scheme;
      const origin = `${normalizedScheme}//${parsed.host}`;
      if (isLocalHost(parsed.hostname)) {
        if (req.resourceType === "mainFrame") {
          return { allowed: true, dedupeKey: origin };
        }
        return { allowed: record.kind !== "remote", dedupeKey: origin };
      }
      return { allowed: record.consentedOrigins.has(origin), dedupeKey: origin };
    }
    return { allowed: false, dedupeKey: req.url };
  }

  /**
   * Builds the closure `wireWindow` installs via `setRequestGate`. Legibility
   * (non-negotiable, cut §1.1): a denied SUBRESOURCE records exactly one ring
   * entry, deduplicated per (record, origin-or-file-path) via `warnedKeys` —
   * a retry loop cannot flood the ring. A denied mainFrame request logs via
   * `deps.logger.warn` instead (it already surfaces as a load failure to the
   * model). Resolver rejection/throw is answered `deny`, never propagated —
   * this function must never itself reject.
   */
  private makeRequestGate(record: PreviewRecord): (req: { url: string; resourceType: string }) => Promise<boolean> {
    return async (req) => {
      let outcome: { allowed: boolean; dedupeKey: string };
      try {
        outcome = await this.classifyGateRequest(record, req);
      } catch {
        outcome = { allowed: false, dedupeKey: req.url };
      }
      if (!outcome.allowed) {
        if (req.resourceType === "mainFrame") {
          this.deps.logger.warn(`[preview] denied request for ${record.previewId}: ${req.resourceType} ${req.url}`);
        } else {
          this.recordDeniedOnce(
            record,
            outcome.dedupeKey,
            `[preview] blocked by security policy: ${req.resourceType} ${req.url.slice(0, 200)}`,
            record.gateDeniedKeys,
          );
        }
      }
      return outcome.allowed;
    };
  }

  /** Records ONE ring entry per (record, key) — a retry loop cannot flood the ring (cut §1.1 legibility requirement). */
  private recordDeniedOnce(record: PreviewRecord, key: string, message: string, warnedKeys: Set<string>): void {
    if (warnedKeys.has(key)) {
      return;
    }
    warnedKeys.add(key);
    this.recordConsole(record, {
      level: "warn",
      message,
      at: new Date(this.now()).toISOString(),
    });
  }

  // ── console ring + throttled forwarding ──

  private recordConsole(record: PreviewRecord, entry: PreviewConsoleEntry): void {
    record.consoleRing.push(entry);
    if (record.consoleRing.length > RING_MAX_ENTRIES) {
      record.consoleRing.shift();
      record.consoleDropped += 1;
    }
    this.forwardEvent(record, entry);
  }

  private forwardEvent(record: PreviewRecord, entry: PreviewConsoleEntry): void {
    const now = this.now();
    if (now - record.eventWindowStart >= EVENT_WINDOW_MS) {
      this.flushEventSummary(record);
      record.eventWindowStart = now;
      record.eventSentInWindow = 0;
    }
    if (record.eventSentInWindow < EVENT_MAX_PER_WINDOW) {
      record.eventSentInWindow += 1;
      this.deps.postToHost(record.tabId, { type: PREVIEW_EVENT_TYPE, previewId: record.previewId, entry });
    } else {
      record.eventSuppressedInWindow += 1;
    }
  }

  private flushEventSummary(record: PreviewRecord): void {
    if (record.eventSuppressedInWindow > 0) {
      this.deps.postToHost(record.tabId, {
        type: PREVIEW_EVENT_TYPE,
        previewId: record.previewId,
        suppressed: record.eventSuppressedInWindow,
      });
      record.eventSuppressedInWindow = 0;
    }
  }
}

/** Wires a fresh, deps-injected PreviewHost (mirrors main/artifacts-ipc.ts's `register<X>Ipc(deps)` convention). */
export function registerPreviewHost(deps: PreviewHostDeps): PreviewHostHandle {
  return new PreviewHost(deps);
}

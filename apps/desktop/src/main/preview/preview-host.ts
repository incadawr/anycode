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
import { basename, dirname } from "node:path";
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
import type {
  PreviewChangedPayload,
  PreviewContainerKind,
  PreviewPanelBounds,
  PreviewPanelInfo,
  PreviewPanelStatePayload,
  PreviewSetContainerResult,
} from "../../shared/preview-panel.js";

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
  /**
   * D14 transfer (96-P3): snapshot of the back/forward stack, captured from
   * the OLD contents before it is torn down. Synchronous (mirrors Electron's
   * own `navigationHistory.getAllEntries()`/`getActiveIndex()`, which never
   * touch the network).
   */
  getNavigationHistory(): { entries: Array<{ url: string; title: string }>; index: number };
  /**
   * D14 transfer (96-P3): replays a captured history onto the NEW contents —
   * Electron's `navigationHistory.restore()` also navigates to the active
   * entry itself, so the caller never calls `loadURL` alongside this (empty
   * history is the caller's cue to fall back to `loadURL(record.url)`
   * instead of calling this at all).
   */
  restoreNavigationHistory(state: { entries: Array<{ url: string; title: string }>; index: number }): Promise<void>;
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

/**
 * Panel extension over the existing seam (panel-track CUT.md §2.2, TASK.96
 * 96-P1). `PreviewWindowLike` above is UNCHANGED; a panel container
 * implements it plus this. `show()`/`showInactive()` map to `setVisible(true)`
 * in the adapter (panel-adapter.ts) — the host's panel paths never call them
 * (D13 handles the screenshot case explicitly via the visible-slot map +
 * `applyPanel()`).
 */
export interface PreviewPanelViewLike extends PreviewWindowLike {
  /** DIP ints; the caller (preview-host.ts's `applyPanel`) pre-clamps/rounds via `clampPanelBounds`. */
  setBounds(bounds: PreviewPanelBounds): void;
  setVisible(visible: boolean): void;
}

/**
 * M1 (TASK.99 CUT.md CONTRACTS): the slim window-like surface a dom-md
 * "Open in window" container will need — declared now so `MdDomPreviewRecord`
 * can carry a typed `mdWindow?` field, but nothing constructs one until M3
 * wires `PreviewHostDeps.createMdWindow` (`md-window-adapter.ts`). Deliberately
 * NOT `PreviewWindowLike`: a dom-md window has no `webContents` to secure —
 * it loads the SAME trusted renderer bundle the main window does, under a
 * `?view=md-preview` query route, not an arbitrary page.
 */
export interface MdPreviewWindowLike {
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  showInactive(): void;
  onClosed(listener: () => void): void;
  capturePage(): Promise<PreviewCapturedImage>;
  setBackgroundThrottling(enabled: boolean): void;
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
  /** Real `WebContentsView`-backed container (panel-adapter.ts's `createElectronPanelView`), injected the same way `createWindow` is. */
  createPanelView(opts: CreateWindowOpts): PreviewPanelViewLike;
  /**
   * M3 (TASK.99 CUT.md CONTRACTS): a second real `BrowserWindow` loading the
   * SAME trusted renderer bundle under a `?view=md-preview` query route
   * (`main/preview/md-window-adapter.ts`'s `createMdPreviewWindow`) —
   * renderer-URL/query construction is closed over at the wiring site
   * (main/index.ts), never here. Used both for a fresh `displayMode:"window"`
   * open and for a panel->window `setContainer` transfer.
   */
  createMdWindow(opts: { previewId: string; tabId: string }): MdPreviewWindowLike;
  /**
   * Live read of `settings.preview?.displayMode ?? "panel"` (D4), sibling of
   * `autoOpenEnabled` above: consulted ONLY when `openForTab` creates a NEW
   * record — a reuse (`previewId` given) keeps its existing container.
   */
  displayMode(): "panel" | "window";
  /** Main wires this to `win.webContents.send(PREVIEW_CHANGED_CHANNEL, payload)` (D7); absent is a safe no-op (e.g. in tests that never care). */
  onPreviewsChanged?(payload: PreviewChangedPayload): void;
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
  /** panel-track CUT.md §3 96-P4 gate fix: which container this preview lives in (panel vs window) — was missing from the 96-E automation probe shape, so a 96-P4 smoke could never assert on it. */
  container: PreviewContainerKind;
  /** M1 (TASK.99 CUT.md CONTRACTS): which record kind this is — 96-E probes assert on it. */
  viewKind: "web" | "dom-md";
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
  /** D7: renderer-published panel-gating state; triggers `applyPanel()`. */
  setPanelState(state: PreviewPanelStatePayload): void;
  /** D9: rAF-coalesced panel body rect (already clamped/rounded by the caller, re-clamped defensively here); `null` hides every panel (renderer-reload reset). Triggers `applyPanel()`. */
  setPanelBounds(bounds: PreviewPanelBounds | null): void;
  /** D5: makes a PANEL-container preview the visible slot occupant for its tab. */
  selectPanelPreview(tabId: string, previewId: string): { ok: boolean; error?: string };
  /** Destroys one preview (panel header ×), same semantics as a user-closed window. */
  closePreview(tabId: string, previewId: string): { ok: boolean; error?: string };
  /** Hydration read (P1): ALL of the tab's previews across both containers + the visible panel slot. */
  listForPanel(tabId: string): PreviewChangedPayload;
  /** D14: recreates the preview's container (panel<->window), preserving history/console/consent (96-P3). */
  setContainer(tabId: string, previewId: string, container: PreviewContainerKind): Promise<PreviewSetContainerResult>;
  /**
   * M1 (TASK.99): current doc identity for a LIVE dom-md record — the lookup
   * `md-doc.ts`'s read handler closes over (main/index.ts wiring) so it can
   * re-stat/re-read the source fresh on every invoke, never caching here.
   * `undefined` for no-such-preview, wrong tab, a destroyed record, or a
   * "web" record (this channel is md-only — see shared/md-preview.ts).
   */
  getMdDocRef(tabId: string, previewId: string): { sourcePath: string; realSourcePath: string; docDir: string; docVersion: number } | undefined;
  /**
   * M2 (TASK.99): commits a NAVIGATE mutation to a LIVE dom-md record —
   * `md-doc.ts`'s `navigateMdDoc` closes over this (main/index.ts wiring)
   * after its own fresh containment/read succeeds, so the record is never
   * mutated on a refused navigate. Updates `sourcePath`/`realSourcePath`/
   * `docDir`/`title` from `fields`, derives `url` from `realSourcePath`
   * (same `pathToFileURL` mapping every other record mutation site uses),
   * bumps `docVersion`/`lastOpenedAt`, and pushes the change (D7). Returns
   * the record's fresh `docVersion`, or `undefined` for no-such-preview/
   * wrong-tab/a destroyed record/a "web" record — mirrors `getMdDocRef`'s
   * own refusal set exactly, so `navigateMdDoc` can reuse the identical
   * `no_preview` mapping for both.
   */
  commitMdNavigate(
    tabId: string,
    previewId: string,
    fields: { sourcePath: string; realSourcePath: string; docDir: string; title: string },
  ): number | undefined;
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
/** D18: promote-then-capture race window — one short paint delay before the single retry. */
export const PANEL_SCREENSHOT_RETRY_DELAY_MS = 150;

/**
 * D9's main-side clamp (exported for panel-ipc.ts + tests, single source of
 * truth shared by both the IPC boundary and `PreviewHost.setPanelBounds`
 * itself, so a test driving either layer observes the identical result):
 * `x`/`y` floored at 0 (no upper bound — a panel is always laid out inside
 * the main window's own content area); `width`/`height` clamped to
 * `0..32768`. All four rounded to the nearest integer (DIP ints, cut §2.2).
 */
export function clampPanelBounds(bounds: PreviewPanelBounds): PreviewPanelBounds {
  const clampMin0 = (n: number): number => Math.max(0, Math.round(n));
  const clampWidthHeight = (n: number): number => Math.min(32768, Math.max(0, Math.round(n)));
  return {
    x: clampMin0(bounds.x),
    y: clampMin0(bounds.y),
    width: clampWidthHeight(bounds.width),
    height: clampWidthHeight(bounds.height),
  };
}

type PreviewErrorKind = NonNullable<Extract<PreviewResult<unknown>, { ok: false }>["errorKind"]>;
type SettleStatus = "ready" | "failed" | "crashed";

/** Today's preview shape (window/panel WebContentsView, executeJavaScript/capturePage-backed) — unchanged except the added discriminant. */
interface WebPreviewRecord {
  viewKind: "web";
  previewId: string;
  tabId: string;
  window: PreviewWindowLike;
  containerKind: "window" | "panel";
  /** SAME object as `window` when `containerKind === "panel"` — a narrower typed handle so `applyPanel()` can call `setBounds`/`setVisible` without a cast. Undefined for window-container records. */
  panelView?: PreviewPanelViewLike;
  status: "loading" | SettleStatus;
  url: string;
  kind: "file" | "localhost" | "remote";
  sourcePath?: string;
  /** realpath of `sourcePath` — used for auto-open dedup, independent of the raw string the model wrote. */
  realSourcePath?: string;
  renderedFrom?: string;
  /** Temp HTML path from `renderMarkdown`; unlinked (best-effort) when this preview is destroyed. Dead field from M1 on (the md open path no longer produces one) — removed in M5 alongside the pipeline (CUT.md Gap 3). */
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

/**
 * M1/M3 (TASK.99 CUT.md CONTRACTS): a `.md` preview rendered natively in the
 * renderer's own DOM (chat's `Markdown.tsx`, reused) — owns no `PreviewWindowLike`/
 * `PreviewWebContentsLike` at all in a panel container (nothing to secure:
 * there is no executeJavaScript/capturePage surface, no `webContents`,
 * because there is no embedded page). `status` settles SYNCHRONOUSLY at
 * open/navigate (no load to await) — never "loading"/"crashed", so there are
 * no `settleWaiters` either. M3: `displayMode()` is honored for a fresh
 * dom-md open exactly like the web path, and `setContainer` transfers both
 * directions — `mdWindow` is defined iff `containerKind === "window"`.
 */
interface MdDomPreviewRecord {
  viewKind: "dom-md";
  previewId: string;
  tabId: string;
  containerKind: "panel" | "window";
  /** Window container only (M3) — NEVER a `PreviewWindowLike`. Undefined for a panel-container record. */
  mdWindow?: MdPreviewWindowLike;
  status: "ready" | "failed";
  /** `pathToFileURL(realSourcePath).href` — kept so `PreviewOpenSuccess`/tool shapes stay unchanged across viewKinds. */
  url: string;
  sourcePath: string;
  realSourcePath: string;
  /** `dirname(realSourcePath)` — the resolver anchor for M2's doc-relative image/link joins. */
  docDir: string;
  /** = `sourcePath` (tool-contract continuity with the web record's own `renderedFrom`). */
  renderedFrom: string;
  title: string;
  /** Bumps on navigate (M2) — the renderer's MD_PREVIEW_READ refetch key. */
  docVersion: number;
  createdAt: number;
  lastOpenedAt: number;
  destroyed: boolean;
}

type PreviewRecord = WebPreviewRecord | MdDomPreviewRecord;

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

/**
 * D18: a `capturePage()` rejection is UnknownVizError-class when Chromium's
 * compositor hasn't produced a first frame yet for a view JUST promoted from
 * hidden to visible (panel-track CUT.md §6) — a visibility race, not a real
 * load failure. Matched on message content only (no error-class/name check:
 * Electron surfaces this as a plain `Error`, and the exact constructor is not
 * a documented contract).
 */
function isUnknownVizErrorLike(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("UnknownVizError");
  }
  return typeof error === "string" && error.includes("UnknownVizError");
}

/**
 * D14 epoch guard (the ONE guard helper `wireWindow` uses for every listener
 * it installs, not ten copies): wraps a listener body so it only ever runs
 * while `container` — captured once, at the `wireWindow` call that wired
 * it — is STILL the record's current container. A transfer
 * (`PreviewHost.setContainer`) swaps `record.window` to a fresh container and
 * re-runs `wireWindow` against it; every listener the OLD wiring installed
 * then fails this check forever (the old container is destroyed right after
 * the swap, but even a late in-flight event — did-fail-load,
 * render-process-gone, onClosed — arriving before that teardown lands must
 * not mutate or destroy a record that has already moved on).
 */
function guardContainerEpoch<A extends unknown[]>(
  record: WebPreviewRecord,
  container: PreviewWindowLike,
  handler: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    if (record.window !== container) {
      return;
    }
    handler(...args);
  };
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
  /** D5: one visible panel slot per tab — the previewId currently occupying it (absent = none). */
  private readonly visiblePanelPreviewId = new Map<string, string>();
  /** D7: renderer-published panel-gating state; all-hidden until the renderer's first setPanelState. */
  private panelState: PreviewPanelStatePayload = { activeTabId: null, panelMounted: false, overlayOpen: false };
  /** D9: last rAF-coalesced panel body rect, already clamped/rounded; null hides every panel. */
  private panelBounds: PreviewPanelBounds | null = null;

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

    let existing: PreviewRecord | undefined;
    if (req.previewId !== undefined) {
      const found = this.previews.get(req.previewId);
      if (found === undefined || found.tabId !== tabId || found.destroyed) {
        return this.fail("invalid_input", `no such preview: ${req.previewId}`);
      }
      existing = found;
    }

    if (hasPath && isMarkdownPath(req.path!)) {
      return this.openMarkdownTarget(tabId, req.path!, existing);
    }
    return this.openWebTarget(tabId, req, existing);
  }

  /**
   * The pre-M1 open flow, generalized to also accept a cross-viewKind flip
   * (CUT.md CONTRACTS "Cross-viewKind reuse-navigate"): `existing` may be a
   * `WebPreviewRecord` (ordinary reuse-navigate, byte-identical to the
   * pre-M1 behavior), a `MdDomPreviewRecord` (a BrowserOpen with the SAME
   * previewId whose target flipped from markdown to web — dom-md owns no
   * Electron container in M1, so there is nothing to tear down; a fresh
   * container is created under the SAME previewId/containerKind), or
   * undefined (brand-new preview, unchanged).
   */
  private async openWebTarget(
    tabId: string,
    req: { path?: string; url?: string; previewId?: string; allowRemote?: boolean },
    existing: PreviewRecord | undefined,
  ): Promise<PreviewResult<PreviewOpenSuccess>> {
    const hasPath = req.path !== undefined && req.path !== "";

    let record: WebPreviewRecord;
    let isNewWindow: boolean;
    if (existing !== undefined && existing.viewKind === "web") {
      record = existing;
      isNewWindow = false;
    } else {
      // Brand-new previewId, OR a dom-md->web flip landing on an existing
      // previewId — either way a fresh Electron container is created; a
      // flip reuses the OLD record's previewId/containerKind (CONTRACTS'
      // "previewId stays valid for the model"), a brand-new one mints both.
      if (existing !== undefined && existing.viewKind === "dom-md" && existing.mdWindow !== undefined && !existing.mdWindow.isDestroyed()) {
        // M3: a dom-md record can now own a live mdWindow (it could not in
        // M1) — tear it down before this flip overwrites the map entry with
        // a fresh web record below, mirroring openMarkdownTarget's own
        // symmetric web->md teardown (no orphan windows survive a
        // cross-viewKind flip either direction).
        try {
          existing.mdWindow.destroy();
        } catch (error) {
          this.deps.logger.warn(`[preview] failed to destroy old md window for ${existing.previewId} during flip`, error);
        }
      }
      const previewId = existing?.previewId ?? randomUUID();
      // D4: displayMode is consulted ONLY for a genuinely brand-new record —
      // a reuse/flip keeps its existing container regardless of a later
      // settings change.
      const containerKind: "window" | "panel" =
        existing?.containerKind ?? (this.deps.displayMode() === "panel" ? "panel" : "window");
      let window: PreviewWindowLike;
      let panelView: PreviewPanelViewLike | undefined;
      if (containerKind === "panel") {
        const view = this.deps.createPanelView({ previewId });
        window = view;
        panelView = view;
      } else {
        // Cascade position is windows-only (D4) — a panel has no free-floating position to cascade.
        const cascade = this.cascadePosition();
        window = this.deps.createWindow({ previewId, x: cascade.x, y: cascade.y });
      }
      record = this.newWebRecord(tabId, previewId, window, containerKind, panelView);
      this.previews.set(previewId, record);
      this.wireWindow(record);
      isNewWindow = true;
      if (containerKind === "panel") {
        // D5: the most-recently-opened panel preview of a tab is the visible
        // slot occupant — a second panel open on the same tab hides the first.
        this.visiblePanelPreviewId.set(tabId, previewId);
        this.applyPanel();
      }
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

  /**
   * M1/M3 (TASK.99 CUT.md Gap 3 + CONTRACTS): a `.md` open/reuse-navigate
   * never touches `deps.renderMarkdown` or a `PreviewWindowLike` — it
   * settles SYNCHRONOUSLY once containment resolves, tolerating a
   * cross-viewKind flip (an existing "web" record gets its Electron
   * container torn down; an existing "dom-md" record is mutated in place,
   * `docVersion` bumped). M3: `displayMode()` is consulted for a brand-new
   * record exactly like the web path (D4) — a `"window"` pick creates a live
   * `MdPreviewWindowLike` via `deps.createMdWindow` up front, no forced
   * panel narrowing.
   */
  private async openMarkdownTarget(
    tabId: string,
    path: string,
    existing: PreviewRecord | undefined,
  ): Promise<PreviewResult<PreviewOpenSuccess>> {
    const resolved = await this.deps.resolveArtifact(tabId, path);
    if ("failure" in resolved) {
      return this.fail("invalid_input", `cannot open ${path}: ${resolved.failure}`);
    }
    const realPath = resolved.realPath;

    let record: MdDomPreviewRecord;
    if (existing !== undefined && existing.viewKind === "dom-md") {
      record = existing;
      record.sourcePath = path;
      record.realSourcePath = realPath;
      record.docDir = dirname(realPath);
      record.renderedFrom = path;
      record.title = basename(path);
      record.url = pathToFileURL(realPath).href;
      record.docVersion += 1;
      record.status = "ready";
      record.lastOpenedAt = this.now();
    } else {
      if (existing !== undefined && existing.viewKind === "web") {
        // dom-md owns no Electron container to swap in-place (D14-style) —
        // the OLD web container is simply torn down; the record entry itself
        // is replaced below, same previewId/containerKind.
        if (!existing.window.isDestroyed()) {
          try {
            existing.window.destroy();
          } catch (error) {
            this.deps.logger.warn(`[preview] failed to destroy old container for ${existing.previewId} during md flip`, error);
          }
        }
      }
      const previewId = existing?.previewId ?? randomUUID();
      const containerKind: "window" | "panel" =
        existing?.containerKind ?? (this.deps.displayMode() === "panel" ? "panel" : "window");
      record = this.newMdRecord(tabId, previewId, path, realPath, containerKind);
      this.previews.set(previewId, record);
      if (containerKind === "window") {
        record.mdWindow = this.deps.createMdWindow({ previewId, tabId });
        this.wireMdWindow(record);
        record.mdWindow.show();
      }
    }

    if (record.containerKind === "panel") {
      // A panel dom-md record is brought to the front the same way a fresh
      // panel web-open does (D5). A window-container record has no panel
      // slot to reconcile — its own window already showed itself above.
      this.visiblePanelPreviewId.set(tabId, record.previewId);
      this.applyPanel();
    }
    this.pushChanged(tabId);

    return {
      ok: true,
      value: {
        previewId: record.previewId,
        url: record.url,
        title: record.title,
        kind: "file",
        renderedFrom: record.renderedFrom,
      },
    };
  }

  private async resolveFileTarget(tabId: string, path: string): Promise<OpenTarget> {
    const resolved = await this.deps.resolveArtifact(tabId, path);
    if ("failure" in resolved) {
      return { ok: false, errorKind: "invalid_input", error: `cannot open ${path}: ${resolved.failure}` };
    }
    const realPath = resolved.realPath;
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
    if (record.viewKind === "dom-md") {
      // M1 interim: full BrowserRead support for a dom-md preview (raw
      // source, honest selector refusal — CUT.md Gap 2) lands in M4.
      return this.fail("unavailable", "reading a markdown preview is not supported yet");
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
  private async pollSelector(record: WebPreviewRecord, selector: string, waitMs: number): Promise<boolean> {
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
    if (record.viewKind === "dom-md") {
      // M1 interim: full BrowserScreenshot support for a dom-md preview
      // (capturePage(rect) of the main window — CUT.md Gap 2) lands in M4.
      return this.fail("unavailable", "screenshotting a markdown preview is not supported yet");
    }
    const settled = await this.waitForSettle(record, READY_WAIT_MS);
    if (settled === "timeout") {
      return this.fail("timeout", "preview is not ready");
    }
    if (settled !== "ready") {
      return this.fail(settled === "crashed" ? "crashed" : "load_failed", record.errorMessage ?? "preview failed to load");
    }

    const wc = record.window.webContents;
    // F1: true when THIS call is the one moving the visible slot onto
    // `record` (the slot was empty or held by a different preview) — used
    // below to gate the isEmpty() retry onto the D18 race class specifically,
    // never a genuine hidden-panel refusal.
    let promoted = false;
    if (record.containerKind === "panel") {
      // D13: the container-agnostic `showInactive()` intent, mapped honestly
      // for a panel — promote this preview to the visible slot instead of
      // forcing container visibility; the overlay/tab/mount gates inside
      // `applyPanel()` are NEVER bypassed for a capture.
      promoted = this.visiblePanelPreviewId.get(record.tabId) !== record.previewId;
      this.visiblePanelPreviewId.set(record.tabId, record.previewId);
      this.applyPanel();
      this.pushChanged(record.tabId);
    } else {
      // macOS trap (risk §5.5): a backgrounded/occluded window can capture empty
      // unless shown first; `showInactive` avoids stealing focus from the main
      // window for what is otherwise an invisible, automatable operation.
      record.window.showInactive();
    }
    wc.setBackgroundThrottling(false);
    try {
      let image: PreviewCapturedImage;
      try {
        image = await wc.capturePage();
      } catch (error) {
        // D18: on a PANEL container only, an UnknownVizError-class rejection
        // means the view was JUST promoted (above) and Chromium hasn't
        // composited its first frame yet — retry once after a short paint
        // delay before treating this as a real failure. Any other rejection,
        // and every window-container rejection, re-throws to the outer catch
        // unchanged (a real load failure must never be masked as
        // "unavailable").
        if (record.containerKind !== "panel" || !isUnknownVizErrorLike(error)) {
          throw error;
        }
        await sleep(PANEL_SCREENSHOT_RETRY_DELAY_MS);
        try {
          image = await wc.capturePage();
        } catch (retryError) {
          if (!isUnknownVizErrorLike(retryError)) {
            throw retryError;
          }
          return this.fail(
            "unavailable",
            "screenshot unavailable while the panel preview has not yet painted a frame — switch to the tab or move the preview to a window",
          );
        }
      }
      if (image.isEmpty()) {
        if (record.containerKind === "panel") {
          if (!promoted) {
            // The slot was already held by this preview, so an empty frame
            // is NOT the D18 race — the reconciler still keeps it hidden
            // (inactive tab / unmounted region / overlay open). An honest
            // refusal, never a gate bypass, zero retry.
            return this.fail(
              "unavailable",
              "screenshot unavailable while the panel preview is hidden — switch to the tab or move the preview to a window",
            );
          }
          // F1: the D18 promote-then-capture race (above) can also manifest
          // as an EMPTY first frame instead of an UnknownVizError rejection —
          // notably when the slot's previous holder was a dom-md record,
          // which composites no WebContentsView at all, so nothing was ever
          // painted before this promote. Retry once, mirroring the
          // exception-path retry's semantics exactly: a still-UVE-class
          // rejection on the retry becomes the same honest "hasn't painted a
          // frame yet" refusal, any other rejection propagates unchanged, and
          // a still-empty (but non-rejecting) retry falls back to today's
          // "hidden" refusal.
          await sleep(PANEL_SCREENSHOT_RETRY_DELAY_MS);
          try {
            image = await wc.capturePage();
          } catch (retryError) {
            if (!isUnknownVizErrorLike(retryError)) {
              throw retryError;
            }
            return this.fail(
              "unavailable",
              "screenshot unavailable while the panel preview has not yet painted a frame — switch to the tab or move the preview to a window",
            );
          }
          if (image.isEmpty()) {
            return this.fail(
              "unavailable",
              "screenshot unavailable while the panel preview is hidden — switch to the tab or move the preview to a window",
            );
          }
        } else {
          record.window.show();
          image = await wc.capturePage();
        }
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
    if (record.viewKind === "web") {
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
    } else if (record.mdWindow !== undefined && !record.mdWindow.isDestroyed()) {
      // M3: a window-container dom-md record owns a live mdWindow — torn
      // down here on every path that reaches destroyRecord (closeForTab,
      // closeAll, closePreview, and the mdWindow's own guarded onClosed).
      try {
        record.mdWindow.destroy();
      } catch (error) {
        this.deps.logger.warn(`[preview] failed to destroy md window for ${record.previewId}`, error);
      }
    }
    if (record.containerKind === "panel" && this.visiblePanelPreviewId.get(record.tabId) === record.previewId) {
      // D5: the visible-slot occupant just died — re-point to the most-
      // recently-opened SURVIVING panel preview of this tab (none left ->
      // clear the slot).
      this.promoteMostRecentPanelSurvivor(record.tabId);
    }
    this.applyPanel();
    this.pushChanged(record.tabId);
  }

  // ── inspection (96-E automation probes) ──

  listForTab(tabId: string): PreviewSummary[] {
    const out: PreviewSummary[] = [];
    for (const record of this.previews.values()) {
      if (record.destroyed || record.tabId !== tabId) {
        continue;
      }
      if (record.viewKind === "dom-md") {
        // dom-md keeps no console ring in M1 (nothing runs script) — empty, honest.
        out.push({
          previewId: record.previewId,
          url: record.url,
          sourcePath: record.sourcePath,
          status: record.status,
          title: record.title,
          consoleCount: 0,
          dropped: 0,
          container: record.containerKind,
          viewKind: "dom-md",
        });
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
        container: record.containerKind,
        viewKind: "web",
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
    if (record.viewKind === "dom-md") {
      // Nothing runs script in a dom-md preview — an honest empty console, not a refusal.
      return { entries: [], dropped: 0 };
    }
    const entries = tail !== undefined && tail > 0 ? record.consoleRing.slice(-tail) : [...record.consoleRing];
    return { entries, dropped: record.consoleDropped };
  }

  // ── panel container (D5/D6/D7/D9/D13, panel-track CUT.md §2.2/§3 96-P1) ──

  setPanelState(state: PreviewPanelStatePayload): void {
    this.panelState = state;
    this.applyPanel();
  }

  setPanelBounds(bounds: PreviewPanelBounds | null): void {
    this.panelBounds = bounds === null ? null : clampPanelBounds(bounds);
    this.applyPanel();
  }

  selectPanelPreview(tabId: string, previewId: string): { ok: boolean; error?: string } {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId) {
      return { ok: false, error: `no such preview: ${previewId}` };
    }
    if (record.containerKind !== "panel") {
      return { ok: false, error: "preview is not in the panel" };
    }
    this.visiblePanelPreviewId.set(tabId, previewId);
    this.applyPanel();
    this.pushChanged(tabId);
    return { ok: true };
  }

  closePreview(tabId: string, previewId: string): { ok: boolean; error?: string } {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId) {
      return { ok: false, error: `no such preview: ${previewId}` };
    }
    this.destroyRecord(record);
    this.previews.delete(previewId);
    return { ok: true };
  }

  listForPanel(tabId: string): PreviewChangedPayload {
    const previews: PreviewPanelInfo[] = [];
    for (const record of this.previews.values()) {
      if (record.destroyed || record.tabId !== tabId) {
        continue;
      }
      previews.push({
        previewId: record.previewId,
        tabId: record.tabId,
        url: record.url,
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.sourcePath !== undefined ? { sourcePath: record.sourcePath } : {}),
        status: record.status,
        container: record.containerKind,
        viewKind: record.viewKind,
        ...(record.viewKind === "dom-md" ? { docVersion: record.docVersion } : {}),
      });
    }
    return {
      tabId,
      previews,
      visiblePanelPreviewId: this.visiblePanelPreviewId.get(tabId) ?? null,
    };
  }

  /**
   * D14 transfer (96-P3): recreate-with-epoch-guard. Same-container requests
   * are zero-churn no-ops (a "panel" one reuses D5's own select semantics; a
   * "window" one has nothing to select). A real transfer captures the OLD
   * contents' navigation history, creates the NEW container under the SAME
   * previewId (D2 — same partition, cookies/localStorage survive), swaps
   * `record.window`/`containerKind`/`panelView` to it, re-wires it (the
   * epoch guard below is what makes this swap-before-destroy order safe),
   * destroys the OLD container, then restores history (empty -> `loadURL`
   * fallback) and waits for it to settle. Any failure past this point
   * (restore/load rejects, or the new contents never reaches "ready") is
   * honest: `{ok:false}` with the record left in status "failed" — never
   * silently left "loading" — recoverable via another `BrowserOpen`.
   */
  async setContainer(
    tabId: string,
    previewId: string,
    container: PreviewContainerKind,
  ): Promise<PreviewSetContainerResult> {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId) {
      return { ok: false, error: `no such preview: ${previewId}` };
    }

    if (record.viewKind === "dom-md") {
      // M3 (CUT.md CONTRACTS): a same-container request is a zero-churn
      // no-op, byte-mirroring the web record's own same-container branch
      // below (a "panel" one reuses D5's own select semantics; a "window"
      // one has nothing to select). A genuine transfer creates/destroys the
      // `MdPreviewWindowLike` — no navigation-history dance (the window
      // re-reads on boot), so it settles synchronously, unlike the web path.
      if (record.containerKind === container) {
        if (container === "panel") {
          const result = this.selectPanelPreview(tabId, previewId);
          return result.ok ? { ok: true, reloaded: false } : { ok: false, error: result.error ?? "failed to select preview" };
        }
        return { ok: true, reloaded: false };
      }
      return this.transferMdContainer(tabId, record, container);
    }

    if (record.containerKind === container) {
      // Zero container churn (invariant — no create/destroy calls at all).
      if (container === "panel") {
        const result = this.selectPanelPreview(tabId, previewId);
        return result.ok ? { ok: true, reloaded: false } : { ok: false, error: result.error ?? "failed to select preview" };
      }
      return { ok: true, reloaded: false };
    }

    const oldContainer = record.window;
    const wasVisibleSlotHolder = record.containerKind === "panel" && this.visiblePanelPreviewId.get(tabId) === previewId;

    let history: { entries: Array<{ url: string; title: string }>; index: number };
    try {
      history = oldContainer.webContents.getNavigationHistory();
    } catch {
      history = { entries: [], index: 0 };
    }

    let newWindow: PreviewWindowLike;
    let newPanelView: PreviewPanelViewLike | undefined;
    if (container === "panel") {
      const view = this.deps.createPanelView({ previewId });
      newWindow = view;
      newPanelView = view;
    } else {
      // Cascade position is windows-only (D4) — mirrors openForTab's own new-window path.
      const cascade = this.cascadePosition();
      newWindow = this.deps.createWindow({ previewId, x: cascade.x, y: cascade.y });
    }

    // Swap BEFORE re-wiring: `wireWindow` captures its own epoch off
    // `record.window`, so the new listeners must see the NEW container
    // already in place — from this line on, every listener the OLD wiring
    // installed stops matching `record.window` and becomes a no-op (D14).
    record.window = newWindow;
    record.containerKind = container;
    record.panelView = newPanelView;
    record.status = "loading";
    this.wireWindow(record);

    // The old container's death (and any of its late in-flight events —
    // did-fail-load, render-process-gone, onClosed) is now safely a no-op
    // for `record`: the epoch guard on every listener it registered no
    // longer matches `record.window`.
    if (!oldContainer.isDestroyed()) {
      try {
        oldContainer.destroy();
      } catch (error) {
        this.deps.logger.warn(`[preview] failed to destroy old container for ${previewId} during transfer`, error);
      }
    }

    const newWc = record.window.webContents;
    try {
      if (history.entries.length > 0) {
        await newWc.restoreNavigationHistory(history);
      } else {
        await newWc.loadURL(record.url);
      }
    } catch (error) {
      record.status = "failed";
      record.errorMessage = `transfer failed to restore preview: ${String(error)}`;
      this.pushChanged(tabId);
      return { ok: false, error: record.errorMessage };
    }

    const settled = await this.waitForSettle(record, OPEN_TIMEOUT_MS);
    if (settled !== "ready") {
      // Honest terminal state either way (timeout/load_failed/crashed) —
      // never left dangling "loading"; recoverable via another BrowserOpen.
      record.status = "failed";
      record.errorMessage = record.errorMessage ?? "preview failed to load after transfer";
      this.pushChanged(tabId);
      return { ok: false, error: record.errorMessage };
    }

    if (container === "panel") {
      // D5: a freshly transferred-in panel preview becomes the visible slot.
      this.visiblePanelPreviewId.set(tabId, previewId);
    } else if (wasVisibleSlotHolder) {
      // This preview just left the panel while holding the visible slot —
      // re-point it to the most-recently-opened survivor (D5's own close semantics).
      this.promoteMostRecentPanelSurvivor(tabId);
    }
    this.applyPanel();

    if (container === "window") {
      record.window.show();
    }

    this.pushChanged(tabId);
    return { ok: true, reloaded: true };
  }

  /**
   * M3 (TASK.99 CUT.md CONTRACTS, GAP 1): the dom-md half of D14 transfer —
   * simpler than the web path's `setContainer` body because a dom-md record
   * has no `webContents`/navigation history to capture-and-restore and
   * settles synchronously (no `waitForSettle`). `panel->window` creates the
   * `MdPreviewWindowLike` up front (mirrors `openMarkdownTarget`'s own
   * window-open branch) and, if this record held the visible panel slot,
   * promotes the survivor (D5, mirrors the web path's `wasVisibleSlotHolder`
   * handling). `window->panel` clears `record.mdWindow` BEFORE destroying
   * the old window — `wireMdWindow` installs exactly one `onClosed` guard,
   * and clearing the field first is what makes that guard a no-op for this
   * expected teardown (mirrors the web path's own swap-before-destroy
   * order) — then takes the visible panel slot (D5).
   */
  private async transferMdContainer(
    tabId: string,
    record: MdDomPreviewRecord,
    container: PreviewContainerKind,
  ): Promise<PreviewSetContainerResult> {
    if (container === "window") {
      const wasVisibleSlotHolder = this.visiblePanelPreviewId.get(tabId) === record.previewId;
      record.mdWindow = this.deps.createMdWindow({ previewId: record.previewId, tabId });
      record.containerKind = "window";
      this.wireMdWindow(record);
      if (wasVisibleSlotHolder) {
        this.promoteMostRecentPanelSurvivor(tabId);
      }
      this.applyPanel();
      record.mdWindow.show();
      this.pushChanged(tabId);
      return { ok: true, reloaded: true };
    }

    // window -> panel: clear the field BEFORE destroying the old window so
    // its guarded onClosed (wireMdWindow) sees a mismatched container and
    // no-ops instead of re-entering destroyRecord for a record that is very
    // much still alive (mirrors the web path's swap-before-destroy order).
    const oldWindow = record.mdWindow;
    record.mdWindow = undefined;
    record.containerKind = "panel";
    if (oldWindow !== undefined && !oldWindow.isDestroyed()) {
      try {
        oldWindow.destroy();
      } catch (error) {
        this.deps.logger.warn(`[preview] failed to destroy md window for ${record.previewId} during transfer`, error);
      }
    }
    // D5: a freshly transferred-in panel preview becomes the visible slot
    // (mirrors the web path's own container === "panel" branch).
    this.visiblePanelPreviewId.set(tabId, record.previewId);
    this.applyPanel();
    this.pushChanged(tabId);
    return { ok: true, reloaded: true };
  }

  /** Broadcasts the tab's current preview set (main -> renderer push, D7's contract). */
  private pushChanged(tabId: string): void {
    this.deps.onPreviewsChanged?.(this.listForPanel(tabId));
  }

  /**
   * D6 — the single main-side reconciler for panel visibility, run after
   * every mutation that could affect it (setPanelState, setPanelBounds,
   * open-settle, select, close, closeForTab, closeAll — transfer joins this
   * list in 96-P3). For every LIVE panel-container record, `visible` is
   * exactly: panel mounted AND no overlay open AND this record's tab is the
   * active tab AND this record is its tab's visible-slot occupant AND the
   * last-published bounds are non-degenerate. `setBounds` is always applied
   * BEFORE `setVisible(true)` — a view can never flash at stale/zero
   * geometry; hidden is always plain `setVisible(false)` (D6 — chosen over
   * zero-bounds).
   */
  private applyPanel(): void {
    const boundsOk = this.panelBounds !== null && this.panelBounds.width > 0 && this.panelBounds.height > 0;
    for (const record of this.previews.values()) {
      // dom-md panel records have NO panelView (CUT.md CONTRACTS) — the
      // `viewKind !== "web"` clause is what makes that true for the type
      // checker too (TS narrows `record.panelView` through it); the
      // reconciler logic itself is otherwise untouched from pre-M1.
      if (record.destroyed || record.containerKind !== "panel" || record.viewKind !== "web" || record.panelView === undefined) {
        continue;
      }
      const isVisibleSlot = this.visiblePanelPreviewId.get(record.tabId) === record.previewId;
      const visible =
        this.panelState.panelMounted &&
        !this.panelState.overlayOpen &&
        record.tabId === this.panelState.activeTabId &&
        isVisibleSlot &&
        boundsOk;
      if (visible) {
        record.panelView.setBounds(this.panelBounds!);
        record.panelView.setVisible(true);
      } else {
        record.panelView.setVisible(false);
      }
    }
  }

  /** D5: on close of the visible-slot occupant, re-point to the most-recently-opened SURVIVING panel preview of the tab (none left -> clear the slot). */
  private promoteMostRecentPanelSurvivor(tabId: string): void {
    let best: PreviewRecord | undefined;
    for (const record of this.previews.values()) {
      if (record.destroyed || record.tabId !== tabId || record.containerKind !== "panel") {
        continue;
      }
      if (best === undefined || record.lastOpenedAt > best.lastOpenedAt) {
        best = record;
      }
    }
    if (best === undefined) {
      this.visiblePanelPreviewId.delete(tabId);
    } else {
      this.visiblePanelPreviewId.set(tabId, best.previewId);
    }
  }

  // ── internals ──

  private newWebRecord(
    tabId: string,
    previewId: string,
    window: PreviewWindowLike,
    containerKind: "window" | "panel",
    panelView?: PreviewPanelViewLike,
  ): WebPreviewRecord {
    const now = this.now();
    return {
      viewKind: "web",
      previewId,
      tabId,
      window,
      containerKind,
      panelView,
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

  /** M1/M3 (TASK.99): brand-new dom-md record, `status:"ready"` (resolution already succeeded by the time this is called). `mdWindow` is set by the caller right after construction when `containerKind === "window"` (mirrors `newWebRecord`'s caller-populates-the-container-handle shape). */
  private newMdRecord(
    tabId: string,
    previewId: string,
    sourcePath: string,
    realSourcePath: string,
    containerKind: "panel" | "window",
  ): MdDomPreviewRecord {
    const now = this.now();
    return {
      viewKind: "dom-md",
      previewId,
      tabId,
      containerKind,
      status: "ready",
      url: pathToFileURL(realSourcePath).href,
      sourcePath,
      realSourcePath,
      docDir: dirname(realSourcePath),
      renderedFrom: sourcePath,
      title: basename(sourcePath),
      docVersion: 0,
      createdAt: now,
      lastOpenedAt: now,
      destroyed: false,
    };
  }

  // ── md doc identity lookup (M1: md-doc.ts's read handler closes over this) ──

  getMdDocRef(
    tabId: string,
    previewId: string,
  ): { sourcePath: string; realSourcePath: string; docDir: string; docVersion: number } | undefined {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId || record.viewKind !== "dom-md") {
      return undefined;
    }
    return {
      sourcePath: record.sourcePath,
      realSourcePath: record.realSourcePath,
      docDir: record.docDir,
      docVersion: record.docVersion,
    };
  }

  // ── md doc navigate commit (M2: md-doc.ts's navigate handler closes over this) ──

  /**
   * M2 (TASK.99 CUT.md CONTRACTS): mutates a LIVE dom-md record in place —
   * replace semantics, no history stack. Called ONLY after `navigateMdDoc`'s
   * own fresh containment/read has already succeeded, so this method itself
   * does no validation beyond re-confirming the record is still the SAME
   * live dom-md record `getRecordRef`/`getMdDocRef` saw a moment earlier (a
   * close/destroy racing the in-flight navigate is the only way this can
   * fail here).
   */
  commitMdNavigate(
    tabId: string,
    previewId: string,
    fields: { sourcePath: string; realSourcePath: string; docDir: string; title: string },
  ): number | undefined {
    const record = this.previews.get(previewId);
    if (record === undefined || record.destroyed || record.tabId !== tabId || record.viewKind !== "dom-md") {
      return undefined;
    }
    record.sourcePath = fields.sourcePath;
    record.realSourcePath = fields.realSourcePath;
    record.docDir = fields.docDir;
    record.title = fields.title;
    record.url = pathToFileURL(fields.realSourcePath).href;
    record.docVersion += 1;
    record.lastOpenedAt = this.now();
    this.pushChanged(tabId);
    return record.docVersion;
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

  private settle(record: WebPreviewRecord, status: SettleStatus): void {
    if (record.status !== "loading") {
      return; // already settled (e.g. a late did-fail-load after we already marked ready)
    }
    record.status = status;
    const waiters = record.settleWaiters;
    record.settleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
    // "open-settle" / status-change record-set mutation (shared/preview-panel.ts's CHANGED doc comment).
    this.pushChanged(record.tabId);
  }

  private waitForSettle(record: WebPreviewRecord, timeoutMs: number): Promise<SettleStatus | "timeout"> {
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

  /**
   * D14 (96-P3, the ONLY permitted modification to this method — it stays
   * the single security-wiring copy, D1): every listener below is wrapped in
   * `guardContainerEpoch`, closing over `container`/`wc` as captured AT THIS
   * CALL — a transfer swaps `record.window` to a fresh container and calls
   * this method again for it, which makes every listener from a PRIOR call
   * (still attached to the now-superseded container) an early-return no-op
   * forever after. `setWindowOpenHandler`/`setPermissionRequestHandler`/
   * `setRequestGate` are deliberately NOT guarded: they are stateless
   * deny-everything policy (or read live `record` fields shared across
   * containers) with no "stale container" hazard to guard against.
   */
  private wireWindow(record: WebPreviewRecord): void {
    const container = record.window;
    const wc = container.webContents;
    const guard = <A extends unknown[]>(handler: (...args: A) => void): ((...args: A) => void) =>
      guardContainerEpoch(record, container, handler);

    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.setPermissionRequestHandler((_permission, callback) => callback(false));

    wc.onDidFinishLoad(guard(() => {
      this.settle(record, "ready");
    }));
    wc.onDidFailLoad(guard((errorCode, errorDescription, isMainFrame) => {
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
    }));
    wc.onRenderProcessGone(guard((reason) => {
      record.errorMessage = `renderer process gone: ${reason}`;
      this.settle(record, "crashed");
    }));
    wc.onWillNavigate((navUrl, preventDefault) => {
      preventDefault();
      void this.evaluateNavigation(record, navUrl).then(guard((result) => {
        if (result.allow) {
          // F8a (TOCTOU): load the REALPATH the policy check already resolved,
          // never the raw `navUrl` a symlink could have repointed since.
          if (!container.isDestroyed() && !wc.isDestroyed()) {
            void wc.loadURL(result.loadUrl);
          }
        } else {
          this.deps.logger.warn(`[preview] denied navigation for ${record.previewId}: ${navUrl}`);
        }
      }));
    });
    // F1 belt-and-braces layer: the request gate below is the authoritative
    // net (every redirect leg re-enters it as a fresh mainFrame request), but
    // `preventDefault` here is SYNCHRONOUS and therefore the only thing that
    // can actually stop this specific redirect from completing.
    wc.onWillRedirect(guard((redirectUrl, preventDefault) => {
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
    }));
    wc.onDidNavigate(guard((navUrl) => {
      record.url = navUrl;
    }));
    wc.onConsoleMessage(guard((level, message) => {
      this.recordConsole(record, {
        level,
        message: message.slice(0, RING_MAX_MSG_CHARS),
        at: new Date(this.now()).toISOString(),
      });
    }));
    // F2 keystone: per-partition request gate covering every resource type
    // (subframes, images, scripts, fetch/XHR, WebSocket) that will-navigate
    // never sees, and every redirect hop besides.
    wc.setRequestGate(this.makeRequestGate(record));
    container.onClosed(guard(() => {
      this.destroyRecord(record);
      this.previews.delete(record.previewId);
    }));
  }

  /**
   * M3 (TASK.99): the dom-md analogue of `guardContainerEpoch` — same
   * "only run while this container is still the record's current one"
   * semantics, narrowed to `MdDomPreviewRecord`/`MdPreviewWindowLike` (a
   * dom-md record has exactly one listener to guard, `onClosed`, so this
   * stays its own small helper rather than a generic shared with the web
   * path's wider listener set).
   */
  private guardMdWindowEpoch(record: MdDomPreviewRecord, container: MdPreviewWindowLike, handler: () => void): () => void {
    return () => {
      if (record.mdWindow !== container) {
        return;
      }
      handler();
    };
  }

  /**
   * M3 (TASK.99 CUT.md CONTRACTS): wires a freshly-created `mdWindow`'s ONE
   * listener — a native/user-initiated close (red-x, Cmd+W, `window.close()`
   * from the renderer's own header Close button) destroys the record,
   * mirroring `wireWindow`'s own `onClosed`-driven cleanup for a web record
   * exactly (CUT.md M3 scope item 6: "close destroys the preview, matching
   * the web window path's onClosed semantics"). Epoch-guarded so a transfer
   * (`transferMdContainer`) that has already swapped/cleared `record.mdWindow`
   * never lets a late close event from the OLD window re-enter destroyRecord
   * for a record that has moved on.
   */
  private wireMdWindow(record: MdDomPreviewRecord): void {
    const container = record.mdWindow;
    if (container === undefined) {
      return;
    }
    container.onClosed(this.guardMdWindowEpoch(record, container, () => {
      this.destroyRecord(record);
      this.previews.delete(record.previewId);
    }));
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
    record: WebPreviewRecord,
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
  private evaluateRedirect(record: WebPreviewRecord, url: string): boolean {
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
    record: WebPreviewRecord,
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
  private makeRequestGate(record: WebPreviewRecord): (req: { url: string; resourceType: string }) => Promise<boolean> {
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
  private recordDeniedOnce(record: WebPreviewRecord, key: string, message: string, warnedKeys: Set<string>): void {
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

  private recordConsole(record: WebPreviewRecord, entry: PreviewConsoleEntry): void {
    record.consoleRing.push(entry);
    if (record.consoleRing.length > RING_MAX_ENTRIES) {
      record.consoleRing.shift();
      record.consoleDropped += 1;
    }
    this.forwardEvent(record, entry);
  }

  private forwardEvent(record: WebPreviewRecord, entry: PreviewConsoleEntry): void {
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

  private flushEventSummary(record: WebPreviewRecord): void {
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

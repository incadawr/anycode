/**
 * Host-owned browser-preview control plane (night-track wave-1 cut §2.1,
 * frozen). Core tools request a preview open/read/screenshot through this
 * port; they never touch a BrowserWindow, spawn a renderer, or reach across a
 * process boundary themselves — that plumbing (transport, window lifecycle,
 * navigation/consent security) is entirely host-owned (desktop: an RPC client
 * over `process.parentPort` talking to main's PreviewHost).
 *
 * Every method returns a discriminated `PreviewResult` and never throws — the
 * same "always produced, never thrown" discipline as `WorktreeControlPort`.
 */

export interface PreviewConsoleEntry {
  level: "log" | "warn" | "error" | "pageerror";
  message: string;
  /** ISO timestamp. */
  at: string;
}

export interface PreviewOpenRequest {
  path?: string;
  url?: string;
  /** Reusing an existing preview navigates it instead of opening a new window. */
  previewId?: string;
}

export interface PreviewOpenSuccess {
  previewId: string;
  url: string;
  title?: string;
  kind: "file" | "localhost" | "remote";
  /** The .md source path when this preview is a rendered markdown page. */
  renderedFrom?: string;
}

export interface PreviewReadRequest {
  previewId?: string;
  selector?: string;
  format?: "text" | "html";
  waitForSelector?: string;
  waitMs?: number;
  includeConsole?: boolean;
}

export interface PreviewReadSuccess {
  previewId: string;
  url: string;
  text: string;
  matches?: number;
  console?: PreviewConsoleEntry[];
  consoleDropped?: number;
}

export interface PreviewScreenshotSuccess {
  previewId: string;
  url: string;
  mediaType: "image/png";
  /** Base64, no data-URI prefix (mirrors ImageAttachment.data). */
  data: string;
  width: number;
  height: number;
  /**
   * Logical/CSS viewport size (DIP, not device pixels) at capture time, when
   * the capture path could observe one (TASK.198 slice G) — mirrors
   * ImageAttachment.cssSize's own additive-optional contract. Absent when
   * the underlying page/window could not report a CSS size (unresponsive,
   * destroyed, panel bounds unset); callers must not treat its absence as an
   * error.
   */
  cssWidth?: number;
  cssHeight?: number;
}

export type PreviewResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      errorKind?:
        | "invalid_input"
        | "cancelled"
        | "unavailable"
        | "load_failed"
        | "crashed"
        | "timeout"
        | "stale_ref"
        | "not_allowed";
    };

/** Element target for click/type: a snapshot ref (`e12`) or a CSS selector (main document only). */
export type PreviewTarget = { ref: string } | { selector: string };

/**
 * Browser control (Taskana 4759). One discriminated request for every control
 * action so the port surface, the RPC client and test fakes stay small.
 * Phase B adds `console` and `eval`.
 */
export type PreviewControlRequest =
  | { action: "navigate"; previewId?: string; to: { url: string } | { history: "back" | "forward" | "reload" } }
  | { action: "snapshot"; previewId?: string; maxChars?: number }
  | { action: "click"; previewId?: string; target: PreviewTarget; button?: "left" | "right"; doubleClick?: boolean }
  | {
      action: "type";
      previewId?: string;
      target: PreviewTarget;
      text: string;
      clear?: boolean;
      submit?: boolean;
    }
  | { action: "waitFor"; previewId?: string; text?: string; selector?: string; gone?: boolean; timeoutMs?: number };

export interface PreviewControlSuccess {
  previewId: string;
  url: string;
  title?: string;
  /** Model-facing text: the snapshot or the action report (already capped). */
  text: string;
  /** True when the main frame navigated while the action ran. */
  navigated?: boolean;
  /** snapshot only: number of refs issued. */
  refs?: number;
  /** snapshot only: true when the tree was cut at the node/char cap. */
  truncated?: boolean;
}

export interface PreviewPort {
  /**
   * `allowRemote: true` is the ONLY thing that may authorize navigating to a
   * non-localhost http(s) origin — set by the BrowserOpen handler exclusively
   * when the permission engine already approved that risk-escalated call
   * (types/tools.ts `resolveMetadata`). The port implementation must still
   * enforce this itself (never trust the caller blindly): a request without
   * it targeting a remote origin is refused host-side.
   */
  open(
    req: PreviewOpenRequest,
    opts: { signal: AbortSignal; toolCallId?: string; allowRemote?: boolean },
  ): Promise<PreviewResult<PreviewOpenSuccess>>;
  read(
    req: PreviewReadRequest,
    opts: { signal: AbortSignal; toolCallId?: string },
  ): Promise<PreviewResult<PreviewReadSuccess>>;
  screenshot(
    req: { previewId?: string },
    opts: { signal: AbortSignal; toolCallId?: string },
  ): Promise<PreviewResult<PreviewScreenshotSuccess>>;
  /**
   * Browser control (Taskana 4759). OPTIONAL: a port without it makes the
   * control tools answer "Browser control is unavailable in this session."
   * `allowRemote: true` only when the permission engine approved an escalated
   * call; the host re-checks it (same rule as `open`).
   */
  control?(
    req: PreviewControlRequest,
    opts: { signal: AbortSignal; toolCallId?: string; allowRemote?: boolean },
  ): Promise<PreviewResult<PreviewControlSuccess>>;
}

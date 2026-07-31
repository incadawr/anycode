/**
 * Control-plane contract for the host<->main preview channel (night-track
 * wave-1 cut §2.3, TASK.96 96-A). Mirrors shared/credentials.ts exactly:
 * VALUE-ONLY module, zero imports, no zod (the parentPort proc channel is
 * trusted — zod only guards renderer IPC boundaries). Both the host
 * (utilityProcess) and main import this module, so it must never drag in
 * @anycode/core or any Electron type.
 *
 * The result shapes below (`PreviewOpenSuccess`/`PreviewReadSuccess`/
 * `PreviewScreenshotSuccess`/`PreviewResult`) are a deliberate duplicate of
 * `packages/core/src/ports/preview.ts`'s §2.1 shapes (96-B, not yet landed in
 * this slice) — serialized verbatim over this wire, same precedent as
 * `CredentialRequest`/`CredentialResponse` standing apart from any core type.
 * 96-B's host-side RPC client casts the generic `PreviewResult` union down to
 * the shape it expects for the op it sent; main (this module's other
 * consumer, `main/preview/preview-host.ts`) is the one place that actually
 * constructs these values.
 */

// ── console entries (ring-buffered main-side per preview) ──

export interface PreviewConsoleEntry {
  level: "log" | "warn" | "error" | "pageerror";
  message: string;
  /** ISO timestamp. */
  at: string;
}

// ── op request shapes (host -> main, riding inside PreviewRequestMessage) ──

export type PreviewOp =
  | { kind: "open"; path?: string; url?: string; previewId?: string; allowRemote?: boolean }
  | {
      kind: "read";
      previewId?: string;
      selector?: string;
      format?: "text" | "html";
      waitForSelector?: string;
      waitMs?: number;
      includeConsole?: boolean;
    }
  | { kind: "screenshot"; previewId?: string };

// ── result value shapes (main -> host, §2.1 verbatim) ──

export interface PreviewOpenSuccess {
  previewId: string;
  url: string;
  title?: string;
  kind: "file" | "localhost" | "remote";
  /** The original `.md` source path, when this preview was rendered from markdown. */
  renderedFrom?: string;
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
  /** base64 PNG bytes. */
  data: string;
  width: number;
  height: number;
}

export type PreviewResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      errorKind?: "invalid_input" | "cancelled" | "unavailable" | "load_failed" | "crashed" | "timeout";
    };

// ── parentPort message types (host <-> main) ──

/** host -> main: perform a preview op, correlated by `requestId`. */
export const PREVIEW_REQUEST_TYPE = "anycode:preview-request";

export interface PreviewRequestMessage {
  type: typeof PREVIEW_REQUEST_TYPE;
  requestId: string;
  op: PreviewOp;
}

/** main -> host: the answer to a PreviewRequestMessage, same `requestId`. */
export const PREVIEW_RESPONSE_TYPE = "anycode:preview-response";

export interface PreviewResponseMessage {
  type: typeof PREVIEW_RESPONSE_TYPE;
  requestId: string;
  result: PreviewResult<PreviewOpenSuccess | PreviewReadSuccess | PreviewScreenshotSuccess>;
}

/**
 * main -> host: a throttled console/pageerror forward (≤20 per preview per
 * rolling 10s, then one summary carrying `suppressed`). Unsolicited — not
 * correlated to any request.
 */
export const PREVIEW_EVENT_TYPE = "anycode:preview-event";

export interface PreviewEventMessage {
  type: typeof PREVIEW_EVENT_TYPE;
  previewId: string;
  /** Absent on a pure summary message (every entry this window was suppressed). */
  entry?: PreviewConsoleEntry;
  suppressed?: number;
}

/**
 * host -> main: turn-end auto-open signal (cut §1(a)). `paths` are absolute,
 * exactly as written by the Write/Edit tool that produced them — main
 * resolves/contains each one itself before opening anything.
 */
export const PREVIEW_ARTIFACTS_TYPE = "anycode:preview-artifacts";

export interface PreviewArtifactsMessage {
  type: typeof PREVIEW_ARTIFACTS_TYPE;
  paths: string[];
}

/**
 * Host<->main control-plane contract for the browser-preview capability
 * (night-track wave-1 cut §2.3, frozen). Same posture as shared/credentials.ts
 * and shared/worktrees.ts: a VALUE-ONLY module with zero imports, so it drags
 * neither zod nor @anycode/core into either process purely to describe these
 * messages. The result payload shapes are duplicated verbatim from
 * packages/core/src/ports/preview.ts §2.1 by contract — the two are frozen
 * together and must be kept in lockstep by hand (mirrors shared/worktrees.ts's
 * own WorktreeIdentity duplicate against ports/worktrees.ts).
 *
 * NOTE: this file is independently authored by BOTH slice 96-A and slice
 * 96-B against the same frozen §2.3 text (they build in parallel against the
 * same contract, not against each other's code); the orchestrator reconciles
 * the two copies at merge. Content here is verbatim §2.3 — nothing extra.
 */

// ── parentPort message types (host <-> main) ──

/** parentPort message type: host asks main to run a preview operation. */
export const PREVIEW_REQUEST_TYPE = "anycode:preview-request";

/** parentPort message type: main answers a preview request. */
export const PREVIEW_RESPONSE_TYPE = "anycode:preview-response";

/** parentPort message type: main pushes a live preview console/error event. */
export const PREVIEW_EVENT_TYPE = "anycode:preview-event";

/** parentPort message type: host reports turn-end auto-open candidate paths. */
export const PREVIEW_ARTIFACTS_TYPE = "anycode:preview-artifacts";

// ── operation payloads (host -> main, carried inside a request message) ──

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

/** host -> main: run a preview operation. `requestId` correlates the answer. */
export interface PreviewRequestMessage {
  type: typeof PREVIEW_REQUEST_TYPE;
  requestId: string;
  op: PreviewOp;
}

// ── result payloads (verbatim mirror of ports/preview.ts §2.1) ──

export interface PreviewConsoleEntry {
  level: "log" | "warn" | "error" | "pageerror";
  /** ISO timestamp. */
  message: string;
  at: string;
}

export interface PreviewOpenSuccess {
  previewId: string;
  url: string;
  title?: string;
  kind: "file" | "localhost" | "remote";
  /** The .md source path when this preview is a rendered markdown page. */
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
  /** Base64, no data-URI prefix. */
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

/** main -> host: the answer to a PreviewRequestMessage, correlated by requestId. */
export interface PreviewResponseMessage {
  type: typeof PREVIEW_RESPONSE_TYPE;
  requestId: string;
  result: PreviewResult<PreviewOpenSuccess | PreviewReadSuccess | PreviewScreenshotSuccess>;
}

// ── live console/error events (main -> host, outside the request/response pair) ──

/** main -> host: a live console/error entry for an open preview. */
export interface PreviewEventMessage {
  type: typeof PREVIEW_EVENT_TYPE;
  previewId: string;
  entry: PreviewConsoleEntry;
  suppressed?: number;
}

// ── turn-end auto-open candidates (host -> main) ──

/** host -> main: absolute paths written this turn that are candidates for auto-open. */
export interface PreviewArtifactsMessage {
  type: typeof PREVIEW_ARTIFACTS_TYPE;
  paths: string[];
}

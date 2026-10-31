/**
 * Diagnostics export IPC (GitHub #18): the main-side handlers behind the
 * session menu's "Export diagnostics…" action.
 *
 * Two channels, one payload: the session id whose TREE is exported. The
 * renderer can ask for nothing else — no path, no directory, no range. Both
 * handlers collapse every failure to a closed reason enum and never return a
 * build error, a path or a timestamp source detail.
 *
 * `preview` builds the bundle once and returns its already-anonymised text
 * plus size counts; `save` writes EXACTLY the bundle that was previewed (the
 * cache is per session id and expires after `ttlMs`), so a person who reviewed
 * the preview cannot end up shipping different data.
 */

import { ipcMain } from "electron";
import {
  DIAGNOSTICS_MAX_BUNDLE_BYTES,
  DIAGNOSTICS_PREVIEW_CHANNEL,
  DIAGNOSTICS_SAVE_CHANNEL,
  type DiagnosticsFailureReason,
  type DiagnosticsPreviewResult,
  type DiagnosticsSaveResult,
} from "../shared/diagnostics.js";
import { renderDiagnosticsPreview, type DiagnosticsBuild } from "./diagnostics-export.js";

export interface DiagnosticsWriteResult {
  saved: boolean;
  path?: string;
}

/** The two filesystem operations a save needs; `node:fs/promises` satisfies this. */
export interface DiagnosticsSaveFs {
  writeFile(path: string, content: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** 0600: the bundle is diagnostics, not something other local users should read. */
export const DIAGNOSTICS_FILE_MODE = 0o600;

/**
 * Writes the bundle and then FORCES 0600 on the result. `mode` in
 * `writeFile` only applies when the file is CREATED: exporting a second time
 * into the same Downloads path would inherit the old mode (typically 0644),
 * so the chmod is not a belt-and-braces flourish but the actual guarantee.
 */
export async function writeDiagnosticsFile(
  fs: DiagnosticsSaveFs,
  path: string,
  content: string,
): Promise<void> {
  await fs.writeFile(path, content, { encoding: "utf8", mode: DIAGNOSTICS_FILE_MODE });
  await fs.chmod(path, DIAGNOSTICS_FILE_MODE);
}

export interface DiagnosticsIpcDeps {
  build(sessionId: string): Promise<DiagnosticsBuild>;
  /** Shows the save dialog and writes the file; `saved: false` means canceled. */
  save(payload: { defaultFileName: string; content: string }): Promise<DiagnosticsWriteResult>;
  now?: () => number;
}

/** `anycode-diagnostics-YYYYMMDD-HHmmss.json` from UTC time (no user/host data in the name). */
export function diagnosticsDefaultFileName(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `anycode-diagnostics-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}.json`;
}

/**
 * Validates the ONE renderer payload. A session id is an opaque identifier:
 * non-empty, bounded, and never anything path- or whitespace-shaped, so it can
 * be joined onto the telemetry directory without becoming a traversal.
 */
export const DIAGNOSTICS_SESSION_ID_MAX_CHARS = 200;

export function parseDiagnosticsRequest(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = (raw as { sessionId?: unknown }).sessionId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DIAGNOSTICS_SESSION_ID_MAX_CHARS) return null;
  if (trimmed !== value) return null;
  // Id shape only: no separators, no dots-as-traversal, no whitespace.
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return null;
  return trimmed;
}

function failure(reason: DiagnosticsFailureReason): { ok: false; reason: DiagnosticsFailureReason } {
  return { ok: false, reason };
}

type Built = { ok: true; build: DiagnosticsBuild } | { ok: false; reason: DiagnosticsFailureReason };

async function buildForExport(deps: DiagnosticsIpcDeps, sessionId: string): Promise<Built> {
  let build: DiagnosticsBuild;
  try {
    build = await deps.build(sessionId);
  } catch {
    return failure("build_failed");
  }
  if (Buffer.byteLength(build.json, "utf8") >= DIAGNOSTICS_MAX_BUNDLE_BYTES) return failure("too_large");
  return { ok: true, build };
}

async function writeBuild(deps: DiagnosticsIpcDeps, build: DiagnosticsBuild): Promise<DiagnosticsSaveResult> {
  try {
    const written = await deps.save({
      defaultFileName: diagnosticsDefaultFileName((deps.now ?? Date.now)()),
      content: build.json,
    });
    if (!written.saved) return { ok: true, saved: false };
    return { ok: true, saved: true, ...(written.path !== undefined ? { path: written.path } : {}) };
  } catch {
    return failure("write_failed");
  }
}

export async function handleDiagnosticsPreview(
  deps: DiagnosticsIpcDeps,
  raw?: unknown,
): Promise<DiagnosticsPreviewResult> {
  const sessionId = parseDiagnosticsRequest(raw);
  if (sessionId === null) return failure("invalid_request");
  const built = await buildForExport(deps, sessionId);
  if (!built.ok) return failure(built.reason);
  return {
    ok: true,
    summary: built.build.summary,
    preview: renderDiagnosticsPreview(built.build.json),
  };
}

export async function handleDiagnosticsSave(
  deps: DiagnosticsIpcDeps,
  raw?: unknown,
): Promise<DiagnosticsSaveResult> {
  const sessionId = parseDiagnosticsRequest(raw);
  if (sessionId === null) return failure("invalid_request");
  const built = await buildForExport(deps, sessionId);
  if (!built.ok) return failure(built.reason);
  return writeBuild(deps, built.build);
}

/** How long a previewed bundle may be saved as-is before it is rebuilt. */
export const DIAGNOSTICS_PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface DiagnosticsIpcSession {
  preview(raw: unknown): Promise<DiagnosticsPreviewResult>;
  /** Saves EXACTLY the bundle that was previewed for the same session (rebuilt only after the TTL). */
  save(raw: unknown): Promise<DiagnosticsSaveResult>;
}

/**
 * The stateful pair behind the two channels. ONE slot keyed by the session id
 * it was built for: saving reuses that bundle only when the request names the
 * same session, so a preview of session A can never be written under session
 * B's request. The cache expires after `ttlMs` so a stale snapshot is never
 * written much later.
 */
export function createDiagnosticsIpcSession(
  deps: DiagnosticsIpcDeps,
  options?: { ttlMs?: number; now?: () => number },
): DiagnosticsIpcSession {
  const ttlMs = options?.ttlMs ?? DIAGNOSTICS_PREVIEW_TTL_MS;
  const now = options?.now ?? deps.now ?? Date.now;
  let pending: { sessionId: string; build: DiagnosticsBuild; at: number } | null = null;

  return {
    async preview(raw: unknown) {
      const sessionId = parseDiagnosticsRequest(raw);
      if (sessionId === null) {
        pending = null;
        return failure("invalid_request");
      }
      const built = await buildForExport(deps, sessionId);
      if (!built.ok) {
        pending = null;
        return failure(built.reason);
      }
      pending = { sessionId, build: built.build, at: now() };
      return {
        ok: true,
        summary: built.build.summary,
        preview: renderDiagnosticsPreview(built.build.json),
      };
    },
    async save(raw: unknown) {
      const sessionId = parseDiagnosticsRequest(raw);
      const cached = pending;
      pending = null;
      if (sessionId === null) return failure("invalid_request");
      if (cached !== null && cached.sessionId === sessionId && now() - cached.at <= ttlMs) {
        return writeBuild(deps, cached.build);
      }
      const built = await buildForExport(deps, sessionId);
      if (!built.ok) return failure(built.reason);
      return writeBuild(deps, built.build);
    },
  };
}

/**
 * Registers both channels. The only renderer-supplied value is the session id
 * to export, and the session guarantees "what you previewed is what you save".
 */
export function registerDiagnosticsIpc(deps: DiagnosticsIpcDeps): void {
  const session = createDiagnosticsIpcSession(deps);
  ipcMain.handle(DIAGNOSTICS_PREVIEW_CHANNEL, (_event, raw: unknown) => session.preview(raw));
  ipcMain.handle(DIAGNOSTICS_SAVE_CHANNEL, (_event, raw: unknown) => session.save(raw));
}

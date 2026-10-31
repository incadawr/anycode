/**
 * Diagnostics export IPC (GitHub #18): the main-side handlers behind
 * Settings -> Environment -> "Export diagnostics…".
 *
 * Two channels, no payloads: `preview` builds the bundle once and returns its
 * already-anonymised text plus size counts, `save` builds it again and asks
 * the injected saver (Electron's save dialog in production) to write it. The
 * handlers never pass a build error, a path or a timestamp source detail back
 * to the renderer — failures collapse to a closed reason enum.
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

export interface DiagnosticsIpcDeps {
  build(): Promise<DiagnosticsBuild>;
  /** Shows the save dialog and writes the file; `saved: false` means canceled. */
  save(payload: { defaultFileName: string; content: string }): Promise<DiagnosticsWriteResult>;
  now?: () => number;
}

/** `anycode-diagnostics-YYYYMMDD-HHmmss.json` from UTC time (no user/host data in the name). */
export function diagnosticsDefaultFileName(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `anycode-diagnostics-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}.json`;
}

function failure(reason: DiagnosticsFailureReason): { ok: false; reason: DiagnosticsFailureReason } {
  return { ok: false, reason };
}

type Built = { ok: true; build: DiagnosticsBuild } | { ok: false; reason: DiagnosticsFailureReason };

async function buildForExport(deps: DiagnosticsIpcDeps): Promise<Built> {
  let build: DiagnosticsBuild;
  try {
    build = await deps.build();
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

export async function handleDiagnosticsPreview(deps: DiagnosticsIpcDeps): Promise<DiagnosticsPreviewResult> {
  const built = await buildForExport(deps);
  if (!built.ok) return failure(built.reason);
  return {
    ok: true,
    summary: built.build.summary,
    preview: renderDiagnosticsPreview(built.build.json),
  };
}

export async function handleDiagnosticsSave(deps: DiagnosticsIpcDeps): Promise<DiagnosticsSaveResult> {
  const built = await buildForExport(deps);
  if (!built.ok) return failure(built.reason);
  return writeBuild(deps, built.build);
}

/** How long a previewed bundle may be saved as-is before it is rebuilt. */
export const DIAGNOSTICS_PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface DiagnosticsIpcSession {
  preview(): Promise<DiagnosticsPreviewResult>;
  /** Saves EXACTLY the bundle that was previewed (rebuilt only after the TTL). */
  save(): Promise<DiagnosticsSaveResult>;
}

/**
 * The stateful pair behind the two channels. Saving reuses the previewed
 * bundle — a person who reviewed the preview must get that same content, not
 * a second build with a fresh salt and newer telemetry. The cache is one slot
 * (one window, one export) and expires after `ttlMs` so a stale snapshot is
 * never written much later.
 */
export function createDiagnosticsIpcSession(
  deps: DiagnosticsIpcDeps,
  options?: { ttlMs?: number; now?: () => number },
): DiagnosticsIpcSession {
  const ttlMs = options?.ttlMs ?? DIAGNOSTICS_PREVIEW_TTL_MS;
  const now = options?.now ?? deps.now ?? Date.now;
  let pending: { build: DiagnosticsBuild; at: number } | null = null;

  return {
    async preview() {
      const built = await buildForExport(deps);
      if (!built.ok) {
        pending = null;
        return failure(built.reason);
      }
      pending = { build: built.build, at: now() };
      return {
        ok: true,
        summary: built.build.summary,
        preview: renderDiagnosticsPreview(built.build.json),
      };
    },
    async save() {
      const cached = pending;
      pending = null;
      if (cached !== null && now() - cached.at <= ttlMs) {
        return writeBuild(deps, cached.build);
      }
      const built = await buildForExport(deps);
      if (!built.ok) return failure(built.reason);
      return writeBuild(deps, built.build);
    },
  };
}

/**
 * Registers both channels. Both take no renderer payload at all, and the
 * session guarantees "what you previewed is what you save".
 */
export function registerDiagnosticsIpc(deps: DiagnosticsIpcDeps): void {
  const session = createDiagnosticsIpcSession(deps);
  ipcMain.handle(DIAGNOSTICS_PREVIEW_CHANNEL, () => session.preview());
  ipcMain.handle(DIAGNOSTICS_SAVE_CHANNEL, () => session.save());
}

/**
 * Diagnostics export (GitHub #18) — channels and renderer-facing result
 * shapes. Value-only module with ZERO runtime imports: the sandboxed preload
 * imports the channel names, and a preload that pulls in any package (zod)
 * fails to load, leaving the renderer without `window.anycode`.
 *
 * Privacy baseline: the bundle is anonymised in MAIN before it ever reaches
 * this surface. `preview` returns only the already-anonymised text; nothing
 * here can carry telemetry payloads, prompts, paths or secrets back to the
 * renderer.
 */

/** Renderer -> main: build the anonymised bundle and return its preview. */
export const DIAGNOSTICS_PREVIEW_CHANNEL = "anycode:diagnostics-preview";

/** Renderer -> main: write the anonymised bundle to a user-chosen file. */
export const DIAGNOSTICS_SAVE_CHANNEL = "anycode:diagnostics-save";

/**
 * Hard ceiling for one bundle, bytes. The card requires < 5 MB; the builder
 * measures the EXACT serialised UTF-8 length and trims until strictly below
 * this value, so an export can never produce a larger file.
 */
export const DIAGNOSTICS_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** One section's size/record counts, safe to show in the UI. */
export interface DiagnosticsSectionSummary {
  name: string;
  records: number;
  bytes: number;
}

/** What the UI shows next to the preview: sizes only, never content. */
export interface DiagnosticsSummary {
  generatedAt: string;
  bytes: number;
  sections: DiagnosticsSectionSummary[];
  /** True when a cap dropped data (see the bundle's own `notes`). */
  truncated: boolean;
  /** How many secret/path/host/id-shaped fragments the anonymiser replaced. */
  redactions: number;
}

export type DiagnosticsFailureReason = "build_failed" | "too_large" | "write_failed" | "canceled";

export type DiagnosticsPreviewResult =
  | { ok: true; summary: DiagnosticsSummary; preview: string }
  | { ok: false; reason: DiagnosticsFailureReason };

export type DiagnosticsSaveResult =
  | { ok: true; saved: boolean; path?: string }
  | { ok: false; reason: DiagnosticsFailureReason };

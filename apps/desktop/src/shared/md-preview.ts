/**
 * Native DOM markdown-preview contract between main and renderer (TASK.99
 * CUT.md CONTRACTS, M1: READ only — NAVIGATE lands in M2). Same value-only
 * shape as shared/preview-panel.ts / shared/window.ts: channel-name constants
 * + wire types only, ZERO runtime imports, so it is safe to import from
 * preload (sandboxed CJS), the renderer web bundle, AND main alike without
 * dragging any Electron runtime into a bundle that cannot afford it. Kept as
 * its OWN file (not appended to shared/preview-panel.ts) so that frozen-track
 * file stays near-untouched (CUT.md Gap 3 sequencing note / RISK REGISTER §2).
 */

/** invoke (renderer→main): (re)read the LIVE source of a dom-md preview's document — Reload is the SAME invoke, no cache. */
export const MD_PREVIEW_READ_CHANNEL = "anycode:md-preview-read";
// zod: { tabId: z.string().min(1), previewId: z.string().min(1) }

/**
 * invoke (renderer→main): follow a doc-relative or absolute `.md` link,
 * replacing the preview's current document in place (M2 — the constant is
 * declared here now so the frozen contract file only changes once; no
 * preload method, zod schema, or main handler exists for it until M2).
 */
export const MD_PREVIEW_NAVIGATE_CHANNEL = "anycode:md-preview-navigate";
// zod: { tabId, previewId, href: z.string().min(1).max(4096) }   href = doc-relative or absolute .md target

export interface MdDocPayload {
  previewId: string;
  sourcePath: string;
  realSourcePath: string;
  docDir: string;
  sourceText: string;
  sizeBytes: number;
  mtimeMs: number;
  docVersion: number;
}

export type MdDocReadResult =
  | { ok: true; doc: MdDocPayload }
  | {
      ok: false;
      reason: "no_preview" | "not_md" | "not_found" | "outside_roots" | "too_large" | "io_error";
    };

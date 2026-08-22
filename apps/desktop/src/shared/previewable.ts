/**
 * TASK.112 — one source of truth for "which document extensions can the
 * PreviewHost window render". The same list used to live hand-copied in six
 * independent gates (renderer link chip, md-doc navigation, the artifact
 * preview IPC, PreviewHost's record-kind switch, the md-doc reader, and the
 * turn-end auto-open filter), and `.markdown` was missing from every one of
 * them — a file named `notes.markdown` opened through no path at all.
 *
 * `renderer: plain web target, zero Node` (electron.vite.config.ts): this
 * module is imported by the renderer bundle as well as by main and host, so
 * it may not import `node:path` — the extension split is hand-rolled string
 * math that works unchanged in the browser bundle and under vitest's plain
 * node env alike.
 */

/** Markdown extensions PreviewHost renders as a native `dom-md` record (TASK.99 CUT.md CONTRACTS) rather than loading as a web page. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown"]);

/**
 * Document extensions the artifact-preview channel may load into a
 * PreviewHost window. Deliberately disjoint from the raster-image sets — a
 * document is RENDERED here, never handed to `shell.openPath`.
 */
export const PREVIEWABLE_DOC_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm", ...MARKDOWN_EXTENSIONS]);

/**
 * Lowercased extension including the dot (`".md"`), or `""` when the final
 * path segment has none. A leading-dot name (`.gitignore`) counts as
 * extensionless, not as an extension — `dot <= 0` — which is what keeps a
 * bare `.md` directory entry from being mistaken for a markdown document.
 * Splits on BOTH separators so a win32 path is handled like a POSIX one.
 */
export function extensionOfPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Does this path name a markdown document (`.md` or `.markdown`)? */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOfPath(path));
}

/** Does this path name a document PreviewHost can render (markdown or HTML)? */
export function isPreviewableDocPath(path: string): boolean {
  return PREVIEWABLE_DOC_EXTENSIONS.has(extensionOfPath(path));
}

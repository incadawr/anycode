/**
 * Native DOM markdown-preview: doc read + navigate (TASK.99 CUT.md
 * CONTRACTS, M1 READ / M2 NAVIGATE). Pure handlers over a deps bag —
 * mirrors artifacts-ipc.ts's own handler-over-deps-bag shape
 * (unit-testable without ipcMain) — closed over a `getRecordRef` lookup
 * into the LIVE `PreviewHost` (bound at the wiring site, main/index.ts, to
 * `PreviewHostHandle.getMdDocRef`), so this module never imports
 * preview-host.ts's Electron-adjacent types.
 *
 * NO CACHE: every invoke (including a Reload click, which re-issues the SAME
 * READ channel) re-resolves containment AND re-stats AND re-reads the file
 * from disk. Two custody layers, same posture as artifacts-ipc.ts's
 * `handleArtifactReadImage`:
 *  - `resolveArtifact` re-runs the record's ORIGINAL `sourcePath` (READ) or
 *    the freshly-joined navigate target (NAVIGATE) through the SAME
 *    containment resolver `PreviewHost.openForTab` used at open time
 *    (main/index.ts binds both to `resolveContainedPath`/`resolveArtifactPath`
 *    over the identical allowed-roots policy) — a TOCTOU symlink swap since
 *    open time, or a workspace that no longer contains the file, is caught
 *    fresh on every call, not just once at open time.
 *  - `readFileNoFollow` is an O_NOFOLLOW read (NodeArtifactsFs pattern):
 *    the final path component must not be a symlink at read time either.
 *
 * `MD_PREVIEW_MAX_SOURCE_BYTES` is exported here as the single source of
 * truth for the read cap — main/index.ts wires no other constant for it.
 */

import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import type { MdDocReadResult } from "../../shared/md-preview.js";

/** Read cap for the raw markdown source — anything bigger is an honest `too_large` refusal, never a truncated read. */
export const MD_PREVIEW_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** The live dom-md record fields `readMdDoc` needs, re-read fresh on every call — never cached in this module. */
export interface MdDocRecordRef {
  sourcePath: string;
  realSourcePath: string;
  docDir: string;
  docVersion: number;
}

export interface MdDocDeps {
  /** Bound (main/index.ts) to `PreviewHostHandle.getMdDocRef` — `undefined` for no-such-preview/wrong-tab/a "web" record. */
  getRecordRef(tabId: string, previewId: string): MdDocRecordRef | undefined;
  /**
   * `resolveArtifact`-style containment (artifacts-ipc.ts's
   * `resolveArtifactPath`/`resolveContainedPath` pattern), re-run fresh
   * against the record's ORIGINAL `sourcePath` on every call — the same
   * resolver `PreviewHost.openForTab` used to create the record in the first
   * place, so a later containment change (moved workspace, swapped symlink)
   * is caught honestly rather than trusting a stale open-time realpath.
   */
  resolveArtifact(tabId: string, path: string): Promise<{ realPath: string } | { failure: "not_found" | "outside_roots" }>;
  stat(path: string): Promise<{ size: number; isFile: boolean; mtimeMs: number }>;
  /** O_NOFOLLOW read — fails if the final path component is a symlink (NodeArtifactsFs pattern, artifacts-ipc.ts). */
  readFileNoFollow(path: string): Promise<Buffer>;
  /**
   * M2: commits a NAVIGATE mutation to the live dom-md record — bound
   * (main/index.ts) to `PreviewHostHandle.commitMdNavigate`, which also
   * derives the record's new `url` from `realSourcePath` and bumps
   * `docVersion`/`lastOpenedAt` (CUT.md CONTRACTS: replace semantics, no
   * history stack). Returns the record's fresh `docVersion` on success,
   * `undefined` if the record vanished (closed/destroyed) in the window
   * between `getRecordRef` and this call — `navigateMdDoc` maps that to the
   * same honest `no_preview` refusal `getRecordRef` itself would give.
   */
  commitNavigate(
    tabId: string,
    previewId: string,
    fields: { sourcePath: string; realSourcePath: string; docDir: string; title: string },
  ): number | undefined;
}

/**
 * MD_PREVIEW_READ (M1): re-resolves, re-stats, and re-reads the dom-md
 * preview's current source, honestly refusing at the first failing gate.
 * Reload is this SAME call, made again — there is no cache or watcher to
 * invalidate.
 */
export async function readMdDoc(deps: MdDocDeps, tabId: string, previewId: string): Promise<MdDocReadResult> {
  const ref = deps.getRecordRef(tabId, previewId);
  if (ref === undefined) {
    return { ok: false, reason: "no_preview" };
  }

  const resolved = await deps.resolveArtifact(tabId, ref.sourcePath);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  const realPath = resolved.realPath;
  if (!/\.md$/i.test(realPath)) {
    return { ok: false, reason: "not_md" };
  }

  let stat: { size: number; isFile: boolean; mtimeMs: number };
  try {
    stat = await deps.stat(realPath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stat.isFile) {
    return { ok: false, reason: "not_found" };
  }
  if (stat.size > MD_PREVIEW_MAX_SOURCE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFileNoFollow(realPath);
  } catch {
    return { ok: false, reason: "io_error" };
  }

  return {
    ok: true,
    doc: {
      previewId,
      sourcePath: ref.sourcePath,
      realSourcePath: realPath,
      docDir: dirname(realPath),
      sourceText: bytes.toString("utf8"),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      docVersion: ref.docVersion,
    },
  };
}

/** Cuts at the first `?` or `#` (URL convention: query precedes fragment) — neither is ever part of a filesystem path. Same policy as doc-links.ts's own `isLocalMdHref`/`resolveDocRelative` (documented once there; applied independently here since main cannot import renderer code — RECON §4, separate build targets). */
function stripFragmentAndQuery(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * MD_PREVIEW_NAVIGATE (M2): follows a doc-relative or absolute `.md` href
 * from the CURRENT document, replacing the preview's content in place — no
 * history stack (CUT.md CONTRACTS: "replace semantics"). Reuses
 * `readMdDoc`'s exact custody chain (fresh containment + O_NOFOLLOW read)
 * unabridged: the ONLY new step is joining `href` against the record's
 * CURRENT `docDir` BEFORE that chain runs (Node's real `path.resolve`/
 * `path.isAbsolute` — this module is main-side Node, unlike doc-links.ts's
 * browser-safe hand-rolled join), and committing the record mutation on
 * success. A navigate target gets NO less scrutiny than a plain read: the
 * `.md` extension check runs against the RESOLVED REALPATH (matching
 * `readMdDoc`), not the raw href.
 */
export async function navigateMdDoc(
  deps: MdDocDeps,
  tabId: string,
  previewId: string,
  href: string,
): Promise<MdDocReadResult> {
  const ref = deps.getRecordRef(tabId, previewId);
  if (ref === undefined) {
    return { ok: false, reason: "no_preview" };
  }

  const pathPart = stripFragmentAndQuery(href);
  if (pathPart.length === 0) {
    // A bare `#fragment`/`?query` with no filename portion is never a valid
    // navigate target — there is no file to join or resolve.
    return { ok: false, reason: "not_md" };
  }
  const joined = isAbsolute(pathPart) ? pathPart : resolvePath(ref.docDir, pathPart);

  const resolved = await deps.resolveArtifact(tabId, joined);
  if ("failure" in resolved) {
    return { ok: false, reason: resolved.failure };
  }
  const realPath = resolved.realPath;
  if (!/\.md$/i.test(realPath)) {
    return { ok: false, reason: "not_md" };
  }

  let stat: { size: number; isFile: boolean; mtimeMs: number };
  try {
    stat = await deps.stat(realPath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stat.isFile) {
    return { ok: false, reason: "not_found" };
  }
  if (stat.size > MD_PREVIEW_MAX_SOURCE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFileNoFollow(realPath);
  } catch {
    return { ok: false, reason: "io_error" };
  }

  const newDocDir = dirname(realPath);
  const docVersion = deps.commitNavigate(tabId, previewId, {
    sourcePath: joined,
    realSourcePath: realPath,
    docDir: newDocDir,
    title: basename(joined),
  });
  if (docVersion === undefined) {
    // The record was destroyed/closed in the (tiny) window between
    // `getRecordRef` above and the fs work just completed — an honest
    // `no_preview`, the same refusal `getRecordRef` itself would give.
    return { ok: false, reason: "no_preview" };
  }

  return {
    ok: true,
    doc: {
      previewId,
      sourcePath: joined,
      realSourcePath: realPath,
      docDir: newDocDir,
      sourceText: bytes.toString("utf8"),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      docVersion,
    },
  };
}

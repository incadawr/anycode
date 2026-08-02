/**
 * Pure doc-relative href helpers for the native DOM markdown preview (TASK.99
 * CUT.md CONTRACTS, M2). `renderer: plain web target, zero Node`
 * (electron.vite.config.ts) - neither function may import `node:path`; both
 * are hand-rolled string math so this module works unmodified in the browser
 * bundle AND under vitest's plain-node test env alike (RISK REGISTER §5).
 *
 * Both functions share one fragment/query policy, applied consistently on
 * both sides of an md-doc link/image reference:
 *  - A `?query` and/or `#fragment` suffix is stripped before any extension
 *    check or path join - neither is ever part of a filesystem path. Cut at
 *    the FIRST `?` or `#`, whichever appears first in the string (URL
 *    convention: query precedes fragment), so `doc.md?x=1#top` and
 *    `doc.md#top` both yield the path `doc.md`. A href that is NOTHING but a
 *    fragment/query (`#top`, `?x=1`) has no path portion at all and is
 *    rejected by both functions - there is no file to join or navigate to.
 *  - A URI-scheme href (`http:`, `mailto:`, `data:`, etc.) or a
 *    protocol-relative one (`//host/path` - a network-path reference, not a
 *    filesystem path) is never local: `resolveDocRelative` returns `null`,
 *    `isLocalMdHref` returns `false`. A win32 drive path (`C:\...`/`C:/...`)
 *    is NOT mistaken for a scheme (mirrors Markdown.tsx's own
 *    `isLocalFileHref` regex).
 */

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/** A URI scheme prefix (`scheme:`), excluding a win32 drive letter (`C:\` / `C:/`), which is an absolute LOCAL path, not a scheme. */
function hasUriScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !WIN_DRIVE_RE.test(href);
}

/** `//host/path` - a network-path (protocol-relative) reference, never a local filesystem path. */
function isProtocolRelative(href: string): boolean {
  return href.startsWith("//");
}

/** POSIX (`/...`), win32 drive (`C:\...` / `C:/...`), or win32 UNC (`\\server...`) absolute path. */
function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || WIN_DRIVE_RE.test(path) || path.startsWith("\\\\");
}

/** Cuts at the first `?` or `#` (URL convention: query precedes fragment) - neither is ever part of a filesystem path. */
function stripFragmentAndQuery(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

interface DirParts {
  /** `""` (relative docDir, defensive-only - `docDir` is always absolute in practice), `"/"`, `"C:\\"` / `"C:/"`, or `"\\\\"` (UNC). */
  root: string;
  sep: "/" | "\\";
  segments: string[];
}

/** Splits an absolute directory into its root marker + path segments, detecting win32 vs POSIX by the presence of `\` (a POSIX path never contains one). */
function splitDir(docDir: string): DirParts {
  const sep: "/" | "\\" = docDir.includes("\\") ? "\\" : "/";
  let root = "";
  let rest = docDir;
  if (docDir.startsWith("\\\\")) {
    root = "\\\\";
    rest = docDir.slice(2);
  } else if (WIN_DRIVE_RE.test(docDir)) {
    root = docDir.slice(0, 3);
    rest = docDir.slice(3);
  } else if (docDir.startsWith("/")) {
    root = "/";
    rest = docDir.slice(1);
  }
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  return { root, sep, segments };
}

/**
 * Joins a relative path (`.` / `..` / plain segments, ALWAYS `/`-separated -
 * markdown hrefs are conventionally forward-slash even on win32) onto
 * `docDir`'s own segments, popping on `..` (clamped at the root, matching
 * `path.join`/`path.resolve`'s own clamping - never throws or produces a
 * relative result). Rebuilt using `docDir`'s OWN separator style so a win32
 * `docDir` yields a win32-separated result.
 */
function joinRelative(docDir: string, relPath: string): string {
  const { root, sep, segments } = splitDir(docDir);
  const result = [...segments];
  for (const seg of relPath.split("/")) {
    if (seg.length === 0 || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (result.length > 0) {
        result.pop();
      }
      continue;
    }
    result.push(seg);
  }
  return root + result.join(sep);
}

/**
 * Resolves a markdown href against the document's own directory - the
 * renderer-side half of TASK.99 M2's image custody chain: the caller joins
 * FIRST, then hands the result to the EXISTING `api.readImage(tabId, absPath)`
 * containment channel unchanged (this function does no filesystem work and
 * makes no containment claim of its own).
 *
 * - A URI-scheme or protocol-relative href is never local - returns `null`
 *   (the caller's own upstream local-file gate should already have excluded
 *   these; this is a defensive, independently-correct fallback, not the
 *   primary gate).
 * - An absolute local path passes through UNCHANGED (fragment/query still
 *   stripped) - already anchored, nothing to join.
 * - Everything else (bare `img.png`, `./img.png`, `../assets/img.png`) is
 *   joined onto `docDir`.
 */
export function resolveDocRelative(docDir: string, href: string): string | null {
  if (href.length === 0 || isProtocolRelative(href) || hasUriScheme(href)) {
    return null;
  }
  const pathPart = stripFragmentAndQuery(href);
  if (pathPart.length === 0) {
    return null;
  }
  return isAbsoluteLocalPath(pathPart) ? pathPart : joinRelative(docDir, pathPart);
}

/**
 * Is this href a local `.md` navigation target `MdLink` should route through
 * `onOpenMdLink` (MD_PREVIEW_NAVIGATE) instead of the chat-path
 * `artifacts.preview`? True for a relative OR absolute local path whose
 * (fragment/query-stripped) path portion ends in `.md` (case-insensitive) -
 * `resolveDocRelative` / the main-side NAVIGATE handler do the actual
 * resolution; this is purely the routing decision at click time.
 */
export function isLocalMdHref(href: string): boolean {
  if (href.length === 0 || href.startsWith("#") || isProtocolRelative(href) || hasUriScheme(href)) {
    return false;
  }
  const pathPart = stripFragmentAndQuery(href);
  return pathPart.length > 0 && /\.md$/i.test(pathPart);
}

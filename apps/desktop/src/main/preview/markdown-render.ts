/**
 * Markdown -> sanitized static HTML render pipeline (night-track wave-1 cut
 * §1(g), TASK.96 96-F): the implementation behind PreviewHost's
 * `renderMarkdown` dependency (`preview-host.ts` §2.5 — that file's own doc
 * comment notes the dep is "absent this checkpoint" and refuses every `.md`
 * open honestly rather than ever loading the raw source as plaintext; this
 * module is what `main/index.ts` injects to remove that refusal). The
 * model-authored/model-adjacent markdown source is untrusted input all the
 * way through this pipeline — nothing here assumes the file is "safe" just
 * because it lives inside an allowed artifact root (PreviewHost's own
 * containment check already guarantees that; this module's job is what
 * happens to the BYTES once a path is contained).
 *
 * Pipeline: read (size-capped) -> `marked` (GFM on, the same devDep already
 * used elsewhere in this app) -> `sanitize-html` (frozen allowlist below) ->
 * a static HTML shell carrying a strict CSP meta tag -> written to a
 * deterministic path under the OS temp dir, file 0600 / dir 0700.
 * `loadFile`-ing the returned path and cleaning it up on preview
 * close/closeAll is PreviewHost's job (preview-host.ts), not this module's.
 *
 * Electron-free by construction, mirroring preview-host.ts's own doc comment:
 * only `node:fs`/`node:os`/`node:path`/`node:crypto` plus the two pure npm
 * deps (`marked`, `sanitize-html`) are used, so this file's tests run under
 * plain `vitest` with zero Electron runtime involved.
 *
 * SANITIZE ALLOWLIST (frozen, cut §1(g) — do not drift without a re-cut):
 *  - Tags: `sanitize-html`'s own defaults (headings/paragraphs/lists/inline
 *    text semantics/etc. — `table`/`thead`/`tbody`/`tr`/`td`/`th`/`pre`/`code`
 *    are ALREADY in those defaults) plus `img`, `details`, `summary`, `input`
 *    — the four tags this pipeline needs beyond the library's baseline.
 *  - Attributes: `href` (only on `a`), `src`/`alt` (only on `img`), `title`/
 *    `class` (any tag) — nothing else survives on any tag. That is what
 *    strips every `on*` event handler and every `style` attribute: neither
 *    name is in this list, so the library's own attribute-allowlist check
 *    removes them: no bespoke handler-stripping logic is needed here.
 *  - Schemes: `img[src]` accepts `https|file|data` only; `http:` images are
 *    dropped ENTIRELY (the `exclusiveFilter` below removes the whole `<img>`
 *    once its `src` has been stripped by the scheme check, rather than
 *    leaving a bare broken-image tag with no `src`). `a[href]` accepts
 *    `https|mailto` only — `javascript:` and every other scheme is stripped,
 *    degrading the link to plain text.
 *  - `input`: the ONLY `<input>` that survives at all is one with
 *    `type="checkbox"` AND a `disabled` attribute present — exactly what
 *    `marked`'s GFM task-list renderer emits for every task-list item
 *    (`checked` is additionally preserved so a checked item does not
 *    silently render unchecked; it carries no injection surface of its own).
 *    Any other `<input>` a hostile source smuggles in as raw HTML (`marked`
 *    passes raw HTML embedded in markdown source through verbatim) is
 *    discarded outright by the same filter.
 *  - `<script>`/`<style>` are never in the allowed-tags list AND are in
 *    `sanitize-html`'s `nonTextTags` default, so their content is discarded
 *    together with the tag — never unwrapped into visible text.
 *
 * CSP is the backstop for all of the above: `default-src 'none'` with NO
 * `script-src` means even a sanitizer miss cannot execute script in the
 * rendered page.
 *
 * KNOWN LIMITATION (cut §1(g), deliberately deferred — not wave 1): relative
 * image paths in the source markdown (`![](./diagram.png)`) do not resolve.
 * The rendered file lives under the OS temp dir, not next to the source, and
 * the CSP choice above rules out adding a `<base href>` back at the source's
 * directory to fix that. Follow-up work, tracked separately.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

export type RenderMarkdownResult = { htmlPath: string } | { error: string };

/** Source-file size cap (cut §1(g)): anything bigger is refused honestly before ever being read into memory. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** `os.tmpdir()`-relative directory every rendered preview file lives under (dir mode 0700). */
export const PREVIEW_DIR_NAME = "anycode-preview";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** CSP meta content (frozen literal, cut §1(g)) — no `script-src` means scripts stay dead even if sanitize-html misses something. */
export const PREVIEW_CSP =
  "default-src 'none'; img-src file: data: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * `sanitize-html`'s own defaults already include most block/inline tags
 * (including `table`/`thead`/`tbody`/`tr`/`td`/`th`/`pre`/`code` — listed
 * again below anyway to keep this literal a direct, checkable transcript of
 * the cut's frozen allowlist rather than relying on a reader to know which
 * of these the library already permits). `img`/`details`/`summary`/`input`
 * are the four genuinely NEW tags this pipeline adds.
 */
const ALLOWED_TAGS = Array.from(
  new Set([
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "pre",
    "code",
    "details",
    "summary",
    "input",
  ]),
);

export const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // Protocol-relative `//host/path` values are otherwise permitted by
  // sanitize-html's default and resolve against the file:// shell document as
  // `file://host/path` (a UNC/NTLM egress on win32) — closed for both `img`
  // and `a` scheme checks below (cut §1.7, F6).
  allowProtocolRelative: false,
  allowedAttributes: {
    "*": ["title", "class"],
    a: ["href", "title", "class"],
    img: ["src", "alt", "title", "class"],
    input: ["type", "disabled", "checked"],
  },
  allowedSchemesByTag: {
    img: ["https", "file", "data"],
    a: ["https", "mailto"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  // Per-tag overrides above cover every scheme-carrying attribute this
  // allowlist admits; an empty global default means any OTHER tag that
  // somehow ends up with a scheme-checked attribute is refused, not
  // defaulted to the library's normally-permissive http/https/ftp/mailto/tel.
  allowedSchemes: [],
  exclusiveFilter: (frame) => {
    if (frame.tag === "input") {
      return !(frame.attribs.type === "checkbox" && "disabled" in frame.attribs);
    }
    if (frame.tag === "img") {
      return !frame.attribs.src;
    }
    return false;
  },
};

function renderShell(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
    max-width: 860px;
    margin: 0 auto;
    padding: 24px;
    background: #ffffff;
    color: #1a1a1a;
  }
  a { color: #0969da; }
  pre, code { background: #f4f4f4; border-radius: 4px; }
  pre { padding: 12px; overflow-x: auto; }
  code { padding: 2px 4px; }
  pre code { padding: 0; background: none; }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid currentColor; padding: 4px 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1e1e; color: #e6e6e6; }
    a { color: #6cb6ff; }
    pre, code { background: #2a2a2a; }
  }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

/** Deterministic render-target path: same source path + same mtime -> the SAME file (idempotent); an edit (new mtime) -> a new path, so re-opening after a save re-renders instead of serving a stale file. */
function renderedPathFor(dir: string, realPath: string, mtimeMs: number): string {
  const name = createHash("sha256").update(`${realPath}:${mtimeMs}`).digest("hex");
  return join(dir, `${name}.html`);
}

/**
 * Renders `realPath` (already containment-checked by PreviewHost's caller —
 * this function trusts the path it is given) to a sanitized static HTML file
 * and returns its location. Every failure mode is an honest `{error}` — the
 * source is NEVER loaded as plaintext HTML by the caller on a render failure
 * (preview-host.ts's own fallback for a missing `renderMarkdown` dep).
 */
export async function renderMarkdownFile(realPath: string): Promise<RenderMarkdownResult> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(realPath);
  } catch (error) {
    return { error: `cannot read ${realPath}: ${String(error)}` };
  }
  if (!fileStat.isFile()) {
    return { error: `not a file: ${realPath}` };
  }
  if (fileStat.size > MAX_SOURCE_BYTES) {
    return { error: `markdown source exceeds the ${MAX_SOURCE_BYTES}-byte preview cap` };
  }

  let source: string;
  try {
    source = await readFile(realPath, "utf8");
  } catch (error) {
    return { error: `failed to read ${realPath}: ${String(error)}` };
  }

  let rawHtml: string;
  try {
    rawHtml = marked.parse(source, { gfm: true, async: false });
  } catch (error) {
    return { error: `failed to render markdown: ${String(error)}` };
  }

  const bodyHtml = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  const page = renderShell(bodyHtml);

  const dir = join(tmpdir(), PREVIEW_DIR_NAME);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE);
  } catch (error) {
    return { error: `failed to prepare preview directory: ${String(error)}` };
  }

  const htmlPath = renderedPathFor(dir, realPath, fileStat.mtimeMs);
  try {
    await writeFile(htmlPath, page, { mode: FILE_MODE });
    await chmod(htmlPath, FILE_MODE);
  } catch (error) {
    return { error: `failed to write rendered preview: ${String(error)}` };
  }

  return { htmlPath };
}

/**
 * Pure classifier for marked's `html` token `raw` string (TASK.99 owner
 * smoke-test fix #2). `renderer: plain web target, zero Node`
 * (electron.vite.config.ts) — no regex feature needs Node, so this module
 * works unmodified in the browser bundle AND under vitest's plain-node test
 * env alike (same constraint as doc-links.ts).
 *
 * Chat rendering (guardrail §6.5) never interprets raw HTML: an `html` token
 * is always the literal source text. That law is correct for the chat
 * transcript (model-authored, CSP/XSS-sensitive) but too blunt for a
 * document read off disk — a real markdown file's `<!-- comment -->` and
 * `<span class="accent">…</span>` are supposed to be invisible/inert, not
 * printed as source. `Markdown.tsx`'s DOCUMENT path (gated on `MdDocContext
 * !== null`, same mechanism as its doc-relative image resolution) asks THIS
 * function for a verdict per `html` token and acts on it; the chat path
 * never calls it, so chat stays byte-identical.
 *
 * No HTML string is ever produced here and no token is re-lexed — this is
 * string classification only, matching one token's `raw` against three
 * outcomes:
 *  - `hidden`: the raw string IS (only) an HTML comment — renders as
 *    nothing, like every other markdown renderer.
 *  - `unwrap`: the raw string IS (only) one open/close/self-closing tag of
 *    an allowlisted inert tag, with no event-handler attribute — the tag
 *    itself renders as nothing (its content, if any, is a SEPARATE sibling
 *    token that already renders normally — marked's own inline tokenizer
 *    splits `<span>text</span>` into three tokens, and a self-contained
 *    single-tag block token carries no inner content at all), except `br`
 *    which renders as a line break.
 *  - `literal`: anything else — a non-allowlisted tag, `script`/`iframe`/
 *    `style`, an event-handler attribute, malformed/unterminated markup, or
 *    a multi-line block token whose raw bundles open+content+close as one
 *    opaque string — keeps today's behaviour (render `raw` as literal
 *    text). Fail closed by construction: every path that doesn't positively
 *    match `hidden` or `unwrap` falls through to this.
 */

export type HtmlTokenVerdict =
  | { readonly kind: "hidden" }
  | { readonly kind: "unwrap"; readonly tag: string }
  | { readonly kind: "literal" };

const LITERAL: HtmlTokenVerdict = { kind: "literal" };

/**
 * Inert tags whose own markup we're willing to drop in the document path.
 * All are ordinary phrasing-content tags with no active behaviour; `br` is
 * the one member with visible effect (a line break) instead of nothing.
 * Deliberately excludes anything that can execute or fetch (`script`,
 * `iframe`, `style`, `img`, …) or carries block-level layout meaning
 * (`div`, `p`, `table`, …) — those keep the literal fallback.
 */
const UNWRAP_TAGS = new Set([
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "kbd",
  "code",
  "mark",
  "br",
]);

/** Matches an event-handler attribute name (`onclick=`, `onerror =`, …) anywhere in an attribute string, case-insensitively. */
const EVENT_HANDLER_ATTR_RE = /(?:^|\s)on[a-zA-Z-]*\s*=/i;

/**
 * A single open/close/self-closing HTML tag spanning the ENTIRE (trimmed)
 * string — nothing before `<`, nothing after the final `>`. Group 1: `/` for
 * a closing tag. Group 2: tag name. Group 3: everything between the tag name
 * and the final `>` (attributes and/or a trailing self-close `/`).
 * `[^>]` intentionally matches newlines too (a multi-line attribute list on
 * one otherwise self-contained tag is still just one tag).
 */
const SINGLE_TAG_RE = /^<(\/)?([A-Za-z][A-Za-z0-9]*)([^>]*)>$/;

/** Is `s` (already trimmed) nothing but a single HTML comment? */
function isHtmlComment(s: string): boolean {
  return s.startsWith("<!--") && s.endsWith("-->") && s.length >= "<!---->".length;
}

/** Classifies a single/self-contained tag string; `null` if it isn't one, isn't allowlisted, or carries an event-handler attribute. */
function classifySingleTag(s: string): string | null {
  const match = SINGLE_TAG_RE.exec(s);
  if (!match) {
    return null;
  }
  const closing = match[1] !== undefined;
  const tag = (match[2] ?? "").toLowerCase();
  if (!UNWRAP_TAGS.has(tag)) {
    return null;
  }
  // Strip a trailing self-close `/` (with any whitespace before it) before
  // inspecting what remains as attributes.
  const rest = (match[3] ?? "").replace(/\/\s*$/, "");
  if (closing) {
    // A well-formed closing tag carries nothing else; anything left over
    // (`</span foo>`) is malformed HTML, not a closing tag — fail closed.
    return rest.trim() === "" ? tag : null;
  }
  return EVENT_HANDLER_ATTR_RE.test(rest) ? null : tag;
}

/** Classifies a marked `html` token's `raw` string for the document rendering path. See module doc for the three outcomes. */
export function classifyHtmlToken(raw: string): HtmlTokenVerdict {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return LITERAL;
  }
  if (isHtmlComment(trimmed)) {
    return { kind: "hidden" };
  }
  const tag = classifySingleTag(trimmed);
  return tag !== null ? { kind: "unwrap", tag } : LITERAL;
}

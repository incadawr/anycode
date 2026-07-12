/**
 * Markdown lexing helpers (design /working-docs/ui-track/design/slice-R1-cut.md
 * §3.1). Lexer-only: we never invoke marked's parser or HTML renderer — the
 * renderer walks the block-token array itself (components/Markdown.tsx) and
 * emits React nodes, so no HTML string is ever produced and
 * `dangerouslySetInnerHTML` is never needed (guardrail §6.5). A fresh `Lexer`
 * is created per call because the class holds per-run state; instantiation is
 * trivial, and this avoids any shared instance or global option mutation.
 */
import { Lexer } from "marked";
import type { Token } from "marked";

/**
 * Lexes `text` into marked's block-token array with GFM enabled and
 * `breaks: true` (a single newline becomes a hard break — deliberate fidelity
 * to models that emit single-newline plain text, matching today's
 * `white-space: pre-wrap` rendering). The returned `TokensList` is `Token[]`
 * plus a `links` map; the narrower `Token[]` type is sufficient since the
 * lexer has already resolved reference links into `link` tokens.
 */
export function lexMarkdown(text: string): Token[] {
  return new Lexer({ gfm: true, breaks: true }).lex(text);
}

/**
 * Decodes exactly the five HTML entities marked's `escape()` emits, in this
 * order: `&lt; &gt; &quot; &#39;` then `&amp;` LAST — decoding `&amp;` last
 * prevents double-decoding of an author-written `&amp;lt;` (which must stay
 * `&lt;`, not collapse to `<`). Applied to text-bearing leaves whose content we
 * render through React text nodes rather than an HTML pipeline; also matches
 * CommonMark's entity-reference semantics for author-written `&lt;`. Idempotent
 * on plain text (no entities → unchanged).
 */
export function decodeMarkedText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Display label for a fenced code block from its info string: the first
 * whitespace-separated word, lowercased and capped at 20 chars; `null` for an
 * empty/undefined info string. marked's `code` token `lang` carries the FULL
 * info string ("ts title=x"), so both this and `langIdForFenceInfo` must take
 * the first word only.
 */
export function fenceLabel(lang: string | undefined): string | null {
  if (!lang) {
    return null;
  }
  const first = lang.trim().split(/\s+/)[0] ?? "";
  if (first === "") {
    return null;
  }
  return first.toLowerCase().slice(0, 20);
}

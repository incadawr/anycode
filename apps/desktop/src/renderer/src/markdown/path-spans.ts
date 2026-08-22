/**
 * TASK.112 slice 2 — finds candidate local filesystem paths inside a plain
 * run of text (a markdown `text` leaf or a `codespan`'s whole content — see
 * Markdown.tsx's `InlineTokens` for the two call sites; a `link` token's own
 * children and fenced `code` blocks are never scanned, by the CALLER's
 * choice, not this module's).
 *
 * The gap this closes: a click-to-open affordance is born ONLY when the
 * model wrote a real markdown link `[text](path)`. A path stated in prose
 * ("saved it in report.html") or inline code (`` `report.html` ``) produces a
 * `text`/`codespan` token, never a `link` token — this module is the scan
 * that finds those paths anyway, so `Markdown.tsx` can offer to verify and
 * linkify them.
 *
 * `renderer: plain web target, zero Node` (electron.vite.config.ts): pure
 * string/regex work, no `node:path` — the same constraint `shared/
 * previewable.ts` documents, since `extensionOfPath` is imported from there.
 */
import { extensionOfPath, PREVIEWABLE_DOC_EXTENSIONS } from "../../../shared/previewable.js";

export interface PathSpan {
  /** Index into the source `text` where the path begins (inclusive). */
  start: number;
  /** Index into the source `text` where the path ends (exclusive) — `text.slice(start, end) === path`. */
  end: number;
  path: string;
}

/**
 * Hard cap on spans returned per call. Pathological text (thousands of
 * dot-extension-looking tokens pasted into a message) must not fan out into
 * hundreds of `artifacts.previewable` IPC round-trips — the caller batches
 * every returned candidate into ONE call, so the cap is what bounds that
 * batch, not any per-call size limit on the channel itself.
 */
const MAX_SPANS = 32;

/**
 * Matches one candidate path run: an optional win32 drive prefix (`C:\` /
 * `C:/`) followed by one or more "path characters" (letters, digits,
 * `_ . - + / \ ~`). The drive prefix is its own alternative because the
 * colon it needs can't be part of the general run — with `:` in the run's
 * own character class, every URL scheme (`https:`) would read as a path
 * body too.
 *
 * The leading negative lookbehind is the "a candidate must start at a
 * boundary" rule: it blocks a match from starting right after any of the
 * run's own characters, PLUS `@`. `@` is deliberately absent from the run's
 * OWN character class (a run can never grow across one) but present here —
 * that asymmetry is what makes `notes.md` in `user@notes.md` boundary-
 * illegal (the "preceded by `@`, email-ish" rejection rule) as a structural
 * consequence of the regex, with no separate runtime check needed for it.
 */
const CANDIDATE_RE = new RegExp(
  "(?<![A-Za-z0-9_.\\-@+/\\\\~])(?:[A-Za-z]:[\\\\/])?[A-Za-z0-9_.\\-+/\\\\~]+",
  "g",
);

function hasPreviewableExtension(candidate: string): boolean {
  return PREVIEWABLE_DOC_EXTENSIONS.has(extensionOfPath(candidate));
}

/**
 * Characters that are legal WITHIN a path (hence part of the run above, hence
 * part of the raw regex match) but are also common end-of-sentence/bracket
 * noise — "see plan.md.", "docs/plan.md,". Trimmed off the end one at a time,
 * and ONLY while the extension check still fails, so a genuinely valid
 * extension is never chewed into: the loop stops the instant the remainder
 * already ends in a recognized one.
 */
const TRAILING_NOISE = new Set([".", "-", "_", "~", "/", "\\"]);

function trimTrailingNoise(candidate: string): string {
  let result = candidate;
  while (
    result.length > 0 &&
    !hasPreviewableExtension(result) &&
    TRAILING_NOISE.has(result[result.length - 1] as string)
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Is this raw match (BEFORE trimming) shaped like a URL rather than a local
 * path, in the two ways the run's own character class (no `:`) doesn't
 * already rule out? A scheme (`https:`) breaks the run at its colon — but the
 * `//host/...` tail that follows is itself boundary-legal (the colon isn't a
 * "path character") and would otherwise be matched as its own candidate one
 * position later; `startsWith("//")` is what catches that tail, and a bare
 * protocol-relative href (`//host/a.md`, nothing before it at all) besides.
 * `includes("://")` is a second, cheap net for the rarer case where the
 * scheme's letters themselves end up folded into the same run (defensive —
 * not reachable through the run's own character class today, kept because a
 * future widening of that class must not silently reopen this gap).
 */
function looksLikeUrl(raw: string): boolean {
  return raw.includes("://") || raw.startsWith("//");
}

/**
 * Finds candidate local filesystem paths in `text`. Accepts absolute POSIX
 * (`/a/b.md`), win32 drive (`C:\a\b.md`, `C:/a/b.md`), home-anchored
 * (`~/a.md`), dot-relative (`./a.md`, `../a.md`), plain relative
 * (`docs/plan.md`), and bare filenames (`plan.md`) — case-insensitive on the
 * extension. Rejects anything URL-shaped or email-adjacent (see
 * `looksLikeUrl`/the lookbehind's own doc comment) and anything whose
 * extension isn't in `PREVIEWABLE_DOC_EXTENSIONS`. Spans are non-overlapping
 * and in source order (a single left-to-right sweep), capped at `MAX_SPANS`.
 */
export function findPathSpans(text: string): PathSpan[] {
  const spans: PathSpan[] = [];
  CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (spans.length < MAX_SPANS && (match = CANDIDATE_RE.exec(text)) !== null) {
    const raw = match[0];
    if (looksLikeUrl(raw)) {
      continue;
    }
    const trimmed = trimTrailingNoise(raw);
    if (trimmed.length === 0 || !hasPreviewableExtension(trimmed)) {
      continue;
    }
    const start = match.index;
    spans.push({ start, end: start + trimmed.length, path: trimmed });
  }
  return spans;
}

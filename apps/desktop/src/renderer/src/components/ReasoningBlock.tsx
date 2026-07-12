/**
 * Collapsible reasoning transcript block. Disclosure is "default unless
 * user-overrode" (slice R4(d)): the default is derived every render —
 * expanded only while this block is the live streaming tail (the growing
 * pre IS the liveness signal, R3), collapsed the moment `live` drops (next
 * block appends or the turn ends: the agent tidies up after itself). A
 * manual toggle overrides the default for this mount; the stable
 * `key={block.id}` in MessageList preserves it across streaming re-renders.
 * `block.collapsed` no longer participates: it is always false at creation
 * and the reducer never mutates it (store.ts) — dead field, core-track note.
 * R3's live tail preview (shimmer, shown while live AND user-collapsed) is
 * behavior-identical under the new seeding.
 */
import { useId, useState } from "react";
import type { TranscriptBlock } from "../store.js";
import { Chevron } from "./icons.js";

/**
 * Local, module-scoped brain glyph (design/slice-P7.2-cut.md §3.2) — identifies
 * the reasoning plate. `icons.tsx` is untouched (WIP-locked elsewhere); this
 * stays inline pending a post-WIP migration (residual §6). Pure vector, no
 * image asset (R21 law precedent): two stroke-style lobes, currentColor.
 */
function BrainIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      style={{ flexShrink: 0, opacity: 0.75, verticalAlign: "text-bottom" }}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 2.5c-1.4 0-2.5 1-2.5 2.2 0 .4.1.8.3 1.1-.9.4-1.5 1.3-1.5 2.3 0 .8.4 1.5 1 1.9-.2.3-.3.7-.3 1.1 0 1.2 1 2.2 2.3 2.2.4 0 .7-.1 1-.3v-8.6c-.1-.9-.2-1.9-.3-1.9Z" />
      <path d="M9.5 2.5c1.4 0 2.5 1 2.5 2.2 0 .4-.1.8-.3 1.1.9.4 1.5 1.3 1.5 2.3 0 .8-.4 1.5-1 1.9.2.3.3.7.3 1.1 0 1.2-1 2.2-2.3 2.2-.4 0-.7-.1-1-.3v-8.6c.1-.9.2-1.9.3-1.9Z" />
      <path d="M6.5 5.3h3" />
      <path d="M6.2 8h3.6" />
      <path d="M6.5 10.6h3" />
    </svg>
  );
}

type ReasoningTranscriptBlock = Extract<TranscriptBlock, { kind: "reasoning" }>;

export function ReasoningBlock({
  block,
  live = false,
  enter = false,
}: {
  block: ReasoningTranscriptBlock;
  live?: boolean;
  enter?: boolean;
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? live;
  // R3(d) preview path — byte-identical predicate: live AND user-collapsed.
  const showPreview = live && !expanded;
  // R17 a11y: bind the disclosure toggle to the reasoning text it controls.
  const textId = useId();

  return (
    <div className={`reasoning-block${enter ? " message-enter" : ""}`}>
      <button
        type="button"
        className={`reasoning-toggle${showPreview ? " reasoning-toggle-live" : ""}`}
        aria-expanded={expanded}
        aria-controls={textId}
        onClick={() => setUserExpanded(!expanded)}
      >
        <span className="reasoning-caret" aria-hidden="true">
          <Chevron />
        </span>{" "}
        <BrainIcon />
        Reasoning
        {showPreview && (
          // aria-hidden keeps the toggle's accessible name "Reasoning" —
          // the streaming tail is visual liveness, not SR content (the
          // column's aria-live would otherwise re-announce every delta).
          <span className="reasoning-live-preview" aria-hidden="true">
            <span className="shimmer-text">{reasoningTailPreview(block.text)}</span>
          </span>
        )}
      </button>
      {expanded && (
        <pre
          id={textId}
          className={`reasoning-text${userExpanded === true ? " disclosure-open" : ""}`}
          aria-live="off"
        >
          {block.text}
        </pre>
      )}
    </div>
  );
}

// ── sanitized tail preview (design/slice-P7.2-cut.md §3.1) ──
//
// Root cause of the owner bug: the old implementation tail-sliced the RAW
// last line of the accumulating stream, so markdown syntax (list markers,
// emphasis, inline code) and mid-token cuts leaked straight into the plate.
// The fixed pipeline is three pure, total steps: (1) plain-textify the last
// few raw lines and join them, walking backward only while a line strips to
// nothing (recovers content when the very last raw line is itself just a
// stray marker/token — the smallest lookback that still fixes that case);
// (2) cap at 160 chars, cutting at a word boundary so the preview never
// opens mid-word; (3) sweep a trailing orphan token/punctuation mark left
// dangling by the raw stream's mid-token cutoff.

const TAIL_PREVIEW_CAP = 160;
const TAIL_PREVIEW_LOOKBACK_LINES = 4;

// leading block markers: "- "/"* "/"+ ", "1. ", "#{1,6} ", "> " — the marker
// may also stand alone with nothing after it yet (a marker-only line still
// mid-stream), hence `\s+|$` rather than requiring a space.
const LEADING_MARKER_RE = /^\s*(?:[-*+]|\d+\.|#{1,6}|>)(?:\s+|$)/;

/**
 * Strips leading block markers to a fixpoint, not just once — a blockquoted
 * list item (`> - item`) nests two markers, so a single pass left the inner
 * `-` leaking through raw. Repeats until a pass changes nothing (including
 * stripping down to the empty string for a marker-only line like `> -`,
 * which must come back empty so the caller's lookback can join the previous
 * line instead of leaking the bare marker).
 */
function stripLeadingMarkers(line: string): string {
  let s = line;
  for (;;) {
    const next = s.replace(LEADING_MARKER_RE, "");
    if (next === s) {
      return s;
    }
    s = next;
  }
}

/** Strips block + inline markdown syntax from a single line, plain text out. */
function stripMarkdownLine(line: string): string {
  let s = stripLeadingMarkers(line);
  // links: [text](url) -> text.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // bold/strong markers (all occurrences, incl. an unpaired trailing one).
  s = s.replace(/\*\*/g, "").replace(/__/g, "");
  // inline code fences (all occurrences).
  s = s.replace(/`/g, "");
  // single */_ emphasis wrapping a word.
  s = s.replace(/\*([^\s*][^*]*?)\*/g, "$1");
  s = s.replace(/_([^\s_][^_]*?)_/g, "$1");
  return s;
}

/** Collapses any whitespace run (incl. embedded newlines) to a single space, trimmed. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** True for a UTF-16 code unit that is the low (trailing) half of a surrogate pair. */
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Takes the last `n` UTF-16 code units of `s`, nudging the cut point back by
 * one unit if it would otherwise land inside a surrogate pair — a plain
 * `slice(-n)` on a string full of astral characters (e.g. emoji) can split a
 * pair in half, producing a lone low surrogate that renders as a broken
 * glyph. Never widens by more than one unit, so it stays a cheap O(1) check,
 * not a full code-point scan.
 */
function safeTailSlice(s: string, n: number): string {
  const start = s.length - n;
  if (start <= 0) {
    return s;
  }
  return isLowSurrogate(s.charCodeAt(start)) ? s.slice(start - 1) : s.slice(start);
}

// Perf bound (codex finding): a live, user-collapsed reasoning block re-runs
// this whole line-split/regex pipeline on the FULL accumulated stream every
// render. Only the last TAIL_PREVIEW_LOOKBACK_LINES lines / TAIL_PREVIEW_CAP
// chars can ever surface in the output, so the raw input is truncated to a
// generous multiple of that up front — comfortably more than any real case
// needs, so the sanitized result is unchanged, but the per-render cost
// becomes O(cap) instead of O(accumulated stream length).
const PIPELINE_INPUT_CAP = 2000;

/**
 * Plain-text tail: walks backward from the last raw line, joining lines only
 * while each is empty after stripping (an orphaned marker/token line) so the
 * normal one-meaningful-last-line case (the pre-existing behavior) is
 * unchanged, while a trailing marker-only line recovers the real content
 * above it. Bounded to the last `TAIL_PREVIEW_LOOKBACK_LINES` raw lines —
 * the preview never needs more context than that.
 */
function tailPlainText(text: string): string {
  const bounded = text.length > PIPELINE_INPUT_CAP ? safeTailSlice(text, PIPELINE_INPUT_CAP) : text;
  const rawLines = bounded.trimEnd().split("\n");
  const collected: string[] = [];
  const start = rawLines.length - 1;
  const floor = Math.max(0, rawLines.length - TAIL_PREVIEW_LOOKBACK_LINES);
  for (let i = start; i >= floor; i -= 1) {
    const cleaned = collapseWhitespace(stripMarkdownLine(rawLines[i] ?? ""));
    collected.unshift(cleaned);
    if (cleaned.length > 0) {
      break;
    }
  }
  return collapseWhitespace(collected.join(" "));
}

/**
 * Drops a trailing dangling token/punctuation mark left by a mid-stream cut:
 * a short (<=2 char) last token that STARTS with an unclosed opening
 * delimiter (an orphaned quote/bracket/backtick with nothing to pair it) is
 * dropped whole back to the previous word boundary; a string that itself
 * ENDS in a bare dangling punctuation mark has just that trailing mark

 * `Second`, the screenshot case).
 */
function sweepTrailingOrphan(input: string): string {
  const openerClass = /[`"'«([{\\]/;
  const trailingPunctClass = /[`"'«([{\\\-:,]$/;
  let s = input;
  for (;;) {
    if (s.length === 0) {
      return s;
    }
    const lastSpace = s.lastIndexOf(" ");
    const lastToken = lastSpace === -1 ? s : s.slice(lastSpace + 1);
    if (lastToken.length > 0 && lastToken.length <= 2 && openerClass.test(lastToken[0] ?? "")) {
      s = lastSpace === -1 ? "" : s.slice(0, lastSpace);
      continue;
    }
    if (trailingPunctClass.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

/**
 * Sanitized, deterministic, total live-tail preview — exported pure for unit
 * tests. Output is plain text (no `` ` `` `*` `#` `[`), no leading/trailing
 * whitespace, and carries a `…` prefix iff the tail was cut by the cap.
 */
export function reasoningTailPreview(text: string): string {
  const plain = tailPlainText(text);
  if (plain.length === 0) {
    return "";
  }

  let candidate = plain;
  let ellipsis = false;
  if (candidate.length > TAIL_PREVIEW_CAP) {
    const kept = safeTailSlice(candidate, TAIL_PREVIEW_CAP);
    const firstSpace = kept.indexOf(" ");
    // No whitespace inside the kept window (one giant unbroken token): fall
    // back to the plain tail slice rather than dropping the whole thing.
    candidate = firstSpace === -1 ? kept : kept.slice(firstSpace + 1);
    ellipsis = true;
  }

  const swept = sweepTrailingOrphan(candidate);
  if (swept.length === 0) {
    return "";
  }
  return ellipsis ? `…${swept}` : swept;
}

/**
 * Write/Edit diff view (design /working-docs/build/design/phase-mvp.md §5):
 * renders the hunks from diff/compute.ts, with syntax highlighting from
 * diff/highlight.ts layered on top (before/after are each tokenized once;
 * this component slices the resulting per-line token arrays by the hunk
 * lines' oldLine/newLine). Standalone component with a narrow props
 * contract — ToolCallCard's `.tool-call-diff-slot` mount point wires this in
 * during MVP.6, not here (design: this task builds the component, not the
 * integration).
 */
import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ToolCallSnapshot } from "../store.js";
import { computeDiff, type DiffHunk, type DiffLine } from "../diff/compute.js";
import { highlightSource, type DiffTheme, type HighlightedLine } from "../diff/highlight.js";
import { useResolvedTheme } from "../theme.js";
import { Check, Chevron, Copy } from "./icons.js";

export interface DiffViewProps {
  before: ToolCallSnapshot | null;
  after: ToolCallSnapshot | null;
  /** Workspace-relative (or absolute) file path — drives language detection by extension (diff/highlight.ts) and is shown in the header. */
  path: string;
}

interface HighlightedSides {
  before: HighlightedLine[];
  after: HighlightedLine[];
}

/** vscode-textmate fontStyle bit flags (Shiki tokens carry them as-is): 1=italic, 2=bold, 4=underline. */
function fontStyleToCss(fontStyle: number | undefined): CSSProperties {
  if (!fontStyle) {
    return {};
  }
  const style: CSSProperties = {};
  if (fontStyle & 1) {
    style.fontStyle = "italic";
  }
  if (fontStyle & 2) {
    style.fontWeight = "bold";
  }
  if (fontStyle & 4) {
    style.textDecoration = "underline";
  }
  return style;
}

function tokensForLine(line: DiffLine, highlighted: HighlightedSides | null): HighlightedLine | null {
  if (!highlighted) {
    return null;
  }
  // Deletions only ever exist in "before"; additions and context lines both
  // have a valid position in "after" (context lines are identical text on
  // both sides, so either array would do — "after" is picked arbitrarily).
  if (line.kind === "del") {
    return line.oldLine !== null ? (highlighted.before[line.oldLine - 1] ?? null) : null;
  }
  return line.newLine !== null ? (highlighted.after[line.newLine - 1] ?? null) : null;
}

function DiffLineRow({ line, highlighted }: { line: DiffLine; highlighted: HighlightedSides | null }) {
  const tokens = tokensForLine(line, highlighted);
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  return (
    <div className={`diff-line diff-line-${line.kind}`}>
      <span className="diff-line-gutter">{line.oldLine ?? ""}</span>
      <span className="diff-line-gutter">{line.newLine ?? ""}</span>
      <span className="diff-line-marker">{marker}</span>
      <span className="diff-line-text">
        {tokens
          ? tokens.map((token, index) => (
              <span key={index} style={{ color: token.color, ...fontStyleToCss(token.fontStyle) }}>
                {token.content}
              </span>
            ))
          : line.text}
      </span>
    </div>
  );
}

/** Header stat-chip counts (R13(a)). hunk.oldLines/newLines are SPANS
 * (context lines included) and must never be used here — count the
 * already-parsed DiffLine.kind instead. */
export interface DiffStats {
  added: number;
  removed: number;
}

/** Single pass over every line of every hunk; kind === "add" -> added++,
 * kind === "del" -> removed++ ("del", not "remove" — compute.ts's DiffLineKind). */
export function diffStats(hunks: readonly DiffHunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        added += 1;
      } else if (line.kind === "del") {
        removed += 1;
      }
    }
  }
  return { added, removed };
}

/** Roadmap R13(b): a diff past this many changed (added+removed) lines
 * default-collapses behind the header; a user's own toggle always wins. */
export const DIFF_COLLAPSE_THRESHOLD = 200;

/** Strict >: exactly DIFF_COLLAPSE_THRESHOLD changed lines still renders open. */
export function defaultDiffCollapsed(stats: DiffStats): boolean {
  return stats.added + stats.removed > DIFF_COLLAPSE_THRESHOLD;
}

/** Unchanged lines elided between two consecutive hunks (R13(d')). Arithmetic
 * over already-parsed hunk headers, not diff math: every line between two
 * hunks is unchanged by construction, so the old-side gap equals the
 * new-side gap computed here. */
export function hunkGap(prev: DiffHunk, next: DiffHunk): number {
  return next.newStart - (prev.newStart + prev.newLines);
}

/** "40 unchanged lines" / "1 unchanged line" — plain text; the "⋯" glyph is a
 * separate aria-hidden presentation span added by the caller, not part of
 * this label. */
export function unchangedGapLabel(hidden: number): string {
  return `${hidden} unchanged line${hidden === 1 ? "" : "s"}`;
}

/** Local private copy of components/Markdown.tsx's `tryClipboardWrite` (not
 * exported there — importing a component into a component to reuse an
 * 8-line helper would be the wrong direction of coupling). Swallows clipboard
 * rejection; no error theater for a clipboard edge. */
function tryClipboardWrite(text: string, onSuccess: () => void): void {
  const write = navigator.clipboard?.writeText(text);
  if (!write) {
    return;
  }
  void write.then(onSuccess).catch(() => {});
}

export function DiffView({ before, after, path }: DiffViewProps) {
  const result = computeDiff(before, after);
  const [highlighted, setHighlighted] = useState<HighlightedSides | null>(null);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [foldedHunks, setFoldedHunks] = useState<ReadonlySet<number>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R17 a11y: base ids binding the whole-diff toggle → hunks region and each
  // hunk header → its lines region (per-hunk id = `${hunkBaseId}-${index}`).
  const hunksId = useId();
  const hunkBaseId = useId();

  // Resolved concrete theme (design §2.5) drives Shiki's theme choice —
  // `highlightSource`'s 3rd param already existed but was never wired up
  // until UI-6. Included in the effect's deps so a live theme flip
  // (Settings → Light/Dark, or an OS `prefers-color-scheme` change while on
  // "system") re-highlights already-tokenized diffs instead of leaving them
  // stuck on the theme that was resolved when the diff first rendered.
  const resolvedTheme = useResolvedTheme();
  const diffTheme: DiffTheme = resolvedTheme === "light" ? "github-light" : "github-dark";

  // Highlighting only makes sense once both snapshots have resolved to real
  // (non-null, non-oversize) content — `result.status === "ready"` already
  // guarantees before/after are non-null strings, so the casts below just
  // recover that narrowing for the effect's dependency array.
  const shouldHighlight = result.status === "ready" && !result.tooLargeForHighlight;
  const beforeContent = shouldHighlight ? (before as ToolCallSnapshot).content : null;
  const afterContent = shouldHighlight ? (after as ToolCallSnapshot).content : null;

  useEffect(() => {
    if (!shouldHighlight || beforeContent === null || afterContent === null) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      highlightSource(beforeContent, path, diffTheme),
      highlightSource(afterContent, path, diffTheme),
    ]).then(([beforeResult, afterResult]) => {
      if (!cancelled) {
        setHighlighted({ before: beforeResult.lines, after: afterResult.lines });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [shouldHighlight, beforeContent, afterContent, path, diffTheme]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  if (result.status === "pending") {
    return <div className="diff-view diff-view-placeholder">Waiting for file snapshot…</div>;
  }
  if (result.status === "unavailable") {
    return <div className="diff-view diff-view-placeholder">File too large to read — diff unavailable.</div>;
  }
  if (result.status === "empty") {
    return <div className="diff-view diff-view-placeholder">No changes.</div>;
  }

  const stats = diffStats(result.hunks);
  const expanded = userExpanded ?? !defaultDiffCollapsed(stats);
  // Independent of the highlight gate (unlike `afterContent` above, which is
  // nulled when tooLargeForHighlight) — Copy must work on huge diffs too.
  const copySource = after?.content ?? null;

  const toggleHunk = (index: number) => {
    setFoldedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const onCopy = () => {
    if (copySource === null) {
      return;
    }
    tryClipboardWrite(copySource, () => {
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="diff-view">
      <div className="diff-view-header">
        <button
          type="button"
          className="diff-view-toggle"
          aria-expanded={expanded}
          aria-controls={hunksId}
          onClick={() => setUserExpanded(!expanded)}
        >
          <span className="tool-call-caret" aria-hidden="true">
            <Chevron />
          </span>
          <span className="diff-view-path">{path}</span>
        </button>
        <span className="diff-view-stats">
          {stats.added > 0 && <span className="diff-stat diff-stat-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="diff-stat diff-stat-del">−{stats.removed}</span>}
        </span>
        {result.isNewFile && <span className="diff-view-badge">New file</span>}
        {result.tooLargeForHighlight && (
          <span className="diff-view-badge diff-view-badge-warning">Large diff — highlighting disabled</span>
        )}
        <button
          type="button"
          className="diff-view-copy"
          data-copied={copied}
          aria-label="Copy file contents"
          onClick={onCopy}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
      {expanded && (
        <div id={hunksId} className={`diff-view-hunks${userExpanded === true ? " disclosure-open" : ""}`}>
          {result.hunks.map((hunk, hunkIndex) => {
            const folded = foldedHunks.has(hunkIndex);
            const prevHunk = hunkIndex > 0 ? result.hunks[hunkIndex - 1] : undefined;
            const gap = prevHunk ? hunkGap(prevHunk, hunk) : 0;
            const hunkLinesId = `${hunkBaseId}-${hunkIndex}`;
            return (
              <Fragment key={hunkIndex}>
                {gap > 0 && (
                  <div className="diff-hunk-gap">
                    <span aria-hidden="true">⋯ </span>
                    {unchangedGapLabel(gap)}
                  </div>
                )}
                <div className="diff-hunk">
                  <button
                    type="button"
                    className="diff-hunk-header"
                    aria-expanded={!folded}
                    aria-controls={hunkLinesId}
                    onClick={() => toggleHunk(hunkIndex)}
                  >
                    <span className="tool-call-caret" aria-hidden="true">
                      <Chevron />
                    </span>
                    @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                  </button>
                  {!folded && (
                    <div id={hunkLinesId} className="diff-hunk-lines">
                      {hunk.lines.map((line, lineIndex) => (
                        <DiffLineRow key={lineIndex} line={line} highlighted={highlighted} />
                      ))}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

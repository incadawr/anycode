/**
 * Pure diff computation for Write/Edit tool-call snapshots (design
 * /working-docs/build/design/phase-mvp.md §5): turns a before/after pair of
 * file snapshots into unified-diff hunks ready for rendering. Deliberately
 * has zero dependency on React, Shiki, or the zustand store — highlighting
 * (diff/highlight.ts) is a separate concern layered on top by DiffView, and
 * keeping this module pure/side-effect-free is what makes it trivially
 * unit-testable (design §10).
 *
 * Line-numbering convention: jsdiff's own `structuredPatch` treats a single
 * trailing "\n" as *terminating* the last line rather than starting a new
 * (empty) one — e.g. "a\nb\n" is 2 lines, not 3 (verified empirically against
 * the installed `diff@9` package: `structuredPatch` on that content reports
 * oldLines: 2). `oldLine`/`newLine` below follow that same convention, which
 * matters because diff/highlight.ts's per-line token arrays must be indexed
 * the same way for DiffView to line them up correctly.
 */
import { structuredPatch } from "diff";

/**
 * Structurally identical to store.ts's `ToolCallSnapshot` (content/truncated
 * shape), duck-typed here rather than imported so this module stays
 * independent of the store — callers (DiffView) can pass a
 * `ToolCallSnapshot` straight through with no adapter.
 */
export interface DiffSnapshot {
  content: string | null;
  truncated: boolean;
}

/** Diff/highlight size caps (design §5): past either threshold the diff still
 * renders, but as a flat/unhighlighted view rather than paying for full
 * tokenization of a huge file. */
export const DIFF_MAX_BYTES = 200_000;
export const DIFF_MAX_LINES = 5000;

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the "before" content; null for pure additions. */
  oldLine: number | null;
  /** 1-based line number in the "after" content; null for pure deletions. */
  newLine: number | null;
  /** Line text with the leading unified-diff " "/"+"/"-" marker stripped. */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffResult =
  /** One (or both) of before/after hasn't arrived from the host yet (design §5: file_snapshot is a separate channel from tool_call). */
  | { status: "pending" }
  /** A snapshot arrived but its content is null — unreadable or over the host-side SNAPSHOT_MAX_BYTES cap (design §5). */
  | { status: "unavailable" }
  /** Both snapshots resolved with byte-identical content — nothing to show. */
  | { status: "empty" }
  | {
      status: "ready";
      hunks: DiffHunk[];
      /** True when `before` was empty (Write creating a new file, per the host-side snapshot hook's `content:""` convention, design §5). */
      isNewFile: boolean;
      /** True when either side exceeds DIFF_MAX_BYTES/DIFF_MAX_LINES — DiffView must render these hunks without calling into diff/highlight.ts. */
      tooLargeForHighlight: boolean;
    };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** jsdiff-convention line count: a trailing "\n" terminates the last line rather than starting a phantom empty one (see module docstring). */
function lineCount(text: string): number {
  if (text === "") {
    return 0;
  }
  const parts = text.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function exceedsCap(text: string): boolean {
  return byteLength(text) > DIFF_MAX_BYTES || lineCount(text) > DIFF_MAX_LINES;
}

function toDiffLines(hunk: { oldStart: number; newStart: number; lines: string[] }): DiffLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((raw): DiffLine => {
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    if (marker === "+") {
      const line: DiffLine = { kind: "add", oldLine: null, newLine, text };
      newLine += 1;
      return line;
    }
    if (marker === "-") {
      const line: DiffLine = { kind: "del", oldLine, newLine: null, text };
      oldLine += 1;
      return line;
    }
    const line: DiffLine = { kind: "context", oldLine, newLine, text };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

/**
 * Computes the diff between a Write/Edit tool call's before/after file
 * snapshots. Branch order mirrors design §5's enumeration: missing snapshot
 * -> unavailable content -> identical content -> real hunks (flagging new
 * file / oversize as needed).
 */
export function computeDiff(before: DiffSnapshot | null, after: DiffSnapshot | null): DiffResult {
  if (before === null || after === null) {
    return { status: "pending" };
  }
  if (before.content === null || after.content === null) {
    return { status: "unavailable" };
  }
  if (before.content === after.content) {
    return { status: "empty" };
  }

  const patch = structuredPatch("before", "after", before.content, after.content);
  if (patch.hunks.length === 0) {
    // Byte-different strings can still produce zero line-level hunks in
    // degenerate cases (e.g. differing only in a final newline); treat the
    // same as "nothing to show" rather than rendering an empty hunk list.
    return { status: "empty" };
  }

  return {
    status: "ready",
    hunks: patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: toDiffLines(hunk),
    })),
    isNewFile: before.content === "",
    tooLargeForHighlight: exceedsCap(before.content) || exceedsCap(after.content),
  };
}

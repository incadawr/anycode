/**
 * Pure parser for `git diff`-style unified-diff text (design
 * /working-docs/build/design/slice-5.8-cut.md §2.6). Turns the raw text a
 * `git diff` wire message carries (GitDiffState.text) into per-file hunks
 * using the SAME `DiffHunk`/`DiffLine` shapes diff/compute.ts already
 * established for the Write/Edit tool-call diff view (line-numbering
 * convention included — see compute.ts's `toDiffLines`), so GitDiffPane can
 * reuse DiffView's rendering language for free instead of inventing a second
 * line-numbering scheme.
 *
 * Deliberately dependency-free and side-effect-free, and — unlike
 * `structuredPatch` in compute.ts, which is fed two known-good strings this
 * module parses text that arrived over the wire and can legitimately be
 * malformed: cut mid-line by the CONCERN-1 truncation cap (GitDiffState.
 * truncated — see trimTruncatedTail below), or simply contain a git-output
 * shape this parser doesn't recognize. Every branch below is fail-safe:
 * unrecognized lines are skipped rather than throwing.
 */
import type { DiffHunk, DiffLine } from "./compute.js";

/** One file's worth of a unified diff (design §2.6). `binary: true` files
 * carry no hunks — git's "Binary files … differ" line replaces hunk content
 * entirely, there is nothing line-oriented to parse. */
export interface GitFileDiff {
  oldPath: string;
  newPath: string;
  /** Present only for a `rename from`/`rename to` pair; equals the pre-rename path. */
  renamedFrom?: string;
  binary: boolean;
  hunks: DiffHunk[];
}

const DIFF_GIT_PREFIX = "diff --git ";
// Trailing context after the closing "@@" (e.g. "@@ -1,3 +1,3 @@ function foo() {")
// is intentionally unanchored/unmatched — git emits it, and hunk parsing doesn't need it.
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const OLD_HEADER_RE = /^--- (.+)$/;
const NEW_HEADER_RE = /^\+\+\+ (.+)$/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;
const BINARY_RE = /^Binary files .+ differ$/;
// Lazy old-path capture so a " b/" occurring inside a path with spaces still
// prefers splitting at the LAST plausible " b/" marker; best-effort only —
// the authoritative paths come from the "---"/"+++"/rename lines below when
// present, this is purely the binary/rename-only fallback.
const DIFF_GIT_HEADER_RE = /^diff --git a\/(.*?) b\/(.*)$/;

interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = HUNK_HEADER_RE.exec(line);
  if (match === null) {
    return null;
  }
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] !== undefined ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] !== undefined ? Number(match[4]) : 1,
  };
}

/** Strips a unified-diff "a/"/"b/" path prefix; "/dev/null" (added/deleted
 * file marker) is left untouched since it carries no such prefix. */
function normalizeDiffPath(raw: string, prefix: "a/" | "b/"): string {
  if (raw === "/dev/null") {
    return raw;
  }
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function parseFileSection(sectionLines: string[]): GitFileDiff {
  const headerMatch = DIFF_GIT_HEADER_RE.exec(sectionLines[0] ?? "");
  let oldPath = headerMatch ? (headerMatch[1] ?? "") : "";
  let newPath = headerMatch ? (headerMatch[2] ?? "") : "";
  let renamedFrom: string | undefined;
  let binary = false;
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of sectionLines.slice(1)) {
    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader !== null) {
      currentHunk = { ...hunkHeader, lines: [] };
      oldLine = hunkHeader.oldStart;
      newLine = hunkHeader.newStart;
      hunks.push(currentHunk);
      continue;
    }

    if (currentHunk === null) {
      // Still in the per-file header block (index/mode/similarity lines are
      // deliberately unmatched below and fall through to the skip case).
      const oldPathMatch = OLD_HEADER_RE.exec(line);
      if (oldPathMatch) {
        oldPath = normalizeDiffPath(oldPathMatch[1] ?? "", "a/");
        continue;
      }
      const newPathMatch = NEW_HEADER_RE.exec(line);
      if (newPathMatch) {
        newPath = normalizeDiffPath(newPathMatch[1] ?? "", "b/");
        continue;
      }
      const renameFromMatch = RENAME_FROM_RE.exec(line);
      if (renameFromMatch) {
        renamedFrom = renameFromMatch[1] ?? "";
        oldPath = renameFromMatch[1] ?? "";
        continue;
      }
      const renameToMatch = RENAME_TO_RE.exec(line);
      if (renameToMatch) {
        newPath = renameToMatch[1] ?? "";
        continue;
      }
      if (BINARY_RE.test(line)) {
        binary = true;
        continue;
      }
      continue; // unrecognized header line — skip fail-safe
    }

    // Inside a hunk body.
    if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file" — swallowed per design §2.6
    }
    const marker = line.charAt(0);
    if (marker === "+") {
      currentHunk.lines.push({ kind: "add", oldLine: null, newLine, text: line.slice(1) });
      newLine += 1;
    } else if (marker === "-") {
      currentHunk.lines.push({ kind: "del", oldLine, newLine: null, text: line.slice(1) });
      oldLine += 1;
    } else if (marker === " ") {
      currentHunk.lines.push({ kind: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // Any other marker is garbage inside a hunk body — skipped fail-safe,
    // counters left untouched.
  }

  return {
    oldPath,
    newPath,
    ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    binary,
    hunks: binary ? [] : hunks,
  };
}

/**
 * Parses `git diff`-style unified-diff text into per-file hunks. Sections are
 * split at each `diff --git` line; text before the first such line (or all of
 * it, if there is no `diff --git` line at all — e.g. an empty diff) yields no
 * files. Never throws: malformed/truncated input degrades to best-effort
 * output rather than an exception.
 */
export function parseUnifiedDiff(text: string): GitFileDiff[] {
  const lines = text.split("\n");
  const sectionStarts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      sectionStarts.push(index);
    }
  });

  return sectionStarts.map((start, i) => {
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : lines.length;
    return parseFileSection(lines.slice(start, end));
  });
}

/**
 * Drops an incomplete trailing line from wire diff text — call ONLY when
 * `GitDiffState.truncated` is true (CONCERN-1: the adapter/wire cap can cut
 * raw git output mid-line). A text that already ends with "\n" has no partial
 * final line and is returned unchanged; text with no "\n" at all is a single
 * partial line and is dropped entirely.
 */
export function trimTruncatedTail(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    return "";
  }
  return text.slice(0, lastNewline + 1);
}

/**
 * Shared match-range highlighter (slice-R9-cut ruling 3 — extracted verbatim
 * from CommandPalette's private copy): splits `text` into plain and <mark>
 * segments from fuzzyMatch's merged, ascending, half-open ranges. Empty
 * ranges → the plain string unchanged. Each consuming surface styles its own
 * `mark` (both current consumers use the `--accent-soft` chip). Returns JSX,
 * so it lives beside the components and is exercised by the visual harness,
 * not node unit tests.
 */
import type { ReactNode } from "react";
import type { MatchRange } from "../fuzzy.js";

export function highlight(text: string, ranges: readonly MatchRange[]): ReactNode {
  if (ranges.length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

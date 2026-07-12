/**
 * Fuzzy subsequence scorer (ui-roadmap §4-R5, ruling C). Pure, case-insensitive,
 * integer-scored. Lives in its own module (not keymap.ts) because R9 reuses it
 * for the Sidebar search — search logic and the keymap table are unrelated
 * concepts and stay decoupled (frozen pure-export law: one module, one job).
 *
 * The match is GREEDY left-to-right: each query char consumes the next matching
 * target char. Greedy can miss a later, better-scoring alignment; that
 * non-optimality is accepted and documented — targets are short labels
 * (≤ ~60 chars), row sets are dozens, and greedy is deterministic and
 * unit-testable in a few lines of head-math. There is no gap penalty;
 * tie-breaking between candidates is the consumer's comparator, not this
 * function's.
 */

/** Half-open [start, end) index ranges into the ORIGINAL target string, merged and ascending. */
export type MatchRange = readonly [number, number];

export interface FuzzyResult {
  score: number;
  ranges: readonly MatchRange[];
}

/** Word-boundary separators: a match right after one of these earns the boundary bonus. */
const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":"]);

/** True for a cased letter whose lower form differs from itself (i.e. it is uppercase). */
function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** True for a cased letter whose upper form differs from itself (i.e. it is lowercase). */
function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

/** Merges an ascending list of matched indices into half-open, non-overlapping ranges. */
function toRanges(indices: readonly number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const idx of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === idx) {
      ranges[ranges.length - 1] = [last[0], idx + 1];
    } else {
      ranges.push([idx, idx + 1]);
    }
  }
  return ranges;
}

/**
 * null = query is not a subsequence of target. Empty query matches everything:
 * `{ score: 0, ranges: [] }` (the palette's resting state lists all rows).
 *
 * Scoring, summed per matched query char:
 *  - base +1;
 *  - +3 word-boundary — match at index 0, previous target char is a separator,
 *    or a lower→UPPER camel step;
 *  - +2 start-of-target — additional, first query char matching index 0 only;
 *  - +2 contiguous — this match is at the previous match's index + 1.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) {
    return { score: 0, ranges: [] };
  }

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let score = 0;
  const matched: number[] = [];
  let cursor = 0;
  let prevMatchIndex = -1;

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi]!;
    while (cursor < t.length && t[cursor] !== qc) {
      cursor += 1;
    }
    if (cursor >= t.length) {
      return null;
    }

    const boundary =
      cursor === 0 ||
      SEPARATORS.has(target[cursor - 1]!) ||
      (isLower(target[cursor - 1]!) && isUpper(target[cursor]!));

    let charScore = 1;
    if (boundary) {
      charScore += 3;
    }
    if (qi === 0 && cursor === 0) {
      charScore += 2;
    }
    if (qi > 0 && cursor === prevMatchIndex + 1) {
      charScore += 2;
    }

    score += charScore;
    matched.push(cursor);
    prevMatchIndex = cursor;
    cursor += 1;
  }

  return { score, ranges: toRanges(matched) };
}

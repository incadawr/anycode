/**
 * Pure-logic tests for DiffView's R13 diff-review-affordance helpers (design
 * /working-docs/ui-track/design/slice-R13-cut.md §6/§10). Same `.test.ts`-only
 * rationale as ToolCallCard.test.ts/PermissionModal.test.ts: no jsdom in this
 * package's vitest config, so the exported pure functions are covered
 * directly rather than through DOM rendering. Fixtures build literal
 * `DiffHunk`s by hand — `computeDiff`'s own behavior (jsdiff wiring, status
 * branches) is compute.test.ts's job, not this file's.
 */
import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLineKind } from "../diff/compute.js";
import {
  DIFF_COLLAPSE_THRESHOLD,
  defaultDiffCollapsed,
  diffStats,
  hunkGap,
  unchangedGapLabel,
} from "./DiffView.js";

/** Minimal DiffLine — diffStats only reads `.kind`, so oldLine/newLine/text
 * are filler. */
function line(kind: DiffLineKind) {
  return { kind, oldLine: null, newLine: null, text: "" };
}

/** Builds a literal DiffHunk from a header-span object plus a list of line
 * kinds — `spans` is deliberately allowed to disagree with `kinds.length` in
 * some fixtures below, to prove diffStats never reads oldLines/newLines. */
function hunkOf(
  spans: { oldStart: number; oldLines: number; newStart: number; newLines: number },
  kinds: DiffLineKind[],
): DiffHunk {
  return { ...spans, lines: kinds.map(line) };
}

describe("diffStats", () => {
  it("counts added/removed lines across multiple hunks, ignoring context — hunk spans lie and must not be used", () => {
    // 8 context + 2 add = 10 real lines, but oldLines/newLines claim 10/12.
    const hunk1 = hunkOf({ oldStart: 1, oldLines: 10, newStart: 1, newLines: 12 }, [
      "context",
      "context",
      "context",
      "context",
      "context",
      "context",
      "context",
      "context",
      "add",
      "add",
    ]);
    const hunk2 = hunkOf({ oldStart: 50, oldLines: 6, newStart: 52, newLines: 5 }, [
      "context",
      "context",
      "context",
      "del",
      "del",
      "add",
    ]);
    expect(diffStats([hunk1, hunk2])).toEqual({ added: 3, removed: 2 });
  });

  it("returns zero counts for an empty hunk list", () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });

  it("counts a del-only hunk (kind: \"del\", not \"remove\")", () => {
    const hunk = hunkOf({ oldStart: 5, oldLines: 3, newStart: 5, newLines: 0 }, ["del", "del", "del"]);
    expect(diffStats([hunk])).toEqual({ added: 0, removed: 3 });
  });
});

describe("defaultDiffCollapsed", () => {
  it("pins DIFF_COLLAPSE_THRESHOLD at 200", () => {
    expect(DIFF_COLLAPSE_THRESHOLD).toBe(200);
  });

  it("stays open at exactly the threshold (200 changed lines)", () => {
    expect(defaultDiffCollapsed({ added: 100, removed: 100 })).toBe(false);
  });

  it("collapses one line past the threshold (201 changed lines)", () => {
    expect(defaultDiffCollapsed({ added: 100, removed: 101 })).toBe(true);
  });

  it("stays open for a zero-change diff", () => {
    expect(defaultDiffCollapsed({ added: 0, removed: 0 })).toBe(false);
  });
});

describe("hunkGap", () => {
  it("computes the elided run length from consecutive hunk headers (probe-derived pairs)", () => {
    const prev = hunkOf({ oldStart: 2, oldLines: 9, newStart: 2, newLines: 9 }, []);
    expect(hunkGap(prev, hunkOf({ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1 }, []))).toBe(1);
    expect(hunkGap(prev, hunkOf({ oldStart: 43, oldLines: 1, newStart: 43, newLines: 1 }, []))).toBe(32);
  });

  it("returns 0 for touching hunks (no elided lines between them)", () => {
    const prev = hunkOf({ oldStart: 2, oldLines: 9, newStart: 2, newLines: 9 }, []);
    const next = hunkOf({ oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 }, []);
    expect(hunkGap(prev, next)).toBe(0);
  });

  it("agrees with the old-side gap when old/new starts diverge (net line delta earlier in the file)", () => {
    // prev spans old [10,15), new [14,19) — a net +4 lines added before this hunk.
    const prev = hunkOf({ oldStart: 10, oldLines: 5, newStart: 14, newLines: 5 }, []);
    const next = hunkOf({ oldStart: 20, oldLines: 1, newStart: 24, newLines: 1 }, []);
    const newSideGap = hunkGap(prev, next);
    const oldSideGap = next.oldStart - (prev.oldStart + prev.oldLines);
    expect(newSideGap).toBe(5);
    expect(newSideGap).toBe(oldSideGap);
  });
});

describe("unchangedGapLabel", () => {
  it("singularizes at 1", () => {
    expect(unchangedGapLabel(1)).toBe("1 unchanged line");
  });

  it("pluralizes above 1", () => {
    expect(unchangedGapLabel(32)).toBe("32 unchanged lines");
  });

  it("never includes the presentation glyph — that's added by the caller", () => {
    expect(unchangedGapLabel(1)).not.toContain("⋯");
    expect(unchangedGapLabel(32)).not.toContain("⋯");
  });
});

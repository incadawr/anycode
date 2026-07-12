/**
 * Pure logic tests for diff/compute.ts (design §10's MVP.5 test plan):
 * before/after -> hunks, new file, empty diff, content:null unavailable, and
 * the size-cap fallback flag. No React/DOM — this module has none.
 */
import { describe, expect, it } from "vitest";
import { computeDiff, DIFF_MAX_BYTES, DIFF_MAX_LINES, type DiffSnapshot } from "./compute.js";

function snap(content: string | null, truncated = false): DiffSnapshot {
  return { content, truncated };
}

describe("computeDiff", () => {
  it("returns pending when either snapshot hasn't arrived yet", () => {
    expect(computeDiff(null, snap("a"))).toEqual({ status: "pending" });
    expect(computeDiff(snap("a"), null)).toEqual({ status: "pending" });
    expect(computeDiff(null, null)).toEqual({ status: "pending" });
  });

  it("returns unavailable when a resolved snapshot's content is null (too large/unreadable at the source)", () => {
    expect(computeDiff(snap(null, true), snap("after"))).toEqual({ status: "unavailable" });
    expect(computeDiff(snap("before"), snap(null, true))).toEqual({ status: "unavailable" });
  });

  it("returns empty for byte-identical before/after content", () => {
    expect(computeDiff(snap("same\ncontent\n"), snap("same\ncontent\n"))).toEqual({ status: "empty" });
    expect(computeDiff(snap(""), snap(""))).toEqual({ status: "empty" });
  });

  it("computes hunks for a simple edit, with correct old/new line numbers", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nlineTWO\nline3\nline4\n";
    const result = computeDiff(snap(before), snap(after));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.isNewFile).toBe(false);
    expect(result.tooLargeForHighlight).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(result.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "line1" },
      { kind: "del", oldLine: 2, newLine: null, text: "line2" },
      { kind: "add", oldLine: null, newLine: 2, text: "lineTWO" },
      { kind: "context", oldLine: 3, newLine: 3, text: "line3" },
      { kind: "add", oldLine: null, newLine: 4, text: "line4" },
    ]);
  });

  it("flags isNewFile when before is empty (Write creating a new file, per the snapshot hook's content:'' convention)", () => {
    const result = computeDiff(snap(""), snap("hello\nworld\n"));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.isNewFile).toBe(true);
    expect(result.hunks[0]?.lines.every((line) => line.kind === "add")).toBe(true);
  });

  it("flags tooLargeForHighlight when either side exceeds the byte cap", () => {
    const huge = "x".repeat(DIFF_MAX_BYTES + 1);
    const result = computeDiff(snap("small"), snap(huge));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.tooLargeForHighlight).toBe(true);
  });

  it("flags tooLargeForHighlight when either side exceeds the line-count cap", () => {
    const manyLines = "line\n".repeat(DIFF_MAX_LINES + 1);
    const result = computeDiff(snap("line\n"), snap(manyLines));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.tooLargeForHighlight).toBe(true);
  });

  it("does not flag tooLargeForHighlight for ordinary small diffs", () => {
    const result = computeDiff(snap("a\n"), snap("b\n"));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.tooLargeForHighlight).toBe(false);
  });
});

/**
 * Pure-logic tests for the fuzzy scorer (ui-roadmap §4-R5, ruling C). node env,
 * no React/DOM. Covers subsequence matching, the four scoring bonuses (via the
 * worked "ns" anchors), range merging, and the ranges invariant.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatch, type MatchRange } from "./fuzzy.js";

/** Asserts a match exists and returns it (narrows away the null branch). */
function match(query: string, target: string) {
  const result = fuzzyMatch(query, target);
  expect(result).not.toBeNull();
  return result!;
}

describe("fuzzyMatch", () => {
  it("empty query matches everything with score 0 and no ranges", () => {
    expect(fuzzyMatch("", "New session")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch("", "")).toEqual({ score: 0, ranges: [] });
  });

  it("non-subsequence and over-length query → null", () => {
    expect(fuzzyMatch("xyz", "New session")).toBeNull();
    expect(fuzzyMatch("abcd", "abc")).toBeNull();
  });

  it("is case-insensitive and ranges index the original string", () => {
    const result = match("NS", "new session");
    // 'n'@0, 's'@4 (first 's' in "session")
    expect(result.ranges).toEqual([
      [0, 1],
      [4, 5],
    ]);
  });

  it("exact contiguous substring merges into one range with contiguous bonuses", () => {
    const result = match("term", "Show terminal");
    // 't'@5 = 1+3 (boundary after space); e/r/m each 1+2 contiguous → 13
    expect(result.score).toBe(13);
    expect(result.ranges).toEqual([[5, 9]]);
  });

  it("boundary-seeking beats a buried mid-word run (worked anchor)", () => {
    expect(match("ns", "New session").score).toBe(10);
    expect(match("ns", "instance").score).toBe(4);
    expect(match("ns", "New session").score).toBeGreaterThan(match("ns", "instance").score);
  });

  it("start-of-target bonus outranks a mid-string boundary match", () => {
    expect(match("se", "Settings").score).toBeGreaterThan(match("se", "New session").score);
  });

  it("camelCase humps both earn the boundary bonus", () => {
    const result = match("cp", "CommandPalette");
    // 'c'@0 = 1+3+2 (boundary + start), 'p'@7 = 1+3 (lower→UPPER camel step)
    expect(result.score).toBe(10);
    expect(result.ranges).toEqual([
      [0, 1],
      [7, 8],
    ]);
  });

  it("merges adjacent matched indices only", () => {
    expect(match("ac", "abc").ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(match("abc", "abc").ranges).toEqual([[0, 3]]);
  });

  it("literal spaces in the query match literal spaces", () => {
    const result = match("new s", "New session");
    expect(result.ranges).toEqual([[0, 5]]);
  });

  it("ranges are always in-bounds, ascending, and non-overlapping", () => {
    const inputs: Array<[string, string]> = [
      ["ns", "New session"],
      ["cp", "CommandPalette"],
      ["term", "Show terminal"],
      ["ac", "a-b-c"],
      ["settings", "Open settings"],
    ];
    for (const [query, target] of inputs) {
      const result = match(query, target);
      let prevEnd = 0;
      for (const [start, end] of result.ranges as MatchRange[]) {
        expect(start).toBeGreaterThanOrEqual(prevEnd);
        expect(start).toBeLessThan(end);
        expect(end).toBeLessThanOrEqual(target.length);
        prevEnd = end;
      }
    }
  });
});

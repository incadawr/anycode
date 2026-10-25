/**
 * semver-range tests (Taskana 4732 S1-A, design §2 engines.anycode): parse
 * tolerance (prerelease ignored, malformed → undefined), the comparator
 * grammar (>= > <= < =, ^, ~, space AND, || OR), empty range = any, and the
 * fail-closed "garbage → no match" ruling.
 */

import { describe, expect, it } from "vitest";
import {
  compareSemver,
  isValidSemver,
  normalizeSemverRange,
  parseSemver,
  rangeMatches,
} from "./semver-range.js";

describe("parseSemver / isValidSemver", () => {
  it.each([
    ["0.0.35", { major: 0, minor: 0, patch: 35 }],
    ["1.4.2", { major: 1, minor: 4, patch: 2 }],
    ["10.20.30", { major: 10, minor: 20, patch: 30 }],
  ])("parses %s", (input, expected) => {
    expect(parseSemver(input)).toEqual(expected);
  });

  it("ignores a prerelease suffix (design: prereleases ignored)", () => {
    expect(parseSemver("1.4.2-beta.1")).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(parseSemver("1.4.2+build.5")).toEqual({ major: 1, minor: 4, patch: 2 });
  });

  it.each(["", "  ", "1", "1.2", "v1.2.3", "1.2.x", "garbage", "1.2.3.4"])(
    "rejects %p",
    (input) => {
      expect(parseSemver(input)).toBeUndefined();
      expect(isValidSemver(input)).toBe(false);
    },
  );

  it("isValidSemver accepts plain and prerelease triples", () => {
    expect(isValidSemver("0.0.35")).toBe(true);
    expect(isValidSemver("1.0.0-rc.1")).toBe(true);
  });
});

describe("compareSemver", () => {
  it("compares numerically per segment", () => {
    expect(compareSemver("0.0.35", "0.0.36")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("prerelease compares equal to its release (ignored)", () => {
    expect(compareSemver("1.4.2-beta.1", "1.4.2")).toBe(0);
  });

  it("malformed inputs compare 0 (never throws)", () => {
    expect(compareSemver("garbage", "1.0.0")).toBe(0);
  });
});

describe("rangeMatches — empty and exact", () => {
  it("an empty range matches everything (engines.anycode absent = any)", () => {
    expect(rangeMatches("", "0.0.1")).toBe(true);
    expect(rangeMatches("   ", "99.99.99")).toBe(true);
  });

  it("'=' and bare versions are exact matches (prerelease-insensitive)", () => {
    expect(rangeMatches("=1.4.2", "1.4.2")).toBe(true);
    expect(rangeMatches("1.4.2", "1.4.2")).toBe(true);
    expect(rangeMatches("1.4.2", "1.4.3")).toBe(false);
    expect(rangeMatches("=1.4.2", "1.4.2-rc.1")).toBe(true);
  });
});

describe("rangeMatches — comparators, AND, OR", () => {
  it(">= > <= < behave numerically", () => {
    expect(rangeMatches(">=0.0.35", "0.0.35")).toBe(true);
    expect(rangeMatches(">=0.0.35", "0.0.34")).toBe(false);
    expect(rangeMatches(">1.0.0", "1.0.0")).toBe(false);
    expect(rangeMatches(">1.0.0", "1.0.1")).toBe(true);
    expect(rangeMatches("<0.2.0", "0.1.9")).toBe(true);
    expect(rangeMatches("<0.2.0", "0.2.0")).toBe(false);
    expect(rangeMatches("<=0.2.0", "0.2.0")).toBe(true);
  });

  it("space = AND", () => {
    expect(rangeMatches(">=0.0.35 <0.2.0", "0.1.0")).toBe(true);
    expect(rangeMatches(">=0.0.35 <0.2.0", "0.2.0")).toBe(false);
    expect(rangeMatches(">=0.0.35 <0.2.0", "0.0.34")).toBe(false);
  });

  it("|| = OR (first satisfied alternative wins)", () => {
    expect(rangeMatches("<0.0.30 || >=0.2.0", "0.0.29")).toBe(true);
    expect(rangeMatches("<0.0.30 || >=0.2.0", "0.2.5")).toBe(true);
    expect(rangeMatches("<0.0.30 || >=0.2.0", "0.1.0")).toBe(false);
  });

  it("numeric (not lexicographic) segment comparison", () => {
    expect(rangeMatches("<0.10.0", "0.9.0")).toBe(true);
    expect(rangeMatches("<0.10.0", "0.9.5")).toBe(true);
    expect(rangeMatches(">=1.2.0", "1.10.0")).toBe(true);
  });
});

describe("rangeMatches — ^ and ~ sugar", () => {
  it("^1.2.3 = >=1.2.3 <2.0.0", () => {
    expect(rangeMatches("^1.2.3", "1.2.3")).toBe(true);
    expect(rangeMatches("^1.2.3", "1.9.9")).toBe(true);
    expect(rangeMatches("^1.2.3", "2.0.0")).toBe(false);
    expect(rangeMatches("^1.2.3", "1.2.2")).toBe(false);
  });

  it("^0.1.3 locks the minor (npm 0.x rule)", () => {
    expect(rangeMatches("^0.1.3", "0.1.9")).toBe(true);
    expect(rangeMatches("^0.1.3", "0.2.0")).toBe(false);
  });

  it("^0.0.3 locks the patch", () => {
    expect(rangeMatches("^0.0.3", "0.0.3")).toBe(true);
    expect(rangeMatches("^0.0.3", "0.0.4")).toBe(false);
  });

  it("~1.2.3 = >=1.2.3 <1.3.0", () => {
    expect(rangeMatches("~1.2.3", "1.2.9")).toBe(true);
    expect(rangeMatches("~1.2.3", "1.3.0")).toBe(false);
    expect(rangeMatches("~0.0.35", "0.0.35")).toBe(true);
    expect(rangeMatches("~0.0.35", "0.1.0")).toBe(false);
  });
});

describe("rangeMatches — garbage never matches (fail closed)", () => {
  it.each(["garbage", ">=abc", ">= ", ">=1.2.3 <bad", "^x", "~", "1.2.3 && 2.0.0"])(
    "a malformed range %p matches nothing",
    (range) => {
      expect(rangeMatches(range, "1.0.0")).toBe(false);
    },
  );

  it("one malformed alternative poisons only itself", () => {
    // The first alternative is garbage, the second is satisfiable → match.
    expect(rangeMatches(">=bad || >=1.0.0", "1.5.0")).toBe(true);
    // A satisfiable alternative followed by garbage still matches.
    expect(rangeMatches(">=1.0.0 || garbage", "1.5.0")).toBe(true);
    expect(rangeMatches("garbage || also-bad", "1.0.0")).toBe(false);
  });

  it("a malformed VERSION never matches a non-empty range", () => {
    expect(rangeMatches(">=1.0.0", "not-a-version")).toBe(false);
  });

  it("never throws on pathological input", () => {
    expect(() => rangeMatches("||||||", "1.0.0")).not.toThrow();
    expect(rangeMatches("||||||", "1.0.0")).toBe(false);
  });
});

describe("normalizeSemverRange", () => {
  it("collapses whitespace for display in problem strings", () => {
    expect(normalizeSemverRange("  >=0.0.35   <0.2.0 ")).toBe(">=0.0.35 <0.2.0");
  });
});

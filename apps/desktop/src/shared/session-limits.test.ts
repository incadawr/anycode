import { describe, expect, it } from "vitest";
import {
  SESSION_LIMIT_RANGES,
  clampSessionLimit,
  readSessionLimits,
} from "./session-limits.js";

describe("clampSessionLimit", () => {
  const cases = [
    ["maxTabs", 4, 40],
    ["childSessionsPerParentMax", 1, 8],
    ["childSessionsGlobalMax", 1, 24],
  ] as const;

  for (const [kind, min, max] of cases) {
    describe(String(kind), () => {
      it("passes through a valid min", () => {
        expect(clampSessionLimit(kind, min)).toBe(min);
      });
      it("passes through a valid max", () => {
        expect(clampSessionLimit(kind, max)).toBe(max);
      });
      it("clamps below-min to min", () => {
        expect(clampSessionLimit(kind, min - 1)).toBe(min);
      });
      it("clamps above-max to max", () => {
        expect(clampSessionLimit(kind, max + 1)).toBe(max);
      });
      it("truncates an in-range fraction", () => {
        const inRange = Math.max(min, Math.min(max, 2.7));
        expect(clampSessionLimit(kind, inRange)).toBe(Math.trunc(inRange));
      });
      it("returns undefined for NaN / Infinity / string / null", () => {
        expect(clampSessionLimit(kind, Number.NaN)).toBeUndefined();
        expect(clampSessionLimit(kind, Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(clampSessionLimit(kind, Number.NEGATIVE_INFINITY)).toBeUndefined();
        expect(clampSessionLimit(kind, "7")).toBeUndefined();
        expect(clampSessionLimit(kind, null)).toBeUndefined();
      });
      it("returns undefined for absent", () => {
        expect(clampSessionLimit(kind, undefined)).toBeUndefined();
      });
    });
  }

  it("TASK.119 fraction example: maxTabs 7.9 -> 7", () => {
    expect(clampSessionLimit("maxTabs", 7.9)).toBe(7);
  });

  it("TASK.147 fraction example: child caps 2.7 -> 2", () => {
    expect(clampSessionLimit("childSessionsPerParentMax", 2.7)).toBe(2);
    expect(clampSessionLimit("childSessionsGlobalMax", 2.7)).toBe(2);
  });

  it("defaults are 20 / 3 / 8", () => {
    expect(SESSION_LIMIT_RANGES.maxTabs.default).toBe(20);
    expect(SESSION_LIMIT_RANGES.childSessionsPerParentMax.default).toBe(3);
    expect(SESSION_LIMIT_RANGES.childSessionsGlobalMax.default).toBe(8);
  });
});

describe("readSessionLimits", () => {
  it("round-trips a full valid object (clamped)", () => {
    expect(
      readSessionLimits({ maxTabs: 12, childSessionsPerParentMax: 2, childSessionsGlobalMax: 10 }),
    ).toEqual({ maxTabs: 12, childSessionsPerParentMax: 2, childSessionsGlobalMax: 10 });
  });

  it("clamps out-of-range values in a section", () => {
    expect(readSessionLimits({ maxTabs: 99, childSessionsPerParentMax: 0, childSessionsGlobalMax: 2 })).toEqual({
      maxTabs: 40,
      childSessionsPerParentMax: 1,
      childSessionsGlobalMax: 2,
    });
  });

  it("a garbage section (string) yields an all-undefined result and never throws", () => {
    expect(readSessionLimits("nope")).toEqual({});
  });

  it("an array section yields an all-undefined result and never throws", () => {
    expect(readSessionLimits([1, 2, 3])).toEqual({});
  });

  it("null/undefined yield an all-undefined result", () => {
    expect(readSessionLimits(null)).toEqual({});
    expect(readSessionLimits(undefined)).toEqual({});
  });

  it("extra keys are dropped", () => {
    expect(readSessionLimits({ maxTabs: 10, nope: 1, other: "x" })).toEqual({ maxTabs: 10 });
  });
});

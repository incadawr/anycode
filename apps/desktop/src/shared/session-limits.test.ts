import { describe, expect, it } from "vitest";
import {
  SESSION_LIMIT_RANGES,
  clampSessionLimit,
  readSessionLimits,
  resolveChildSessionsPerParentMax,
} from "./session-limits.js";
import { CHILD_RUNS_GLOBAL_MAX, CHILD_RUNS_PER_PARENT_MAX } from "./child-sessions.js";

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

/**
 * GitHub #17 slice B: ONE effective per-parent cap shared by
 * main and the host. The session setting is the base; an explicit selected
 * role profile's maxParallelChildren can only LOWER it. The old competing
 * role default of 4 must not resurface anywhere.
 */
describe("resolveChildSessionsPerParentMax", () => {
  it("per-parent default is three with no competing role default", () => {
    expect(resolveChildSessionsPerParentMax(undefined, undefined)).toBe(3);
    expect(resolveChildSessionsPerParentMax({}, undefined)).toBe(3);
    // Presence of a role profile WITHOUT an explicit value is not a value:
    // the old `?? 4` would have returned 4 here.
    expect(resolveChildSessionsPerParentMax({}, null)).toBe(3);
    expect(resolveChildSessionsPerParentMax({}, "4")).toBe(3);
  });

  it("an explicit role cap lowers the session cap and never raises it", () => {
    const cases = [
      [{ childSessionsPerParentMax: 6 }, 2, 2],
      [{ childSessionsPerParentMax: 6 }, undefined, 6],
      [{ childSessionsPerParentMax: 3 }, 8, 3],
      [{ childSessionsPerParentMax: 6 }, 6, 6],
    ] as const;
    for (const [limits, role, expected] of cases) {
      expect(resolveChildSessionsPerParentMax(limits, role)).toBe(expected);
    }
  });

  it("an invalid role value leaves the base untouched", () => {
    for (const role of [0, -1, 17, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveChildSessionsPerParentMax({ childSessionsPerParentMax: 5 }, role)).toBe(5);
    }
    expect(resolveChildSessionsPerParentMax(undefined, 0)).toBe(3);
  });

  it("the session setting is clamped like every other limit", () => {
    expect(resolveChildSessionsPerParentMax({ childSessionsPerParentMax: 0 }, undefined)).toBe(1);
    expect(resolveChildSessionsPerParentMax({ childSessionsPerParentMax: 99 }, undefined)).toBe(8);
    expect(resolveChildSessionsPerParentMax({ childSessionsPerParentMax: 2.7 }, undefined)).toBe(2);
    expect(resolveChildSessionsPerParentMax({ childSessionsPerParentMax: "6" }, undefined)).toBe(3);
    expect(resolveChildSessionsPerParentMax("nope", undefined)).toBe(3);
  });

  it("agrees with the admission constants main falls back to (3 / 8)", () => {
    expect(CHILD_RUNS_PER_PARENT_MAX).toBe(SESSION_LIMIT_RANGES.childSessionsPerParentMax.default);
    expect(CHILD_RUNS_GLOBAL_MAX).toBe(SESSION_LIMIT_RANGES.childSessionsGlobalMax.default);
    expect(CHILD_RUNS_PER_PARENT_MAX).toBe(3);
    expect(CHILD_RUNS_GLOBAL_MAX).toBe(8);
  });
});

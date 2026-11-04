import { describe, expect, it } from "vitest";
import { GLM_QUOTA_SOURCE, parseGlmQuota } from "./glm-quota-adapter.js";

describe("GLM coding-plan quota", () => {
  const now = 1_800_000_000_000;
  // Live shape (verified 04.11 via working-docs/tools/glm-quota/glm-quota.sh):
  // data.level + data.limits[]; CREDIT_LIMIT entries carry unit/number,
  // usage (limit), currentValue (used), percentage, nextResetTime (epoch ms).
  const entry = (fields: object) => ({ type: "CREDIT_LIMIT", ...fields });
  const response = (limits: object[]) => ({ data: { level: "pro", limits } });

  it("maps unit 3 to the 5-hour window and unit 6 to the week", () => {
    expect(
      parseGlmQuota(
        response([
          entry({ unit: 3, number: 5, usage: 12000, currentValue: 128, remaining: 11872, percentage: 1.07, nextResetTime: now + 60_000 }),
          entry({ unit: 6, number: 1, usage: 60000, currentValue: 47004, remaining: 12996, percentage: 78.3, nextResetTime: now + 120_000 }),
        ]),
        now,
      ),
    ).toEqual({
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: now / 1000 + 60 },
      secondary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: now / 1000 + 120 },
      primarySource: GLM_QUOTA_SOURCE,
      sources: [GLM_QUOTA_SOURCE],
    });
  });

  it("falls back to the currentValue/usage ratio when percentage is unusable", () => {
    expect(
      parseGlmQuota(response([entry({ unit: 3, number: 5, usage: 12000, currentValue: 6000, percentage: "x", nextResetTime: now + 60_000 })]), now)?.primary,
    ).toEqual({ usedPercent: 50, windowDurationMins: 300, resetsAt: now / 1000 + 60 });
  });

  it("drops a window with neither a usable percentage nor a usable ratio", () => {
    expect(parseGlmQuota(response([entry({ unit: 3, number: 5, usage: 0, currentValue: 0, percentage: null })]), now)).toBeNull();
  });

  it("omits implausible reset times (in the past or beyond the window)", () => {
    expect(
      parseGlmQuota(response([entry({ unit: 3, number: 5, usage: 12000, currentValue: 6000, percentage: 50, nextResetTime: now / 1000 })]), now)?.primary,
    ).toEqual({ usedPercent: 50, windowDurationMins: 300 });
    expect(
      parseGlmQuota(response([entry({ unit: 3, number: 5, usage: 12000, currentValue: 6000, percentage: 50, nextResetTime: now + 6 * 60 * 60_000 })]), now)?.primary,
    ).toEqual({ usedPercent: 50, windowDurationMins: 300 });
  });

  it("ignores unknown limit types and unknown units, never throwing on them", () => {
    const raw = response([
      { type: "TOKEN_LIMIT", unit: 2, number: 100, usage: 1000, currentValue: 10, percentage: 1 },
      entry({ unit: 9, number: 3, usage: 100, currentValue: 1, percentage: 1 }),
      "garbage",
      null,
    ]);
    expect(parseGlmQuota(raw, now)).toBeNull();
    const mixed = { data: { level: "pro", limits: [...(raw as typeof raw).data.limits, entry({ unit: 6, number: 1, usage: 60000, currentValue: 30000, percentage: 50 })] } };
    expect(parseGlmQuota(mixed, now)?.primary).toEqual({ usedPercent: 50, windowDurationMins: 10080 });
  });

  it("keeps the first entry when a window repeats", () => {
    expect(
      parseGlmQuota(
        response([
          entry({ unit: 3, number: 5, usage: 12000, currentValue: 1200, percentage: 10 }),
          entry({ unit: 3, number: 5, usage: 12000, currentValue: 2400, percentage: 20 }),
        ]),
        now,
      )?.primary,
    ).toEqual({ usedPercent: 10, windowDurationMins: 300 });
  });

  it("returns null for non-objects, missing data and missing limits", () => {
    for (const raw of [null, undefined, "x", 42, {}, { data: null }, { data: {} }, { data: { level: "pro" } }, { data: { limits: "no" } }]) {
      expect(parseGlmQuota(raw, now)).toBeNull();
    }
  });

  it("promotes the week to primary when the 5-hour window is absent", () => {
    expect(
      parseGlmQuota(response([entry({ unit: 6, number: 1, usage: 60000, currentValue: 30000, percentage: 50 })]), now),
    ).toEqual({ primary: { usedPercent: 50, windowDurationMins: 10080 }, primarySource: GLM_QUOTA_SOURCE, sources: [GLM_QUOTA_SOURCE] });
  });
});

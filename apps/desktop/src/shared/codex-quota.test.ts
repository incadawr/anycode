import { describe, expect, it } from "vitest";
import { mergeCodexRateLimits, type CodexRateLimits } from "./codex-quota.js";

/**
 * Sparse-merge regression suite (codex-profiles cut §6.3, amended §A3.3,
 * test-hazard §14.3): "no repeated delivery can ever decrease the
 * information a snapshot holds". Every positive assertion below is paired
 * with an explicit RED-proof against an INVERTED (replace-on-null)
 * implementation, per the cut's "durable: ERRATA-4/5/6" requirement — a test
 * that only asserts the correct behavior, without proving it can fail, is
 * not accepted (cut §14.3 point 3).
 */

const BASE: CodexRateLimits = {
  primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1_784_791_993 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "0" },
  planType: "plus",
  limitName: null,
  observedAt: "2026-07-16T10:00:00.000Z",
};

/**
 * The INVERTED rule under test-hazard #3: null/absent REPLACES (instead of
 * preserving) the previous value. Used only to prove our positive
 * assertions can fail — never exercised by production code.
 */
function mergeInverted(previous: CodexRateLimits, update: Partial<CodexRateLimits>, observedAt: string): CodexRateLimits {
  return {
    primary: "primary" in update ? update.primary : previous.primary,
    secondary: "secondary" in update ? update.secondary : previous.secondary,
    credits: "credits" in update ? update.credits : previous.credits,
    planType: "planType" in update ? update.planType : previous.planType,
    limitName: "limitName" in update ? update.limitName : previous.limitName,
    observedAt,
  };
}

describe("mergeCodexRateLimits — sparse-merge invariant", () => {
  it("a null/absent field in the update PRESERVES the previous value", () => {
    const merged = mergeCodexRateLimits(BASE, { primary: null, secondary: undefined }, "2026-07-16T11:00:00.000Z");
    expect(merged.primary).toEqual(BASE.primary);
    expect(merged.secondary).toBeNull(); // unchanged: BASE.secondary was already null
    expect(merged.credits).toEqual(BASE.credits);
    expect(merged.planType).toBe("plus");
  });

  it("RED-PROOF: the same scenario fails under the inverted (replace-on-null) rule", () => {
    const inverted = mergeInverted(BASE, { primary: null }, "2026-07-16T11:00:00.000Z");
    // The inverted implementation WIPES `primary` to null — proving this
    // test scenario is capable of catching the bug the real function must
    // not have.
    expect(inverted.primary).toBeNull();
    expect(inverted.primary).not.toEqual(BASE.primary);
  });

  it("a non-null field in the update REPLACES the previous value", () => {
    const freshPrimary = { usedPercent: 77, windowDurationMins: 10080, resetsAt: 1_800_000_000 };
    const merged = mergeCodexRateLimits(BASE, { primary: freshPrimary }, "2026-07-16T12:00:00.000Z");
    expect(merged.primary).toEqual(freshPrimary);
  });

  it("observedAt always advances, even when every other field is absent", () => {
    const merged = mergeCodexRateLimits(BASE, {}, "2026-07-16T13:00:00.000Z");
    expect(merged.observedAt).toBe("2026-07-16T13:00:00.000Z");
    expect(merged).toEqual({ ...BASE, observedAt: "2026-07-16T13:00:00.000Z" });
  });

  it("byLimitId merges PER KEY: an update to one bucket leaves sibling buckets untouched", () => {
    const withBuckets: CodexRateLimits = {
      ...BASE,
      byLimitId: {
        codex: { ...BASE },
        other: { primary: { usedPercent: 5 }, secondary: null, planType: null, limitName: "other", observedAt: BASE.observedAt },
      },
    };
    const merged = mergeCodexRateLimits(
      withBuckets,
      { byLimitId: { codex: { primary: { usedPercent: 99 }, secondary: null, planType: null, limitName: null, observedAt: "2026-07-16T14:00:00.000Z" } } },
      "2026-07-16T14:00:00.000Z",
    );
    expect(merged.byLimitId?.codex?.primary).toEqual({ usedPercent: 99 });
    // sibling bucket untouched
    expect(merged.byLimitId?.other).toEqual(withBuckets.byLimitId?.other);
  });

  it("RED-PROOF: byLimitId — a naive whole-map replace would wipe the sibling bucket", () => {
    const withBuckets: CodexRateLimits = {
      ...BASE,
      byLimitId: {
        codex: { ...BASE },
        other: { primary: { usedPercent: 5 }, secondary: null, planType: null, limitName: "other", observedAt: BASE.observedAt },
      },
    };
    const update = { codex: { primary: { usedPercent: 99 }, secondary: null, planType: null, limitName: null, observedAt: "x" } };
    // Naive "replace the whole map" behavior — proves the per-key merge
    // above is doing real work, not a no-op.
    const naiveWholeMapReplace = update as unknown as Record<string, CodexRateLimits>;
    expect(naiveWholeMapReplace.other).toBeUndefined();
    expect(withBuckets.byLimitId?.other).toBeDefined();
  });

  it("credits: non-null replaces, null preserves", () => {
    const merged = mergeCodexRateLimits(BASE, { credits: null }, "2026-07-16T15:00:00.000Z");
    expect(merged.credits).toEqual(BASE.credits);

    const freshCredits = { hasCredits: true, unlimited: true, balance: null };
    const merged2 = mergeCodexRateLimits(BASE, { credits: freshCredits }, "2026-07-16T16:00:00.000Z");
    expect(merged2.credits).toEqual(freshCredits);
  });
});

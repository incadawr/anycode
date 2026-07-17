import { describe, expect, it } from "vitest";
import {
  CodexQuotaTracker,
  decodeAccountRateLimitsRead,
  decodeRateLimitSnapshot,
  decodeRateLimitsUpdatedParams,
} from "./quota.js";

/**
 * The LIVE W0-R1 probe shape, verbatim structure (working-docs/references/
 * codex-rate-limits-probe/rate-limits-response.json, real plus account):
 * ONE populated window, `secondary` present-but-null, `byLimitId.codex`
 * byte-duplicating the top level, `rateLimitResetCredits` present (dropped),
 * `resetsAt` in epoch SECONDS. Amendment §A3.2 requires tests to use THIS
 * shape, not an invented 5h/weekly pair.
 */
function liveReadResult(): unknown {
  const snapshot = {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    planType: "plus",
    rateLimitReachedType: null,
  };
  return {
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot },
    rateLimitResetCredits: { availableCount: 3, credits: [{ id: "x", resetType: "codexRateLimits" }] },
  };
}

describe("decodeRateLimitSnapshot", () => {
  it("decodes the live single-window shape and drops unconsumed fields (limitId/individualLimit/rateLimitReachedType)", () => {
    const decoded = decodeRateLimitSnapshot((liveReadResult() as { rateLimits: unknown }).rateLimits);
    expect(decoded).toEqual({
      primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "plus",
    });
    // present-but-null secondary / limitName are OMITTED, never carried as null.
    expect(decoded).not.toHaveProperty("secondary");
    expect(decoded).not.toHaveProperty("limitName");
  });

  it("keeps balance a string and resetsAt the raw epoch-seconds number (no unit conversion here)", () => {
    const decoded = decodeRateLimitSnapshot({ primary: { usedPercent: 1, resetsAt: 1_784_791_993 }, credits: { hasCredits: true, unlimited: false, balance: "0" } })!;
    expect(decoded.credits?.balance).toBe("0");
    expect(decoded.primary?.resetsAt).toBe(1_784_791_993);
  });

  it("tolerates garbage without throwing", () => {
    expect(decodeRateLimitSnapshot(null)).toBeNull();
    expect(decodeRateLimitSnapshot("junk")).toBeNull();
    expect(decodeRateLimitSnapshot({ primary: { usedPercent: "35" } })).toEqual({});
  });
});

describe("decodeAccountRateLimitsRead — byLimitId first, top-level fallback (amendment §A3.3)", () => {
  it("a single live bucket supplies the top-level fields AND rides byLimitId; rateLimitResetCredits is dropped", () => {
    const decoded = decodeAccountRateLimitsRead(liveReadResult())!;
    expect(decoded.primary).toEqual({ usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 });
    expect(decoded.planType).toBe("plus");
    expect(Object.keys(decoded.byLimitId ?? {})).toEqual(["codex"]);
    expect(decoded).not.toHaveProperty("rateLimitResetCredits");
  });

  it("falls back to the top-level mirror when the map is absent", () => {
    const decoded = decodeAccountRateLimitsRead({ rateLimits: { primary: { usedPercent: 12 }, planType: "pro" } })!;
    expect(decoded.primary).toEqual({ usedPercent: 12 });
    expect(decoded.planType).toBe("pro");
    expect(decoded.byLimitId).toBeUndefined();
  });

  it("with several buckets the top-level mirror stays authoritative for the top-level fields, the full map is carried", () => {
    const decoded = decodeAccountRateLimitsRead({
      rateLimits: { primary: { usedPercent: 20 }, planType: "plus" },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 20 } },
        other: { primary: { usedPercent: 90 } },
      },
    })!;
    expect(decoded.primary).toEqual({ usedPercent: 20 });
    expect(Object.keys(decoded.byLimitId ?? {}).sort()).toEqual(["codex", "other"]);
  });
});

describe("decodeRateLimitsUpdatedParams", () => {
  it("decodes the schema-required {rateLimits} envelope and nothing else", () => {
    expect(decodeRateLimitsUpdatedParams({ rateLimits: { primary: { usedPercent: 40 } } })).toEqual({
      primary: { usedPercent: 40 },
    });
    expect(decodeRateLimitsUpdatedParams({})).toBeNull();
    expect(decodeRateLimitsUpdatedParams(undefined)).toBeNull();
  });
});

describe("CodexQuotaTracker — every advance goes through the frozen sparse-merge", () => {
  it("seeds from the live pull and reports it as the current snapshot", () => {
    const tracker = new CodexQuotaTracker(() => "2026-07-16T00:00:00.000Z");
    const seeded = tracker.seedFromRead(liveReadResult());
    expect(seeded).toMatchObject({
      primary: { usedPercent: 35, windowDurationMins: 10_080 },
      planType: "plus",
      observedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(tracker.current()).toEqual(seeded);
  });

  it("a sparse push updates what it carries and NEVER wipes what it omits (cut §6.3)", () => {
    const times = ["t1", "t2"];
    const tracker = new CodexQuotaTracker(() => times.shift() ?? "tN");
    tracker.seedFromRead(liveReadResult());

    // The push carries ONLY a fresher primary — planType/credits/byLimitId omitted.
    const merged = tracker.applyUpdate({ rateLimits: { primary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_784_791_993 }, secondary: null, planType: null } });

    expect(merged).toMatchObject({
      primary: { usedPercent: 41 },
      // Known-but-omitted (and known-but-nulled) fields survive the sparse push.
      planType: "plus",
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      observedAt: "t2",
    });
    expect(merged?.byLimitId?.codex).toMatchObject({ planType: "plus" });
  });

  it("an undecodable push produces no event and leaves the snapshot untouched", () => {
    const tracker = new CodexQuotaTracker(() => "t1");
    tracker.seedFromRead(liveReadResult());
    const before = tracker.current();
    expect(tracker.applyUpdate({ nonsense: true })).toBeNull();
    expect(tracker.current()).toEqual(before);
  });

  it("a push arriving before any pull still yields a usable snapshot", () => {
    const tracker = new CodexQuotaTracker(() => "t1");
    const merged = tracker.applyUpdate({ rateLimits: { primary: { usedPercent: 7 } } });
    expect(merged).toMatchObject({ primary: { usedPercent: 7 }, observedAt: "t1" });
  });

  it("stays empty (null) until any source delivered data — an empty quota block is HIDDEN, not 0%", () => {
    const tracker = new CodexQuotaTracker();
    expect(tracker.current()).toBeNull();
    tracker.seedFromRead("garbage");
    expect(tracker.current()).toBeNull();
  });
});

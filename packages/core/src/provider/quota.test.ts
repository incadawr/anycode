/**
 * Tests for providerQuotaFromHeaders (Taskana 4090 / TASK.71, §3 test 1).
 * Pure function: fixture header bags built the same way quota-fetch.ts
 * builds them over a real `Headers` instance.
 */

import { describe, expect, it } from "vitest";
import { headerBagFrom } from "./quota-fetch.js";
import { providerQuotaFromHeaders, type QuotaHeaderBag } from "./quota.js";

const NOW = 1_790_000_000_000; // fixed epoch ms

function bag(status: number, entries: Record<string, string>) {
  const headers = new Headers(entries);
  return headerBagFrom({ status, headers });
}

describe("providerQuotaFromHeaders", () => {
  // (a) canonical x-ratelimit family: usedPercent + resetsAt passthrough
  it("derives usedPercent 80 and passes resetsAt through for an x-ratelimit requests family", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "20",
        "x-ratelimit-requests-reset": "1789999999",
      }),
      NOW,
    );
    expect(update).toEqual({
      primary: { usedPercent: 80, resetsAt: 1_789_999_999 },
      primarySource: "x-ratelimit-requests-limit",
      sources: ["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining", "x-ratelimit-requests-reset"],
    });
  });

  // (b) anthropic-family names collapse to the same family
  it("collapses anthropic-ratelimit-* names into the same family", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "250",
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 75 });
    expect(update?.secondary).toBeUndefined();
  });

  // (c) snake_case variants parse as their own family
  it("parses snake_case ratelimit variants", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-input_tokens-limit": "50",
        "x-ratelimit-input_tokens-remaining": "10",
        "x-ratelimit-input_tokens-reset": "1789999999",
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 80, resetsAt: 1_789_999_999 });
  });

  // (d) ISO-8601 and HTTP-date reset parsing → epoch seconds
  it("parses ISO-8601 reset values into epoch seconds", () => {
    const iso = new Date(1_789_999_999_000).toISOString(); // 2026-11-15T23:33:19.000Z
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "10",
        "x-ratelimit-requests-remaining": "5",
        "x-ratelimit-requests-reset": iso,
      }),
      NOW,
    );
    expect(update?.primary?.resetsAt).toBe(1_789_999_999);
  });

  it("parses HTTP-date reset values into epoch seconds", () => {
    const httpDate = new Date(1_789_999_999_000).toUTCString();
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "10",
        "x-ratelimit-requests-remaining": "5",
        "x-ratelimit-requests-reset": httpDate,
      }),
      NOW,
    );
    expect(update?.primary?.resetsAt).toBe(1_789_999_999);
  });

  // (e) two families → tightest ratio is primary, other is secondary
  it("ranks the tightest remaining/limit ratio as primary and the next distinct ratio as secondary", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "50", // 50% used
        "x-ratelimit-tokens-limit": "1000",
        "x-ratelimit-tokens-remaining": "100", // 90% used — tighter
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 90 });
    expect(update?.secondary).toEqual({ usedPercent: 50 });
  });

  it("omits secondary when two families share the same ratio", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "50",
        "x-ratelimit-tokens-limit": "10",
        "x-ratelimit-tokens-remaining": "5", // same 50% ratio
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 50 });
    expect(update?.secondary).toBeUndefined();
  });

  // (f) remaining > limit → family dropped (fail-closed, no clamping)
  it("drops a family whose remaining exceeds its limit", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "150",
      }),
      NOW,
    );
    expect(update).toBeNull();
  });

  // (g) no quota headers → null
  it("returns null when no quota headers are present", () => {
    expect(providerQuotaFromHeaders(bag(200, { "content-type": "application/json" }), NOW)).toBeNull();
  });

  // (h) 429 + retry-after: 120 → primary 100% + resetsAt = now/1000 + 120
  it("derives a 100% window from a bare retry-after on a 429", () => {
    const update = providerQuotaFromHeaders(bag(429, { "retry-after": "120" }), NOW);
    expect(update).toEqual({
      primary: { usedPercent: 100, resetsAt: 1_790_000_000 + 120 },
      primarySource: "retry-after",
      sources: ["retry-after"],
    });
  });

  it("parses an HTTP-date retry-after on a 429", () => {
    const resetAt = new Date(NOW + 60_000).toUTCString();
    const update = providerQuotaFromHeaders(bag(429, { "retry-after": resetAt }), NOW);
    expect(update).toEqual({
      primary: { usedPercent: 100, resetsAt: 1_790_000_000 + 60 },
      primarySource: "retry-after",
      sources: ["retry-after"],
    });
  });

  // (i) 200 + bare retry-after → null (pacing hint, not exhaustion)
  it("ignores a bare retry-after on a non-429 status", () => {
    expect(providerQuotaFromHeaders(bag(200, { "retry-after": "120" }), NOW)).toBeNull();
  });

  // (j) percent out of [0,100] can only be excluded via the ratio guard
  it("drops a family with a zero limit instead of dividing into nonsense", () => {
    const update = providerQuotaFromHeaders(
      bag(200, { "x-ratelimit-requests-limit": "0", "x-ratelimit-requests-remaining": "0" }),
      NOW,
    );
    expect(update).toBeNull();
  });

  it("drops non-numeric limit/remaining values", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "unlimited",
        "x-ratelimit-requests-remaining": "20",
      }),
      NOW,
    );
    expect(update).toBeNull();
  });

  it("keeps 100% used when remaining is exactly 0", () => {
    const update = providerQuotaFromHeaders(
      bag(200, { "x-ratelimit-requests-limit": "10", "x-ratelimit-requests-remaining": "0" }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 100 });
  });

  // (k) sources lists literal original names — as the bag reports them. A
  // real `Headers` instance normalizes to lowercase (spec behavior), so the
  // literal name seen by the parser IS the lowercase one; the point of the
  // pin is that sources carries the names that were actually consumed (the
  // vendor spelling, not the canonicalized key).
  it("lists the literal header names the bag reported in sources", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "Anthropic-Ratelimit-Requests-Limit": "40",
        "Anthropic-Ratelimit-Requests-Remaining": "30",
      }),
      NOW,
    );
    expect(update?.sources).toEqual(["anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining"]);
  });

  it("carries windowDurationMins when a family reports *-window-minutes", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "10",
        "x-ratelimit-requests-remaining": "5",
        "x-ratelimit-requests-window-minutes": "5",
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 50, windowDurationMins: 5 });
    expect(update?.sources).toContain("x-ratelimit-requests-window-minutes");
  });

  // Review follow-up: OpenAI ordering, relative resets, strict counts.
  it("parses OpenAI-ordered names (x-ratelimit-limit-requests) with a Go-duration reset", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "15",
        "x-ratelimit-reset-requests": "6m0s",
      }),
      NOW,
    );
    expect(update?.primary).toEqual({ usedPercent: 75, resetsAt: NOW / 1000 + 360 });
  });

  it("reads a small numeric reset as a delta in seconds, not as a 1970 epoch", () => {
    const update = providerQuotaFromHeaders(
      bag(200, { "x-ratelimit-requests-limit": "10", "x-ratelimit-requests-remaining": "5", "x-ratelimit-requests-reset": "60" }),
      NOW,
    );
    expect(update?.primary?.resetsAt).toBe(NOW / 1000 + 60);
  });

  it("drops a family whose counts are not plain integers (`20abc`, `1.5`)", () => {
    expect(
      providerQuotaFromHeaders(bag(200, { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "20abc" }), NOW),
    ).toBeNull();
    expect(
      providerQuotaFromHeaders(bag(200, { "x-ratelimit-requests-limit": "1.5", "x-ratelimit-requests-remaining": "1" }), NOW),
    ).toBeNull();
  });

  // Taskana 4090 cross-review A1: `primarySource` names the PRIMARY window's
  // own header, not `sources[0]` (which is the first family in FAMILIES order).
  it("names the primary window's own header, even when another family's header is listed first", () => {
    const update = providerQuotaFromHeaders(
      bag(200, {
        "x-ratelimit-requests-limit": "1000",
        "x-ratelimit-requests-remaining": "900",
        "x-ratelimit-tokens-limit": "100",
        "x-ratelimit-tokens-remaining": "10",
      }),
      NOW,
    );
    expect(update?.primary?.usedPercent).toBe(90);
    expect(update?.secondary?.usedPercent).toBe(10);
    expect(update?.primarySource).toBe("x-ratelimit-tokens-limit");
  });

  // Taskana 4090 cross-review A2: when two raw names canonicalize to the same
  // key, the reported name and value must not depend on the bag's iteration order.
  it("resolves a duplicated canonical family the same way whatever order the bag lists its names", () => {
    const entries: Record<string, string> = {
      "x-ratelimit-requests-remaining": "900",
      "ratelimit-requests-remaining": "800",
      "ratelimit-requests-limit": "1000",
    };
    const bagInOrder = (order: string[]): QuotaHeaderBag => ({
      status: 200,
      get: (name) => entries[name] ?? null,
      names: () => order,
    });
    const forward = providerQuotaFromHeaders(
      bagInOrder(["x-ratelimit-requests-remaining", "ratelimit-requests-remaining", "ratelimit-requests-limit"]),
      NOW,
    );
    const reversed = providerQuotaFromHeaders(
      bagInOrder(["ratelimit-requests-limit", "ratelimit-requests-remaining", "x-ratelimit-requests-remaining"]),
      NOW,
    );
    expect(reversed).toEqual(forward);
  });
});

import { describe, expect, it } from "vitest";
import { calculateUsageCost } from "./usage-cost.js";

const price = { basisId: "test", input: 0.3, cachedInput: 0.006, output: 1.2 };
describe("usage cost snapshots", () => {
  it("prices cache hits separately and reports their savings", () => {
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 }, price))
      .toEqual({ costUsd: 0.1848, cacheSavingsUsd: 0.2352, priceBasisId: "test" });
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, price)?.costUsd).toBe(0.3);
  });
  it("does not invent a price or cache usage", () => {
    expect(calculateUsageCost({ inputTokens: 100, outputTokens: 1 }, price)).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 100, cachedInputTokens: 101, outputTokens: 1 }, price)).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 1 }, undefined)).toBeUndefined();
  });
});

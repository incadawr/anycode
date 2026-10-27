import { describe, expect, it } from "vitest";
import { calculateUsageCost, connectionPricing } from "./usage-cost.js";

const price = { basisId: "test", input: 0.3, cachedInput: 0.006, output: 1.2 };
describe("usage cost snapshots", () => {
  it("prices cache hits separately and reports their savings", () => {
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 }, price))
      .toEqual({ costUsd: 0.1848, cacheSavingsUsd: 0.2352, priceBasisId: "test" });
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, price)?.costUsd).toBe(0.3);
  });
  it("does not persist non-finite results when finite counts and rates overflow", () => {
    expect(calculateUsageCost({ inputTokens: Number.MAX_VALUE, cachedInputTokens: 0, outputTokens: 0 }, { ...price, input: Number.MAX_VALUE })).toBeUndefined();
  });
  it("does not invent a price or cache usage", () => {
    expect(calculateUsageCost({ inputTokens: 100, outputTokens: 1 }, price)).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 100, cachedInputTokens: 101, outputTokens: 1 }, price)).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 1 }, undefined)).toBeUndefined();
  });
});

describe("connection prices", () => {
  it("validates overrides and preserves subscription mode", () => {
    expect(connectionPricing('{"mode":"subscription"}')).toEqual({ subscription: true });
    expect(connectionPricing('{"mode":"rates","input":-1,"cachedInput":0,"output":1}')).toBeUndefined();
    expect(connectionPricing('{"mode":"rates","input":2,"cachedInput":1,"output":3}')?.subscription).toBe(false);
  });
  it("prices reported cache writes and refuses an unknown write rate", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteTokens: 100_000, outputTokens: 0 };
    expect(calculateUsageCost(usage, price)).toBeUndefined();
    expect(calculateUsageCost(usage, { ...price, cacheWrite: 0.5 })?.costUsd).toBeCloseTo(0.2612);
  });
});

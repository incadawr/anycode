import { describe, expect, it } from "vitest";
import { findCatalogEntry } from "@anycode/core/catalog";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { summarizeProviderUsage } from "./session.js";
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

// The catalog snapshots are only worth anything if the
// calculator can consume them end to end, so this drives the real rows — not a
// hand-written fixture — through the same code path a session uses.
describe("catalog prices through the calculator", () => {
  const catalogPrice = (providerId: string, modelId: string) =>
    findCatalogEntry(providerId)?.models.find((model) => model.id === modelId)?.pricing;

  it("prices an all-fresh turn and an all-cached turn for a real DeepSeek row", () => {
    const pro = catalogPrice("deepseek", "deepseek-v4-pro");
    expect(pro).toBeDefined();
    // 1M fresh input + 1M output at V4-Pro's peak rate ($1.32 / $3.96).
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, pro)?.costUsd)
      .toBeCloseTo(5.28);
    // Same token counts, all input served from cache: $0.044 instead of $1.32.
    const cached = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }, pro);
    expect(cached?.costUsd).toBeCloseTo(0.044);
    expect(cached?.cacheSavingsUsd).toBeCloseTo(1.276);
  });

  it("prices GLM cache creation at the input rate in the step and session total", async () => {
    const glm = catalogPrice("z-ai", "glm-5.3");
    expect(glm).toBeDefined();
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteTokens: 100_000, outputTokens: 10_000 };
    const cost = calculateUsageCost(usage, glm);
    const expected = (500_000 * 1.4 + 400_000 * 0.26 + 100_000 * 1.4 + 10_000 * 4.4) / 1_000_000;
    expect(cost?.costUsd).toBeCloseTo(expected);

    const db = new SqlitePersistenceAdapter(":memory:");
    try {
      await db.createSession({ id: "glm", workspace: "/w", model: "glm-5.3", mode: "build" });
      await db.recordProviderUsage({ sessionId: "glm", turnId: "turn", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0, ...usage, ...cost });
      const summary = summarizeProviderUsage(await db.listProviderUsage("glm"));
      expect(summary.steps[0]?.costUsd).toBeCloseTo(expected);
      expect(summary.totals?.costUsd).toBeCloseTo(expected);
    } finally {
      await db.close();
    }
  });

  it("prices cache creation at the input rate for every priced Z.AI model", () => {
    const models = findCatalogEntry("z-ai")?.models.filter((model) => model.pricing);
    expect(models).toHaveLength(8);
    for (const model of models ?? []) {
      expect(model.pricing?.cacheWrite, model.id).toBe(model.pricing?.input);
    }
  });

  it("still reports no cost for a model the catalog cannot price", () => {
    expect(catalogPrice("kimi", "k3")).toBeUndefined();
    expect(catalogPrice("moonshot", "kimi-k2.6")).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 1_000 }, catalogPrice("kimi", "k3"))).toBeUndefined();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCatalogEntry } from "@anycode/core/catalog";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { summarizeProviderUsage } from "./session.js";
import { calculateUsageCost, catalogRateFor, declaredPricingMode, connectionPricing, resolveUsagePrice } from "./usage-cost.js";

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
    // 1M fresh input + 1M output at V4-Pro's peak rate ($1.32 / $3.96) —
    // no timestamp means the conservative peak ceiling.
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, pro)?.costUsd)
      .toBeCloseTo(5.28);
    // The same instant made explicit is still the peak band, with the bare
    // basis id (peak needs no suffix).
    const peak = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, pro, Date.UTC(2026, 9, 28, 2, 30));
    expect(peak?.costUsd).toBeCloseTo(5.28);
    expect(peak?.priceBasisId).toBe("deepseek-v4-pro-deepseek-peak-2026-10-27");
    // Same token counts, all input served from cache: $0.044 instead of $1.32.
    const cached = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }, pro);
    expect(cached?.costUsd).toBeCloseTo(0.044);
    expect(cached?.cacheSavingsUsd).toBeCloseTo(1.276);
  });

  it("halves every DeepSeek rate outside the peak window, off the step's timestamp", () => {
    // The owner's night of 28.10: Wednesday 20:00 UTC is outside the peak
    // windows, so the peak catalog snapshot is billed at half.
    const night = Date.UTC(2026, 9, 28, 20, 0);
    const pro = catalogPrice("deepseek", "deepseek-v4-pro");
    const fresh = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, pro, night);
    expect(fresh?.costUsd).toBeCloseTo(2.64);
    expect(fresh?.priceBasisId).toBe("deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak");
    // Cache hits AND their savings are billed at the same band.
    const cached = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }, pro, night);
    expect(cached?.costUsd).toBeCloseTo(0.022);
    expect(cached?.cacheSavingsUsd).toBeCloseTo(0.638);
    // Flash: $0.30 in + $1.20 out at peak, half of that off-peak.
    const flash = calculateUsageCost(
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      catalogPrice("deepseek", "deepseek-flash"),
      night,
    );
    expect(flash?.costUsd).toBeCloseTo(0.75);
    expect(flash?.priceBasisId).toBe("deepseek-flash-deepseek-peak-2026-10-27+off-peak");
  });

  it("bills hour boundaries and weekends exactly", () => {
    const pro = catalogPrice("deepseek", "deepseek-v4-pro");
    const at = (timestampMs: number) =>
      calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, pro, timestampMs);
    // Half-open windows: 03:59:59.999 is still peak, 04:00:00.000 is not;
    // 05:59:59.999 is off-peak, 06:00:00.000 is peak again.
    expect(at(Date.UTC(2026, 9, 28, 3, 59, 59, 999))?.costUsd).toBeCloseTo(5.28);
    expect(at(Date.UTC(2026, 9, 28, 4, 0))?.costUsd).toBeCloseTo(2.64);
    expect(at(Date.UTC(2026, 9, 28, 6, 0))?.costUsd).toBeCloseTo(5.28);
    expect(at(Date.UTC(2026, 9, 28, 5, 59, 59, 999))?.costUsd).toBeCloseTo(2.64);
    // 02:30 UTC is peak on Friday and off-peak on Saturday, same clock time.
    expect(at(Date.UTC(2026, 9, 30, 2, 30))?.costUsd).toBeCloseTo(5.28);
    expect(at(Date.UTC(2026, 9, 31, 2, 30))?.costUsd).toBeCloseTo(2.64);
  });

  it("keeps flat connection/model rates flat at any timestamp", () => {
    const night = Date.UTC(2026, 9, 28, 20, 0);
    // A user-specified rate declares no tariff, so no hour can discount it.
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, price, night))
      .toEqual(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, price));
    expect(calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, price, night)?.priceBasisId).toBe("test");
  });

  it("persists the off-peak basis id so totals survive a reopen", async () => {
    const pro = catalogPrice("deepseek", "deepseek-v4-pro");
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    const night = Date.UTC(2026, 9, 28, 20, 0);
    const cost = calculateUsageCost(usage, pro, night);
    expect(cost).toBeDefined();
    // A real FILE, closed and reopened: an in-memory adapter would prove only
    // the immediate round trip, not that the band survives the exit a session
    // takes when the popover is next opened.
    const dir = mkdtempSync(join(tmpdir(), "anycode-usage-reopen-"));
    const dbPath = join(dir, "usage.db");
    try {
      const first = new SqlitePersistenceAdapter(dbPath);
      try {
        await first.createSession({ id: "deepseek-night", workspace: "/w", model: "deepseek-v4-pro", mode: "build" });
        await first.recordProviderUsage({ sessionId: "deepseek-night", turnId: "turn", step: 1, createdAt: night, finishReason: "stop", transportRetries: 0, ...usage, ...cost });
      } finally {
        await first.close();
      }
      const reopened = new SqlitePersistenceAdapter(dbPath);
      try {
        const summary = summarizeProviderUsage(await reopened.listProviderUsage("deepseek-night"));
        expect(summary.steps[0]?.priceBasisId).toBe("deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak");
        expect(summary.steps[0]?.createdAt).toBe(night);
        expect(summary.totals?.priceBasisIds).toContain("deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak");
        expect(summary.totals?.costUsd).toBeCloseTo(2.64);
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prices MiMo API cache writes at zero", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteTokens: 100_000, outputTokens: 100_000 };
    for (const [model, expected] of [["mimo-v2.6-pro", 0.39222], ["mimo-v2.6-flash", 0.12656]] as const) {
      const cost = calculateUsageCost(usage, catalogPrice("xiaomi-mimo-api", model));
      expect(cost, model).toBeDefined();
      expect(cost?.costUsd, model).toBeCloseTo(expected);
    }
  });

  it("prices a Token Plan turn at the API list rate", () => {
    for (const region of ["sgp", "cn", "ams"]) {
      const selected = resolveUsagePrice(undefined, "mimo-v2.6-pro", catalogPrice(`xiaomi-mimo-${region}`, "mimo-v2.6-pro"));
      expect(selected?.subscription).toBe(false);
      if (!selected || selected.subscription) throw new Error("Expected catalog pricing");
      const cost = calculateUsageCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, selected.price);
      expect(cost?.costUsd).toBeCloseTo(1.305);
      expect(cost?.priceBasisId).toBe("mimo-v2.6-pro-xiaomi-mimo-api-2026-10-30");
    }
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
    // The kimi.com subscription rows are unpriced by design (membership, not
    // metered billing); moonshot's kimi-k2.6 gained rates on 2026-10-30.
    expect(catalogPrice("kimi", "kimi-for-coding")).toBeUndefined();
    expect(calculateUsageCost({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 1_000 }, catalogPrice("kimi", "kimi-for-coding"))).toBeUndefined();
  });
});


describe("per-model price resolution", () => {
  const a = { input: 1, cachedInput: 0, output: 2 };
  const b = { input: 3, cachedInput: 0, output: 4 };
  const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 };
  it("uses exact model prices, fallback, catalog and subscription in order", () => {
    const raw = JSON.stringify({ fallback: { mode: "rates", ...b }, models: { A: a, B: b, constructor: a, bad: { input: -1 } } });
    for (const [id, expected] of [["A", .003], ["B", .007], ["constructor", .003], ["bad", .007], ["a", .007]] as const) {
      const selected = resolveUsagePrice(raw, id, price);
      expect(selected?.subscription).toBe(false);
      if (selected && !selected.subscription) expect(calculateUsageCost(usage, selected.price)?.costUsd).toBeCloseTo(expected);
    }
    expect(resolveUsagePrice(JSON.stringify({ models: { A: a }, fallback: { mode: "subscription" } }), "A", price)).toEqual({ subscription: true });
    expect(resolveUsagePrice(undefined, "C", price)).toEqual({ subscription: false, price });
    expect(resolveUsagePrice(undefined, "C", undefined)).toBeUndefined();
    const zero = resolveUsagePrice(JSON.stringify({ models: { A: { input: 0, cachedInput: 0, output: 0 } } }), "A", price);
    expect(zero?.subscription).toBe(false);
    if (!zero || zero.subscription) throw new Error("Expected a zero-rate price");
    expect(calculateUsageCost(usage, zero.price)?.costUsd).toBe(0);
    expect(resolveUsagePrice(raw, "A", price)).toEqual(resolveUsagePrice(JSON.stringify({ fallback: { mode: "rates", ...b }, models: { A: a, B: a } }), "A", price));
  });
});

describe("shared billing endpoints", () => {
  it("requires an explicit catalog choice", async () => {
    const { catalogRateFor } = await import("./usage-cost.js");
    const url = "https://api.minimax.io/anthropic/v1";
    const entry = findCatalogEntry("minimax");
    expect(catalogRateFor(entry, url, "MiniMax-M3.1-Flash", undefined)).toBeUndefined();
    expect(catalogRateFor(entry, url, "MiniMax-M3.1-Flash", "catalog")).toBeDefined();
    expect(catalogRateFor(entry, url, "MiniMax-M3.1-Flash", "subscription")).toBeUndefined();
  });
});

it("prices each turn using its captured billing mode", () => {
  const entry = findCatalogEntry("minimax");
  const url = "https://api.minimax.io/anthropic";
  const model = "MiniMax-M3.1-Flash";
  let current = JSON.stringify({ fallback: { mode: "catalog" } });
  const snapshot = current;
  current = JSON.stringify({ fallback: { mode: "subscription" } });
  const capturedPrice = catalogRateFor(entry, url, model, declaredPricingMode(snapshot));
  expect(resolveUsagePrice(snapshot, model, capturedPrice)).toEqual({ subscription: false, price: capturedPrice });
  expect(resolveUsagePrice(current, model, catalogRateFor(entry, url, model, declaredPricingMode(current)))).toEqual({ subscription: true });
  const unknownSnapshot = JSON.stringify({ models: {} });
  current = JSON.stringify({ fallback: { mode: "catalog" } });
  expect(catalogRateFor(entry, url, model, declaredPricingMode(unknownSnapshot))).toBeUndefined();
  expect(catalogRateFor(entry, url, model, declaredPricingMode(current))).toBeDefined();
});

it("derives MiniMax billing defaults without overriding explicit choices", async () => {
  const { pricingSnapshotWithKeyDefault } = await import("./usage-cost.js");
  for (const id of ["minimax", "minimax-cn"]) {
    const entry = findCatalogEntry(id);
    const derive = (raw: string | undefined, key: string | undefined) => pricingSnapshotWithKeyDefault(raw, entry, key);
    expect(declaredPricingMode(derive(undefined, "sk-cp-example"))).toBe("subscription");
    expect(declaredPricingMode(derive(undefined, "sk-api-example"))).toBe("catalog");
    expect(derive(undefined, "other")).toBeUndefined();
    expect(derive(undefined, undefined)).toBeUndefined();
    for (const mode of ["catalog", "subscription", "rates"]) {
      const raw = JSON.stringify({ fallback: { mode }, models: {} });
      expect(derive(raw, "sk-cp-example")).toBe(raw);
      expect(derive(raw, "sk-api-example")).toBe(raw);
    }
    for (const input of [0, 1]) {
      const raw = JSON.stringify({ models: { model: { input, cachedInput: 0, output: 2 } } });
      const snapshot = derive(raw, "sk-cp-example");
      expect(resolveUsagePrice(snapshot, "model", undefined)).toMatchObject({ subscription: false, price: { input, cachedInput: 0, output: 2 } });
      expect(resolveUsagePrice(snapshot, "other", undefined)).toEqual({ subscription: true });
    }
    const raw = JSON.stringify({ models: { model: { input: 1, cachedInput: 0, output: 2 } } });
    expect(JSON.parse(derive(raw, "sk-api-example")!).models).toEqual(JSON.parse(raw).models);
    expect(derive(raw, "sk-api-example")).not.toContain("sk-api");
  }
  expect(pricingSnapshotWithKeyDefault(undefined, findCatalogEntry("deepseek"), "sk-api-example")).toBeUndefined();
});

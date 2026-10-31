/**
 * Production-wiring tests for provider-usage recording.
 *
 * The two host audit writers (the main session sink and the subagent recorder)
 * both go through `usage-recording.ts`, which reads the clock ONCE per step:
 * the same instant decides the tariff band (peak/off-peak) and becomes the
 * row's `createdAt`. That invariant is what makes a DeepSeek night session
 * persist a halved cost instead of the peak ceiling, so it is pinned here at
 * the level the host actually runs — the real row builders, the real adapter,
 * a real close/reopen and the host's own summary port — with a controlled
 * clock. The popover half of the chain (persisted basis → label) is asserted
 * in `Composer-cost-popover.test.ts`, where the ledger lives.
 *
 * `host/index.ts` itself is not importable (see `index.test.ts`'s header), so
 * its two call sites are pinned by a source scan, the same fallback
 * `index.prompt-cache-wiring.test.ts` uses for a wiring that must not drift.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { findCatalogEntry } from "@anycode/core/catalog";
import { sessionUsageRow, subagentUsageRow } from "./usage-recording.js";
import { summarizeWithChildren } from "./usage-summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const pricing = findCatalogEntry("deepseek")!.models.find((model) => model.id === "deepseek-v4-pro")!.pricing;
const OFF_PEAK_BASIS = "deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak";
const PEAK_BASIS = "deepseek-v4-pro-deepseek-peak-2026-10-27";
/** 2026-10-28 is a Wednesday; 20:00 UTC is outside both peak windows. */
const NIGHT = Date.UTC(2026, 9, 28, 20, 0);
const TURN_USAGE = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };

describe("provider-usage recording (host writers)", () => {
  it("prices both the session and the subagent row off the step clock, and the summary survives a reopen", async () => {
    const mainRow = sessionUsageRow(
      { turnId: "turn-1", step: 1, finishReason: "stop", transportRetries: 0, model: "deepseek-v4-pro", ...TURN_USAGE },
      { price: pricing, pricingRaw: undefined, model: "deepseek-v4-pro", now: () => NIGHT },
      "night-session",
    );
    const childRow = subagentUsageRow(
      TURN_USAGE,
      { price: pricing, pricingRaw: undefined, model: "deepseek-v4-pro", now: () => NIGHT },
      { subagentId: "child-1", sessionId: "night-session", step: 1 },
    );
    for (const row of [mainRow, childRow]) {
      expect(row.createdAt).toBe(NIGHT);
      expect(row.costUsd).toBeCloseTo(2.64);
      expect(row.cacheSavingsUsd).toBeGreaterThanOrEqual(0);
      expect(row.priceBasisId).toBe(OFF_PEAK_BASIS);
    }
    // The subagent row is a turn of its own, exactly as the recorder writes it.
    expect(childRow).toMatchObject({ subagentId: "child-1", turnId: "child-1", step: 1, finishReason: "unknown", transportRetries: 0 });

    const dir = mkdtempSync(join(tmpdir(), "anycode-usage-record-"));
    const dbPath = join(dir, "usage.db");
    try {
      const first = new SqlitePersistenceAdapter(dbPath);
      try {
        await first.createSession({ id: "night-session", workspace: "/w", model: "deepseek-v4-pro", mode: "build" });
        await first.recordProviderUsage(mainRow);
        await first.recordProviderUsage(childRow);
      } finally {
        await first.close();
      }
      const reopened = new SqlitePersistenceAdapter(dbPath);
      try {
        // The popover reads `summarizeWithChildren` (own rows + inline child
        // rows), not the raw list.
        const summary = await summarizeWithChildren(reopened, "night-session");
        expect(summary.totals?.costUsd).toBeCloseTo(2.64);
        expect(summary.totals?.subagentCostUsd).toBeCloseTo(2.64);
        expect(summary.totals?.priceBasisIds).toEqual([OFF_PEAK_BASIS]);
        // `steps` is the session's OWN step list; the inline child row is
        // folded into the subagent share above, exactly as the popover shows it.
        expect(summary.steps.map((step) => step.priceBasisId)).toEqual([OFF_PEAK_BASIS]);
        expect(summary.steps[0]?.createdAt).toBe(NIGHT);
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the clock once per step, so a peak-to-off-peak boundary cannot be mispriced", () => {
    // A clock that crosses the 04:00 UTC boundary between calls. A second
    // reading would price this step at peak but store an off-peak timestamp
    // (or the reverse), and every later audit would disagree with itself.
    const instants = [Date.UTC(2026, 9, 28, 3, 59, 59, 999), Date.UTC(2026, 9, 28, 4, 0)];
    let calls = 0;
    const now = () => instants[Math.min(calls++, instants.length - 1)]!;
    const row = sessionUsageRow(
      { turnId: "turn-boundary", step: 1, finishReason: "stop", transportRetries: 0, model: "deepseek-v4-pro", ...TURN_USAGE },
      { price: pricing, pricingRaw: undefined, model: "deepseek-v4-pro", now },
      "boundary-session",
    );
    expect(calls).toBe(1);
    expect(row.createdAt).toBe(instants[0]);
    expect(row.costUsd).toBeCloseTo(5.28);
    expect(row.priceBasisId).toBe(PEAK_BASIS);
  });

  it("keeps a flat connection rate unbanded even at night", () => {
    const row = sessionUsageRow(
      { turnId: "turn-flat", step: 1, finishReason: "stop", transportRetries: 0, model: "deepseek-v4-pro", ...TURN_USAGE },
      {
        price: pricing,
        pricingRaw: JSON.stringify({ mode: "rates", input: 1, cachedInput: 0, output: 2 }),
        model: "deepseek-v4-pro",
        now: () => NIGHT,
      },
      "flat-session",
    );
    expect(row.createdAt).toBe(NIGHT);
    expect(row.costUsd).toBeCloseTo(3);
    expect(row.priceBasisId).toMatch(/^connection:/);
  });
});

describe("host/index.ts — usage-recording wiring", () => {
  const indexSource = readFileSync(resolve(here, "index.ts"), "utf8");

  it("routes both writers through the row builders", () => {
    // One call site each: the main sink and the subagent recorder.
    expect(indexSource.split("sessionUsageRow(").length - 1).toBe(1);
    expect(indexSource.split("subagentUsageRow(").length - 1).toBe(1);
    // Both hand the host clock over explicitly.
    const recorderCalls = indexSource.split("UsageRow(usage, { price").length - 1 + indexSource.split("sessionUsageRow(r, { price").length - 1;
    expect(recorderCalls).toBe(2);
    for (const call of indexSource.split("UsageRow(").slice(1)) {
      expect(call.slice(0, 160)).toContain("now: Date.now");
    }
  });

  it("never prices a step or stamps a row on its own", () => {
    // A direct `calculateUsageCost(…, timestamp)` call outside the builder
    // would re-open the two-clock hazard this module exists to close, so the
    // host must not even import the pricer any more.
    expect(indexSource).not.toContain("calculateUsageCost(");
    expect(indexSource).not.toContain("resolveUsagePrice(");
    expect(indexSource).not.toContain('from "./usage-cost.js"');
  });
});

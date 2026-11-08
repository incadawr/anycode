/**
 * Token-budget math:
 *   effectiveWindow  = contextWindow - min(outputReserve, 25% of contextWindow)
 *   compactThreshold = max(buffered > 0 ? min(byPercent, buffered) : byPercent, 1)
 *     where byPercent = floor(effectiveWindow * pct / 100), buffered = effectiveWindow - buffer
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET,
  compactThresholdTokens,
  effectiveWindowTokens,
  microcompactThresholdTokens,
  resolveContextBudgetConfig,
  type ContextBudgetConfig,
} from "./budget.js";

describe("effectiveWindowTokens", () => {
  it("subtracts the output reserve from the window", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 200_000,
      outputReserveTokens: 24_000,
    });
    expect(effectiveWindowTokens(config)).toBe(176_000);
  });

  it("caps the reserve at 25% when it would consume the window", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 10_000,
      outputReserveTokens: 24_000,
    });
    // 10_000 - 2_500 = 7_500.
    expect(effectiveWindowTokens(config)).toBe(7_500);
  });
});

describe("compactThresholdTokens", () => {
  it("uses the percentage when it is below (effectiveWindow - buffer)", () => {
    const config: ContextBudgetConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      contextWindowTokens: 200_000,
      outputReserveTokens: 24_000,
      compactThresholdPercent: 92,
      compactBufferTokens: 13_000,
    };
    // effectiveWindow = 176_000; 92% = 161_920; window - buffer = 163_000; min = 161_920.
    expect(effectiveWindowTokens(config)).toBe(176_000);
    expect(compactThresholdTokens(config)).toBe(161_920);
  });

  it("is capped by (effectiveWindow - buffer) when the percentage is higher", () => {
    const config: ContextBudgetConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      contextWindowTokens: 100_000,
      outputReserveTokens: 0,
      compactThresholdPercent: 99,
      compactBufferTokens: 13_000,
    };
    // effectiveWindow = 100_000; 99% = 99_000; window - buffer = 87_000; min = 87_000.
    expect(compactThresholdTokens(config)).toBe(87_000);
  });

  it("floors the percentage product", () => {
    const config: ContextBudgetConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      contextWindowTokens: 1_001,
      outputReserveTokens: 0,
      compactThresholdPercent: 33,
      compactBufferTokens: 0,
    };
    // effectiveWindow = 1_001; 33% = 330.33 -> floor 330; window - buffer = 1_001; min = 330.
    expect(compactThresholdTokens(config)).toBe(330);
  });
});

describe("microcompactThresholdTokens", () => {
  it("uses 60% of the frozen default effective window and stays below LLM compaction", () => {
    expect(microcompactThresholdTokens(DEFAULT_CONTEXT_BUDGET)).toBe(105_600);
    expect(microcompactThresholdTokens(DEFAULT_CONTEXT_BUDGET)).toBeLessThan(
      compactThresholdTokens(DEFAULT_CONTEXT_BUDGET),
    );
  });

  it("clamps to the LLM compaction threshold when overrides invert the percentages", () => {
    const config = resolveContextBudgetConfig({ compactThresholdPercent: 50 });
    expect(microcompactThresholdTokens(config)).toBe(compactThresholdTokens(config));
  });

  it("uses the capped reserve and remains positive", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 8_000,
      outputReserveTokens: 24_000,
    });
    // effective window = 6,000; 60% = 3,600.
    expect(microcompactThresholdTokens(config)).toBe(3_600);
    expect(microcompactThresholdTokens(config)).toBeGreaterThanOrEqual(1);
  });
});

describe("capped output reserve", () => {
  it("live-smoke repro: {contextWindow:8000, outputReserve:24000} no longer collapses to a non-positive/every-turn threshold", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 8_000,
      outputReserveTokens: 24_000,
    });
    // Reserve is capped at 2,000, leaving 6,000.
    expect(effectiveWindowTokens(config)).toBe(6_000);
    // 92% of 6,000 = 5,520.
    expect(compactThresholdTokens(config)).toBe(5_520);
    expect(compactThresholdTokens(config)).toBeGreaterThan(0);
  });

  it("defaults {200000, 24000} are unchanged by the amendment (no-regression lock)", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 200_000,
      outputReserveTokens: 24_000,
    });
    expect(effectiveWindowTokens(config)).toBe(176_000);
    expect(compactThresholdTokens(config)).toBe(161_920);
  });

  it("caps a large reserve on a 37000-token window", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 37_000,
      outputReserveTokens: 24_000,
    });
    // Reserve is capped at 9,250, leaving 27,750.
    expect(effectiveWindowTokens(config)).toBe(27_750);
    // Buffer cap: 27,750 - 13,000 = 14,750.
    expect(compactThresholdTokens(config)).toBe(14_750);
  });

  it.each([100, 1_000, 8_000, 37_000, 200_000])(
    "invariant holds for contextWindow=%i: 1 <= threshold < effectiveWindow <= contextWindow",
    (contextWindowTokens) => {
      const config = resolveContextBudgetConfig({
        contextWindowTokens,
        outputReserveTokens: 24_000,
      });
      const ew = effectiveWindowTokens(config);
      const threshold = compactThresholdTokens(config);
      expect(threshold).toBeGreaterThanOrEqual(1);
      expect(threshold).toBeLessThan(ew);
      expect(ew).toBeLessThanOrEqual(contextWindowTokens);
    },
  );

});

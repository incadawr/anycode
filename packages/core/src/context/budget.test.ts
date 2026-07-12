/**
 * Token-budget math (design §2.5, task 1.2; degraded-window floor amendment,
 * phase1-tails-and-phase2-ruling §2):
 *   effectiveWindow  = max(contextWindow - min(outputReserve, contextWindow),
 *                          ceil(contextWindow * MIN_EFFECTIVE_WINDOW_FRACTION))
 *   compactThreshold = max(buffered > 0 ? min(byPercent, buffered) : byPercent, 1)
 *     where byPercent = floor(effectiveWindow * pct / 100), buffered = effectiveWindow - buffer
 */

import { describe, expect, it } from "vitest";
import { MIN_EFFECTIVE_WINDOW_FRACTION } from "../types/config.js";
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

  it("floors at MIN_EFFECTIVE_WINDOW_FRACTION of the window when the reserve would consume it entirely", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 10_000,
      outputReserveTokens: 24_000,
    });
    // raw = 10_000 - min(24_000, 10_000) = 0; floor = ceil(10_000 * 0.25) = 2_500.
    expect(effectiveWindowTokens(config)).toBe(2_500);
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

  it("uses the degraded-window effective-window floor and remains positive", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 8_000,
      outputReserveTokens: 24_000,
    });
    // effective window = 2,000; 60% = 1,200.
    expect(microcompactThresholdTokens(config)).toBe(1_200);
    expect(microcompactThresholdTokens(config)).toBeGreaterThanOrEqual(1);
  });
});

describe("degraded-window floor (MIN_EFFECTIVE_WINDOW_FRACTION amendment)", () => {
  it("live-smoke repro: {contextWindow:8000, outputReserve:24000} no longer collapses to a non-positive/every-turn threshold", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 8_000,
      outputReserveTokens: 24_000,
    });
    // raw = 8_000 - min(24_000, 8_000) = 0; floor = ceil(8_000 * 0.25) = 2_000.
    expect(effectiveWindowTokens(config)).toBe(2_000);
    // byPercent = floor(2_000 * 92 / 100) = 1_840; buffered = 2_000 - 13_000 < 0 -> byPercent branch.
    expect(compactThresholdTokens(config)).toBe(1_840);
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

  it("boundary contextWindow:37000 lands exactly on buffered === 0, falling back to the percent bound", () => {
    const config = resolveContextBudgetConfig({
      contextWindowTokens: 37_000,
      outputReserveTokens: 24_000,
    });
    // raw = 37_000 - 24_000 = 13_000; floor = ceil(37_000 * 0.25) = 9_250; effectiveWindow = 13_000.
    expect(effectiveWindowTokens(config)).toBe(13_000);
    // buffered = 13_000 - 13_000 = 0 -> not > 0 -> byPercent branch: floor(13_000 * 92 / 100) = 11_960.
    expect(compactThresholdTokens(config)).toBe(11_960);
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

  it("MIN_EFFECTIVE_WINDOW_FRACTION is 0.25", () => {
    expect(MIN_EFFECTIVE_WINDOW_FRACTION).toBe(0.25);
  });
});

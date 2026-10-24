/**
 * TASK.4721: the base-budget learner is pure. These tests pin the training
 * filter (what counts as an accepted outcome), the p90/headroom formula, the
 * model-then-role pool fallback, and the fixed clamps.
 */
import { describe, expect, it } from "vitest";

import {
  LEARNED_BUDGET_MAX,
  LEARNED_BUDGET_MIN,
  LEARNING_MIN_SAMPLES,
  isAcceptedBudgetSample,
  learnBaseBudget,
  p90,
  type BudgetSample,
} from "./budget-learning.js";
import { SUBAGENT_MAX_TURNS_CEILING } from "../types/config.js";

function samples(role: string, model: string | undefined, turns: number[]): BudgetSample[] {
  return turns.map((t) => ({ role, ...(model !== undefined ? { model } : {}), turns: t }));
}

describe("isAcceptedBudgetSample (TASK.4721 training filter)", () => {
  it("accepts a completed, untruncated child", () => {
    expect(isAcceptedBudgetSample({ status: "completed", turns: 7 })).toBe(true);
    expect(isAcceptedBudgetSample({ status: "completed", turns: 7, truncated: false })).toBe(true);
  });

  it("rejects a completed child whose final text was truncated", () => {
    expect(isAcceptedBudgetSample({ status: "completed", turns: 7, truncated: true })).toBe(false);
  });

  it("accepts max_turns ONLY when the child declared done at its ceiling", () => {
    expect(isAcceptedBudgetSample({ status: "max_turns", turns: 9, declaredDoneAtCeiling: true })).toBe(true);
    expect(isAcceptedBudgetSample({ status: "max_turns", turns: 9 })).toBe(false);
    expect(isAcceptedBudgetSample({ status: "max_turns", turns: 9, declaredDoneAtCeiling: false })).toBe(false);
  });

  it("never accepts error or cancelled outcomes", () => {
    expect(isAcceptedBudgetSample({ status: "error", turns: 3 })).toBe(false);
    expect(isAcceptedBudgetSample({ status: "cancelled", turns: 3 })).toBe(false);
  });
});

describe("p90", () => {
  it("is the nearest-rank 90th percentile", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([42])).toBe(42);
  });

  it("does not depend on input order", () => {
    expect(p90([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toBe(9);
  });
});

describe("learnBaseBudget (TASK.4721 formula)", () => {
  it("returns undefined below the minimum sample count", () => {
    const few = samples("general-purpose", "m1", Array.from({ length: LEARNING_MIN_SAMPLES - 1 }, () => 10));
    expect(learnBaseBudget(few, { role: "general-purpose", model: "m1" })).toBeUndefined();
    expect(learnBaseBudget([], { role: "general-purpose" })).toBeUndefined();
  });

  it("is ceil(p90 * 1.25) once the pool is large enough", () => {
    // p90 of 5 equal samples at 40 turns = 40; 40 * 1.25 = 50.
    const pool = samples("explore", "m1", [40, 40, 40, 40, 40]);
    expect(learnBaseBudget(pool, { role: "explore", model: "m1" })).toBe(50);
  });

  it("prefers the same-model pool over the same-role pool", () => {
    const records = [
      ...samples("explore", "fast", [10, 10, 10, 10, 10]),
      ...samples("explore", "slow", [60, 60, 60, 60, 60]),
    ];
    // 10 * 1.25 = 12.5 -> 13, floored at the minimum clamp.
    expect(learnBaseBudget(records, { role: "explore", model: "fast" })).toBe(LEARNED_BUDGET_MIN);
    expect(learnBaseBudget(records, { role: "explore", model: "slow" })).toBe(75);
  });

  it("falls back to the same-role pool when the model pool is too small", () => {
    const records = [
      ...samples("explore", "fast", [60, 60]), // only 2 for this model
      ...samples("explore", "slow", [60, 60, 60]),
      ...samples("explore", undefined, []),
    ];
    // Same-role pool = 5 samples, all 60 -> 75.
    expect(learnBaseBudget(records, { role: "explore", model: "fast" })).toBe(75);
  });

  it("ignores other roles entirely", () => {
    const records = samples("general-purpose", "m1", [100, 100, 100, 100, 100]);
    expect(learnBaseBudget(records, { role: "explore", model: "m1" })).toBeUndefined();
  });

  it("clamps the result to [LEARNED_BUDGET_MIN, LEARNED_BUDGET_MAX]", () => {
    expect(learnBaseBudget(samples("r", undefined, [1, 1, 1, 1, 1]), { role: "r" })).toBe(LEARNED_BUDGET_MIN);
    expect(learnBaseBudget(samples("r", undefined, [500, 500, 500, 500, 500]), { role: "r" })).toBe(
      LEARNED_BUDGET_MAX,
    );
    expect(LEARNED_BUDGET_MAX).toBeLessThanOrEqual(SUBAGENT_MAX_TURNS_CEILING);
  });

  it("one outlier run cannot move the budget past the clamp", () => {
    const records = samples("r", undefined, [30, 30, 30, 30, 10_000]);
    const learned = learnBaseBudget(records, { role: "r" });
    expect(learned).toBeGreaterThanOrEqual(LEARNED_BUDGET_MIN);
    expect(learned).toBeLessThanOrEqual(LEARNED_BUDGET_MAX);
  });

  it("only the last 30 records of a pool count (recent history wins)", () => {
    const old = samples("r", undefined, Array.from({ length: 30 }, () => 100));
    const recent = samples("r", undefined, Array.from({ length: 30 }, () => 25));
    // Chronological order: old first, recent last. Only `recent` is in the window.
    expect(learnBaseBudget([...old, ...recent], { role: "r" })).toBe(Math.ceil(25 * 1.25));
  });
});

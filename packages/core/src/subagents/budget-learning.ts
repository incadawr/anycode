/**
 * TASK.4721: the base subagent turn budget learned from accepted-task history.
 *
 * Only the ADAPTIVE mode consults this (`CeilingConfig.adaptive` on, via the
 * `tools.adaptiveTurnBudget` setting). The learned value sits BELOW every
 * explicit user bound: a request's maxTurns, a role's declared turnBudget and
 * the `tools.subagentMaxTurns` setting all still win.
 *
 * "Accepted" is a PROXY. The parent's acceptance is not observable from here,
 * so a finished child is training data only when it is evidence the work was
 * done:
 *  - `completed` and not truncated, or
 *  - `max_turns` where the child itself declared the work done at its ceiling.
 * Stopping at the limit (plain `max_turns`), `error` and `cancelled` are never
 * recorded: hitting the limit is a LOWER bound on the need, not an optimum, and
 * a failed run must not be allowed to move the global default.
 *
 * The formula is deliberately small and bounded: p90 of the pool's turns plus
 * 25% headroom, clamped to [LEARNED_BUDGET_MIN, LEARNED_BUDGET_MAX] and to the
 * runaway ceiling. One run therefore cannot move the budget far.
 *
 * Pure: no I/O. The desktop host owns the history store and feeds records in.
 */

import { SUBAGENT_MAX_TURNS_CEILING } from "../types/config.js";

/** One accepted child run, as stored in the history. */
export interface BudgetSample {
  role: string;
  model?: string;
  turns: number;
}

/** The outcome fields the training filter reads (inline and session tiers alike). */
export interface BudgetOutcomeLike {
  status: string;
  turns: number;
  truncated?: boolean;
  declaredDoneAtCeiling?: boolean;
}

/** Fewest samples a pool needs before its p90 is trusted. */
export const LEARNING_MIN_SAMPLES = 5;
/** Only the most recent N records of a pool are considered. */
export const LEARNING_POOL_SIZE = 30;
/** Headroom multiplier on the p90 turn count. */
export const LEARNING_HEADROOM = 1.25;
/** Lowest value the learner may produce. */
export const LEARNED_BUDGET_MIN = 20;
/** Highest value the learner may produce (also capped by the runaway ceiling). */
export const LEARNED_BUDGET_MAX = 120;

/** The training filter: does this finished child count as an accepted task? */
export function isAcceptedBudgetSample(outcome: BudgetOutcomeLike): boolean {
  if (outcome.status === "completed") {
    return outcome.truncated !== true;
  }
  if (outcome.status === "max_turns") {
    return outcome.declaredDoneAtCeiling === true;
  }
  return false;
}

/** Nearest-rank 90th percentile of a non-empty list of turn counts. */
export function p90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] as number;
}

/**
 * The learned base budget for `key`, or undefined when there is not enough
 * history to trust. `records` is chronological (oldest first).
 *
 * Pool: the same role AND model (last LEARNING_POOL_SIZE). When that is below
 * LEARNING_MIN_SAMPLES, the same-role pool (last LEARNING_POOL_SIZE) is used
 * instead. Fewer than LEARNING_MIN_SAMPLES in that pool too => undefined.
 */
export function learnBaseBudget(
  records: readonly BudgetSample[],
  key: { role: string; model?: string },
): number | undefined {
  const sameRole = records.filter((record) => record.role === key.role);
  const sameModel =
    key.model !== undefined ? sameRole.filter((record) => record.model === key.model) : [];
  let pool = sameModel.slice(-LEARNING_POOL_SIZE);
  if (pool.length < LEARNING_MIN_SAMPLES) {
    pool = sameRole.slice(-LEARNING_POOL_SIZE);
  }
  if (pool.length < LEARNING_MIN_SAMPLES) {
    return undefined;
  }
  const raw = Math.ceil(p90(pool.map((record) => record.turns)) * LEARNING_HEADROOM);
  return Math.min(Math.max(raw, LEARNED_BUDGET_MIN), LEARNED_BUDGET_MAX, SUBAGENT_MAX_TURNS_CEILING);
}

/**
 * Provider-usage recording shared by the host's two audit writers: the main
 * session sink (`usage_audit` per completed step) and the subagent recorder.
 *
 * The one thing they must never disagree about is TIME. A tariff-carrying
 * price (DeepSeek) is billed by the step's own instant, and the row stores
 * that same instant as `createdAt` — so `priceUsageStep` reads ONE instant and
 * hands back both halves. Reading two instants would let a step that finished
 * at 03:59:59.999 be stored as a 04:00:00.000 row: the peak charge would be
 * filed under an off-peak timestamp, and every later audit (and the context
 * popover) would read a cost whose basis disagrees with its own time.
 *
 * That instant is the MODEL STEP's, not the write's: the host stages a
 * finished step and flushes it only after the turn's tool dispatch and any
 * approval completes, so a response finished at 03:59 and priced at 04:05
 * would otherwise be billed off-peak. Callers pass the instant they captured
 * at the finish (`finishedAt`); the write-clock fallback exists only for
 * writers with no delayed flush (the inline-subagent recorder writes live).
 *
 * Both host call sites resolve the catalog/override price on their own (they
 * guard the exact-endpoint rule differently) and then go through here, so a
 * test can drive the real recording path with a controlled clock.
 */

import type { CatalogProviderEntry, ProviderUsageRecord } from "@anycode/core";
import type { ModelPricing } from "@anycode/core/catalog";
import { calculateUsageCost, catalogRateFor, declaredPricingMode, resolveUsagePrice } from "./usage-cost.js";

/** Provider-reported token counts of one finished step. */
export interface UsageTokens {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StepPricing {
  /**
   * The catalog rate already resolved for the provider endpoint, or undefined
   * when the endpoint is a proxy/reseller (which may charge differently) or the
   * model is unpriced.
   */
  price?: ModelPricing | undefined;
  catalogEntry?: CatalogProviderEntry | undefined;
  baseUrl?: string | undefined;
  /** The connection's override envelope (`ANYCODE_CONNECTION_PRICING`). */
  pricingRaw: string | undefined;
  /** Absent when the provider reported no model id (e.g. an engine child). */
  model?: string;
  /**
   * The instant THIS model step finished, captured when its finish event
   * arrived. A delayed write (the session sink stages at finish and flushes
   * after tool dispatch) must price the step by this instant, not by the
   * flush's — otherwise a step that crossed a tariff boundary is billed in
   * the wrong band. Absent ⇒ the write clock below.
   */
  finishedAt?: number;
  /** Clock; defaults to `Date.now`. Tests pass a fixed instant. */
  now?: () => number;
}

/**
 * Price one finished step and stamp it. Returns the `createdAt` to persist
 * alongside the cost it produced — one clock reading, never two.
 */
export function priceUsageStep(
  usage: UsageTokens,
  pricing: StepPricing,
): {
  createdAt: number;
  cost: { costUsd?: number; cacheSavingsUsd?: number; priceBasisId: string } | undefined;
} {
  const createdAt = pricing.finishedAt ?? (pricing.now ?? Date.now)();
  const price = pricing.baseUrl === undefined ? pricing.price : catalogRateFor(pricing.catalogEntry, pricing.baseUrl, pricing.model, declaredPricingMode(pricing.pricingRaw));
  const override = resolveUsagePrice(pricing.pricingRaw, pricing.model ?? "", price);
  const cost = override?.subscription
    ? { priceBasisId: "subscription" }
    : calculateUsageCost(usage, override?.price, createdAt);
  return { createdAt, cost };
}

/** The main session sink's row: what the host hands `recordProviderUsage`. */
export function sessionUsageRow(
  record: Omit<ProviderUsageRecord, "sessionId" | "createdAt" | "costUsd" | "cacheSavingsUsd" | "priceBasisId">,
  pricing: StepPricing,
  sessionId: string,
): ProviderUsageRecord {
  const { createdAt, cost } = priceUsageStep(record, pricing);
  return { ...record, ...cost, sessionId, createdAt };
}

/** The subagent recorder's row, stamped with the subagent's own turn id. */
export function subagentUsageRow(
  usage: UsageTokens,
  pricing: StepPricing,
  ids: { subagentId: string; sessionId: string; step: number },
): ProviderUsageRecord {
  const { createdAt, cost } = priceUsageStep(usage, pricing);
  // The subagent's own turn id: every subagent step is a turn of its own, so
  // the audit never merges two children's steps into one turn.
  return {
    ...usage,
    ...cost,
    subagentId: ids.subagentId,
    sessionId: ids.sessionId,
    turnId: ids.subagentId,
    step: ids.step,
    createdAt,
    model: pricing.model,
    finishReason: "unknown",
    transportRetries: 0,
  };
}

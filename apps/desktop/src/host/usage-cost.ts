import type { ModelPricing } from "@anycode/core/catalog";

/** Snapshot a cost only when the provider supplied enough information to price it. */
export function calculateUsageCost(
  usage: { inputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; outputTokens?: number },
  price: ModelPricing | undefined,
): { costUsd: number; cacheSavingsUsd: number; priceBasisId: string } | undefined {
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output } = usage;
  const write = usage.cacheWriteTokens ?? 0;
  if (price === undefined || input === undefined || cached === undefined || output === undefined ||
      ![input, cached, write, output, price.input, price.cachedInput, price.output].every((n) => Number.isFinite(n) && n >= 0) ||
      cached + write > input || (write > 0 && (price.cacheWrite === undefined || !Number.isFinite(price.cacheWrite) || price.cacheWrite < 0))) return undefined;
  const costUsd = ((input - cached - write) * price.input + cached * price.cachedInput + write * (price.cacheWrite ?? 0) + output * price.output) / 1_000_000;
  const cacheSavingsUsd = cached * (price.input - price.cachedInput) / 1_000_000;
  if (!Number.isFinite(costUsd) || !Number.isFinite(cacheSavingsUsd)) return undefined;
  return { costUsd, cacheSavingsUsd, priceBasisId: price.basisId };
}

/** Read the connection snapshot passed by main; malformed overrides stay unknown. */
export function connectionPricing(raw: string | undefined): { subscription: true } | { subscription: false; price: ModelPricing } | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.mode === "subscription") return { subscription: true };
    if (value.mode !== "rates" || ![value.input, value.cachedInput, value.output].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
        (value.cacheWrite !== undefined && (typeof value.cacheWrite !== "number" || !Number.isFinite(value.cacheWrite) || value.cacheWrite < 0))) return undefined;
    return { subscription: false, price: { basisId: `connection:${raw}`, input: value.input as number, cachedInput: value.cachedInput as number, output: value.output as number, ...(value.cacheWrite !== undefined ? { cacheWrite: value.cacheWrite as number } : {}) } };
  } catch { return undefined; }
}

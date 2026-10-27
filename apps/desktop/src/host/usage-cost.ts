import type { ModelPricing } from "@anycode/core/catalog";

/** Snapshot a cost only when the provider supplied enough information to price it. */
export function calculateUsageCost(
  usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number },
  price: ModelPricing | undefined,
): { costUsd: number; cacheSavingsUsd: number; priceBasisId: string } | undefined {
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output } = usage;
  if (price === undefined || input === undefined || cached === undefined || output === undefined ||
      ![input, cached, output, price.input, price.cachedInput, price.output].every((n) => Number.isFinite(n) && n >= 0) ||
      cached > input) return undefined;
  return {
    costUsd: ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1_000_000,
    cacheSavingsUsd: cached * (price.input - price.cachedInput) / 1_000_000,
    priceBasisId: price.basisId,
  };
}

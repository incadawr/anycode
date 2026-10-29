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

/** Resolve one complete price for the model, keeping explicit scopes stable. */
export function resolveUsagePrice(raw: string | undefined, model: string, catalog: ModelPricing | undefined): { subscription: true } | { subscription: false; price: ModelPricing } | undefined {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : undefined; } catch { value = undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return catalog ? { subscription: false, price: catalog } : undefined;
  const object = value as Record<string, unknown>;
  const envelope = Object.hasOwn(object, "fallback") || Object.hasOwn(object, "models");
  const fallback = envelope ? object.fallback : object;
  const fallbackPrice = connectionPricing(fallback === undefined ? undefined : JSON.stringify(fallback));
  if (fallbackPrice?.subscription) return fallbackPrice;
  const models = object.models;
  if (envelope && models !== null && typeof models === "object" && !Array.isArray(models) && Object.hasOwn(models, model)) {
    const candidate = (models as Record<string, unknown>)[model];
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const rates = candidate as Record<string, unknown>;
      if ([rates.input, rates.cachedInput, rates.output].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
          (rates.cacheWrite === undefined || (typeof rates.cacheWrite === "number" && Number.isFinite(rates.cacheWrite) && rates.cacheWrite >= 0))) {
        const tuple = { input: rates.input as number, cachedInput: rates.cachedInput as number, output: rates.output as number, ...(rates.cacheWrite === undefined ? {} : { cacheWrite: rates.cacheWrite as number }) };
        return { subscription: false, price: { ...tuple, basisId: `model:${JSON.stringify([model, tuple])}` } };
      }
    }
  }
  return fallbackPrice ?? (catalog ? { subscription: false, price: catalog } : undefined);
}

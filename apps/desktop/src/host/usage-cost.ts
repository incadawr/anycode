import { tariffAt, type ModelPricing } from "@anycode/core/catalog";
import { normalizeAnthropicBaseUrl, resolveBillingMode, type CatalogProviderEntry } from "@anycode/core";

/**
 * Snapshot a cost only when the provider supplied enough information to price
 * it. `timestampMs` is the step's own timestamp: a price that declares a
 * time-of-day tariff is billed at the band that instant falls in, and an
 * unknown/absent timestamp keeps the conservative peak ceiling.
 */
export function calculateUsageCost(
  usage: { inputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; outputTokens?: number },
  price: ModelPricing | undefined,
  timestampMs?: number,
): { costUsd: number; cacheSavingsUsd: number; priceBasisId: string } | undefined {
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output } = usage;
  const write = usage.cacheWriteTokens ?? 0;
  if (price === undefined || input === undefined || cached === undefined || output === undefined ||
      ![input, cached, write, output, price.input, price.cachedInput, price.output].every((n) => Number.isFinite(n) && n >= 0) ||
      cached + write > input || (write > 0 && (price.cacheWrite === undefined || !Number.isFinite(price.cacheWrite) || price.cacheWrite < 0))) return undefined;
  const offPeak = price.tariff !== undefined && timestampMs !== undefined && Number.isFinite(timestampMs) &&
    tariffAt(price.tariff, timestampMs) === "off-peak";
  const rate = offPeak ? price.tariff!.offPeakMultiplier : 1;
  const costUsd = ((input - cached - write) * price.input * rate + cached * price.cachedInput * rate + write * (price.cacheWrite ?? 0) * rate + output * price.output * rate) / 1_000_000;
  const cacheSavingsUsd = cached * (price.input - price.cachedInput) * rate / 1_000_000;
  if (!Number.isFinite(costUsd) || !Number.isFinite(cacheSavingsUsd)) return undefined;
  return { costUsd, cacheSavingsUsd, priceBasisId: offPeak ? `${price.basisId}+off-peak` : price.basisId };
}

/**
 * The catalog's own per-token rate for a model — or `undefined` when that
 * rate must NOT be applied.
 *
 * The rate is withheld when the catalog entry's endpoint serves BOTH a
 * pay-as-you-go key and a subscription key (`sharedBillingEndpoint` — the
 * MiniMax case, where the API key and the M Plan key are used on the SAME
 * base URL) and the connection has not said which one it holds. An unset
 * pricing mode then means "unknown", not "the API rate": showing a
 * per-token estimate to a subscription user is a number that is simply wrong
 * for them. An explicit choice (the catalog/API rate, the subscription, or
 * custom rates) always wins — see `resolveBillingMode`.
 *
 * The entry is also required to be the EXACT endpoint the connection talks
 * to: a proxy or reseller may charge a different price even when it exposes
 * the same model.
 */
export function catalogRateFor(
  entry: CatalogProviderEntry | undefined,
  baseUrl: string,
  model: string | undefined,
  declaredMode: "subscription" | "rates" | "catalog" | undefined,
): ModelPricing | undefined {
  if (entry === undefined) return undefined;
  if (normalizeAnthropicBaseUrl(baseUrl) !== normalizeAnthropicBaseUrl(entry.baseUrl)) return undefined;
  if (resolveBillingMode(entry, declaredMode) !== "catalog") return undefined;
  if (model === undefined) return undefined;
  return entry.models.find((item) => item.id === model)?.pricing;
}

/** Read the declared billing mode from the same snapshot used to price usage. */
export function declaredPricingMode(raw: string | undefined): "subscription" | "rates" | "catalog" | undefined {
  try {
    const value = raw ? JSON.parse(raw) : undefined;
    const pricing = value && typeof value === "object" && (Object.hasOwn(value, "fallback") || Object.hasOwn(value, "models")) ? value.fallback : value;
    const mode = pricing?.mode;
    return mode === "subscription" || mode === "rates" || mode === "catalog" ? mode : undefined;
  } catch { return undefined; }
}

/** Add a key-derived default without changing an explicit connection choice. */
export function pricingSnapshotWithKeyDefault(raw: string | undefined, entry: CatalogProviderEntry | undefined, key: string | undefined): string | undefined {
  if (entry?.id !== "minimax" && entry?.id !== "minimax-cn") return raw;
  if (declaredPricingMode(raw) !== undefined) return raw;
  const mode = key?.startsWith("sk-cp-") ? "subscription" : key?.startsWith("sk-api-") ? "catalog" : undefined;
  if (mode === undefined) return raw;
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : undefined; } catch { return raw; }
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) return raw;
  const object = (value ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(object, "mode")) return raw;
  return JSON.stringify({ ...object, fallback: { mode, keyDerived: true } });
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
  if (fallbackPrice?.subscription && !(fallback && typeof fallback === "object" && (fallback as Record<string, unknown>).keyDerived === true)) return fallbackPrice;
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

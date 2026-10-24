/**
 * Fetch wrapper for provider-reported quota capture (Taskana 4090 / TASK.71).
 *
 * The AI SDK factory options all accept a `fetch` override, and a wrapping
 * fetch is the ONE interception point that sees response HEADERS without
 * touching the SDK's stream decode. This module builds the canonical header
 * bag (`headerBagFrom`) the pure parser in ./quota.ts consumes, and the
 * wrapper (`wrapFetchWithQuota`) that offers every response's headers to the
 * observer. The callback must never kill a model call: any throw it makes is
 * swallowed, and the response passes through byte-identical.
 */

import { providerQuotaFromHeaders, type ProviderQuotaUpdate, type QuotaHeaderBag } from "./quota.js";

/**
 * Builds the canonical header bag over a standard fetch `Response`. `Headers`
 * has no `headersNames()`; it DOES expose `keys()` (the WHATWG spec iterable),
 * which is what `names()` iterates here.
 */
export function headerBagFrom(response: { status: number; headers: Headers }): QuotaHeaderBag {
  return {
    status: response.status,
    get: (name) => response.headers.get(name),
    names: () => response.headers.keys(),
  };
}

/**
 * Wraps `fetchImpl` so every response's headers are offered to `onQuota`.
 * Pure interception: the request init is forwarded verbatim and the response
 * object is returned untouched (same instance, undecoded body).
 */
export function wrapFetchWithQuota(
  fetchImpl: typeof fetch,
  onQuota: (update: ProviderQuotaUpdate | null, baseUrl: string) => void,
  baseUrl: string,
): typeof fetch {
  return async (input, init) => {
    const res = await fetchImpl(input, init);
    try {
      onQuota(providerQuotaFromHeaders(headerBagFrom(res), Date.now()), baseUrl);
    } catch {
      // Never fatal: a quota parse/observer failure must not kill a model call.
    }
    return res;
  };
}

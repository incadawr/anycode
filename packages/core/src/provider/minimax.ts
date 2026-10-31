import { MiniMaxBalanceFailure } from "./failure.js";

/**
 * MiniMax wire-mapping helpers.
 *
 * MiniMax speaks the Anthropic-messages protocol, but its reasoning tier
 * rides `output_config.effort` (an ENUM), not a thinking budget:
 * https://platform.minimax.io/docs/api-reference/text-anthropic-api
 * (checked 2026-10-31) documents
 *
 *   - `output_config.effort` — "Tunes thinking depth for MiniMax-M3.1-Flash.
 *     Accepts low, medium, high, xhigh, and max; defaults to max when
 *     omitted." `none` is not supported and returns 400;
 *   - `thinking` — "MiniMax-M3.1-Flash always thinks and returns 400 if
 *     disabled is sent." The endpoint's own error text: `thinking.type=
 *     "disabled" (including reasoning.effort=none) is not allowed (2013)`.
 *     Omitting `thinking` leaves thinking ON;
 *   - `thinking.budget_tokens` — not part of MiniMax's vocabulary at all.
 *
 * So a MiniMax request must carry the effort enum and NO thinking key:
 * a `thinking: {type:"disabled"}` is a hard 400, and a thinking budget is a
 * field the endpoint ignores.
 *
 * The provider names are the CATALOG ENTRY NAMES (the wiring layer sets
 * `providerName` from `catalogEntry.name`, never from the id), so they are
 * matched exactly and pinned by a test — renaming an entry's display name
 * without updating this helper would silently disable the whole mapping.
 */

/** Catalog entry names that carry the MiniMax brand (see catalog-data.ts). */
export const MINIMAX_PROVIDER_NAMES = ["MiniMax", "MiniMax (China)"] as const;

/** The MiniMax model that supports the effort enum. */
export const MINIMAX_EFFORT_MODEL = "MiniMax-M3.1-Flash";

/** The MiniMax model with no effort vocabulary and thinking off by default. */
export const MINIMAX_PLAIN_MODEL = "MiniMax-M3";

/**
 * True for a MiniMax connection on the anthropic-messages transport.
 *
 * `providerName` is the catalog entry's display name. The desktop also
 * resolves custom connections to a catalog entry by their base URL.
 */
export function isMiniMaxProvider(providerName?: string): boolean {
  return (MINIMAX_PROVIDER_NAMES as readonly string[]).includes(providerName ?? "");
}

/**
 * True for a MiniMax connection running one of MiniMax's own models.
 *
 * The model id is matched too, so a MiniMax endpoint serving something else
 * (a vendor-forwarded model, a typo) is not silently given MiniMax's mapping.
 */
export function isMiniMaxModel(providerName?: string, modelId?: string): boolean {
  if (!isMiniMaxProvider(providerName)) {
    return false;
  }
  return modelId === MINIMAX_EFFORT_MODEL || modelId === MINIMAX_PLAIN_MODEL;
}

/**
 * True when this MiniMax model rides the effort enum (M3.1-Flash).
 *
 * `MiniMax-M3` documents no effort levels at all ("output_config.effort —
 * Fully Supported: Tunes thinking depth for MiniMax-M3.1-Flash"), so it is
 * excluded here: sending it an effort the model does not know is a request the
 * endpoint may reject.
 */
export function isMiniMaxEffortModel(providerName?: string, modelId?: string): boolean {
  return isMiniMaxProvider(providerName) && modelId === MINIMAX_EFFORT_MODEL;
}

/** Identify a balance error locally without exposing the key or provider body. */
export function contextualizeMiniMaxBalance(error: unknown, providerName: string | undefined, apiKey: string | undefined): unknown {
  if (!isMiniMaxProvider(providerName) || !apiKey?.startsWith("sk-api-")) return error;
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 24) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const candidate = value as { type?: unknown; code?: unknown; error?: unknown; data?: unknown; responseBody?: unknown };
    if (candidate.type === "insufficient_balance_error" || candidate.code === "insufficient_balance_error" || candidate.code === 1008 || candidate.code === "1008") {
      return new MiniMaxBalanceFailure(error);
    }
    queue.push(candidate.error, candidate.data);
    if (typeof candidate.responseBody === "string") {
      try { queue.push(JSON.parse(candidate.responseBody)); } catch { /* not a structured response */ }
    } else {
      queue.push(candidate.responseBody);
    }
  }
  return error;
}

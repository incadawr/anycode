/**
 * Catalog-driven provider descriptors. Adding a provider = adding an entry with
 * this shape, not code: the dispatcher (language-model.ts) picks the client
 * factory by the resolved `ProviderTransport`.
 *
 * Provider identity and wire transport are DIFFERENT axes (TASK.43 §0.1): one
 * endpoint may speak several protocols (OpenRouter/vLLM expose both OpenAI
 * transports), so the catalog declares a default plus the full supported set
 * instead of collapsing both axes into a single `kind`.
 */

import type { ReasoningEffort } from "../types/config.js";

/**
 * Wire protocol spoken to an endpoint. This is the runtime discriminant every
 * provider factory branches on — never inferred from a URL or a model id.
 */
export type ProviderTransport =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

/** USD per million tokens. A basis ID identifies the immutable rate snapshot. */
export interface ModelPricing {
  basisId: string;
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
  /**
   * Time-of-day tariff (DeepSeek): the listed rates above are the PEAK rates;
   * outside the peak windows every rate is billed at `offPeakMultiplier` ×
   * peak. Absent = the listed rates apply at every hour (all other providers,
   * and all connection/model override rates).
   */
  tariff?: TariffWindow;
}

/**
 * When the listed (peak) rates apply. Days and hours are UTC — read them with
 * `Date#getUTCDay` / `Date#getUTCHours` of the step timestamp, never local time.
 */
export interface TariffWindow {
  /** Days the peak windows apply, `Date#getUTCDay` values (0=Sun … 6=Sat). */
  peakUtcDays: number[];
  /** Peak windows as half-open UTC hour pairs `[startHour, endHour)`. */
  peakUtcHours: [number, number][];
  /** Multiplier applied to every rate outside the peak windows (DeepSeek: 0.5). */
  offPeakMultiplier: number;
}

/**
 * Band for one step's timestamp. "peak" iff the UTC weekday is listed AND the
 * UTC hour falls inside some half-open `[start, end)` peak window; everything
 * else — including the whole weekend — is "off-peak".
 */
export function tariffAt(tariff: TariffWindow, timestampMs: number): "peak" | "off-peak" {
  const at = new Date(timestampMs);
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const peak = tariff.peakUtcDays.includes(day) &&
    tariff.peakUtcHours.some(([start, end]) => hour >= start && hour < end);
  return peak ? "peak" : "off-peak";
}

export interface CatalogModel {
  pricing?: ModelPricing;
  id: string;
  /** Mutating calls between stale-plan reminders (default: 10). */
  todoReminderEvery?: number;
  name?: string;
  contextWindow: number;
  /**
   * The most context the model still works well with, when that is below the
   * advertised `contextWindow` (GLM-5.x: 1M advertised, quality drops past
   * ~300k — owner-measured, 2026-10-07). Sessions budget against this instead:
   * auto-compaction and the context meter use it, so a long run is compacted
   * before it degrades. ANYCODE_CONTEXT_WINDOW still overrides both.
   */
  usableContextWindow?: number;
  maxOutputTokens?: number;
  /** Static hint that the endpoint accepts Anthropic-compatible thinking. */
  reasoning?: boolean;
  /**
   * Effort levels the model's reasoning supports, for UI rendering and override
   * validation. Absent on a `reasoning: true` model defaults to the legacy
   * `["off", "low", "medium", "high"]` set (Anthropic budgetTokens-style).
   * GLM-5.2 declares `["off", "high", "max"]` to mirror its native 3-state UI.
   */
  effortLevels?: ReasoningEffort[];
  /** The provider accepts an explicit no-reasoning effort. */
  supportsExplicitOff?: boolean;
  /** The model cannot disable reasoning. */
  thinkingAlwaysOn?: boolean;
  /**
   * Taskana 4894: the effort tier the PROVIDER applies when the request says
   * nothing — only ever set where the provider's own documentation states it
   * (DeepSeek: "default high"; GLM-5.3: "default max"). It is the rung between
   * "the user picked a level" and "no effort information exists": with no
   * explicit choice, a session both shows and sends this level instead of
   * either guessing (`effortLevels[0]`, which made DeepSeek display `low`) or
   * sending nothing and leaving the user unable to see what the endpoint is
   * really doing. Absent = no recorded provider default, so the pre-4894
   * behaviour stands untouched for that model.
   */
  defaultEffort?: ReasoningEffort;
  /**
   * Static capability hint (Phase 6 slice 6.2): true marks the model as accepting
   * image input. Absent = not marked ⇒ the CLI refuses image attach without the
   * ANYCODE_IMAGE_INPUT=on override.
   */
  imageInput?: boolean;
}

/**
 * Declarative auth block of a catalog entry (slice 2.5 §3.1). `oauth` describes a

 * ships `api_key` only; the OAuth engine (wave 2.5.2) is validated against a
 * fake-IdP, and real providers' oauth blocks are data gated on user decision U1.
 */
export type CatalogAuth =
  | { kind: "api_key" }
  | {
      kind: "oauth";
      authorizationUrl: string;
      tokenUrl: string;
      clientId: string;
      scopes: string[];
    };

export interface CatalogProviderEntry {
  id: string;
  name: string;
  /**
   * TASK.70 (Taskana 4089): the brand this entry belongs to when several
   * catalog entries are the SAME vendor sold via different endpoints (Kimi:
   * kimi.com subscription vs the moonshot platform API). Entries that share a
   * `brand` render as ONE card with a mode selector; the pair below is data,
   * not a merge. Absent on every single-mode brand. It is also the
   * user-visible card label (optgroup / tile header), so it is display-cased.
   */
  brand?: string;
  /**
   * TASK.70 (Taskana 4089): short selector label naming THIS entry's mode
   * inside its brand card (e.g. "Subscription (kimi.com)"). Rendering pairs
   * `brand` + `modeLabel`; `modeLabel` without `brand` must not occur and is
   * guarded by `assertBrandContract`.
   */
  modeLabel?: string;
  /**
   * True when this endpoint serves BOTH a pay-as-you-go key and a
   * subscription key, so the catalog's per-token rate applies to only one of
   * them.
   *
   * MiniMax is the case that forced this: its pay-as-you-go API key and its M
   * Plan subscription key are used on the SAME base URL (owner's live M Plan
   * connection, 2026-10-31) and differ only in billing. A connection that
   * never says which key it holds would otherwise be priced at the API rate,
   * and a subscription user would be shown a per-token estimate for a flat
   * monthly plan — a number that is simply wrong for them.
   *
   * So on such an entry the catalog rate is NOT applied by default: an unset
   * pricing mode prices the usage as UNKNOWN (no cost, no estimate) until
   * the user states which billing they have — the catalog/API rate or the
   * subscription. An explicit choice always wins.
   */
  sharedBillingEndpoint?: boolean;
  /** Full endpoint base (may be empty for `custom`, which sources it from settings). */
  baseUrl: string;
  /**
   * Full base URL per transport, for endpoints whose protocols live under
   * different roots. Absent transport ⇒ `baseUrl`. These are COMPLETE prefixes:
   * no factory appends `/v1` on its own (TASK.43 §0.5), so a non-standard prefix
   * (`https://gw.example/api/openai`) stays expressible.
   */
  transportBaseUrls?: Partial<Record<ProviderTransport, string>>;
  /**
   * COMPLETE URL of the entry's models-list endpoint, for entries whose
   * models route lives under a different root than any transport baseUrl
   * (DeepSeek: anthropic transport at /anthropic, models at the bare origin).
   * LIMITED CONTRACT: declaring this asserts the endpoint follows OpenAI
   * models conventions — `Authorization: Bearer` auth and an
   * `{object:"list",data:[{id}]}` response — regardless of the entry's
   * session transport. Entries whose models route follows the transport's
   * auth shape MUST NOT declare it. Absent ⇒ derived `<base>/v1/models`,
   * unchanged.
   */
  modelsUrl?: string;
  /** Transport used when neither env nor settings pick one. */
  defaultTransport: ProviderTransport;
  /** Every transport this endpoint is known to speak; a UI may only offer these. */
  supportedTransports: ProviderTransport[];
  /** Auth mechanism (slice 2.5 §3.1); defaults to api_key semantics when omitted. */
  auth: CatalogAuth;
  /** Environment variable holding the API key for this provider. */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models: CatalogModel[];
  /** Historical capability hints for saved connections, excluded from suggestions. */
  retiredModels?: CatalogModel[];
  /**
   * True when this endpoint legitimately runs with no credential at all (a
   * local vLLM/Ollama-style server, TASK.43 W5) — readiness does not require a
   * key even though `auth.kind` is still `api_key` for the case a key IS
   * supplied. Absent/false is the byte-compat default: every other entry
   * (including `custom`) keeps requiring a key when its resolved transport is
   * `anthropic-messages` (desktop's readiness gate, cut Risk #3).
   */
  authOptional?: boolean;
}

export interface ProviderCatalog {
  schemaVersion: "anycode.model-providers.v1";
  providers: CatalogProviderEntry[];
}

/* */
export interface ResolvedEndpoint {
  baseUrl: string;
  model: string;
}

/**
 * Pure projection (slice 2.5 §2.2): given a catalog entry, a chosen model id and
 * the resolved api key, returns the {baseUrl, model} pair main writes into a host

 * shaping, not client construction.
 *
 * `baseUrl` is the entry's transport-specific base URL when it declares one, else
 * its plain `baseUrl` (the case for every anthropic-messages entry, whose baseUrl
 * is already the full path). The `custom` entry carries an empty baseUrl — the
 * caller substitutes `settings.provider.baseUrl`. `apiKey` is part of the frozen
 * 2.5.2 contract (a future auth-dependent host may route on it) and is
 * intentionally not read by the v1 projection. `model` passes through verbatim so
 * a free-text model id survives.
 */
export function resolveEndpoint(
  entry: CatalogProviderEntry,
  modelId: string,
  apiKey: string,
  transport: ProviderTransport = entry.defaultTransport,
): ResolvedEndpoint {
  void apiKey;
  if (!entry.supportedTransports.includes(transport)) {
    throw new Error(
      `Provider "${entry.id}" does not support transport "${transport}" (supported: ${entry.supportedTransports.join(", ")})`,
    );
  }
  return { baseUrl: entry.transportBaseUrls?.[transport] ?? entry.baseUrl, model: modelId };
}

/**
 * Dev-time invariant (TASK.43 W5): a catalog entry's `defaultTransport` must be
 * a member of its own `supportedTransports`, else `resolveEndpoint`'s default
 * parameter would immediately throw for every caller that doesn't pass an
 * explicit transport. Called over the whole built-in catalog at module load
 * (catalog-data.ts) so a broken entry fails fast at import time, not the first
 * time a host tries to boot it.
 */
export function assertTransportContract(entry: CatalogProviderEntry): void {
  if (!entry.supportedTransports.includes(entry.defaultTransport)) {
    throw new Error(
      `Catalog entry "${entry.id}": defaultTransport "${entry.defaultTransport}" is not in its own supportedTransports [${entry.supportedTransports.join(", ")}]`,
    );
  }
}

/**
 * Dev-time invariant (TASK.70): an entry may declare `modeLabel` only together
 * with `brand`, and a brand group needs ≥2 declared modes to be a group at all.
 */
export function assertBrandContract(entries: readonly CatalogProviderEntry[]): void {
  const brands = new Map<string, number>();
  for (const entry of entries) {
    if (entry.modeLabel !== undefined && entry.brand === undefined) {
      throw new Error(`Provider "${entry.id}" declares modeLabel without brand`);
    }
    if (entry.brand !== undefined) brands.set(entry.brand, (brands.get(entry.brand) ?? 0) + 1);
  }
  for (const [brand, count] of brands) {
    if (count < 2) throw new Error(`Brand "${brand}" has a single entry — it is not a group`);
  }
}

/**
 * How a connection on this catalog entry is billed.
 *
 * - `"catalog"` — the entry's own per-token rate applies (the default for
 *   every entry whose endpoint serves one kind of key);
 * - `"subscription"` — the user declared a flat plan;
 * - `"unknown"` — the endpoint serves BOTH kinds of key
 *   (`sharedBillingEndpoint`), the user has not said which one they hold, so
 *   the catalog rate CANNOT be applied: showing an API-rate estimate to a
 *   subscription user would be a number that is simply wrong for them.
 */
export type CatalogBillingMode = "catalog" | "subscription" | "unknown";

/**
 * Resolve the billing mode of a connection from the entry's own facts and the
 * connection's declared pricing mode.
 *
 * The connection's declaration always wins when it is explicit:
 * `"subscription"` is a subscription, and the "catalog"/API-rate mode (the
 * drawer's "Catalog or unknown" option) says the per-token rate applies.
 *
 * The ONE case this resolves is the unset mode on a `sharedBillingEndpoint`
 * (MiniMax: its pay-as-you-go key and its M Plan key share the base URL).
 * There the answer is `"unknown"` — no rate, no estimate — until the user
 * picks one. Every other entry keeps the plain `"catalog"` default, so their
 * behaviour is byte-identical to before.
 */
export function resolveBillingMode(
  entry: CatalogProviderEntry | undefined,
  declaredMode: "subscription" | "rates" | "catalog" | undefined,
): CatalogBillingMode {
  if (declaredMode === "subscription") return "subscription";
  if (declaredMode === "rates") return "catalog";
  if (declaredMode === "catalog") return "catalog";
  return entry?.sharedBillingEndpoint === true ? "unknown" : "catalog";
}

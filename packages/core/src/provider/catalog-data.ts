/**
 * Built-in provider catalog v1 (slice 2.5 §2.2). DATA, not code: each entry is

 * model lists are STATIC HINTS only; the UI always also accepts a free-text model

 *
 * AUTH: every v1 entry is `{ kind: "api_key" }` (ruling U1 — real providers'
 * OAuth blocks are gated on a user decision; the OAuth engine is validated
 * against a fake-IdP in wave 2.5.2). `custom` carries an empty baseUrl — the
 * caller substitutes `settings.provider.baseUrl`.
 *
 * Reachable via the `@anycode/core/catalog` subpath export (core package.json),
 * so main can value-import it without pulling the whole barrel (precedent:
 * `@anycode/core/persistence`). Re-exports the catalog types + `resolveEndpoint`
 * so consumers get one import surface.
 */

export type {
  CatalogAuth,
  CatalogModel,
  ModelPricing,
  TariffWindow,
  CatalogProviderEntry,
  ProviderCatalog,
  ProviderTransport,
  ResolvedEndpoint,
} from "./catalog.js";
export { resolveEndpoint, tariffAt } from "./catalog.js";

import {
  assertBrandContract,
  assertTransportContract,
  type CatalogProviderEntry,
  type ProviderCatalog,
  type TariffWindow,
} from "./catalog.js";

/** Sentinel id for the user-supplied endpoint whose baseUrl lives in settings. */
export const CUSTOM_PROVIDER_ID = "custom";

/**
 * GLM-5.x advertises 1M tokens of context, but its answers degrade past ~300k
 * (owner, 2026-10-07, after long orchestration runs). Budgeting sessions on
 * the full 1M put auto-compaction at ~900k — far past that point. The 1M
 * MiMo V2.6 models share the same usable budget.
 */
const LARGE_MODEL_USABLE_CONTEXT_TOKENS = 300_000;

// Token Plan is a credit subscription; displayed costs are pay-as-you-go
// list-price estimates. Its console specifies interactive coding-tool use, not
// automated scripts or backends. Models and regions are from the console.
// Overseas real-time API prices in USD per 1M tokens, accessed 2026-10-30:
// https://mimo.mi.com/docs/en-US/price/pay-as-you-go. Cache write is
// limited-time free, so cacheWrite is 0 until Xiaomi changes it.
const MIMO_MODELS: CatalogProviderEntry["models"] = [
  { id: "mimo-v2.6-pro", pricing: { basisId: "mimo-v2.6-pro-xiaomi-mimo-api-2026-10-30", input: 0.435, cachedInput: 0.0036, cacheWrite: 0, output: 0.87 }, name: "MiMo V2.6 Pro", contextWindow: 1_048_576, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, imageInput: true, reasoning: true },
  { id: "mimo-v2.6-flash", pricing: { basisId: "mimo-v2.6-flash-xiaomi-mimo-api-2026-10-30", input: 0.14, cachedInput: 0.0028, cacheWrite: 0, output: 0.28 }, name: "MiMo V2.6 Flash", contextWindow: 1_048_576, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, imageInput: true, reasoning: true },
];

// DeepSeek bills by time of day (api-docs.deepseek.com/quick_start/pricing/,
// checked 2026-10-27): 01:00–04:00 and 06:00–10:00 UTC on weekdays carry the
// full (peak) rates listed below; every other minute of the week — including
// the whole weekend — is billed at exactly half.
//
// KNOWN LIMIT: Chinese public holidays are off-peak for the whole day on the
// provider's page, but no holiday calendar is modelled here. A holiday that
// falls inside a peak window is therefore priced at peak, i.e. the cost shown
// can be up to 2x the real charge. Both prices remain ESTIMATES (the popover
// labels them "rate estimates"), so this never reads as an exact bill.
const DEEPSEEK_TARIFF: TariffWindow = {
  peakUtcDays: [1, 2, 3, 4, 5],
  peakUtcHours: [[1, 4], [6, 10]],
  offPeakMultiplier: 0.5,
};

const ENTRIES: CatalogProviderEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      // Live Claude lineup, checked 2026-10-27. Specs (API id, 1M-token
      // context, 128K max output, text+image input) come from
      // platform.claude.com/docs/en/models/overview; rates from
      // platform.claude.com/docs/en/about-claude/pricing, USD per 1M tokens,
      // standard (non-batch) tier. `cachedInput` is that page's "hits and
      // refreshes" column; `cacheWrite` is the 5-minute cache write (the 1-hour
      // write is a separate, pricier row). Order follows Anthropic's own
      // advice ("start with Claude Opus 5.5"), since the first row is what an
      // empty model field prefills; Fable 5.1 is last because it is the
      // specialist tier, not the default.
      //
      // Effort levels and defaults: https://platform.claude.com/docs/en/build-with-claude/effort (checked 2026-10-28).
      // Opus 5.5: $4 in / $0.20 hit / $5 5m write / $20 out.
      { id: "claude-opus-5-5", pricing: { basisId: "claude-opus-5-5-anthropic-2026-10-27", input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 }, name: "Claude Opus 5.5", contextWindow: 1_000_000, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      // Sonnet 5.5: $2 in / $0.10 hit / $2.50 5m write / $10 out.
      { id: "claude-sonnet-5-5", pricing: { basisId: "claude-sonnet-5-5-anthropic-2026-10-27", input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, name: "Claude Sonnet 5.5", contextWindow: 1_000_000, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
      // Haiku 5.5: the pricing page tiers it by prompt length — these are the
      // "prompts up to 100,000 tokens" rates ($0.10 in / $0.01 hit / $0.125 5m
      // write / $0.50 out); prompts over 100k pay $0.50 / $0.05 / $0.625 / $2.50.
      { id: "claude-haiku-5-5", pricing: { basisId: "claude-haiku-5-5-anthropic-2026-10-27", input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, name: "Claude Haiku 5.5", contextWindow: 1_000_000, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      // Fable 5.1: $10 in / $0.25 hit / $12.50 5m write / $50 out.
      { id: "claude-fable-5-1", pricing: { basisId: "claude-fable-5-1-anthropic-2026-10-27", input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 }, name: "Claude Fable 5.1", contextWindow: 1_000_000, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
    ],
    retiredModels: [
      { id: "claude-opus-4-20250514", name: "Claude Opus 4", contextWindow: 200_000, imageInput: true, reasoning: true, effortLevels: ["off", "low", "medium", "high"] },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200_000, imageInput: true, reasoning: true, effortLevels: ["off", "low", "medium", "high"] },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 200_000, imageInput: true },
    ],
  },
  {
    id: "z-ai",
    name: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    // TASK.113 (2026-08-15): refreshed to the live docs.z.ai model line (guides/llm
    // sidebar + each page's spec box and code samples). Fresh-first so the first
    // chip — the empty-model prefill — is the newest model. reasoning/effortLevels
    // stay only where a source confirmed them (glm-5.2's native 3-state UI, and
    // glm-5.3 — same 5.x thinking line, owner-confirmed live on the coding plan);
    // the rest of the 5.x/4.7 line advertises "multiple thinking modes" without a
    // confirmed level set, so those fields stay absent rather than guessed.
    // The z.ai effort mapping itself is provider-level, not per-model
    // (`reasoningRequestOptions`, providerName "Z.AI (GLM)": effort high/max +
    // a thinking budget), so a missing `reasoning: true` here is what silently
    // drops a connection's stored effort — the model list is the only gate.
    // GLM-5.3's id is owner-confirmed live on the coding plan (works via manual
    // entry); docs.z.ai carries the page but no code sample yet ("API coming
    // soon"). 4.5/4.5-air numbers predate this pass and are kept as-is.
    //
    // TASK.163 (2026-08-28, re-verified via WebFetch): the pass above got the
    // glm-5.3 row wrong. docs.z.ai/guides/llm/glm-5.3 states "GLM-5.3 always
    // operates with reasoning enabled" and "Disabling reasoning is no longer
    // supported", with three documented effort levels "low", "high", and "max"
    // (default "max") — `off` never belonged in effortLevels; `low` was
    // missing. Corrected below. docs.z.ai/guides/vlm/glm-5.3-flash adds the
    // flash row: "Text parameters are consistent with GLM-5.3" (1M context,
    // same low/high/max family), "`thinking.type` only supports `enabled`;
    // thinking cannot be disabled". The GLM wire mapping (`reasoningRequestOptions` in
    // model-port.ts) was fixed in the same slice so a selected `low` reaches
    // the wire as `low` instead of silently upgrading to `high` — otherwise
    // advertising `low` here would have been a fresh lie.
    //
    // TASK.170 (2026-08-29, re-verified via direct fetch of the raw page, not
    // just the summarizing fetch): the flash page's spec card now reads
    // "Input Modality: Video / Image / Text / File", "Output Modality: Text",
    // "Context Length: 1M", "Maximum Output Tokens: 128K" — the "max output
    // length is never stated" claim above was true on 2026-08-28 but the page
    // has since been filled in (site was mid-launch: TASK.163's own comment
    // flagged "API coming soon" for 5.3 the day before). `maxOutputTokens` is
    // filled in below from that spec card. Without it, a subagent spawned on
    // glm-5.3-flash silently got DEFAULT_MAX_OUTPUT_TOKENS (32_768, a ~4x drop
    // from the parent glm-5.3's 131_072) — the TASK.170 defect.
    //
    // TASK.197 (2026-08-30, owner's ruling): `imageInput: true` on the FLASH
    // row. Two prior passes read the same spec card ("Input Modality: Video /
    // Image / Text / File") and still withheld the flag, on the argument that
    // a spec card is not proof the Anthropic-messages endpoint accepts image
    // blocks. That caution was never a rule — the four kimi.com rows below and
    // the moonshot line declare `imageInput: true` over this SAME transport
    // with no such proof either — so it was inconsistency, not conservatism,
    // and it cost the owner the feature twice (asked 2026-08-29, asked again
    // 2026-08-30). The owner runs this model daily and states its images work;
    // that is the measurement this row now records. NON-flash `glm-5.3` stays
    // unmarked on purpose: it is documented under `guides/llm/`, not
    // `guides/vlm/`, and nobody has claimed images for it.
    models: [
      // Current Z.AI text models, checked 2026-10-27 against
      // docs.z.ai/guides/overview/overview (the provider's own model matrix)
      // and docs.z.ai/guides/overview/pricing. Prices are USD per 1M tokens:
      // "Input" / "Cached Input" / "Output". Z.AI lists a single rate per model
      // (no peak/off-peak, no context tier), so those ARE the whole table.
      // Newly cached content is billed at the standard input rate; cache
      // storage is free (https://docs.z.ai/guides/capabilities/cache, 2026-10-28).
      // Dropped 2026-10-27 because Z.AI no longer lists them as current:
      // `glm-5-turbo` (absent from both pages), `glm-4.5` and `glm-4.5-air`
      // (still billed under the page's collapsed "Other Pricing" table, but no
      // longer in the model matrix). A connection carrying those ids as free
      // text keeps working — the catalog is a hint list, not an allow-list.
      // GLM-5.3/5.3-flash/5.3-flashx/5.2: 1M context, 128K max output
      // (docs.z.ai spec boxes; the 5.3-Flash page states "Context Length 1M",
      // "Maximum Output Tokens 128K" for the flash/flashx pair).
      // GLM-5.3: $1.4 in / $0.26 cached / $4.4 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-5.3", pricing: { basisId: "glm-5.3-zai-2026-10-27", input: 1.4, cachedInput: 0.26, cacheWrite: 1.4, output: 4.4 }, name: "GLM-5.3", contextWindow: 1_000_000, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["low", "high", "max"], defaultEffort: "max" },
      // GLM-5.3-Flash: $0.15 in / $0.03 cached / $0.50 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-5.3-flash", pricing: { basisId: "glm-5.3-flash-zai-2026-10-27", input: 0.15, cachedInput: 0.03, cacheWrite: 0.15, output: 0.5 }, name: "GLM-5.3 Flash", contextWindow: 1_000_000, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"] },
      // GLM-5.3-FlashX: the same model at ~200 tokens/s. Model code and the
      // family's "Video / Image / Text / File" input plus "thinking.type only
      // supports enabled" come from docs.z.ai/guides/vlm/glm-5.3-flash
      // (2026-10-27); $0.37 in / $0.075 cached / $1.25 out from
      // docs.z.ai/guides/overview/pricing (2026-10-27).
      { id: "glm-5.3-flashx", pricing: { basisId: "glm-5.3-flashx-zai-2026-10-27", input: 0.37, cachedInput: 0.075, cacheWrite: 0.37, output: 1.25 }, name: "GLM-5.3 FlashX", contextWindow: 1_000_000, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"] },
      // GLM-5.2: $1.4 in / $0.26 cached / $4.4 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-5.2", pricing: { basisId: "glm-5.2-zai-2026-10-27", input: 1.4, cachedInput: 0.26, cacheWrite: 1.4, output: 4.4 }, name: "GLM-5.2", contextWindow: 1_000_000, usableContextWindow: LARGE_MODEL_USABLE_CONTEXT_TOKENS, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["off", "high", "max"] },
      // GLM-5.1/5/4.7/4.6: 200K context, 128K max output (docs.z.ai spec boxes).
      // GLM-5.1: $1.4 in / $0.26 cached / $4.4 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-5.1", pricing: { basisId: "glm-5.1-zai-2026-10-27", input: 1.4, cachedInput: 0.26, cacheWrite: 1.4, output: 4.4 }, name: "GLM-5.1", contextWindow: 200_000, maxOutputTokens: 131_072 },
      // GLM-5: $1 in / $0.2 cached / $3.2 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-5", pricing: { basisId: "glm-5-zai-2026-10-27", input: 1, cachedInput: 0.2, cacheWrite: 1, output: 3.2 }, name: "GLM-5", contextWindow: 200_000, maxOutputTokens: 131_072 },
      // GLM-4.7: $0.6 in / $0.11 cached / $2.2 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-4.7", pricing: { basisId: "glm-4.7-zai-2026-10-27", input: 0.6, cachedInput: 0.11, cacheWrite: 0.6, output: 2.2 }, name: "GLM-4.7", contextWindow: 200_000, maxOutputTokens: 131_072 },
      // GLM-4.6: $0.6 in / $0.11 cached / $2.2 out (docs.z.ai/guides/overview/pricing, 2026-10-27).
      { id: "glm-4.6", pricing: { basisId: "glm-4.6-zai-2026-10-27", input: 0.6, cachedInput: 0.11, cacheWrite: 0.6, output: 2.2 }, name: "GLM-4.6", contextWindow: 200_000, maxOutputTokens: 131_072 },
    ],
    retiredModels: [
      { id: "glm-5-turbo", name: "GLM-5 Turbo", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    // 4244: the models list lives at the bare origin, not under the anthropic
    // transport prefix. GET https://api.deepseek.com/models, Bearer auth,
    // OpenAI-style {object:"list",data:[{id}]} — hence modelsUrl's contract.
    modelsUrl: "https://api.deepseek.com/models",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      // TASK 4241 (2026-10-10): rows replaced from the supplied authoritative
      // live GET /models facts. Default effort is high — carried as
      // `defaultEffort` on both rows (Taskana 4894), so a session with no
      // explicit pick shows AND sends `high` instead of falling back to the
      // vocabulary's first entry (`low`).
      // https://api-docs.deepseek.com/quick_start/pricing/ — checked 2026-10-27.
      // Peak rates; the tariff below tells which hours they apply to.
      { id: "deepseek-flash", pricing: { basisId: "deepseek-flash-deepseek-peak-2026-10-27", input: 0.3, cachedInput: 0.006, output: 1.2, tariff: DEEPSEEK_TARIFF }, name: "DeepSeek-V4.1-Flash", contextWindow: 1_048_576, maxOutputTokens: 393_216, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"], defaultEffort: "high", todoReminderEvery: 20 },
      // Official DeepSeek pricing page, checked 2026-10-27
      // (api-docs.deepseek.com/quick_start/pricing, checked 2026-10-27) lists
      // peak / off-peak rates; off-peak is exactly half of peak. The PEAK rate
      // is recorded (the conservative ceiling) together with the tariff window
      // below, so each step is priced by its own timestamp: peak hours pay the
      // ceiling, every other minute pays half. V4-Pro peak: $1.32 in / $0.044
      // cache hit / $3.96 out per 1M tokens; off-peak is $0.66 / $0.022 / $1.98.
      { id: "deepseek-v4-pro", pricing: { basisId: "deepseek-v4-pro-deepseek-peak-2026-10-27", input: 1.32, cachedInput: 0.044, output: 3.96, tariff: DEEPSEEK_TARIFF }, name: "DeepSeek-V4-Pro", contextWindow: 1_048_576, maxOutputTokens: 393_216, reasoning: true, effortLevels: ["low", "high", "max"], defaultEffort: "high", todoReminderEvery: 20 },
    ],
  },
  {
    id: "xiaomi-mimo-api",
    name: "Xiaomi MiMo API",
    brand: "Xiaomi MiMo",
    modeLabel: "API (pay as you go)",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: MIMO_MODELS,
  },
  {
    id: "xiaomi-mimo-sgp",
    name: "Xiaomi MiMo Token Plan (SGP)",
    brand: "Xiaomi MiMo",
    modeLabel: "Token Plan (SGP)",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: MIMO_MODELS,
  },
  {
    id: "xiaomi-mimo-cn",
    name: "Xiaomi MiMo Token Plan (CN)",
    brand: "Xiaomi MiMo",
    modeLabel: "Token Plan (CN)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: MIMO_MODELS,
  },
  {
    id: "xiaomi-mimo-ams",
    name: "Xiaomi MiMo Token Plan (AMS)",
    brand: "Xiaomi MiMo",
    modeLabel: "Token Plan (AMS)",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: MIMO_MODELS,
  },
  {
    id: "moonshot",
    // TASK.70 (Taskana 4089): one brand = one card; this entry is the platform
    // API mode of the Kimi brand card.
    name: "Moonshot (Kimi, platform API)",
    brand: "Kimi",
    modeLabel: "Platform API (moonshot.ai)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      // Current platform models, checked 2026-10-27 against
      // platform.kimi.ai/docs/models (the provider's Model List). The two rows
      // that used to be here (`kimi-k2-0711-preview`, `moonshot-v1-128k`) are
      // on that page's own Deprecated list — discontinued 2026-05-25 and
      // 2026-08-31 — so they are gone from the hint list. A connection that
      // still carries one of those ids as free text keeps working.
      // Context windows: the pricing page states "All K3 series models support
      // a 1,048,576-token context window" and "All K2 series models support a
      // 262,144-token context window" (platform.kimi.ai/docs/pricing/chat).
      // `imageInput` only where the Model List says so ("native visual
      // understanding" for K3/K3.1, "visual and text input" for K2.6).
      // K3 rates: https://platform.kimi.ai/docs/pricing/chat (Model Inference
      // Pricing) checked 2026-10-30, USD per million tokens. `cacheWrite` is
      // the table's 5m-TTL write rate (1h writes cost 2× and are not billed
      // anywhere here); the 2026-10-27 pass had cited the site root instead
      // of this page. No output ceiling is published on the model list.
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30.
      { id: "kimi-k3.1-pro", pricing: { basisId: "kimi-k3.1-pro-kimi-2026-10-30", input: 2, cachedInput: 0.2, cacheWrite: 2, output: 10 }, name: "Kimi K3.1 Pro", contextWindow: 1_048_576, imageInput: true },
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30.
      { id: "kimi-k3.1-pro-highspeed", pricing: { basisId: "kimi-k3.1-pro-highspeed-kimi-2026-10-30", input: 4, cachedInput: 0.2, cacheWrite: 4, output: 20 }, name: "Kimi K3.1 Pro Highspeed", contextWindow: 1_048_576, imageInput: true },
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30.
      { id: "kimi-k3", pricing: { basisId: "kimi-k3-kimi-2026-10-30", input: 3, cachedInput: 0.3, cacheWrite: 3, output: 15 }, name: "Kimi K3", contextWindow: 1_048_576, imageInput: true },
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30. The
      // K2 table (Model / Input / Output / Cached input) was filled in after
      // the 2026-10-28 pass found no rates; it publishes no cache-write
      // column, so `cacheWrite` stays undefined.
      { id: "kimi-k2.7-code", pricing: { basisId: "kimi-k2.7-code-kimi-2026-10-30", input: 0.95, cachedInput: 0.19, output: 4 }, name: "Kimi K2.7 Code", contextWindow: 262_144 },
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30.
      { id: "kimi-k2.7-code-highspeed", pricing: { basisId: "kimi-k2.7-code-highspeed-kimi-2026-10-30", input: 1.9, cachedInput: 0.38, output: 8 }, name: "Kimi K2.7 Code Highspeed", contextWindow: 262_144 },
      // https://platform.kimi.ai/docs/pricing/chat — checked 2026-10-30.
      { id: "kimi-k2.6", pricing: { basisId: "kimi-k2.6-kimi-2026-10-30", input: 0.95, cachedInput: 0.16, output: 4 }, name: "Kimi K2.6", contextWindow: 262_144, imageInput: true },
    ],
    retiredModels: [
      { id: "kimi-k2-0711-preview", name: "Kimi K2", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128k", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    // Kimi consumer subscription ("Kimi For Coding", kimi.com): its sk-kimi-*
    // keys are only valid on api.kimi.com/coding — the moonshot platform entry
    // above 401s them (verified live 2026-07-17). Models/262k context/thinking
    // capabilities mirror the endpoint's /v1/models declaration; the K2.7 pair
    // is thinking-only (no "off"), k3 natively declares low/high/max efforts.
    // k3-256k is the same K3 served under its context-suffixed id (both appear
    // in the endpoint's live model list), so it carries K3's capabilities.
    //
    // TASK.170 (2026-08-29): `maxOutputTokens` is deliberately OMITTED on all
    // four rows below. The product's own docs
    // (kimi.com/code/docs/en/kimi-code/models, "Model Configuration" table,
    // fetched and read as raw HTML — not just the summarized version) list
    // Model ID / version / description / speed / context window / reasoning /
    // availability / multimodal input for k3, k3-256k, kimi-for-coding and
    // kimi-for-coding-highspeed, and there is no output-ceiling row or
    // sentence anywhere on that page. The Moonshot Open Platform's separate
    // docs (platform.kimi.ai, api.moonshot.ai) DO document a K3
    // max_completion_tokens default of 131_072 (settable up to 1_048_576), but
    // that is a different product on a different base URL — the comment above
    // already established sk-kimi-* keys 401 against that platform entry, so
    // its numbers are not evidence for what THIS endpoint (api.kimi.com/coding)
    // actually enforces. Copying that sibling's number here would be exactly
    // the guess this file's own convention (effortLevels/reasoning) forbids.
    // Until kimi.com/code publishes an output ceiling or support confirms one,
    // these four resolve through `resolveMaxOutputTokens`'s DEFAULT stub
    // (32_768, TASK.150) — now observable via `onStubFallback` (TASK.170)
    // instead of silently.
    id: "kimi",
    // TASK.70 (Taskana 4089): one brand = one card; this entry is the
    // subscription mode of the Kimi brand card.
    name: "Kimi (kimi.com subscription)",
    brand: "Kimi",
    modeLabel: "Subscription (kimi.com)",
    baseUrl: "https://api.kimi.com/coding",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      // Model list checked 2026-10-27 against
      // kimi.com/code/docs/en/kimi-code/models (the product's own "Model
      // Configuration" table): it now also offers k3.1-pro and
      // k3.1-pro-highspeed. The context column there reads "Up to 1048576 (for
      // higher-tier members)" for k3.1-pro/k3/kimi-for-coding, but access to
      // the 1M window is plan-gated (403 without it), so the rows keep the
      // 262_144 floor this entry has always used rather than promising a window
      // half the users' plans reject.
      //
      // NO `pricing` on purpose (checked 2026-10-27). This endpoint is the
      // membership product, not metered API billing: the same page gates each
      // model by plan tier (Moderato/Andante/…) and quota, and publishes no USD
      // per-1M-token rate; the pay-as-you-go price list on platform.kimi.ai
      // explicitly says it "differs from … Kimi Code". A subscription
      // connection states that with the connection's own "subscription"
      // pricing mode instead of inventing a rate.
      // Names follow the version column of that table: `kimi-for-coding` is
      // served as K2.8 Preview, `kimi-for-coding-highspeed` as K2.7 Code
      // Highspeed.
      { id: "k3.1-pro", name: "K3.1 Pro", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"], defaultEffort: "high" },
      { id: "k3.1-pro-highspeed", name: "K3.1 Pro Highspeed", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"], defaultEffort: "high" },
      { id: "kimi-for-coding", name: "K2.8 Preview", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high"] },
      { id: "kimi-for-coding-highspeed", name: "K2.7 Code Highspeed", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high"] },
      { id: "k3", name: "K3", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"] },
      { id: "k3-256k", name: "K3 256k", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "high", "max"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultTransport: "openai-responses",
    supportedTransports: ["openai-responses", "openai-chat-completions"],
    auth: { kind: "api_key" },
    // Current GPT-6 family, checked 2026-10-27. Ids/specs from each model's own
    // page under developers.openai.com/api/docs/models (all five: 1,050,000
    // context window, 922,000 max input, 128,000 max output, text+image
    // input); rates from developers.openai.com/api/docs/pricing, USD per 1M
    // tokens, standard (non-batch/Flex/Fast) short-context tier — the pricing
    // page states a >272K-input request pays 2x input/cache and 1.5x output.
    // `cachedInput` is that page's "cached input" column, `cacheWrite` its
    // "30m write" column (12h writes cost more and are not what a live session
    // creates).
    // Effort levels and defaults: https://developers.openai.com/api/docs/guides/reasoning
    // and https://developers.openai.com/api/docs/models/gpt-6.1-terra (checked 2026-10-28).
    // OpenAI does not document Astra's default there, so it remains unspecified.
    models: [
      // gpt-6.1-sol: $2 in / $0.10 cached / $2.50 30m write / $10 out.
      { id: "gpt-6.1-sol", pricing: { basisId: "gpt-6.1-sol-openai-2026-10-27", input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, name: "GPT-6.1 Sol", contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      // gpt-6.1-terra: $1 in / $0.05 cached / $1.25 30m write / $5 out.
      { id: "gpt-6.1-terra", pricing: { basisId: "gpt-6.1-terra-openai-2026-10-27", input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 }, name: "GPT-6.1 Terra", contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true, reasoning: true, supportsExplicitOff: true, effortLevels: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      // gpt-6-luna: $0.10 in / $0.01 cached / $0.125 30m write / $0.50 out.
      { id: "gpt-6-luna", pricing: { basisId: "gpt-6-luna-openai-2026-10-27", input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, name: "GPT-6 Luna", contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true, reasoning: true, supportsExplicitOff: true, effortLevels: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      // gpt-6-astra: $10 in / $1 cached / $12.50 30m write / $50 out.
      { id: "gpt-6-astra", pricing: { basisId: "gpt-6-astra-openai-2026-10-27", input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }, name: "GPT-6 Astra", contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true },
      // gpt-6-sol: $2 in / $0.20 cached / $2.50 30m write / $10 out.
      { id: "gpt-6-sol", pricing: { basisId: "gpt-6-sol-openai-2026-10-27", input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }, name: "GPT-6 Sol", contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true, reasoning: true, supportsExplicitOff: true, effortLevels: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
    ],
    retiredModels: [
      { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 400_000, maxOutputTokens: 128_000 },
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000, maxOutputTokens: 16_384, imageInput: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128_000, maxOutputTokens: 16_384, imageInput: true },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultTransport: "openai-chat-completions",
    supportedTransports: ["openai-chat-completions", "openai-responses"],
    auth: { kind: "api_key" },
    // No static hints: OpenRouter's model set is huge and vendor-prefixed
    // (`vendor/model`) — same free-text-only reasoning as `custom`.
    models: [],
  },
  {
    id: "vllm",
    name: "vLLM / local OpenAI-compatible",
    // Template entry (TASK.43 W5): baseUrl lives in settings, exactly like
    // `custom` — `needsBaseUrl` is derived from this empty string downstream
    // (main/settings-ipc.ts `projectCatalogSummary`).
    baseUrl: "",
    defaultTransport: "openai-chat-completions",
    supportedTransports: ["openai-chat-completions"],
    auth: { kind: "api_key" },
    // A local no-auth deployment is the common case; a key is still accepted
    // (and stored under this entry's own `provider.vllm.apiKey`) for gated
    // deployments, but readiness never blocks on it.
    authOptional: true,
    models: [],
  },
  {
    id: CUSTOM_PROVIDER_ID,
    name: "Custom endpoint",

    baseUrl: "",
    // Legacy default: a bare custom endpoint keeps speaking Anthropic — the
    // most common existing use (an Anthropic-compatible bridge). Both OpenAI
    // client factories now exist (W2/W3), so `supportedTransports` widens to
    // all three: the user may explicitly opt a custom endpoint into either
    // OpenAI transport (e.g. a local no-auth vLLM/Ollama server) without
    // changing the default anyone already relies on.
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages", "openai-chat-completions", "openai-responses"],
    auth: { kind: "api_key" },
    // No static hints — free-text model id only.
    models: [],
  },
];

// Dev-time invariant (TASK.43 W5): fail fast at import time if a future entry
// declares a defaultTransport outside its own supportedTransports, rather than
// the first time some caller's default-parameter resolveEndpoint call throws.
for (const entry of ENTRIES) {
  assertTransportContract(entry);
}
assertBrandContract(ENTRIES);

const CATALOG: ProviderCatalog = {
  schemaVersion: "anycode.model-providers.v1",
  providers: ENTRIES,
};

/** The frozen built-in catalog v1. */
export function getBuiltinCatalog(): ProviderCatalog {
  return CATALOG;
}

/** All catalog provider ids (allow-list source for `isKnownSecretKey`). */
export function catalogProviderIds(): string[] {
  return ENTRIES.map((entry) => entry.id);
}

/** Look up one entry by id; undefined when the id is not in the catalog. */
export function findCatalogEntry(id: string): CatalogProviderEntry | undefined {
  return ENTRIES.find((entry) => entry.id === id);
}

/** True when `id` names the user-supplied custom endpoint. */
export function isCustomProvider(id: string): boolean {
  return id === CUSTOM_PROVIDER_ID;
}

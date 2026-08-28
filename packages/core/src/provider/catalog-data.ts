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
  CatalogProviderEntry,
  ProviderCatalog,
  ProviderTransport,
  ResolvedEndpoint,
} from "./catalog.js";
export { resolveEndpoint } from "./catalog.js";

import { assertTransportContract, type CatalogProviderEntry, type ProviderCatalog } from "./catalog.js";

/** Sentinel id for the user-supplied endpoint whose baseUrl lives in settings. */
export const CUSTOM_PROVIDER_ID = "custom";

const ENTRIES: CatalogProviderEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
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
    // thinking cannot be disabled". Its multimodality is demonstrated only via
    // the native API's Chat Completions `image_url` examples, never confirmed
    // through the Anthropic-messages endpoint this entry speaks, so
    // `imageInput` stays OMITTED (fail-closed; ANYCODE_IMAGE_INPUT=on remains
    // the escape hatch). The GLM wire mapping (`reasoningRequestOptions` in
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
    // from the parent glm-5.3's 131_072) — the TASK.170 defect. `imageInput`
    // stays OMITTED regardless: the spec card's input modality is not itself
    // confirmation the Anthropic-messages endpoint accepts image_url on this
    // model, and that verification is a separate concern from output tokens.
    models: [
      // GLM-5.3/5.3-flash/5.2: 1M context, 128K max output (docs.z.ai spec boxes).
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["low", "high", "max"] },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["low", "high", "max"] },
      { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["off", "high", "max"] },
      // GLM-5.1/5/5-turbo/4.7/4.6: 200K context, 128K max output (docs.z.ai spec boxes).
      { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-5", name: "GLM-5", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-5-turbo", name: "GLM-5 Turbo", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-4.7", name: "GLM-4.7", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000, maxOutputTokens: 131_072 },
      { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128_000, maxOutputTokens: 8_192 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128_000, maxOutputTokens: 65_536, reasoning: true, effortLevels: ["off", "high"] },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi, platform API)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
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
    name: "Kimi (kimi.com subscription)",
    baseUrl: "https://api.kimi.com/coding",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      { id: "kimi-for-coding", name: "K2.7 Coding", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high"] },
      { id: "kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed", contextWindow: 262_144, imageInput: true, reasoning: true, effortLevels: ["low", "medium", "high"] },
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
    // Conservative public model ids only; reasoning/effortLevels intentionally
    // omitted until W6 live-smoke confirms per-model tiers (TASK.43 W5).
    models: [
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

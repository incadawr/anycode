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
  ProviderKind,
  ResolvedEndpoint,
} from "./catalog.js";
export { resolveEndpoint } from "./catalog.js";

import type { CatalogProviderEntry, ProviderCatalog } from "./catalog.js";

/** Sentinel id for the user-supplied endpoint whose baseUrl lives in settings. */
export const CUSTOM_PROVIDER_ID = "custom";

const ENTRIES: CatalogProviderEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultKind: "anthropic",
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
    defaultKind: "anthropic",
    auth: { kind: "api_key" },
    models: [
      // GLM-5.2 serves a 1M context window with 128K max output (docs.z.ai, IndexShare sparse attention).
      { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoning: true, effortLevels: ["off", "high", "max"] },
      { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000, maxOutputTokens: 32_768 },
      { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    defaultKind: "anthropic",
    auth: { kind: "api_key" },
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128_000, maxOutputTokens: 8_192 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128_000, maxOutputTokens: 65_536, reasoning: true, effortLevels: ["off", "high"] },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    defaultKind: "anthropic",
    auth: { kind: "api_key" },
    models: [
      { id: "kimi-k2-0711-preview", name: "Kimi K2", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128k", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: CUSTOM_PROVIDER_ID,
    name: "Custom endpoint",

    baseUrl: "",
    defaultKind: "anthropic",
    auth: { kind: "api_key" },
    // No static hints — free-text model id only.
    models: [],
  },
];

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

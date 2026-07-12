/**
 * Catalog-driven provider descriptors (types only in Phase 0).
 * Adding a provider later = adding a JSON entry with this shape, not code:
 * the registry picks the client factory by `kind` (createAnthropic /
 * createOpenAICompatible) and joins baseUrl with the kind-specific path.
 * Phase 0 wires a single anthropic-kind endpoint from env instead.
 */

import type { ReasoningEffort } from "../types/config.js";

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export interface CatalogModel {
  id: string;
  name?: string;
  contextWindow: number;
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
  /** Full endpoint base (may be empty for `custom`, which sources it from settings). */
  baseUrl: string;
  /** Kind-specific API path prefixes, e.g. anthropic -> "/api/anthropic". */
  paths?: Partial<Record<ProviderKind, string>>;
  defaultKind: ProviderKind;
  /** Auth mechanism (slice 2.5 §3.1); defaults to api_key semantics when omitted. */
  auth: CatalogAuth;
  /** Environment variable holding the API key for this provider. */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models: CatalogModel[];
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
 * `baseUrl` is the entry's baseUrl joined with the default-kind path prefix (both
 * empty for v1 anthropic-kind entries, whose baseUrl is already the full path).
 * The `custom` entry carries an empty baseUrl — the caller substitutes
 * `settings.provider.baseUrl`. `apiKey` is part of the frozen 2.5.2 contract
 * (a future auth-dependent host may route on it) and is intentionally not read by
 * the v1 projection. `model` passes through verbatim so a free-text model id

 */
export function resolveEndpoint(
  entry: CatalogProviderEntry,
  modelId: string,
  apiKey: string,
): ResolvedEndpoint {
  void apiKey;
  const pathPrefix = entry.paths?.[entry.defaultKind] ?? "";
  return { baseUrl: `${entry.baseUrl}${pathPrefix}`, model: modelId };
}

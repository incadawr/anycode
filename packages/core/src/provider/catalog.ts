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
  /**
   * Full base URL per transport, for endpoints whose protocols live under
   * different roots. Absent transport ⇒ `baseUrl`. These are COMPLETE prefixes:
   * no factory appends `/v1` on its own (TASK.43 §0.5), so a non-standard prefix
   * (`https://gw.example/api/openai`) stays expressible.
   */
  transportBaseUrls?: Partial<Record<ProviderTransport, string>>;
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
  return { baseUrl: entry.transportBaseUrls?.[transport] ?? entry.baseUrl, model: modelId };
}

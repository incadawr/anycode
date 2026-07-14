/**
 * Transport-aware endpoint config: the single config object every provider
 * factory consumes (TASK.43 §0.4). It is provider-neutral by content — baseUrl,
 * model, auth, headers, retry — and carries the wire protocol as an explicit
 * discriminant.
 */

import type { ProviderTransport } from "./catalog.js";
import type { RetryPolicy } from "./retry.js";

export interface EndpointConfig {
  /**
   * Wire protocol of this endpoint. MANDATORY and deliberately without a
   * default: the back-compat fallback (`anthropic-messages`) is applied exactly
   * once, where env/settings/catalog are resolved. A `transport?` here — or a
   * `?? "anthropic-messages"` in a factory — would turn a forgotten plumbing
   * site into a silent POST of an Anthropic body to an OpenAI endpoint (the very
   * 400/404 class this discriminant exists to prevent) instead of a compile error.
   */
  transport: ProviderTransport;
  /** Base URL of the endpoint; normalization is transport-specific (§0.5). */
  baseUrl: string;
  /**
   * Optional: local vLLM/Ollama-style endpoints legitimately run without auth, so
   * readiness is a catalog auth-policy question, not a global
   * `ANYCODE_API_KEY required` invariant. Transports whose endpoints do require a
   * key stay fail-closed and refuse to build a client without one.
   */
  apiKey?: string;
  /** Extra headers merged over the transport's auth defaults. */
  headers?: Record<string, string>;
  /** Model id to request from the endpoint. */
  model: string;
  /**
   * Ask the endpoint to stream token usage (`stream_options.include_usage` on the
   * OpenAI chat-completions transport). A capability, not a constant: strict
   * OpenAI-compatible servers reject the unknown field. Ignored by
   * anthropic-messages, which always streams usage.
   */
  includeUsage?: boolean;
  /** Overrides over DEFAULT_RETRY_POLICY; maxRetries 0 disables retries (design §2.9). */
  retry?: Partial<RetryPolicy>;
  /**
   * Optional per-attempt api-key resolver (slice 2.5 §3.3; additive-optional, by
   * the precedent of `ExecutionPort.runBinary?` in 2.3). When set, AiSdkModelPort
   * calls it at the START of every attempt to pick up a mid-session-refreshed
   * OAuth token; a rejection or empty result falls back to the static `apiKey`.
   * When unset, behaviour is byte-for-byte the 2.2 static-key path.
   */
  resolveApiKey?: () => Promise<string | undefined>;
  /**
   * Catalog provider name (e.g. "Z.AI (GLM)", "Anthropic") used by the model port
   * to branch reasoning-effort mapping WITHIN a transport: GLM expects an effort
   * enum alongside the thinking budget, real Anthropic only the budget. The
   * transport is the outer branch — provider name never selects a wire protocol.
   */
  providerName?: string;
}

/**
 * @deprecated Name from the single-transport era; kept as an alias so existing
 * imports keep compiling. New code takes `EndpointConfig`.
 */
export type AnthropicEndpointConfig = EndpointConfig;

/**
 * Base-URL policy for endpoints whose prefix is EXPLICIT (both OpenAI
 * transports): trim, reject empty, strip trailing slashes — and nothing else
 * (TASK.43 §0.5). Notably it does NOT append `/v1`: the catalog/settings hold the
 * complete prefix (`https://api.openai.com/v1`, `http://localhost:8000/v1`,
 * `https://gw.example/api/openai`), and guessing a suffix would make valid
 * non-standard prefixes unexpressible. `normalizeAnthropicBaseUrl` keeps its
 * legacy suffixing — that path is byte-pinned and must not be unified with this one.
 */
export function normalizeExplicitBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new Error(`Invalid base URL: "${rawBaseUrl}" is empty after trimming`);
  }
  return trimmed;
}

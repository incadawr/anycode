/**
 * Anthropic-compatible endpoint wrapper over @ai-sdk/anthropic createAnthropic.
 * Covers native Anthropic and the long tail of Anthropic-compatible providers
 * (GLM, Kimi, MiniMax, DeepSeek, ...) that differ only in baseURL and auth.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { RetryPolicy } from "./retry.js";

export interface AnthropicEndpointConfig {
  /** Raw base URL, possibly without the /v1 suffix; normalized before use. */
  baseUrl: string;
  apiKey: string;
  /** Extra headers merged over the dual-auth defaults. */
  headers?: Record<string, string>;
  /** Model id to request from the endpoint. */
  model: string;
  /** Overrides over DEFAULT_RETRY_POLICY; maxRetries 0 disables retries (design §2.9). */
  retry?: Partial<RetryPolicy>;
  /**
   * Optional per-attempt api-key resolver (slice 2.5 §3.3; additive-optional, by
   * the precedent of `ExecutionPort.runBinary?` in 2.3). When set, AiSdkModelPort
   * calls it at the START of every attempt to pick up a mid-session-refreshed
   * OAuth token; a rejection or empty result falls back to the static `apiKey`.
   * When unset, behaviour is byte-for-byte the 2.2 static-key path.
   */
  resolveApiKey?: () => Promise<string>;
  /**
   * Catalog provider name (e.g. "Z.AI (GLM)", "Anthropic") used by the model
   * port to branch reasoning-effort mapping: GLM expects a `reasoning_effort`
   * enum at the top level, real Anthropic uses `providerOptions.anthropic.
   * thinking.budgetTokens`. Absent ⇒ Anthropic path (legacy behaviour).
   */
  providerName?: string;
}

/**
 * Ensures the base URL path ends with "/v1" (idempotent, trailing slashes
 * stripped): "https://api.z.ai/api/anthropic" -> ".../api/anthropic/v1".
 * The SDK appends "/messages" itself.
 */
export function normalizeAnthropicBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new Error(`Invalid Anthropic base URL: "${rawBaseUrl}" is empty after trimming`);
  }
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Dual-header auth shim: the SDK sends `x-api-key` natively; this adds
 * `Authorization: Bearer <apiKey>` on top (some Anthropic-compatible endpoints
 * only accept Bearer). Explicit extra headers win on key collision
 * (case-insensitive: an existing Authorization header is not overwritten).
 */
export function buildDualAuthHeaders(
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const hasAuthorizationOverride = Object.keys(extraHeaders ?? {}).some(
    (key) => key.toLowerCase() === "authorization",
  );
  const headers: Record<string, string> = {};
  if (!hasAuthorizationOverride) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return { ...headers, ...extraHeaders };
}

/**
 * Builds a LanguageModel via createAnthropic({ baseURL, apiKey, headers })
 * using the normalized base URL and dual-auth headers.
 */
export function createAnthropicLanguageModel(config: AnthropicEndpointConfig): LanguageModel {
  const provider = createAnthropic({
    baseURL: normalizeAnthropicBaseUrl(config.baseUrl),
    apiKey: config.apiKey,
    headers: buildDualAuthHeaders(config.apiKey, config.headers),
  });
  return provider(config.model);
}

/**
 * Anthropic-compatible endpoint wrapper over @ai-sdk/anthropic createAnthropic.
 * Covers native Anthropic and the long tail of Anthropic-compatible providers
 * (GLM, Kimi, MiniMax, DeepSeek, ...) that differ only in baseURL and auth.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { EndpointConfig } from "./endpoint.js";

export type { AnthropicEndpointConfig } from "./endpoint.js";

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
 *
 * `EndpointConfig.apiKey` is optional across transports (no-auth local OpenAI
 * endpoints), but this one stays FAIL-CLOSED: every Anthropic-compatible endpoint
 * authenticates, and an unauthenticated call would leave the SDK to fall back to
 * an ambient ANTHROPIC_API_KEY or emit a keyless request. A missing key is a
 * mis-resolved config and must surface as such.
 *
 * The parameter type narrows `transport` to `"anthropic-messages"` so a caller
 * passing an OpenAI-transport config is a compile error; the runtime check below
 * is defense-in-depth for JS callers (or a caller that widens the type), since
 * this factory is exported and reachable outside the transport-routed dispatcher.
 */
export function createAnthropicLanguageModel(
  config: EndpointConfig & { transport: "anthropic-messages" },
): LanguageModel {
  if (config.transport !== "anthropic-messages") {
    throw new Error(
      `createAnthropicLanguageModel received a "${config.transport}" endpoint; only "anthropic-messages" is supported`,
    );
  }
  const { apiKey } = config;
  if (apiKey === undefined) {
    throw new Error("The anthropic-messages transport requires an API key");
  }
  const provider = createAnthropic({
    baseURL: normalizeAnthropicBaseUrl(config.baseUrl),
    apiKey,
    headers: buildDualAuthHeaders(apiKey, config.headers),
  });
  return provider(config.model);
}

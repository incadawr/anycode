/**
 * OpenAI Chat Completions transport (TASK.43 §0.3, `openai-chat-completions`):
 * a thin wrapper over `@ai-sdk/openai-compatible`'s `createOpenAICompatible`,
 * targeting generic chat-completions backends (LiteLLM-fronted gateways, vLLM,
 * Ollama, OpenRouter's chat-completions surface, ...) rather than the real
 * OpenAI Responses API (that is the separate `openai-responses` transport).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { EndpointConfig } from "./endpoint.js";
import { normalizeExplicitBaseUrl } from "./endpoint.js";

/**
 * Stable public provider name. `@ai-sdk/openai-compatible` reads
 * `providerOptions.openaiCompatible` unconditionally regardless of this name
 * (it is also the `providerOptionsName` derived from the model's own
 * `provider` string, but the SDK independently checks the literal
 * `"openaiCompatible"` key first — see `openai-compatible@3.0.10` dist
 * `index.js:475-540`), so `reasoningRequestOptions` in model-port.ts can rely
 * on this exact key without threading the provider name through.
 */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = "openaiCompatible";

/**
 * Builds a chat-completions LanguageModel. `apiKey`/`headers`/`includeUsage`
 * are all CONDITIONAL, not defaulted:
 *  - a no-auth local endpoint (vLLM/Ollama without a key configured) must not
 *    receive an `Authorization` header at all — `createOpenAICompatible` only
 *    adds it when `apiKey` is passed, so an `undefined` config.apiKey is
 *    forwarded as absence, never as an empty-string key;
 *  - `includeUsage` is a capability (some strict chat-completions servers
 *    reject the unknown `stream_options` field), so it is opt-in per
 *    `EndpointConfig.includeUsage` rather than always-on.
 */
export function createOpenAICompatibleLanguageModel(config: EndpointConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    baseURL: normalizeExplicitBaseUrl(config.baseUrl),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.includeUsage === true ? { includeUsage: true } : {}),
  });
  return provider.chatModel(config.model);
}

/**
 * OpenAI Responses transport (TASK.43 §0.3, `openai-responses`): a thin wrapper
 * over `@ai-sdk/openai`'s `createOpenAI(...).responses(modelId)`, targeting the
 * real OpenAI Responses API (`POST /responses`) rather than a generic
 * chat-completions-shaped backend (that is the separate `openai-chat-completions`
 * transport, `openai-compatible.ts`).
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { EndpointConfig } from "./endpoint.js";
import { normalizeExplicitBaseUrl } from "./endpoint.js";

/**
 * Stable public provider name; `@ai-sdk/openai` reads `providerOptions.openai`
 * (falling back to this exact name only when it does NOT contain "azure" — see
 * dist `openai-responses-language-model.js` `providerOptionsName`), so
 * `reasoningRequestOptions` in model-port.ts can rely on the literal key
 * `"openai"` without threading the provider name through.
 */
export const OPENAI_RESPONSES_PROVIDER_NAME = "openai";

/**
 * Builds a Responses-API LanguageModel. `headers` is CONDITIONAL like the
 * chat-completions factory; `apiKey` is DELIBERATELY ALWAYS PASSED (defaulting
 * to the empty string), unlike `createOpenAICompatibleLanguageModel`:
 *
 * `@ai-sdk/openai`'s `createOpenAI` resolves a missing `apiKey` through
 * `loadApiKey`, which falls back to the AMBIENT `OPENAI_API_KEY` process
 * environment variable when the option is `undefined` (verified in
 * `@ai-sdk/openai@4.0.14` dist: `Authorization: Bearer ${loadApiKey({apiKey:
 * options.apiKey, environmentVariableName: "OPENAI_API_KEY", ...})}`, called
 * lazily per-request). `@ai-sdk/openai-compatible` has no such fallback — an
 * absent `apiKey` there simply omits the header. Left as `undefined` here, a
 * no-auth custom endpoint on this transport would silently pick up whatever
 * `OPENAI_API_KEY` happens to be set in the host process (a developer's shell,
 * a CI secret, ...) and send it to an unrelated endpoint — the exact class of
 * "backend the user didn't intend" bug the explicit transport/config contract
 * (§0.4) exists to prevent. Passing `""` short-circuits `loadApiKey` (it
 * accepts any string, including empty) so behaviour is controlled ENTIRELY by
 * `EndpointConfig`, never by the shell environment: a no-auth endpoint gets a
 * deterministic empty Bearer token, never an ambient credential.
 */
export function createOpenAIResponsesLanguageModel(config: EndpointConfig): LanguageModel {
  const provider = createOpenAI({
    name: OPENAI_RESPONSES_PROVIDER_NAME,
    baseURL: normalizeExplicitBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  });
  return provider.responses(config.model);
}

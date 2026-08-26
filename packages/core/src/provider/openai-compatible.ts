/**
 * OpenAI Chat Completions transport (TASK.43 §0.3, `openai-chat-completions`):
 * a thin wrapper over `@ai-sdk/openai-compatible`'s `createOpenAICompatible`,
 * targeting generic chat-completions backends (LiteLLM-fronted gateways, vLLM,
 * Ollama, OpenRouter's chat-completions surface, ...) rather than the real
 * OpenAI Responses API (that is the separate `openai-responses` transport).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderTransport } from "./catalog.js";
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
 *  - `includeUsage` arrives from `resolveIncludeUsage` (TASK.158), which IS the
 *    default authority: production construction sites resolve the transport-
 *    conditional default there and only set the field on an affirmative
 *    verdict, so this factory stays a pure capability forwarder — it spreads
 *    the flag in when and only when it is explicitly `true`.
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

/**
 * The default authority for `stream_options.include_usage` (TASK.158): an
 * explicit setting wins outright, and unset resolves to true exactly when the
 * transport is `openai-chat-completions` — the only transport here that honours
 * the flag (`anthropic-messages` always streams usage and ignores it;
 * `openai-responses` is out of scope for TASK.158 and stays off).
 *
 * History of the default: the original opt-in rationale ("strict
 * chat-completions servers reject the unknown `stream_options` field") was
 * never measured against a real server. It is hereby deliberately downgraded
 * to a minority risk with `ANYCODE_INCLUDE_USAGE=0|false|off` as the escape
 * hatch — leaving it opt-in kept the session token counter dead at 0 for every
 * user who never hand-edits a config, which is strictly worse than a
 * hypothetical strict server whose operator can now flip one env var.
 *
 * Called once at each transport-resolution point (CLI `cli/main.ts`, desktop
 * host `host/index.ts`) AFTER the transport ladder, then carried into every
 * `EndpointConfig` those sites build.
 */
export function resolveIncludeUsage(transport: ProviderTransport, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return transport === "openai-chat-completions";
}

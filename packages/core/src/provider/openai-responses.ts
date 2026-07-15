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
 *
 * That empty token still produces a real outgoing `Authorization: Bearer `
 * header (present, just empty) — the chat-completions transport
 * (`openai-compatible.ts`) instead OMITS the header entirely when there is no
 * key. To match that behaviour without reintroducing the `loadApiKey` ambient
 * fallback, a genuine no-auth config (`config.apiKey === undefined`) keeps the
 * `""` short-circuit AND installs `stripAuthorizationFetch` so the header
 * never reaches the wire; a real key is left untouched.
 *
 * That stripping is only safe when the endpoint has no OTHER intentional
 * Authorization credential. A header-based-auth endpoint (no `apiKey`, but an
 * explicit `config.headers.Authorization`) must keep it: by the time a
 * request reaches `fetch`, the SDK-generated empty `Bearer ` and a real header
 * credential are indistinguishable values, so the decision to install the
 * stripping wrapper at all is made here, before that merge, keyed off the
 * PRESENCE of an explicit header rather than its value (TASK.43 W6-FIX #1).
 */
function stripAuthorizationFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return fetch(input, { ...init, headers });
}

function hasExplicitAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (headers === undefined) {
    return false;
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

export function createOpenAIResponsesLanguageModel(config: EndpointConfig): LanguageModel {
  const shouldStripAmbientAuthorization =
    config.apiKey === undefined && !hasExplicitAuthorizationHeader(config.headers);
  const provider = createOpenAI({
    name: OPENAI_RESPONSES_PROVIDER_NAME,
    baseURL: normalizeExplicitBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(shouldStripAmbientAuthorization ? { fetch: stripAuthorizationFetch } : {}),
  });
  return provider.responses(config.model);
}

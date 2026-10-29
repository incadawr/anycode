/**
 * OpenAI Responses transport (TASK.43 §0.3, `openai-responses`): a thin wrapper
 * over `@ai-sdk/openai`'s `createOpenAI(...).responses(modelId)`, targeting the
 * real OpenAI Responses API (`POST /responses`) rather than a generic
 * chat-completions-shaped backend (that is the separate `openai-chat-completions`
 * transport, `openai-compatible.ts`).
 */

import { wrapResponsesReasoningFetch } from "./responses-reasoning-fetch.js";
import { wrapFetchWithActivity } from "./activity-fetch.js";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel, type LanguageModel } from "ai";
import { ResponsesReasoningTextRecovery, reasoningContentText } from "./responses-reasoning-text.js";
import type { EndpointConfig } from "./endpoint.js";
import { normalizeExplicitBaseUrl } from "./endpoint.js";
import { wrapFetchWithQuota } from "./quota-fetch.js";

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

/** The optional hook observes response-byte activity for the stall watchdog. */
export function createOpenAIResponsesLanguageModel(config: EndpointConfig, onResponseActivity?: () => void): LanguageModel {
  const shouldStripAmbientAuthorization =
    config.apiKey === undefined && !hasExplicitAuthorizationHeader(config.headers);
  // Taskana 4090: when BOTH wrappers apply, the quota wrapper is the OUTER —
  // stripping sees the final init (Authorization removed before it reaches
  // the wire), quota sees the final response. Dormant unless an observer is
  // set: the conditional spread keeps the options byte-identical when unset.
  const fetchChain =
    config.onQuotaHeaders !== undefined
      ? wrapFetchWithQuota(
          shouldStripAmbientAuthorization ? stripAuthorizationFetch : globalThis.fetch,
          config.onQuotaHeaders,
          config.baseUrl,
        )
      : shouldStripAmbientAuthorization
        ? stripAuthorizationFetch
        : undefined;
  const baseFetch = fetchChain ?? ((input, init) => globalThis.fetch(input, init));
  const transportFetch = wrapResponsesReasoningFetch(onResponseActivity !== undefined
    ? wrapFetchWithActivity(baseFetch, onResponseActivity)
    : baseFetch);
  const provider = createOpenAI({
    name: OPENAI_RESPONSES_PROVIDER_NAME,
    baseURL: normalizeExplicitBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(transportFetch !== undefined ? { fetch: transportFetch } : {}),
  });
  return wrapLanguageModel({
    model: provider.responses(config.model),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ type, params }) => type === "stream" ? { ...params, includeRawChunks: true } : params,
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const recovery = new ResponsesReasoningTextRecovery();
        let hasOutput = false;
        let suppressFailure = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === "error" && suppressFailure) { suppressFailure = false; return; }
              if (part.type === "raw" && !hasOutput) {
                const failure = preOutputFailure(part.rawValue, config.baseUrl ?? "", result.response?.headers);
                if (failure) {
                  suppressFailure = true;
                  controller.enqueue({ type: "error", error: failure });
                  return;
                }
              }
              for (const event of recovery.observe(part)) {
                if (event.type === "reasoning_delta") hasOutput = true;
                if (event.type === "reasoning_start") controller.enqueue({ type: "reasoning-start", id: event.id });
                else if (event.type === "reasoning_delta") controller.enqueue({ type: "reasoning-delta", id: event.id, delta: event.text });
                else controller.enqueue({ type: "reasoning-end", id: event.id });
              }
              if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-call" || part.type === "tool-input-delta") hasOutput = true;
              // These raw frames were handled here; do not recover them again downstream.
              if (part.type === "raw" && isRecoveryFrame(part.rawValue)) return;
              controller.enqueue(part);
            },
          })),
        };
      },
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        const body = result.response?.body;
        if (!isRecord(body) || !Array.isArray(body.output)) return result;
        const textById = new Map<string, string>();
        for (const item of body.output) {
          if (!isRecord(item) || item.type !== "reasoning" || typeof item.id !== "string") continue;
          if (Array.isArray(item.summary) && item.summary.some((entry: unknown) => isRecord(entry) && typeof entry.text === "string" && entry.text !== "")) continue;
          const text = reasoningContentText(item.content);
          if (text) textById.set(item.id, text);
        }
        return { ...result, content: result.content.map(part => {
          if (part.type !== "reasoning" || part.text !== "") return part;
          const id = part.providerMetadata?.openai?.itemId;
          const text = typeof id === "string" ? textById.get(id) : undefined;
          return text === undefined ? part : { ...part, text };
        }) };
      },
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecoveryFrame(value: unknown): boolean {
  return isRecord(value) && (value.type === "response.reasoning_text.delta" || value.type === "response.reasoning_text.done" || value.type === "response.output_item.done");
}

/** Preserve the SDK's pre-output failure classification after opening its raw-event gate. */
function preOutputFailure(value: unknown, url: string, responseHeaders: Record<string, string> | undefined): APICallError | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.type === "response.failed" && isRecord(value.response) && isRecord(value.response.error)
    ? value.response.error : value.type === "error" ? (isRecord(value.error) ? value.error : value) : undefined;
  if (!error) return undefined;
  const code = error.code;
  const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : 0;
  const discriminator = [code, value.type === "error" ? error.type : "response.failed"].filter(v => typeof v === "string" || typeof v === "number").join(" ").toLowerCase();
  const statusCode = numeric >= 400 && numeric <= 599 && Number.isInteger(numeric) ? numeric
    : /insufficient_quota|rate_limit/.test(discriminator) ? 429
    : discriminator.includes("authentication") ? 401
    : discriminator.includes("permission") ? 403
    : discriminator.includes("not_found") ? 404
    : /invalid|bad_request|context_length/.test(discriminator) ? 400
    : discriminator.includes("overload") ? 503
    : discriminator.includes("timeout") ? 504 : 500;
  return new APICallError({ message: typeof error.message === "string" ? error.message : "OpenAI stream failed before any output was generated", url, requestBodyValues: {}, statusCode, responseHeaders, responseBody: JSON.stringify(value), data: value });
}

import { contextualizeNetworkFailure } from "./network-failure.js";
/**
 * ModelPort adapter over the AI SDK. Per call:
 * On openai-responses, response bytes also count as watchdog activity and raw
 * chunks recover reasoning_text events hidden by the SDK (GitHub #27).
 *  - builds the LanguageModel via createLanguageModel(config), which picks the
 *    client factory by the config's transport
 *  - invokes streamText with stopWhen: stepCountIs(1) (explicit; one model
 *    step per call — the multi-turn loop lives above this boundary),
 *    maxRetries: 0 (retry policy is owned by this adapter, Phase 1), and a
 *    per-attempt AbortController linked to the request's abortSignal.
 *  - consumes result.fullStream and yields translateStreamPart(part) events,
 *    dropping nulls.
 *
 * Retryable failures before text or tool output may replay the step. Reasoning
 * is provisional and shares the count budget with pre-content retries. Once
 * text or tool output begins, or a successful finish arrives, replay stops.
 * Pre-content network failures retain their time-budget and waiting behavior;
 * reasoning-only attempts use the count budget. Every abandoned attempt is
 * aborted before the retry event and the backoff remains externally abortable.
 * The legacy midStreamRetries setting no longer changes replay eligibility.
 *
 * TASK.168 adds a SEPARATE, budget-exempt one-shot retry on the
 * openai-chat-completions transport: a pre-content HTTP 400 while
 * `includeUsage` is on is retried ONCE with the flag forced off (no backoff,
 * no `stream_retry` event, never counted against `policy.maxRetries`). A
 * successful retry permanently disables the flag for the rest of THIS port
 * instance's life and fires a `DiagnosticSink` warning exactly once; a retry
 * that 400s again restores the flag and re-surfaces the FIRST failure
 * unchanged (see `includeUsageProbeEligible`/`ProbeFailure` and
 * `#includeUsageDisabledForEndpoint`).
 */

import { stepCountIs, streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import { consoleDiagnosticSink, type DiagnosticSink } from "../types/diagnostics.js";
import type { ModelStreamEvent } from "../types/events.js";
import { linkAbortSignal } from "../util/abort.js";
import type { ProviderTransport } from "./catalog.js";
import type { EndpointConfig } from "./endpoint.js";
import type { ImplicitPromptCache } from "../types/config.js";
import { blocksAutomaticReplay, classifyProviderFailure, extractStatusCode, isModelOutputEvent } from "./failure.js";
import { ResponsesReasoningTextRecovery } from "./responses-reasoning-text.js";
import { createLanguageModel } from "./language-model.js";
import type { ProviderQuotaUpdate } from "./quota.js";
import type { NetworkWaiter } from "./network-waiter.js";
import { DEFAULT_RETRY_POLICY, isRetryableStreamError, isTransientNetworkError, retryDelayMs, type RetryPolicy } from "./retry.js";
import { toSdkMessages, toSdkTools } from "./sdk-mapping.js";
import { describeStreamArtifact, isIgnorableStreamArtifact } from "./stream-artifacts.js";
import { translateStreamPart } from "./stream-translator.js";

const REASONING_BUDGET_TOKENS = { low: 4_096, medium: 12_288, high: 24_576 } as const;

/** GLM-5.2 thinking budgets per supported effort tier. */
const GLM_BUDGET_TOKENS = { high: 16_000, max: 32_000 } as const;

/** Z.AI's documented max_tokens ceiling for the GLM-5/4.6 family. */
const GLM_MAX_TOKENS = 131_072;

/** Return shape of `reasoningRequestOptions` on the anthropic-messages transport. */
interface AnthropicReasoningOptions {
  maxOutputTokens?: number;
  // thinking optional since the DeepSeek branch (4241) sends the effort enum alone.
  providerOptions?: { anthropic: { effort?: string; thinking?: { type: "enabled"; budgetTokens: number } | { type: "adaptive" } } };
}

/**
 * Return shape on the openai-chat-completions transport: `reasoning_effort` is
 * a plain enum, not a token budget, so there is no maxOutputTokens arithmetic
 * to perform (§4.3) — `maxOutputTokens` merely passes the request's value
 * through unchanged when present.
 */
interface OpenAICompatibleReasoningOptions {
  maxOutputTokens?: number;
  providerOptions?: {
    openaiCompatible: { reasoningEffort?: string; prompt_cache_options?: ImplicitPromptCache };
  };
}

/**
 * Return shape on the openai-responses transport. Unlike the other two
 * transports, `providerOptions` is NON-optional: `store: false` (TASK.43 §0.2)
 * must ride on EVERY openai-responses request regardless of whether reasoning
 * was requested — real OpenAI defaults `store` to `true` server-side when the
 * field is absent from the body, which would silently start a second,
 * AnyCode-external persistence of the conversation on OpenAI's servers. There
 * is no token-budget arithmetic here either (§4.3, mirrors chat-completions):
 * `reasoning_effort` is an enum on this transport too.
 *
 * `forceReasoning` exists because `@ai-sdk/openai` decides whether to put
 * `reasoning.effort` on the wire from an ID-PREFIX heuristic
 * (`o1|o3|o4-mini|gpt-5*` in 4.0.14), not from what the caller asked for: any
 * model id outside that list — the whole GPT-6 line included — is treated as a
 * non-reasoning model and the effort is silently DROPPED with an unsupported
 * warning. The caller only passes an effort after resolving it against the
 * catalog, so an effort here is a deliberate claim that this model reasons;
 * `forceReasoning: true` makes the SDK honour it.
 */
interface OpenAIResponsesReasoningOptions {
  maxOutputTokens?: number;
  providerOptions: { openai: { store: false; reasoningEffort?: string; forceReasoning?: true; promptCacheOptions?: ImplicitPromptCache } };
}

type ReasoningOptions = AnthropicReasoningOptions | OpenAICompatibleReasoningOptions | OpenAIResponsesReasoningOptions;

/**
 * Provider-aware reasoning-effort mapping. GLM uses the Anthropic-compatible
 * provider options channel exposed by `@ai-sdk/anthropic`:
 *
 *   GLM (z.ai /api/anthropic): the proxy serializes `anthropic.effort` into the
 *   body's `output_config.effort` ("max"|"high") AND `anthropic.thinking` into
 *   `thinking.budget_tokens`. Both fields are load-bearing — `effort` selects
 *   the reasoning tier (the native No-thinking/High/Max UI maps to none/high/
 *   max), `budget_tokens` sets the reasoning-token limit. A bare top-level
 *   `reasoning_effort` would both fail AI SDK v7's SharedV4ProviderOptions
 *   typecheck (string leaf at top level) AND be ignored by the Anthropic-format
 *   proxy; nesting under `anthropic` is the working transport.
 *
 *   Real Anthropic (Claude) uses the canonical `thinking.budgetTokens` with the
 *   legacy low/medium/high tiers (no `effort` field — Claude has no enum). The
 *   generic/default path is kept for unknown providers so a non-catalog custom
 *   endpoint stays on the pre-GLM behaviour.
 *
 * `providerName` (sourced from the catalog entry's `name` field by the wiring
 * layer) branches the two; absent ⇒ default Anthropic path (legacy behaviour,
 * byte-identical for non-GLM boots).
 *
 * `transport` is the OUTER branch and is checked FIRST: reasoning is carried by a
 * thinking budget on anthropic-messages but by an effort enum on the OpenAI
 * transports, so the wire protocol — never the provider name — decides the shape.
 * It defaults to `anthropic-messages` so pre-transport call sites keep their
 * pinned bytes.
 *
 * openai-chat-completions maps to `providerOptions.openaiCompatible.reasoningEffort`.
 * `@ai-sdk/openai-compatible` reads that key and serializes it as top-level
 * `reasoning_effort`. Compatible providers may support different tiers, so the
 * model capability layer determines which value to send.
 *
 * openai-responses maps to `providerOptions.openai.{reasoningEffort, store}`
 * (TASK.43 §0.2/§0.7). `store: false` is UNCONDITIONAL — it rides on every
 * request on this transport, reasoning or not (see `OpenAIResponsesReasoningOptions`
 * above). `reasoningEffort`, when present, is passed through verbatim. Which
 * values a model accepts is a capability-layer/catalog question (`effortLevels`),
 * not something this wire-mapping function should guess or narrow ahead of time.
 *
 * Overloaded so a caller that passes a literal `"anthropic-messages"` transport
 * (or omits it) keeps `providerOptions.anthropic` as a NON-optional key on the
 * return type — model-port.test.ts pins direct `.anthropic.thinking.budgetTokens`
 * access on exactly that call shape, and a plain union return would force an
 * unwanted narrowing check there.
 */
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName?: string,
  transport?: "anthropic-messages",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
): AnthropicReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-chat-completions",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
): OpenAICompatibleReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-responses",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
): OpenAIResponsesReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: ProviderTransport,
  promptCache?: ImplicitPromptCache,
  modelId?: string,
): ReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName?: string,
  transport: ProviderTransport = "anthropic-messages",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
): ReasoningOptions {
  const effort = request.reasoningEffort;

  if (transport === "openai-responses") {
    // store:false is unconditional (§0.2): AnyCode owns history end-to-end, and
    // leaving `store` absent defaults the real API to `store: true` server-side
    // — a hidden second persistence this transport must never create.
    if (effort === "off" && providerName === "OpenAI" && ["gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol"].includes(modelId ?? "")) {
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        providerOptions: { openai: { store: false, reasoningEffort: "none", forceReasoning: true, ...(promptCache !== undefined ? { promptCacheOptions: promptCache } : {}) } },
      };
    }
    if (effort === undefined || effort === "off") {
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        providerOptions: {
          openai: {
            store: false,
            ...(promptCache !== undefined ? { promptCacheOptions: promptCache } : {}),
          },
        },
      };
    }
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: {
        openai: {
          store: false,
          reasoningEffort: effort,
          ...(providerName === "OpenAI" && ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra", "gpt-6-sol"].includes(modelId ?? "") ? { forceReasoning: true as const } : {}),
          ...(promptCache !== undefined ? { promptCacheOptions: promptCache } : {}),
        },
      },
    };
  }

  if (transport === "openai-chat-completions") {
    if (effort === "off" && providerName === "OpenAI" && ["gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol"].includes(modelId ?? "")) {
      return { ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}), providerOptions: { openaiCompatible: { reasoningEffort: "none", ...(promptCache !== undefined ? { prompt_cache_options: promptCache } : {}) } } };
    }
    if (effort === undefined || effort === "off") {
      if (request.maxOutputTokens === undefined && promptCache === undefined) {
        return {};
      }
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(promptCache !== undefined
          ? { providerOptions: { openaiCompatible: { prompt_cache_options: promptCache } } }
          : {}),
      };
    }
    // reasoning_effort is an enum, not a token budget: no maxOutputTokens arithmetic.
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: {
        openaiCompatible: {
          reasoningEffort: effort,
          ...(promptCache !== undefined ? { prompt_cache_options: promptCache } : {}),
        },
      },
    };
  }

  if (effort === undefined || effort === "off") {
    return request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens };
  }

  if (providerName === "Anthropic" && /^(claude-(?:opus|sonnet|haiku)-5-5|claude-fable-5-1)$/.test(modelId ?? "")) {
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: { anthropic: { effort, thinking: { type: "adaptive" } } },
    };
  }

  // GLM via z.ai: effort enum ("low"|"high"|"max") + thinking budget
  // (16k/16k/32k). The proxy honors `effort` (output_config.effort) as the
  // tier selector; the budget must be large enough to hold the thinking
  // output for that tier.
  if (providerName === "Z.AI (GLM)") {
    const glmBudget = effort === "max" ? GLM_BUDGET_TOKENS.max : GLM_BUDGET_TOKENS.high;
    // docs.z.ai/guides/llm/glm-5.3 (accessed 2026-08-28) documents `low` as a
    // real, distinct tier — passing it through to the wire instead of
    // silently upgrading it to `high` (TASK.163). z.ai documents no separate
    // budget for `low`; `budget_tokens` is a ceiling on thinking output, not a
    // floor, so reusing `high`'s 16_000 as `low`'s cap is conservative and
    // cannot under-serve `low`'s lighter reasoning. `medium` has no documented
    // GLM equivalent and still collapses to `high`.
    const glmEffort = effort === "max" ? "max" : effort === "low" ? "low" : "high";
    // @ai-sdk/anthropic serializes enabled thinking as
    // `max_tokens = maxOutputTokens + thinking.budget_tokens`. The catalog's
    // 128K value is the provider's final wire ceiling, not a safe text-only
    // value to pass through unchanged: doing so produced 147072/163072 for
    // GLM high/max and Z.AI rejected the request. Leave room for the budget.
    const maxOutputTokens =
      request.maxOutputTokens === undefined
        ? undefined
        : Math.min(request.maxOutputTokens, GLM_MAX_TOKENS - glmBudget);
    return {
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      providerOptions: { anthropic: { effort: glmEffort, thinking: { type: "enabled", budgetTokens: glmBudget } } },
    };
  }

  // DeepSeek (TASK 4241): distinct low/high/max effort tiers, default high —
  // SUPPLIED FACT from the live GET /models listing (2026-10-10). Mechanism is
  // LOCAL SDK EVIDENCE: @ai-sdk/anthropic@4.0.7 serializes
  // providerOptions.anthropic.effort to output_config.effort whether or not
  // thinking is present, and adds thinkingBudget to max_tokens only when a
  // budget exists — so this emits the enum verbatim, no thinking key, and
  // max_tokens = maxOutputTokens unchanged. No thinking budget is sent
  // because no DeepSeek budget fact exists; borrowing GLM's numbers would be
  // an unsupported live-service inference. `medium` is not a declared tier
  // (legacy stored override only) and collapses to "high" — same local
  // precedent as the GLM branch, not a supplied fact.
  if (providerName === "DeepSeek") {
    const dsEffort = effort === "low" || effort === "max" ? effort : "high";
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: { anthropic: { effort: dsEffort } },
    };
  }

  // Default / real Anthropic (Claude): budgetTokens is the canonical extended-thinking format.
  const budgetTokens =
    effort === "max" || effort === "xhigh"
      ? REASONING_BUDGET_TOKENS.high
      : REASONING_BUDGET_TOKENS[effort as "low" | "medium" | "high"];
  let maxOutputTokens = Math.max(request.maxOutputTokens ?? 0, budgetTokens + 1_024);
  // The SDK adds the thinking budget to max_tokens on the wire.
  if ((providerName === "Xiaomi MiMo API" || providerName?.startsWith("Xiaomi MiMo Token Plan (")) && /^(mimo-v2\.6-pro|mimo-v2\.6-flash)$/.test(modelId ?? "")) {
    maxOutputTokens = Math.min(maxOutputTokens, 131_072 - budgetTokens);
  }
  return {
    maxOutputTokens,
    providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } },
  };
}

/** Sentinel distinguishing "no retry pending" from `undefined`/falsy retryable errors. */
const NO_RETRY = Symbol("no-retry");

/** Discriminates the stall outcome of `nextWithStallTimeout` from a real IteratorResult. */
interface StalledOutcome {
  stalled: true;
}

/**
 * TASK.168: a failure captured for the `stream_options.include_usage` probe.
 * `kind` records whether it arrived as a thrown exception or a stream
 * `error` part, so it can be replayed (on rollback) or re-classified (on
 * confirm) through the SAME channel it would have used had the probe never
 * been attempted, instead of silently changing thrown-vs-yielded shape.
 * Reused for two distinct roles in `streamText`:
 *  - `includeUsageProbe`: the FIRST failure that started the probe, carried
 *    from that attempt to the very next one (the probe retry) so a rollback
 *    can restore it verbatim.
 *  - `pendingProbeFailure`: THIS pass's own failure, captured inside the
 *    try/catch and resolved once OUTSIDE it (see the resolution block below)
 *    — deferring this way means a rollback's `throw` is never at risk of
 *    being re-caught by this same pass's own `catch`.
 */
interface ProbeFailure {
  error: unknown;
  kind: "thrown" | "event";
}

/**
 * True when `error` is an HTTP 400 that arrived before any model output was
 * observed — the one shape a strict openai-chat-completions server produces
 * when it rejects the unknown `stream_options` field (TASK.168). Shared by
 * the probe-eligibility check (is THIS failure worth probing) and the
 * probe-resolution check (did the retry attempt reproduce the same failure).
 */
function isPreContent400(error: unknown, hadModelOutput: boolean): boolean {
  return !hadModelOutput && extractStatusCode(error) === 400;
}

/**
 * Gate for STARTING an include_usage probe retry: only on the
 * openai-chat-completions transport (the one transport that honours the
 * flag), only when the flag was actually ON for the attempt that just failed
 * (an already-disabled endpoint has nothing to probe), only pre-content (a
 * mid-stream 400 after real output must never be silently replayed — that
 * would risk a duplicate answer), and never once the caller's own abort
 * signal has already fired (an external abort always wins over any retry).
 */
function includeUsageProbeEligible(
  transport: ProviderTransport,
  attemptIncludeUsage: boolean | undefined,
  error: unknown,
  hadModelOutput: boolean,
  aborted: boolean,
): boolean {
  return (
    transport === "openai-chat-completions" &&
    attemptIncludeUsage === true &&
    !aborted &&
    isPreContent400(error, hadModelOutput)
  );
}

function resolveRetryPolicy(override: Partial<RetryPolicy> | undefined): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...override };
}

/** Resolves after `ms`, or rejects immediately (before the timer fires) if `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Taskana 4772: first probe tick while waiting for the network; doubles per failed tick up to the cap. */
const NETWORK_WAIT_FIRST_TICK_MS = 5_000;
const NETWORK_WAIT_MAX_TICK_MS = 60_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** A probe is a best-effort answer: a waiter that throws is treated as offline. */
async function probeNetwork(waiter: NetworkWaiter, baseUrl: string, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    return await waiter.probe(baseUrl, signal);
  } catch {
    return false;
  }
}

/** Shared wake state of one waiting episode: `hinted` survives until consumed; `wake` ends the current tick wait early. */
interface HintBox {
  hinted: boolean;
  wake?: () => void;
}

/**
 * Resolves after `ms`, or at once when the hint box is woken, and rejects
 * (with the abort reason) as soon as `signal` aborts. Clears its timer on every exit.
 */
function waitTickOrHint(ms: number, box: HintBox, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      box.wake = undefined;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      finish();
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    box.wake = () => {
      finish();
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Optional lastActivityAt extends the watchdog when response bytes arrive.
 * Waits for the iterator's next result, racing it against an abortable
 * `stallTimeoutMs` watchdog (unarmed when <= 0) and `signal`. A genuine abort
 * that fires WHILE this call is pending rejects (propagating the signal's
 * reason) so it is never mistaken for a stall; a stall resolves with
 * `{ stalled: true }` while the original `iterator.next()` promise is left to
 * settle on its own (its handlers just no-op once this call has already
 * settled). Deliberately does NOT special-case an already-aborted `signal` at
 * call time: that is the caller's concern (mirrors how the underlying stream
 * itself reacts to an already-aborted signal, or doesn't, on its own terms) —
 * short-circuiting here would pre-empt a mock/real stream that settles
 * synchronously with a more specific error regardless of abort state.
 */
function nextWithStallTimeout<T>(
  iterator: AsyncIterator<T>,
  stallTimeoutMs: number,
  signal: AbortSignal,
  lastActivityAt?: () => number,
): Promise<IteratorResult<T> | StalledOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    if (stallTimeoutMs > 0) {
      const armedAt = Date.now();
      const onTimer = (): void => {
        if (settled) return;
        if (lastActivityAt !== undefined) {
          const quietSince = Math.max(armedAt, lastActivityAt());
          const remaining = Math.min(stallTimeoutMs, stallTimeoutMs - (Date.now() - quietSince));
          if (remaining > 0) {
            timer = setTimeout(onTimer, remaining);
            return;
          }
        }
        settled = true;
        cleanup();
        resolve({ stalled: true });
      };
      timer = setTimeout(onTimer, stallTimeoutMs);
    }

    iterator.next().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function isStalledOutcome<T>(outcome: IteratorResult<T> | StalledOutcome): outcome is StalledOutcome {
  return "stalled" in outcome;
}

/**
 * The port's own stall-timeout error (never a provider error): distinguished
 * by type so `describeRetryReason` can give it a fixed whitelist reason
 * instead of routing it through `classifyProviderFailure`'s generic
 * "unknown" bucket, which discards the actionable stall diagnostic (TASK.33
 * W7b-FIX #3). The raw, interpolated message stays on `.message` for the
 * host log (thrown verbatim on retry-exhaustion); only the class identity is
 * used for the wire-crossing reason, never the message text itself.
 */
class StreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(`stream stalled: no events for ${timeoutMs}ms`);
    this.name = "StreamStallError";
  }
}

/**
 * `stream_retry.reason` rides the wire and is rendered verbatim by the CLI and
 * renderer, so it must be a whitelist-derived safe message — NEVER raw
 * provider `error.message` text, which can embed a response body or auth
 * header (TASK.33 W7b-FIX #2). A `StreamStallError` is locally generated, not
 * provider text, so it gets its own fixed, non-interpolated whitelist reason
 * (W7b-FIX #3) rather than falling into `classifyProviderFailure`'s generic
 * "unknown" -> "request failed" bucket.
 */
function describeRetryReason(error: unknown): string {
  if (error instanceof StreamStallError) {
    return "stream_stalled";
  }
  return classifyProviderFailure(error).safe.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Narrows an unknown `fullStream` part to the anthropic-messages raw
 * `message_start` chunk and returns the model id the PROVIDER claimed for the
 * response. Returns undefined for every other part, and for a `message_start`
 * whose `message` carries no `model` string: absence on the wire is preserved
 * as absence. Deliberately the ONLY provenance source — the SDK's own
 * `response.modelId` is initialized from the REQUESTED id and merely overridden
 * by provider metadata when present (ai@7.0.14 dist :9394-9398 / :9470-9475),
 * so reading it would fabricate a provider claim that never arrived.
 */
function rawResponseModelOf(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== "raw") {
    return undefined;
  }
  const rawValue = part.rawValue;
  if (!isRecord(rawValue) || rawValue.type !== "message_start") {
    return undefined;
  }
  const message = rawValue.message;
  if (!isRecord(message)) {
    return undefined;
  }
  const model = message.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

export class AiSdkModelPort implements ModelPort {
  /** Provider's model claim from the most recent raw `message_start` seen by this port. */
  #lastResponseModel: string | undefined;

  /**
   * Taskana 4090 (TASK.71): latest quota update observed by this attempt's
   * wrapped fetch (`config.onQuotaHeaders` writes it via the constructor
   * passthrough below). Fetch resolves before the SDK decodes the body, so
   * it is populated by the time the `finish` part translates; consumed and
   * cleared there — one `provider_quota` emission per attempt, and a
   * retried attempt re-reports fresh headers.
   */
  #lastQuota: ProviderQuotaUpdate | null = null;

  /**
   * TASK.168: permanent, per-PORT-INSTANCE memory that a strict
   * openai-chat-completions endpoint has already been confirmed (by a
   * one-shot probe retry) to reject `stream_options.include_usage`. Once
   * true, every subsequent attempt on THIS port builds its model with the
   * flag forced off — no further probing. Scope is deliberately the port
   * instance, never module/process-global state: a port is constructed
   * per-endpoint (one `EndpointConfig` — a fixed baseUrl+model+transport —
   * for the instance's whole life; CLI `/model` and the desktop hot-swap both
   * construct a FRESH port on a model switch), so this field's lifetime is
   * exactly "the remainder of that endpoint's lifetime" as long as the same
   * port keeps serving it. A switch to a different model/endpoint gets its
   * own port and its own honest first probe.
   */
  #includeUsageDisabledForEndpoint = false;

  constructor(
    private readonly config: EndpointConfig,
    private readonly onDiagnostic: DiagnosticSink = consoleDiagnosticSink,
  ) {
    // Taskana 4090: rebind the config's observer through a port-owned shim so
    // the latest update lands in `#lastQuota` before being forwarded — the
    // shim is built HERE (port-owned), while the factories only ever see the
    // config object this port hands them via buildAttemptModel.
    if (config.onQuotaHeaders !== undefined) {
      const forward = config.onQuotaHeaders;
      this.config = { ...config, onQuotaHeaders: (update, baseUrl) => {
        this.#lastQuota = update;
        forward(update, baseUrl);
      } };
    }
  }

  /** Identity readback: the id this port was constructed for (never canonicalized). */
  get modelId(): string {
    return this.config.model;
  }

  get titleReasoningEffort(): "low" | undefined {
    return this.config.providerName === "DeepSeek" ? "low" : undefined;
  }

  /**
   * The provider's own model claim from the last raw response this port
   * observed, or undefined when none has been seen. Never derived from SDK
   * response metadata (see `rawResponseModelOf`).
   */
  get lastResponseModel(): string | undefined {
    return this.#lastResponseModel;
  }

  /**
   * Builds this attempt's LanguageModel (slice 2.5 §3.3) through the transport
   * dispatcher. When no per-attempt resolver is configured, the ORIGINAL config
   * object is handed to the factory — byte-for-byte the 2.2 static-key path. When
   * one is configured, resolves a fresh key at the START of the attempt so a
   * mid-session-refreshed OAuth token is picked up; a rejection or empty/blank
   * result falls back to the static `config.apiKey` (the model port never fails
   * just because a refresh hiccupped — the SDK call itself will surface a real
   * auth failure).
   *
   * `includeUsage` is the CALLER-resolved effective value for this attempt
   * (TASK.168: `this.config.includeUsage` unless the endpoint-level probe has
   * already disabled it, or unless this very attempt IS the probe retry).
   * When it matches the config's own value — the overwhelming majority of
   * attempts — the config is forwarded UNTOUCHED: spreading would both break
   * the object identity the no-resolver path guarantees and add an
   * `includeUsage: undefined` key the pre-TASK.168 shape never carried.
   */
  // The factory receives exactly one argument when the activity hook is absent.
  private async buildAttemptModel(includeUsage: boolean | undefined, onResponseActivity?: () => void): Promise<LanguageModel> {
    const create = (cfg: EndpointConfig): LanguageModel => onResponseActivity === undefined ? createLanguageModel(cfg) : createLanguageModel(cfg, onResponseActivity);
    const { resolveApiKey } = this.config;
    const usageOverridden = includeUsage !== this.config.includeUsage;
    if (resolveApiKey === undefined) {
      return create(usageOverridden ? { ...this.config, includeUsage } : this.config);
    }
    let apiKey = this.config.apiKey;
    try {
      const resolved = await resolveApiKey();
      if (resolved !== undefined && resolved.trim() !== "") {
        apiKey = resolved;
      }
    } catch {
      // Fall back to the static key: a refresh hiccup must not kill the attempt.
    }
    return create(
      usageOverridden ? { ...this.config, apiKey, includeUsage } : { ...this.config, apiKey },
    );
  }

  /**
   * Commits the TASK.168 include_usage probe: called exactly once, the
   * moment a probe retry (see `includeUsageProbeEligible`) demonstrates the
   * flag was the cause of a pre-content HTTP 400 by NOT reproducing that same
   * failure. `#includeUsageDisabledForEndpoint` is already `true` by the time
   * this runs (set optimistically when the probe started); this only
   * announces it. Unreachable more than once per instance: once committed,
   * every later attempt's effective `includeUsage` is permanently `false`,
   * which fails `includeUsageProbeEligible`'s `attemptIncludeUsage === true`
   * check and so can never start another probe on this port.
   */
  #confirmIncludeUsageProbe(): void {
    this.onDiagnostic({
      kind: "include_usage_disabled",
      baseUrl: this.config.baseUrl,
      model: this.config.model,
    });
  }

  /**
   * Taskana 4772: parks a pre-content transient network failure. Yields
   * `waiting_for_network` once, probes at once, then probes on a 5 s -> 60 s
   * tick (or immediately again when the waiter reports a hint) until the
   * endpoint answers. Returns the episode's monotonic duration on recovery.
   * Throws `error` (the last transient failure, unchanged) once the
   * cumulative wait reaches `maxWaitMs`. Stop (`signal`) rejects at once.
   */
  async *#awaitNetworkRecovery(
    waiter: NetworkWaiter,
    error: unknown,
    spentBeforeMs: number,
    maxWaitMs: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ModelStreamEvent, number, void> {
    const episodeStart = waiter.monotonicNow();
    const elapsedMs = (): number => waiter.monotonicNow() - episodeStart;
    const box: HintBox = { hinted: false };
    const unsubscribe = waiter.onHint?.(() => {
      box.hinted = true;
      box.wake?.();
    });
    try {
      // Review F2: label the episode with WHO is waiting, so a tab-level
      // banner can count per-source episodes instead of flickering when a
      // parent and an inline-subagent child park on the same outage. Absent
      // config ⇒ no label (consumers treat it as the parent).
      yield this.config.networkWaiter !== undefined && this.config.networkWaitSource !== undefined
        ? { type: "waiting_for_network", waitSource: this.config.networkWaitSource }
        : { type: "waiting_for_network" };
      let tickMs = NETWORK_WAIT_FIRST_TICK_MS;
      // F4: probe once at t=0 before arming the first tick — with the count
      // budget exhausted (the only path that reaches the wait without the
      // gate probe) and the network already back, recovery must not wait out
      // an arbitrary 5 s tick to notice.
      let fromHint = true;
      for (;;) {
        if (signal?.aborted) throw abortReason(signal);
        const remainingMs = maxWaitMs - spentBeforeMs - elapsedMs();
        if (remainingMs <= 0) throw error;
        if (!fromHint) {
          await waitTickOrHint(Math.min(tickMs, remainingMs), box, signal);
          fromHint = box.hinted;
        }
        box.hinted = false;
        if (await probeNetwork(waiter, this.config.baseUrl, signal)) {
          return elapsedMs();
        }
        // Only a timer-driven miss backs the tick off; a hint-driven probe keeps the schedule.
        if (!fromHint) tickMs = Math.min(tickMs * 2, NETWORK_WAIT_MAX_TICK_MS);
        fromHint = false;
      }
    } finally {
      unsubscribe?.();
    }
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const policy = resolveRetryPolicy(this.config.retry);
    let attempt = 0;
    // Time of this step's first retryable failure; anchors networkRetryBudgetMs.
    let firstFailureAt: number | undefined;
    // Taskana 4772: monotonic time this step has already spent waiting for the network (all episodes).
    let networkWaitSpentMs = 0;
    // Count-bounded retry gate; past maxRetries only a transient NETWORK error
    // may continue, and only inside the wall-clock budget (0 retries = off).
    const mayRetry = (error: unknown): boolean => {
      firstFailureAt ??= Date.now();
      if (attempt < policy.maxRetries) return true;
      if (policy.maxRetries <= 0 || policy.networkRetryBudgetMs <= 0) return false;
      if (!isTransientNetworkError(error)) return false;
      return Date.now() - firstFailureAt < policy.networkRetryBudgetMs;
    };
    // Taskana 4772: with a network waiter, a pre-content transient network failure
    // is also retryable past the count and the wall-clock budget: the seam below
    // waits for the network instead of failing the turn.
    const mayRetryOrWait = (error: unknown, hadOutput: boolean): boolean =>
      mayRetry(error) ||
      (!hadOutput &&
        this.config.networkWaiter !== undefined &&
        policy.maxRetries > 0 &&
        policy.networkWaitMaxMs > 0 &&
        isTransientNetworkError(error));
    const mayRetryProvisional = (error: unknown, hadOutput: boolean): boolean => {
      if (!hadOutput) return mayRetryOrWait(error, false);
      firstFailureAt ??= Date.now();
      return attempt < policy.maxRetries;
    };
    // TASK.168: the failure that STARTED the include_usage probe, carried
    // from that attempt to the very next one (the probe retry) — see
    // `ProbeFailure`'s docstring.
    let includeUsageProbe: ProbeFailure | undefined;

    for (;;) {
      if (request.abortSignal?.aborted) throw abortReason(request.abortSignal);
      let hadModelOutput = false;
      let replayBlocked = false;
      // finish totals discard raw usage; keep the latest step's wire usage
      // inside this attempt so abandoned attempts cannot affect a retry.
      let stepRawUsage: unknown;
      // Taskana 4705 review: set once a non-error `finish` is yielded. The step
      // is then complete; replaying it would re-bill the provider and drop the
      // usage of the attempt the caller already received, so it is never replayed.
      let completedFinish = false;
      let pendingRetryError: unknown = NO_RETRY;
      // TASK.168: set instead of pendingRetryError when this pass ends by
      // starting an include_usage probe — that retry is immediate (no
      // backoff), doesn't consume the connect/stall retry budget, and never
      // emits a `stream_retry` wire event, so it deliberately bypasses the
      // pendingRetryError machinery below.
      let probeRetryNeeded = false;
      // TASK.168: THIS pass's own failure while a probe was already pending
      // (i.e. this pass IS the probe retry), captured here and resolved once
      // OUTSIDE the try/catch below — see `ProbeFailure`'s docstring for why.
      let pendingProbeFailure: ProbeFailure | undefined;
      // Per-attempt dedup of dropped-artifact warnings (reset with the attempt
      // on retry, alongside hadModelOutput) — slice 3.7 R1, §2.2.
      const warnedArtifacts = new Set<string>();
      // Per-attempt recovery and byte liveness prevent cross-talk on retries (GitHub #27).
      const reasoningTextRecovery = this.config.transport === "openai-responses" ? new ResponsesReasoningTextRecovery() : undefined;
      let lastWireActivityAt = Number.NEGATIVE_INFINITY;
      const onResponseActivity = this.config.transport === "openai-responses" && policy.stallTimeoutMs > 0
        ? (): void => { lastWireActivityAt = Date.now(); } : undefined;
      const lastActivityAt = onResponseActivity !== undefined ? (): number => lastWireActivityAt : undefined;
      // TASK.168: the effective include_usage verdict for THIS attempt —
      // forced off once the endpoint-level probe has committed, or while this
      // attempt IS itself the probe retry (both fold into the same field:
      // the probe sets it optimistically before the retry runs).
      const attemptIncludeUsage = this.#includeUsageDisabledForEndpoint ? false : this.config.includeUsage;

      // Per-attempt controller so a stall can cancel just this attempt's SDK
      // call without tearing down the caller's own abortSignal; linked so an
      // external abort still reaches the SDK immediately.
      const attemptController = new AbortController();
      const disposeLink = request.abortSignal
        ? linkAbortSignal(request.abortSignal, attemptController)
        : () => {};

      try {
        const model = await this.buildAttemptModel(attemptIncludeUsage, onResponseActivity);
        const result = streamText({
          model,
          // System prompt goes out-of-band: ai@7 rejects system-role messages
          // inside `messages`, and its `system` option is deprecated for `instructions`.
          instructions: request.system,
          messages: toSdkMessages(request.messages, this.config.transport),
          tools: toSdkTools(request.tools),
          // One SDK step per ModelPort call; the multi-turn loop lives in AgentLoop.
          stopWhen: stepCountIs(1),
          // Retries are this adapter's responsibility (Phase 1); none in Phase 0.
          maxRetries: 0,
          // The SDK default prints raw response/body/headers to console. The
          // fullStream error already reaches our safe classifier and journal.
          onError: () => {},
          abortSignal: attemptController.signal,
          // Raw chunks carry provenance for Anthropic and reasoning text for Responses.
          ...(this.config.transport === "anthropic-messages" || this.config.transport === "openai-responses"
            ? { includeRawChunks: true } : {}),
          ...reasoningRequestOptions(request, this.config.providerName, this.config.transport, this.config.promptCache, this.config.model),
          temperature: request.temperature,
        });

        const iterator = result.fullStream[Symbol.asyncIterator]();
        for (;;) {
          const outcome = await nextWithStallTimeout(iterator, policy.stallTimeoutMs, attemptController.signal, lastActivityAt);

          if (isStalledOutcome(outcome)) {
            const stallError = new StreamStallError(policy.stallTimeoutMs);
            // Actually cancel the underlying SDK call; it will never be read again.
            attemptController.abort(stallError);
            // A stall after a completed step has nothing left to deliver: end
            // the step as finished instead of replaying it (Taskana 4705 review).
            if (completedFinish) break;
            // A stall may replay only before committed output.
            const stallRetryAllowed =
              !replayBlocked && (hadModelOutput ? mayRetryProvisional(stallError, true) : mayRetry(stallError)) && !request.abortSignal?.aborted;
            if (stallRetryAllowed) {
              pendingRetryError = stallError;
              break;
            }
            throw stallError;
          }

          if (outcome.done) {
            break;
          }

          // Provenance capture runs before translation because `raw` parts
          // have no core-vocabulary counterpart and are dropped by
          // `translateStreamPart` (its default arm). Last write wins: across a
          // retried step the replayed attempt's claim supersedes the abandoned
          // attempt's, which is the claim belonging to the response the caller
          // actually receives.
          const rawResponseModel = rawResponseModelOf(outcome.value);
          if (rawResponseModel !== undefined) {
            this.#lastResponseModel = rawResponseModel;
          }

          if (reasoningTextRecovery !== undefined) {
            for (const recovered of reasoningTextRecovery.observe(outcome.value)) {
              if (isModelOutputEvent(recovered)) hadModelOutput = true;
              yield recovered;
            }
          }
          if (outcome.value.type === "finish-step") {
            stepRawUsage = outcome.value.usage.raw;
          }
          let event = translateStreamPart(outcome.value, {
            transport: this.config.transport,
            stepRawUsage,
          });
          if (event === null) {
            continue;
          }
          if (event.type === "error") event = { ...event, error: contextualizeNetworkFailure(event.error, this.config.baseUrl) };
          // Drop provider chunk-parse artifacts that are safe to ignore (a
          // server tool block from a foreign backend, e.g. z.ai `webReader`
          // result, that isn't in the SDK's closed chunk union): the stream
          // continues (finish still arrives), so warn+continue instead of
          // yielding an `error` that would kill the turn. Does not touch
          // hadModelOutput and does not consume the retry budget (§2.2).
          if (event.type === "error" && isIgnorableStreamArtifact(event.error)) {
            const signature = describeStreamArtifact(event.error);
            if (!warnedArtifacts.has(signature)) {
              warnedArtifacts.add(signature);
              this.onDiagnostic({ kind: "provider_stream_artifact", signature });
            }
            continue;
          }
          // TASK.168: this pass IS a probe retry (started by a previous
          // pass) — defer this failure's fate to the resolution block after
          // the try/catch instead of classifying it here, regardless of
          // whether it would otherwise look retryable. Never reachable for
          // the pass that itself starts a probe (that branch is below, and
          // is mutually exclusive with this one by construction: a pass only
          // reaches this branch when `includeUsageProbe` was ALREADY set
          // before the pass began).
          if (event.type === "error" && includeUsageProbe !== undefined) {
            pendingProbeFailure = { error: event.error, kind: "event" };
            attemptController.abort(event.error);
            break;
          }
          // TASK.168: start a probe when this pre-content 400 is the FIRST
          // sign the flag might be the cause.
          if (
            event.type === "error" &&
            includeUsageProbeEligible(
              this.config.transport,
              attemptIncludeUsage,
              event.error,
              hadModelOutput,
              request.abortSignal?.aborted ?? false,
            )
          ) {
            includeUsageProbe = { error: event.error, kind: "event" };
            this.#includeUsageDisabledForEndpoint = true;
            attemptController.abort(event.error);
            probeRetryNeeded = true;
            break;
          }
          // A retryable failure can replay while output remains provisional.
          if (
            event.type === "error" &&
            !completedFinish &&
            !replayBlocked &&
            isRetryableStreamError(event.error) &&
            mayRetryProvisional(event.error, hadModelOutput) &&
            !request.abortSignal?.aborted
          ) {
            pendingRetryError = event.error;
            attemptController.abort(pendingRetryError);
            break;
          }
          if (blocksAutomaticReplay(event)) replayBlocked = true;
          if (isModelOutputEvent(event)) {
            hadModelOutput = true;
          }
          if (event.type === "finish" && event.finishReason !== "error") {
            completedFinish = true;
          }
          yield event;
          // Taskana 4090: emit the attempt's quota observation immediately
          // after `finish` — the wrapped fetch populated `#lastQuota` before
          // the SDK decoded any body part, so by the time finish translates
          // the headers have long since been seen. One emission per attempt;
          // consumed here so a retried attempt re-reports its own headers.
          if (event.type === "finish" && this.#lastQuota !== null) {
            const quota = this.#lastQuota;
            this.#lastQuota = null;
            yield { type: "provider_quota", quota, baseUrl: this.config.baseUrl };
          }
        }
      } catch (rawError) {
        const error = contextualizeNetworkFailure(rawError, this.config.baseUrl);
        // TASK.168: mirror of the error-part branch above, for a failure that
        // surfaced as a THROWN exception (e.g. a synchronous validation
        // error, or a rejection from `fullStream` iteration before any part
        // was read) instead of a stream part.
        if (includeUsageProbe !== undefined) {
          pendingProbeFailure = { error, kind: "thrown" };
        } else if (
          includeUsageProbeEligible(
            this.config.transport,
            attemptIncludeUsage,
            error,
            hadModelOutput,
            request.abortSignal?.aborted ?? false,
          )
        ) {
          includeUsageProbe = { error, kind: "thrown" };
          this.#includeUsageDisabledForEndpoint = true;
          probeRetryNeeded = true;
        } else if (
          // Match the yielded-error gate and let external cancellation win.
          !completedFinish &&
          !replayBlocked &&
          isRetryableStreamError(error) &&
          mayRetryProvisional(error, hadModelOutput) &&
          !request.abortSignal?.aborted
        ) {
          pendingRetryError = error;
          attemptController.abort(error);
        } else {
          throw error;
        }
      } finally {
        disposeLink();
      }

      // TASK.168: resolve a deferred probe-retry failure OUTSIDE the
      // try/catch above — deliberately, so a rollback's `throw` propagates
      // straight out of the generator instead of risking re-entry into this
      // same pass's own `catch`.
      if (pendingProbeFailure !== undefined) {
        const failure = pendingProbeFailure;
        // Invariant: pendingProbeFailure is only ever set in the two branches
        // above that first check `includeUsageProbe !== undefined`, so it is
        // always defined here too.
        const original = includeUsageProbe as ProbeFailure;
        if (isPreContent400(failure.error, hadModelOutput)) {
          // The retry ALSO 400'd pre-content: the flag was NOT the cause.
          // Roll back the optimistic disable and surface the FIRST failure
          // unchanged through the channel it originally used — this (second)
          // error is discarded so a genuine model-side 400 is never
          // rewritten into a confusing one.
          this.#includeUsageDisabledForEndpoint = false;
          includeUsageProbe = undefined;
          if (original.kind === "thrown") {
            throw original.error;
          }
          yield { type: "error", error: original.error } as ModelStreamEvent;
          return;
        }
        // The retry got past the 400 (success, a stall, or a genuinely
        // different failure): the flag WAS the cause. Commit permanently and
        // warn exactly once, then re-classify THIS pass's actual failure
        // exactly as the non-probe path would have.
        this.#confirmIncludeUsageProbe();
        includeUsageProbe = undefined;
        if (
          !completedFinish && !replayBlocked &&
          isRetryableStreamError(failure.error) &&
          mayRetryProvisional(failure.error, hadModelOutput) &&
          !request.abortSignal?.aborted
        ) {
          pendingRetryError = failure.error;
        } else if (failure.kind === "thrown") {
          throw failure.error;
        } else {
          yield { type: "error", error: failure.error } as ModelStreamEvent;
          return;
        }
      }

      if (probeRetryNeeded) {
        // Immediate, budget-exempt retry: no backoff, no attempt increment,
        // no stream_retry event — the whole point is that a strict server's
        // rejection of an unknown wire field is not a transient network
        // failure the caller needs to see as a retry announcement.
        continue;
      }

      // TASK.168: reaching here with a still-pending probe means THIS pass
      // was the probe retry itself and it finished with NO error part or
      // thrown exception at all (a clean finish, or a stall — the one
      // non-error outcome that also breaks the inner loop without going
      // through pendingProbeFailure above). Either way the flag is no longer
      // the blocker: commit + warn.
      if (includeUsageProbe !== undefined) {
        this.#confirmIncludeUsageProbe();
        includeUsageProbe = undefined;
      }

      if (pendingRetryError === NO_RETRY) {
        return;
      }

      // Taskana 4772: a pre-content transient network failure with a waiter
      // first gets a gate probe (only while the count budget lasts; a server
      // blip on a reachable network keeps the ordinary backoff). If the endpoint
      // is unreachable, the turn waits for the network instead of failing.
      let recoveredAfterMs: number | undefined;
      const networkWaiter = this.config.networkWaiter;
      if (
        networkWaiter !== undefined &&
        !hadModelOutput &&
        policy.networkWaitMaxMs > 0 &&
        isTransientNetworkError(pendingRetryError)
      ) {
        const online =
          attempt < policy.maxRetries && (await probeNetwork(networkWaiter, this.config.baseUrl, request.abortSignal));
        if (!online) {
          recoveredAfterMs = yield* this.#awaitNetworkRecovery(
            networkWaiter,
            pendingRetryError,
            networkWaitSpentMs,
            policy.networkWaitMaxMs,
            request.abortSignal,
          );
          networkWaitSpentMs += recoveredAfterMs;
        }
      }

      // A recovered wait already was the backoff: the replay follows at once.
      // F5: `delayMs` is the PENDING delay before the replay fires, so a
      // recovery carries 0 — the episode's duration rides `waitedMs` instead,
      // for renderers that want to say "network back after N s; retrying now".
      const delayMs = recoveredAfterMs !== undefined ? 0 : retryDelayMs(attempt, pendingRetryError, policy);
      const waitedMs = recoveredAfterMs !== undefined ? Math.round(recoveredAfterMs) : undefined;
      attempt += 1;
      yield {
        type: "stream_retry",
        attempt,
        maxAttempts: policy.maxRetries,
        delayMs,
        ...(waitedMs !== undefined ? { waitedMs } : {}),
        // Review F2: on a recovery, name the source that just woke so a
        // per-source banner count decrements the right one.
        ...(waitedMs !== undefined && this.config.networkWaitSource !== undefined
          ? { waitSource: this.config.networkWaitSource }
          : {}),
        reason: describeRetryReason(pendingRetryError),
      };
      if (recoveredAfterMs === undefined) {
        await abortableDelay(delayMs, request.abortSignal);
      }
      // Falls through to the top of the loop: the whole step is replayed.
    }
  }
}

/**
 * ModelPort adapter over the AI SDK. Per call:
 *  - builds the LanguageModel via createLanguageModel(config), which picks the
 *    client factory by the config's transport
 *  - invokes streamText with stopWhen: stepCountIs(1) (explicit; one model
 *    step per call — the multi-turn loop lives above this boundary),
 *    maxRetries: 0 (retry policy is owned by this adapter, Phase 1), and a
 *    per-attempt AbortController linked to the request's abortSignal.
 *  - consumes result.fullStream and yields translateStreamPart(part) events,
 *    dropping nulls.
 *

 * while no MODEL OUTPUT has yet reached the consumer from this attempt's stream
 * (see `isModelOutputEvent` in ./failure.ts): a before-content failure —
 * connect/reset/HTTP-error-before-content — is safe to replay the whole step.
 * The SDK's `fullStream` unconditionally yields a synthetic `{type:"start"}`
 * before any network I/O, and a same-attempt `{type:"error"}` is the failure
 * descriptor itself, so NEITHER closes the gate (TASK.33 W7a; without this the
 * connect-timeout retry never fired in production). Content, reasoning,
 * tool-input, `tool_call`, and `finish` DO close it — replaying after real
 * output would double-dispatch a tool call, duplicate partial text, or re-bill a
 * completed step. Retries apply uniformly whether the failure surfaces as a
 * thrown exception from `fullStream` iteration or as a translated `error` event.
 * Before each retry the adapter yields `stream_retry`, then waits the backoff
 * delay — the wait is abortable and the request's abortSignal wins instantly;
 * an already-aborted request never retries (an external abort always wins).
 *

 * abortable `policy.stallTimeoutMs` timer (0 disables it). A stall aborts the
 * per-attempt controller (so the underlying SDK call is actually cancelled,
 * not merely abandoned) and is classified as a retryable stall REGARDLESS of
 * `hadModelOutput` — it is the one mid-stream retry allowed by design, still
 * bounded by the shared `attempt < policy.maxRetries` budget. A genuine
 * external abort (request.abortSignal) always wins over a stall and rejects
 * immediately with the abort reason, never retried.
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
import { classifyProviderFailure, extractStatusCode, isModelOutputEvent } from "./failure.js";
import { createLanguageModel } from "./language-model.js";
import { DEFAULT_RETRY_POLICY, isRetryableStreamError, retryDelayMs, type RetryPolicy } from "./retry.js";
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
  providerOptions?: { anthropic: { effort?: string; thinking: { type: "enabled"; budgetTokens: number } } };
}

/**
 * Return shape on the openai-chat-completions transport: `reasoning_effort` is
 * a plain enum, not a token budget, so there is no maxOutputTokens arithmetic
 * to perform (§4.3) — `maxOutputTokens` merely passes the request's value
 * through unchanged when present.
 */
interface OpenAICompatibleReasoningOptions {
  maxOutputTokens?: number;
  providerOptions?: { openaiCompatible: { reasoningEffort: string } };
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
 */
interface OpenAIResponsesReasoningOptions {
  maxOutputTokens?: number;
  providerOptions: { openai: { store: false; reasoningEffort?: string } };
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
 * openai-chat-completions maps to `providerOptions.openaiCompatible.reasoningEffort`
 * (TASK.43 §4.2/§4.3): `@ai-sdk/openai-compatible` reads that exact key
 * unconditionally and serializes it as top-level `reasoning_effort` in the
 * request body. `"max"` collapses to `"high"` — chat-completions has no `xhigh`/
 * `max` tier of its own, unlike GLM's Anthropic-proxied enum above.
 *
 * openai-responses maps to `providerOptions.openai.{reasoningEffort, store}`
 * (TASK.43 §0.2/§0.7). `store: false` is UNCONDITIONAL — it rides on every
 * request on this transport, reasoning or not (see `OpenAIResponsesReasoningOptions`
 * above). `reasoningEffort`, when present, is passed through VERBATIM
 * (including `"max"`) rather than collapsed the way chat-completions collapses
 * it: unlike chat-completions' fixed enum, real OpenAI reasoning models keep
 * gaining tiers (`minimal`, and whatever ships after this was written), and
 * which values a given model actually accepts is a capability-layer/catalog
 * question (`effortLevels`), not something this wire-mapping function should
 * guess or narrow ahead of time.
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
): AnthropicReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-chat-completions",
): OpenAICompatibleReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-responses",
): OpenAIResponsesReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: ProviderTransport,
): ReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName?: string,
  transport: ProviderTransport = "anthropic-messages",
): ReasoningOptions {
  const effort = request.reasoningEffort;

  if (transport === "openai-responses") {
    // store:false is unconditional (§0.2): AnyCode owns history end-to-end, and
    // leaving `store` absent defaults the real API to `store: true` server-side
    // — a hidden second persistence this transport must never create.
    if (effort === undefined || effort === "off") {
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        providerOptions: { openai: { store: false } },
      };
    }
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: { openai: { store: false, reasoningEffort: effort } },
    };
  }

  if (transport === "openai-chat-completions") {
    if (effort === undefined || effort === "off") {
      return request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens };
    }
    // reasoning_effort is an enum, not a token budget: no maxOutputTokens arithmetic.
    // "max" has no chat-completions equivalent; collapse to "high" (§4.3).
    const mapped = effort === "max" ? "high" : effort;
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: { openaiCompatible: { reasoningEffort: mapped } },
    };
  }

  if (effort === undefined || effort === "off") {
    return request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens };
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

  // Default / real Anthropic (Claude): budgetTokens is the canonical extended-thinking format.
  const budgetTokens =
    effort === "max"
      ? REASONING_BUDGET_TOKENS.high
      : REASONING_BUDGET_TOKENS[effort as "low" | "medium" | "high"];
  const maxOutputTokens = Math.max(request.maxOutputTokens ?? 0, budgetTokens + 1_024);
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

/**
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
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stalled: true });
      }, stallTimeoutMs);
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
  ) {}

  /** Identity readback: the id this port was constructed for (never canonicalized). */
  get modelId(): string {
    return this.config.model;
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
   * already disabled it, or unless this very attempt IS the probe retry) — it
   * always wins over `this.config.includeUsage` so the spread below stays a
   * no-op byte-for-byte match of the pre-TASK.168 shape whenever the two
   * values happen to be equal (the overwhelming majority of attempts).
   */
  private async buildAttemptModel(includeUsage: boolean | undefined): Promise<LanguageModel> {
    const { resolveApiKey } = this.config;
    if (resolveApiKey === undefined) {
      return createLanguageModel({ ...this.config, includeUsage });
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
    return createLanguageModel({ ...this.config, apiKey, includeUsage });
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

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const policy = resolveRetryPolicy(this.config.retry);
    let attempt = 0;
    // TASK.168: the failure that STARTED the include_usage probe, carried
    // from that attempt to the very next one (the probe retry) — see
    // `ProbeFailure`'s docstring.
    let includeUsageProbe: ProbeFailure | undefined;

    for (;;) {
      let hadModelOutput = false;
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
        const model = await this.buildAttemptModel(attemptIncludeUsage);
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
          abortSignal: attemptController.signal,
          // Raw provider chunks are the only trustworthy source of the
          // response-side model claim, and only the anthropic-messages
          // transport carries one (`message_start.message.model`); the flag
          // stays off elsewhere so no other transport pays for duplicate parts.
          ...(this.config.transport === "anthropic-messages" ? { includeRawChunks: true } : {}),
          ...reasoningRequestOptions(request, this.config.providerName, this.config.transport),
          temperature: request.temperature,
        });

        const iterator = result.fullStream[Symbol.asyncIterator]();
        for (;;) {
          const outcome = await nextWithStallTimeout(iterator, policy.stallTimeoutMs, attemptController.signal);

          if (isStalledOutcome(outcome)) {
            const stallError = new StreamStallError(policy.stallTimeoutMs);
            // Actually cancel the underlying SDK call; it will never be read again.
            attemptController.abort(stallError);
            // Stall is the one mid-stream retry allowed by design: it ignores
            // hadModelOutput, still bounded by the shared attempt budget.
            if (attempt < policy.maxRetries) {
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

          const event = translateStreamPart(outcome.value);
          if (event === null) {
            continue;
          }
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
          // Retry a before-content failure that surfaced as an `error` STREAM
          // PART (the connect/reset/HTTP-error-before-content class — see the
          // gate note in ./failure.ts). The gate is `!hadModelOutput`, so the
          // synthetic `start` above does NOT block this branch. An already-
          // aborted request always wins over retry (the abort reason may itself
          // look retryable); aborting the attempt controller before breaking
          // tears down the abandoned attempt's socket now instead of at GC,
          // mirroring the stall path.
          if (
            event.type === "error" &&
            !hadModelOutput &&
            attempt < policy.maxRetries &&
            isRetryableStreamError(event.error) &&
            !request.abortSignal?.aborted
          ) {
            pendingRetryError = event.error;
            attemptController.abort(pendingRetryError);
            break;
          }
          if (isModelOutputEvent(event)) {
            hadModelOutput = true;
          }
          yield event;
        }
      } catch (error) {
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
          // Same gate as the error-part branch, for a before-content failure that
          // surfaced as a THROWN exception from `fullStream` iteration. The
          // `!request.abortSignal?.aborted` guard makes an external abort always
          // win over retry, even when the thrown abort reason looks retryable.
          !hadModelOutput &&
          attempt < policy.maxRetries &&
          isRetryableStreamError(error) &&
          !request.abortSignal?.aborted
        ) {
          pendingRetryError = error;
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
          !hadModelOutput &&
          attempt < policy.maxRetries &&
          isRetryableStreamError(failure.error) &&
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

      const delayMs = retryDelayMs(attempt, pendingRetryError, policy);
      attempt += 1;
      yield {
        type: "stream_retry",
        attempt,
        maxAttempts: policy.maxRetries,
        delayMs,
        reason: describeRetryReason(pendingRetryError),
      };
      await abortableDelay(delayMs, request.abortSignal);
      // Falls through to the top of the loop: the whole step is replayed.
    }
  }
}

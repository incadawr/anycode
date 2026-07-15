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
 */

import { stepCountIs, streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import { consoleDiagnosticSink, type DiagnosticSink } from "../types/diagnostics.js";
import type { ModelStreamEvent } from "../types/events.js";
import { linkAbortSignal } from "../util/abort.js";
import type { ProviderTransport } from "./catalog.js";
import type { EndpointConfig } from "./endpoint.js";
import { classifyProviderFailure, isModelOutputEvent } from "./failure.js";
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

  // GLM via z.ai: effort enum ("high"|"max") + thinking budget (16k/32k). The
  // proxy honors `effort` (output_config.effort) as the tier selector; the
  // budget must be large enough to hold the thinking output for that tier.
  if (providerName === "Z.AI (GLM)") {
    const glmBudget = effort === "max" ? GLM_BUDGET_TOKENS.max : GLM_BUDGET_TOKENS.high;
    const glmEffort = effort === "max" ? "max" : "high"; // low/medium collapse to high
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
 * `stream_retry.reason` rides the wire and is rendered verbatim by the CLI and
 * renderer, so it must be the whitelist-derived safe message — NEVER the raw
 * `error.message`, which can embed a response body or auth header (TASK.33
 * W7b-FIX #2).
 */
function describeRetryReason(error: unknown): string {
  return classifyProviderFailure(error).safe.message;
}

export class AiSdkModelPort implements ModelPort {
  constructor(
    private readonly config: EndpointConfig,
    private readonly onDiagnostic: DiagnosticSink = consoleDiagnosticSink,
  ) {}

  /**
   * Builds this attempt's LanguageModel (slice 2.5 §3.3) through the transport
   * dispatcher. When no per-attempt resolver is configured, the ORIGINAL config
   * object is handed to the factory — byte-for-byte the 2.2 static-key path. When
   * one is configured, resolves a fresh key at the START of the attempt so a
   * mid-session-refreshed OAuth token is picked up; a rejection or empty/blank
   * result falls back to the static `config.apiKey` (the model port never fails
   * just because a refresh hiccupped — the SDK call itself will surface a real
   * auth failure).
   */
  private async buildAttemptModel(): Promise<LanguageModel> {
    const { resolveApiKey } = this.config;
    if (resolveApiKey === undefined) {
      return createLanguageModel(this.config);
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
    return createLanguageModel({ ...this.config, apiKey });
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const policy = resolveRetryPolicy(this.config.retry);
    let attempt = 0;

    for (;;) {
      let hadModelOutput = false;
      let pendingRetryError: unknown = NO_RETRY;
      // Per-attempt dedup of dropped-artifact warnings (reset with the attempt
      // on retry, alongside hadModelOutput) — slice 3.7 R1, §2.2.
      const warnedArtifacts = new Set<string>();

      // Per-attempt controller so a stall can cancel just this attempt's SDK
      // call without tearing down the caller's own abortSignal; linked so an
      // external abort still reaches the SDK immediately.
      const attemptController = new AbortController();
      const disposeLink = request.abortSignal
        ? linkAbortSignal(request.abortSignal, attemptController)
        : () => {};

      try {
        const model = await this.buildAttemptModel();
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
          ...reasoningRequestOptions(request, this.config.providerName, this.config.transport),
          temperature: request.temperature,
        });

        const iterator = result.fullStream[Symbol.asyncIterator]();
        for (;;) {
          const outcome = await nextWithStallTimeout(iterator, policy.stallTimeoutMs, attemptController.signal);

          if (isStalledOutcome(outcome)) {
            const stallError = new Error(
              `stream stalled: no events for ${policy.stallTimeoutMs}ms`,
            );
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
        // Same gate as the error-part branch, for a before-content failure that
        // surfaced as a THROWN exception from `fullStream` iteration. The
        // `!request.abortSignal?.aborted` guard makes an external abort always
        // win over retry, even when the thrown abort reason looks retryable.
        if (
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

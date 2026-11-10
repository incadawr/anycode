import { applyGoRequestLimits } from "./go-request-limits.js";
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
 * adds a SEPARATE, budget-exempt one-shot retry on the
 * openai-chat-completions transport: a pre-content HTTP 400 while
 * `includeUsage` is on is retried ONCE with the flag forced off (no backoff,
 * no `stream_retry` event, never counted against `policy.maxRetries`). A
 * successful retry permanently disables the flag for the rest of THIS port
 * instance's life and fires a `DiagnosticSink` warning exactly once; a retry
 * that 400s again restores the flag and re-surfaces the FIRST failure
 * unchanged (see `includeUsageProbeEligible`/`ProbeFailure` and
 * `#includeUsageDisabledForEndpoint`).
 */

import { generateText, stepCountIs, streamText } from "ai";
import type { LanguageModel, TextStreamPart, ToolSet } from "ai";
import { compactReasoningParts } from "./reasoning-compactor.js";
import type { AssistantPart, ReasoningSource } from "../types/history.js";
import { catalogPreservesReasoning } from "./catalog-data.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import { consoleDiagnosticSink, type DiagnosticSink } from "../types/diagnostics.js";
import type { ModelStreamEvent } from "../types/events.js";
import { linkAbortSignal } from "../util/abort.js";
import type { ProviderTransport } from "./catalog.js";
import type { EndpointConfig } from "./endpoint.js";
import type { OpenCodeGoEndpointPolicy } from "./opencode-go-policy.js";
import { DEFAULT_STREAM_OUTPUT_STALL_TIMEOUT_MS } from "../types/config.js";
import type { ImplicitPromptCache, ReasoningEffort } from "../types/config.js";
import { StreamStallError, blocksAutomaticReplay, captureProviderMessage, classifyProviderFailure, extractStatusCode, isModelOutputEvent } from "./failure.js";
import { ResponsesReasoningTextRecovery } from "./responses-reasoning-text.js";
import { isMiMoModel } from "./mimo.js";
import { contextualizeMiniMaxBalance, isMiniMaxEffortModel, isMiniMaxModel } from "./minimax.js";
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

/**
 * Generic-path thinking budget for the `max` effort tier on CUSTOM
 * (non-catalog) Anthropic-compatible endpoints — strictly larger than
 * high/xhigh's 24_576 so `xhigh` and `max` are always distinguishable on the
 * wire even for an endpoint that ignores the effort enum.
 */
const GENERIC_MAX_BUDGET_TOKENS = 32_000;

/** Z.AI's documented max_tokens ceiling for the GLM-5/4.6 family. */
const GLM_MAX_TOKENS = 131_072;

/**
 * Output-token ceiling for a one-shot title request on a provider that cannot
 * turn thinking off (DeepSeek: the anthropic transport here sends the effort
 * enum alone, and the service still reasons first). The default title cap of
 * 32 tokens is entirely eaten by that thinking block — stop_reason
 * `max_tokens`, zero text, heuristic title kept. A live title request on
 * deepseek-flash produced the expected 3-6 word title at `max_tokens: 200`;
 * 512 keeps generous headroom for the thinking block while staying small
 * enough that the model cannot wander into a long preamble.
 */
const MANDATORY_THINKING_TITLE_MAX_OUTPUT_TOKENS = 512;

/** Return shape of `reasoningRequestOptions` on the anthropic-messages transport. */
interface AnthropicReasoningOptions {
  maxOutputTokens?: number;
  // thinking optional since the DeepSeek branch (4241) sends the effort enum alone.
  providerOptions?: { anthropic: { effort?: string; thinking?: { type: "enabled"; budgetTokens: number } | { type: "adaptive" } | { type: "disabled" } } };
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
 * transports, `providerOptions` is NON-optional: `store: false` (§0.2)
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
  providerOptions: { openai: { store: false; include?: string[]; reasoningEffort?: string; forceReasoning?: true; promptCacheOptions?: ImplicitPromptCache } };
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
 * (§0.2/§0.7). `store: false` is UNCONDITIONAL — it rides on every
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
  declaredEffortLevels?: readonly ReasoningEffort[],
  goPolicy?: OpenCodeGoEndpointPolicy,
): AnthropicReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-chat-completions",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
  declaredEffortLevels?: readonly ReasoningEffort[],
  goPolicy?: OpenCodeGoEndpointPolicy,
): OpenAICompatibleReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: "openai-responses",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
  declaredEffortLevels?: readonly ReasoningEffort[],
  goPolicy?: OpenCodeGoEndpointPolicy,
): OpenAIResponsesReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName: string | undefined,
  transport: ProviderTransport,
  promptCache?: ImplicitPromptCache,
  modelId?: string,
  declaredEffortLevels?: readonly ReasoningEffort[],
  goPolicy?: OpenCodeGoEndpointPolicy,
): ReasoningOptions;
export function reasoningRequestOptions(
  request: ModelRequest,
  providerName?: string,
  transport: ProviderTransport = "anthropic-messages",
  promptCache?: ImplicitPromptCache,
  modelId?: string,
  declaredEffortLevels?: readonly ReasoningEffort[],
  goPolicy?: OpenCodeGoEndpointPolicy,
): ReasoningOptions {
  const effort = request.reasoningEffort;
  if (goPolicy) {
    // Go Messages mapping is based on declarations; the paid door is unverified live.
    const r = goPolicy.capabilities?.reasoning;
    const selected = effort === "off" ? "none" : effort;
    const wire = selected !== undefined && r?.effort?.includes(selected) ? selected
      : effort === undefined && r?.default && r.effort?.includes(r.default.value) ? r.default.value : undefined;
    const max = request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens };
    if (transport === "openai-responses") return { ...max, providerOptions: { openai: { store: false, ...(wire ? { reasoningEffort: wire, forceReasoning: true as const } : {}) } } };
    if (transport === "openai-chat-completions") return { ...max, ...(wire ? { providerOptions: { openaiCompatible: { reasoningEffort: wire } } } : {}) };
    if ((effort === undefined || effort === "off") && r?.toggle) return { ...max, providerOptions: { anthropic: { thinking: { type: "disabled" } } } };
    if (wire && r?.effort) return { ...max, providerOptions: { anthropic: { effort: wire, thinking: { type: "adaptive" } } } };
    if (effort && effort !== "off" && !r?.effort && r?.budget) {
      const generic = effort === "low" || effort === "minimal" ? REASONING_BUDGET_TOKENS.low : effort === "medium" ? REASONING_BUDGET_TOKENS.medium : REASONING_BUDGET_TOKENS.high;
      const budgetTokens = Math.min(generic, r.budget.max ?? generic);
      return { ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: Math.max(1, request.maxOutputTokens - budgetTokens) } : {}), providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } } };
    }
    return max;
  }

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
    if (isMiMoModel(providerName, modelId)) {
      // The picker displays No thinking when no explicit choice is stored.
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        providerOptions: { anthropic: { thinking: { type: "disabled" } } },
      };
    }
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
    // silently upgrading it to `high`. z.ai documents no separate
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

  // MiniMax: the tier rides the effort ENUM (`output_config.effort`), and the
  // request must carry NO thinking key at all.
  //
  // Facts (platform.minimax.io/docs/api-reference/text-anthropic-api, checked
  // 2026-10-31): "output_config.effort — Fully Supported: Tunes thinking depth
  // for MiniMax-M3.1-Flash. Accepts low, medium, high, xhigh, and max;
  // defaults to max when omitted" and "MiniMax-M3.1-Flash always thinks and
  // returns 400 if disabled is sent" — the endpoint's own error text is
  // `thinking.type="disabled" (including reasoning.effort=none) is not
  // allowed (2013)`. `thinking.budget_tokens` is not part of MiniMax's
  // vocabulary, and omitting `thinking` leaves thinking ON.
  //
  // So the generic tail below is WRONG for MiniMax in two ways: it sends a
  // thinking budget the endpoint ignores (so the tier never changes), and it
  // sends no effort enum (so the endpoint applies its own default — `max` —
  // whatever the user picked). This branch sends the enum and nothing else.
  //
  // The enum rides for EVERY tier, `low` included: the endpoint switches its
  // reasoning depth on the enum, so a tier that is not sent is a tier that did
  // nothing. The catalog row's own `effortLevels` is the declaration that
  // validates the pick upstream (`resolveReasoningEffort` drops an undeclared
  // level), so no separate `declaredEffortLevels` is needed here — that
  // concept belongs to CUSTOM endpoints, which this branch never matches
  // (a custom connection carries no `providerName`).
  //
  // `MiniMax-M3` is excluded: the docs scope the effort enum to
  // MiniMax-M3.1-Flash, and M3's thinking is off by default (omitting
  // `thinking` keeps it off) — so it gets neither an enum nor a thinking key.
  if (isMiniMaxModel(providerName, modelId)) {
    if (isMiniMaxEffortModel(providerName, modelId)) {
      return {
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        providerOptions: { anthropic: { effort } },
      };
    }
    // MiniMax-M3: no effort vocabulary (the docs scope `output_config.effort`
    // to M3.1-Flash) and thinking is OFF by default — omitting `thinking` keeps
    // it off. So the request carries neither an enum nor a thinking key; the
    // generic tail's thinking budget would be a field MiniMax does not speak.
    return request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens };
  }

  // Xiaomi MiMo: same shape as MiniMax — the tier rides the effort ENUM
  // (`output_config.effort`) and the request carries NO thinking key.
  //
  // Facts: MiMo's documentation (mimo.mi.com, accessed 2026-10-31) documents
  // only `thinking.type` (enabled by default) — no budget field, no documented
  // effort vocabulary. The wire behaviour was MEASURED against the direct API
  // (mimo-v2.6-pro, hard no-tool prompt, 2 reps per cell, all answers correct):
  //   thinking omitted                     31.3k out / 482 s
  //   output_config.effort "low",  no budget  28.7k out / 420 s
  //   output_config.effort "high", no budget  48.0k out / 700 s
  //   old app bytes (enabled + budget)     low 22.6k ≈ high 20.1k
  // So `thinking.budget_tokens` is IGNORED (low and high produced the same
  // amount of reasoning), while the effort enum IS honoured (high ≈ 1.7x low).
  // The generic tail below therefore made every level identical AND sent a
  // field the endpoint does not speak.
  //
  // Levels: only `low` and `high` are measured, and no effort vocabulary is
  // documented, so only those two values are ever emitted. A level between
  // them (`medium`) or above them (`xhigh`, `max`) collapses onto `high` —
  // the same "no documented equivalent ⇒ high" precedent as the GLM branch —
  // rather than inventing enum values the endpoint may reject and claiming a
  // depth nobody measured. Any such pick still reasons at least as deeply as
  // the pick intends; it never silently loses the tier the way the old bytes
  // did (the endpoint ignored the budget and used its own default).
  //
  // No thinking budget ⇒ no max_tokens arithmetic: the SDK adds the budget to
  // max_tokens only when one exists, so `maxOutputTokens` (the catalog's
  // 131_072, the provider's own ceiling) passes through unchanged and the
  // generic tail's MiMo subtraction is gone with the budget.
  //
  // "No level selected" is untouched: it keeps `thinking: {type:"disabled"}`
  // (see the branch above), the knob the picker labels "No thinking".
  if (isMiMoModel(providerName, modelId)) {
    const mimoEffort = effort === "low" ? "low" : "high";
    return {
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      providerOptions: { anthropic: { effort: mimoEffort } },
    };
  }

  // DeepSeek: distinct low/high/max effort tiers, default high —
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
  // xhigh vs max MUST stay distinguishable on the wire (GitHub #2 review) — but
  // ONLY for custom (non-catalog) Anthropic-compatible endpoints, which is the
  // card's scope. The gate is `providerName === undefined`: the wiring layer
  // sets it from the catalog entry's name only for catalog providers, so
  // catalog anthropic-transport providers WITHOUT a dedicated branch above
  // (Kimi, …) keep their exact pre-fix request bytes for every
  // effort — including max (same high budget, no effort field) — rather than
  // suddenly receiving an `output_config.effort` key and a larger budget a
  // strict proxy could reject. Custom connections always get DISTINCT budgets
  // (high's 24_576 for xhigh vs a strictly larger 32_000 for max), so even an
  // endpoint that ignores output_config still sees a different
  // thinking.budget_tokens and the tiers never collapse.
  //
  // `output_config.effort` is a SEPARATE, opt-in half: it is sent only where
  // support is KNOWN. First-party Anthropic models carry it on their dedicated
  // branch above (adaptive thinking) and keep it unchanged here. A custom
  // endpoint gets it when the connection DECLARED an effort vocabulary
  // (`declaredEffortLevels`, from the same ANYCODE_EFFORT_LEVELS declaration
  // the CLI validates the selection against) AND the selected tier is one of
  // the declared levels — the declaration is the endpoint naming the effort
  // vocabulary it speaks, and on this transport an effort enum is the only
  // way that vocabulary can be expressed.
  //
  // The enum is sent for EVERY declared level (low, medium, high, xhigh,
  // max), not only the top two: an endpoint that ignores
  // `thinking.budget_tokens` and switches its reasoning tier on the effort
  // enum (MiniMax and other effort-enum endpoints) otherwise keeps its own
  // default — the maximum — no matter which level was picked, so "low"
  // silently did nothing. The budgets stay as they were (distinct per tier,
  // xhigh vs max still distinct), so an endpoint that ignores the enum still
  // sees a different `thinking.budget_tokens`.
  //
  // Without a declaration the request bytes stay EXACTLY as before: a strict
  // Anthropic-compatible server that only understands `thinking.budget_tokens`
  // never sees an unknown field. A declared level that was never selected
  // (or a selected level the connection did not declare) is likewise not
  // sent.
  const customAnthropicEndpoint = providerName === undefined;
  const budgetTokens =
    effort === "max" && customAnthropicEndpoint
      ? GENERIC_MAX_BUDGET_TOKENS
      : effort === "max" || effort === "xhigh"
        ? REASONING_BUDGET_TOKENS.high
        : REASONING_BUDGET_TOKENS[effort as "low" | "medium" | "high"];
  const wireEffort =
    customAnthropicEndpoint && declaredEffortLevels?.includes(effort) === true ? effort : undefined;
  const maxOutputTokens = Math.max(request.maxOutputTokens ?? 0, budgetTokens + 1_024);
  return {
    maxOutputTokens,
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
        ...(wireEffort !== undefined ? { effort: wireEffort } : {}),
      },
    },
  };
}

/** Sentinel distinguishing "no retry pending" from `undefined`/falsy retryable errors. */
const NO_RETRY = Symbol("no-retry");

/** Discriminates the stall outcome of `nextWithStallTimeout` from a real IteratorResult. */
interface StalledOutcome {
  stalled: true;
}

/**
 * a failure captured for the `stream_options.include_usage` probe.
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
 * when it rejects the unknown `stream_options` field. Shared by
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

/** Input rejection only: output thinking configuration errors are unrelated. */
function rejectsInputReasoning(error: unknown, firstReplay: boolean, includeRequested = false, includeOnly = false): boolean {
  const status = extractStatusCode(error);
  if (status === undefined || status < 400 || status >= 500 ||
      [401, 402, 403, 404, 408, 413, 429].includes(status)) return false;
  const e = error as { message?: unknown; responseBody?: unknown; data?: unknown } | null;
  const body = typeof e?.responseBody === "string" ? e.responseBody.trim() : "";
  const message = typeof e?.message === "string" ? e.message.trim() : "";
  let data = "";
  try { data = e?.data ? JSON.stringify(e.data) : ""; } catch { return false; }
  const text = `${message} ${body} ${data}`;
  const unrelated = [
    /auth|permission|forbidden|api.?key|credential|access.?denied/i,
    /quota|balance|billing|payment|credits?|resource.?exhausted|rate.?limit|too many|insufficient/i,
    /model.{0,30}(not.?found|unknown|missing|unavailable|does not exist)|(?:unknown|missing|unavailable).{0,15}model/i,
    /context.{0,25}(length|limit|window)|token.{0,15}(limit|maximum)|prompt.{0,25}(long|large|limit)/i,
  ];
  if (unrelated.some(pattern => pattern.test(text))) return false;
  // Match parameter/value rejection syntax, never the ordinary verb "include".
  if (includeRequested && /(?:unrecognized|unsupported|invalid|unknown)\s+(?:(?:request|supplied)\s+)*(?:argument|parameter|value)s?\s*(?:supplied\s*)?[:=]?\s*["'`]*(?:include|reasoning\.encrypted_content)\b|(?:unrecognized|unsupported|invalid|unknown)\s+include\s+(?:argument|parameter|value)|(?:argument|parameter|value)\s*["'`]*(?:include|reasoning\.encrypted_content)\b.{0,30}(?:unrecognized|unsupported|invalid|unknown)/i.test(text)) return true;
  if (includeOnly) return false;
  if (status === 400 && firstReplay && !body && !e?.data && /^(?:|bad request|400(?: bad request)?)$/i.test(message)) return true;
  // A thinking budget/type error can mention blocks without rejecting history.
  if (/budget_tokens|output_config|thinking[.\s]+type|reasoning[._]effort/i.test(text) &&
      !/messages?|input|history|assistant/i.test(text)) return false;
  return /encrypted_content|model.{0,40}does not support (?:reasoning|thinking)|reasoning_content|reasoning_details|(?:messages?|input|history|assistant|blocks?)[\s\S]{0,100}(?:reasoning|thinking)|(?:reasoning|thinking)[\s\S]{0,100}(?:messages?|input|history|blocks?|signature)/i.test(text);
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

/** first probe tick while waiting for the network; doubles per failed tick up to the cap. */
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
 * `stream_retry.reason` rides the wire and is rendered verbatim by the CLI and
 * renderer, so it must be a sanitized safe message — NEVER raw
 * provider `error.message` text, which can embed a response body or auth
 * header (W7b-FIX #2). A `StreamStallError` is locally generated, not
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

/** The route identity for replay; Responses requires original encrypted content. */
export function reasoningReplaySource(config: EndpointConfig): ReasoningSource | undefined {
  if (config.reasoningHistory === "none") return undefined;
  if (config.transport === "openai-responses" && config.reasoningHistory?.startsWith("factual_")) return undefined;
  if (!(config.preserveReasoning ?? (!config.reasoningReplayRejected && catalogPreservesReasoning(config.providerName)))) return undefined;
  return {
    transport: config.transport,
    ...(config.goModelPolicy?.compatibility?.reasoning_field === "reasoning_content" ? { requireReasoningContent: true } : {}),
    ...(config.reasoningHistory?.startsWith("factual_") ? { replayFactual: true } : {}),
    ...(config.transport === "anthropic-messages" ? { replayUnsigned: true } : {}),
    ...(config.providerName !== undefined ? { provider: config.providerName } : {}),
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

/** Merges reasoning provider metadata per block id; the latest value wins, like the SDK. */
function collectReasoningMetadata(
  into: Map<string, Record<string, Record<string, unknown>>>,
  part: TextStreamPart<ToolSet>,
): void {
  if (part.type !== "reasoning-start" && part.type !== "reasoning-delta" && part.type !== "reasoning-end") return;
  const metadata = part.providerMetadata;
  if (metadata === undefined) return;
  const merged = { ...(into.get(part.id) ?? {}) };
  for (const [provider, values] of Object.entries(metadata)) {
    merged[provider] = { ...(merged[provider] ?? {}), ...(values as Record<string, unknown>) };
  }
  into.set(part.id, merged);
}

/** Reassemble OpenRouter detail deltas only when their identity is known. */
function collectOpenRouterDetails(details: Record<string, unknown>[], part: TextStreamPart<ToolSet>): boolean {
  if (part.type !== "raw" || !isRecord(part.rawValue) || !Array.isArray(part.rawValue.choices)) return false;
  const choice = part.rawValue.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta) || !Array.isArray(choice.delta.reasoning_details)) return false;
  for (const value of choice.delta.reasoning_details) {
    if (!isRecord(value)) continue;
    const index = typeof value.index === "number" ? value.index : undefined;
    let match = index === undefined ? -1 : details.findLastIndex((item) => item.index === index);
    if (match < 0 && typeof value.id === "string" && value.id !== "") {
      match = details.findLastIndex((item) => item.id === value.id &&
        (index === undefined || item.index === undefined) &&
        (typeof value.type !== "string" || typeof item.type !== "string" || item.type === value.type));
    }
    if (match < 0 && index === undefined && typeof value.type === "string" && typeof value.signature === "string" && value.signature !== "") {
      match = details.findLastIndex((item) => item.signature === value.signature && item.type === value.type &&
        (value.id == null || item.id == null || item.id === value.id));
    }
    if (match >= 0 && ((typeof details[match]!.signature === "string" && details[match]!.signature !== "" &&
      typeof value.text === "string" && value.text !== "" && value.signature !== details[match]!.signature) || ["id", "signature", "type"].some((key) =>
      typeof details[match]![key] === "string" && details[match]![key] !== "" &&
      typeof value[key] === "string" && value[key] !== "" && details[match]![key] !== value[key]))) match = -1;
    if (match < 0) { details.push({ ...value }); continue; }
    const previous = details[match]!;
    const merged = { ...previous, ...value };
    for (const key of ["text", "summary", "data", "signature"]) {
      if (value[key] == null && previous[key] !== undefined) merged[key] = previous[key];
      if (typeof previous[key] === "string" && typeof value[key] === "string" && !(key === "signature" && previous[key] === value[key])) merged[key] = previous[key] + value[key];
    }
    details[match] = merged;
  }
  return true;
}

export class AiSdkModelPort implements ModelPort {
  /** Provider's model claim from the most recent raw `message_start` seen by this port. */
  #lastResponseModel: string | undefined;

  /**
   * latest quota update observed by this attempt's
   * wrapped fetch (`config.onQuotaHeaders` writes it via the constructor
   * passthrough below). Fetch resolves before the SDK decodes the body, so
   * it is populated by the time the `finish` part translates; consumed and
   * cleared there — one `provider_quota` emission per attempt, and a
   * retried attempt re-reports fresh headers.
   */
  #lastQuota: ProviderQuotaUpdate | null = null;

  /**
   * permanent, per-PORT-INSTANCE memory that a strict
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
  #replayRequestSeen = false;
  #replayRejected = false;

  /**
   * This port's route identity when it replays reasoning (GitHub #41), else
   * undefined. Stamped on captured reasoning and compared on replay, so a
   * model or connection switch (a fresh port) never sends foreign reasoning.
   */
  readonly #reasoningSource: ReasoningSource | undefined;

  async compactReasoning(parts: AssistantPart[], signal?: AbortSignal): Promise<AssistantPart[]> {
    const mode = this.config.reasoningHistory;
    if (!mode?.startsWith("factual_") || this.#reasoningSource === undefined) return parts;
    const modelId = this.config.reasoningCompactorModel ?? this.config.model;
    return compactReasoningParts(parts, Number(mode.slice(8)), modelId, async (prompt, system) => {
      const target = this.config.resolveEndpointForModel?.(modelId) ?? { ...this.config, model: modelId };
      const model = await new AiSdkModelPort(target)
        .buildAttemptModel(target.includeUsage);
      return generateText({
        model,
        ...reasoningRequestOptions({
          messages: [], tools: [], reasoningEffort: target.goModelPolicy ? undefined : "low",
          maxOutputTokens: Number(mode.slice(8)) + 8192,
        }, target.providerName, target.transport, undefined, modelId, target.declaredEffortLevels, target.goModelPolicy),
        abortSignal: signal,
        maxRetries: 0,
        system,
        prompt,
      });
    }, signal);
  }

  reasoningReplaySource(effort?: ModelRequest["reasoningEffort"]): ReasoningSource | undefined {
    const options = reasoningRequestOptions({ messages: [], tools: [], reasoningEffort: effort }, this.config.providerName, this.config.transport, this.config.promptCache, this.config.model, this.config.declaredEffortLevels, this.config.goModelPolicy);
    const thinking = (options.providerOptions as { anthropic?: { thinking?: { type?: string } } } | undefined)?.anthropic?.thinking;
    return thinking?.type === "disabled" || this.#replayRejected ? undefined : this.#reasoningSource;
  }

  constructor(
    private readonly config: EndpointConfig,
    private readonly onDiagnostic: DiagnosticSink = consoleDiagnosticSink,
  ) {
    this.#reasoningSource = reasoningReplaySource(config);
    // rebind the config's observer through a port-owned shim so
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
  get goLimits() { return this.config.goModelPolicy?.limits; }

  get modelId(): string {
    return this.config.model;
  }

  get titleReasoningEffort(): "low" | undefined {
    return this.config.providerName === "DeepSeek" ? "low" : undefined;
  }

  /**
   * DeepSeek always reasons before it answers on the live service, even with
   * the low effort enum this port's `titleReasoningEffort` sends, so the title
   * request needs room for that thinking block (see
   * `MANDATORY_THINKING_TITLE_MAX_OUTPUT_TOKENS`). Every other provider keeps
   * the default title cap.
   */
  get titleMaxOutputTokens(): number | undefined {
    return this.config.providerName === "DeepSeek" ? MANDATORY_THINKING_TITLE_MAX_OUTPUT_TOKENS : undefined;
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
   * (`this.config.includeUsage` unless the endpoint-level probe has
   * already disabled it, or unless this very attempt IS the probe retry).
   * When it matches the config's own value — the overwhelming majority of
   * attempts — the config is forwarded UNTOUCHED: spreading would both break
   * the object identity the no-resolver path guarantees and add an
   * `includeUsage: undefined` key the shape never carried.
   */
  // The factory receives exactly one argument when the activity hook is absent.
  private async buildAttemptModel(includeUsage: boolean | undefined, onResponseActivity?: () => void, onKey?: (key: string | undefined) => void, goDisableThinking?: boolean, responsesReplay?: boolean): Promise<LanguageModel> {
    const create = (cfg: EndpointConfig): LanguageModel => {
      if (cfg.transport === "openai-responses" && responsesReplay !== undefined) cfg = { ...cfg, preserveReasoning: responsesReplay };
      return onResponseActivity === undefined ? createLanguageModel(cfg) : createLanguageModel(cfg, onResponseActivity);
    };
    const { resolveApiKey } = this.config;
    const usageOverridden = includeUsage !== this.config.includeUsage;
    if (resolveApiKey === undefined) {
      onKey?.(this.config.apiKey);
      return create(goDisableThinking ? { ...this.config, includeUsage, goDisableThinking } : usageOverridden ? { ...this.config, includeUsage } : this.config);
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
    onKey?.(apiKey);
    return create(
      goDisableThinking ? { ...this.config, apiKey, includeUsage, goDisableThinking } : usageOverridden ? { ...this.config, apiKey, includeUsage } : { ...this.config, apiKey },
    );
  }

  /**
   * Commits the include_usage probe: called exactly once, the
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
   * parks a pre-content transient network failure. Yields
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
    const waitId = crypto.randomUUID();
    const startedAt = Date.now();
    const waitSource = this.config.networkWaitSource;
    const source = waitSource === undefined ? {} : { waitSource };
    let failure: { error: unknown; outcome: "failed" | "cancelled" } | undefined;
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
      yield { type: "waiting_for_network", ...source, waitId, startedAt,
        deadlineAt: startedAt + Math.max(0, maxWaitMs - spentBeforeMs),
        failureCode: classifyProviderFailure(error).code };
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
          break;
        }
        // Only a timer-driven miss backs the tick off; a hint-driven probe keeps the schedule.
        if (!fromHint) tickMs = Math.min(tickMs * 2, NETWORK_WAIT_MAX_TICK_MS);
        fromHint = false;
      }
    } catch (caught) {
      failure = { error: caught, outcome: signal?.aborted ? "cancelled" : "failed" };
    } finally {
      unsubscribe?.();
    }
    const elapsed = elapsedMs();
    yield { type: "network_wait_end", waitId, ...source, outcome: failure?.outcome ?? "recovered" };
    if (failure) throw failure.error;
    return elapsed;
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    request = applyGoRequestLimits(request, this);
    const policy = resolveRetryPolicy(this.config.retry);
    let attempt = 0;
    let stallReplayed = false;
    // Time of this step's first retryable failure; anchors networkRetryBudgetMs.
    let firstFailureAt: number | undefined;
    // monotonic time this step has already spent waiting for the network (all episodes).
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
    // with a network waiter, a pre-content transient network failure
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
    // the failure that STARTED the include_usage probe, carried
    // from that attempt to the very next one (the probe retry) — see
    // `ProbeFailure`'s docstring.
    let includeUsageProbe: ProbeFailure | undefined;
    let reasoningCorrected = false;

    for (;;) {
      if (request.abortSignal?.aborted) throw abortReason(request.abortSignal);
      let hadModelOutput = false;
      let replayBlocked = false;
      // finish totals discard raw usage; keep the latest step's wire usage
      // inside this attempt so abandoned attempts cannot affect a retry.
      let stepRawUsage: unknown;
      // review: set once a non-error `finish` is yielded. The step
      // is then complete; replaying it would re-bill the provider and drop the
      // usage of the attempt the caller already received, so it is never replayed.
      let completedFinish = false;
      let pendingRetryError: unknown = NO_RETRY;
      // set instead of pendingRetryError when this pass ends by
      // starting an include_usage probe — that retry is immediate (no
      // backoff), doesn't consume the connect/stall retry budget, and never
      // emits a `stream_retry` wire event, so it deliberately bypasses the
      // pendingRetryError machinery below.
      let probeRetryNeeded = false;
      // THIS pass's own failure while a probe was already pending
      // (i.e. this pass IS the probe retry), captured here and resolved once
      // OUTSIDE the try/catch below — see `ProbeFailure`'s docstring for why.
      let pendingProbeFailure: ProbeFailure | undefined;
      // Per-attempt dedup of dropped-artifact warnings (reset with the attempt
      // on retry, alongside hadModelOutput) — slice 3.7 R1, §2.2.
      const warnedArtifacts = new Set<string>();
      // Per-attempt recovery and byte liveness prevent cross-talk on retries (GitHub #27).
      const reasoningTextRecovery = this.config.transport === "openai-responses" ? new ResponsesReasoningTextRecovery() : undefined;
      // Per-attempt, so an abandoned attempt never lends metadata to a replay (GitHub #41).
      const reasoningSource = this.reasoningReplaySource(request.reasoningEffort);
      const messages = toSdkMessages(request.messages, this.config.transport, reasoningSource);
      const hasInputReasoning = messages.some(message => message.role === "assistant" && (
        (Array.isArray(message.content) && message.content.some(part => part.type === "reasoning")) ||
        (Array.isArray(message.providerOptions?.openaiCompatible?.reasoning_details) && message.providerOptions.openaiCompatible.reasoning_details.length > 0)
      ));
      const firstReplay = hasInputReasoning && !this.#replayRequestSeen;
      if (hasInputReasoning) this.#replayRequestSeen = true;
      const includeRequested = this.config.transport === "openai-responses" && reasoningSource !== undefined;
      const correctReasoning = (error: unknown): boolean => {
        if (reasoningCorrected || this.config.preserveReasoning !== undefined || (!hasInputReasoning && !includeRequested) ||
            hadModelOutput || completedFinish || request.abortSignal?.aborted || !rejectsInputReasoning(error, firstReplay, includeRequested, !hasInputReasoning)) return false;
        // A pending usage probe is speculative: restore its original request option.
        if (includeUsageProbe !== undefined) {
          this.#includeUsageDisabledForEndpoint = false;
          includeUsageProbe = undefined;
        }
        reasoningCorrected = true;
        this.#replayRejected = true;
        this.onDiagnostic({ kind: "reasoning_replay_rejected", reason: "provider-rejected", baseUrl: this.config.baseUrl, model: this.config.model });
        return true;
      };
      let reasoningRetryNeeded = false;
      const reasoningMetadata = new Map<string, Record<string, Record<string, unknown>>>();
      const openRouterDetails: Record<string, unknown>[] = [];
      let openRouterDetailsPresent = false;
      const openRouterOpen = new Set<string>();
      let openRouterLastId: string | undefined;
      const trackOpenRouter = this.config.providerName === "OpenRouter" && this.config.transport === "openai-chat-completions";
      const captureOpenRouter = trackOpenRouter && reasoningSource !== undefined;
      const replaySource = reasoningSource !== undefined ? { source: reasoningSource } : {};
      let lastWireActivityAt = Number.NEGATIVE_INFINITY;
      const onResponseActivity = this.config.transport === "openai-responses" && policy.stallTimeoutMs > 0
        ? (): void => { lastWireActivityAt = Date.now(); } : undefined;
      const lastActivityAt = onResponseActivity !== undefined ? (): number => lastWireActivityAt : undefined;
      // the effective include_usage verdict for THIS attempt —
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

      let attemptKey: string | undefined;
      try {
        const model = await this.buildAttemptModel(attemptIncludeUsage, onResponseActivity, (key) => { attemptKey = key; }, this.config.goModelPolicy?.capabilities?.reasoning?.toggle === true && (request.reasoningEffort === undefined || request.reasoningEffort === "off"), reasoningSource !== undefined);
        const requestStartedAt = performance.now();
        // Generation speed is measured from the FIRST OUTPUT TOKEN — text,
        // reasoning or tool content — never from the first stream event. A
        // metadata chunk (`start-step`, a raw `message_start`) can arrive
        // seconds before the model produces anything; counting that wait as
        // generation would understate t/s and shrink time-to-first-token.
        let firstOutputAt: number | undefined;
        const requestOptions = reasoningRequestOptions(request, this.config.providerName, this.config.transport, this.config.promptCache, this.config.model, this.config.declaredEffortLevels, this.config.goModelPolicy);
        if (this.config.transport === "openai-responses" && reasoningSource !== undefined &&
            requestOptions.providerOptions && "openai" in requestOptions.providerOptions) {
          requestOptions.providerOptions.openai.include = ["reasoning.encrypted_content"];
        }
        const result = streamText({
          model,
          // System prompt goes out-of-band: ai@7 rejects system-role messages
          // inside `messages`, and its `system` option is deprecated for `instructions`.
          instructions: request.system,
          messages,
          tools: toSdkTools(this.config.goModelPolicy && this.config.goModelPolicy.capabilities?.tools?.supported !== true ? [] : request.tools),
          // One SDK step per ModelPort call; the multi-turn loop lives in AgentLoop.
          stopWhen: stepCountIs(1),
          // Retries are this adapter's responsibility (Phase 1); none in Phase 0.
          maxRetries: 0,
          // The SDK default prints raw response/body/headers to console. The
          // fullStream error already reaches our safe classifier and journal.
          onError: () => {},
          abortSignal: attemptController.signal,
          // Raw chunks carry provenance for Anthropic and reasoning text for Responses.
          includeRawChunks: true,
          ...requestOptions,
          temperature: this.config.goModelPolicy && this.config.goModelPolicy.capabilities?.temperature !== true ? undefined : request.temperature,
        });

        const iterator = result.fullStream[Symbol.asyncIterator]();
        for (;;) {
          // An explicit override applies to both windows, preserving its existing semantics.
          const timeoutMs = (hadModelOutput || stallReplayed) && this.config.retry?.stallTimeoutMs === undefined
            ? DEFAULT_STREAM_OUTPUT_STALL_TIMEOUT_MS : policy.stallTimeoutMs;
          const outcome = await nextWithStallTimeout(iterator, timeoutMs, attemptController.signal, lastActivityAt);

          if (isStalledOutcome(outcome)) {
            const stallError = new StreamStallError(timeoutMs);
            // Actually cancel the underlying SDK call; it will never be read again.
            attemptController.abort(stallError);
            // A stall after a completed step has nothing left to deliver: end
            // the step as finished instead of replaying it (review).
            if (completedFinish) break;
            // A stall may replay only before committed output.
            const stallRetryAllowed =
              !replayBlocked && !stallReplayed && (hadModelOutput ? mayRetryProvisional(stallError, true) : mayRetry(stallError)) && !request.abortSignal?.aborted;
            if (stallRetryAllowed) {
              stallReplayed = true;
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
              if (isModelOutputEvent(recovered)) {
                hadModelOutput = true;
                firstOutputAt ??= performance.now();
              }
              yield recovered;
            }
          }
          if (outcome.value.type === "finish-step") {
            stepRawUsage = outcome.value.usage.raw;
          }
          if (reasoningSource !== undefined) collectReasoningMetadata(reasoningMetadata, outcome.value);
          if (captureOpenRouter && collectOpenRouterDetails(openRouterDetails, outcome.value)) openRouterDetailsPresent = true;
          if (trackOpenRouter && outcome.value.type === "finish-step") {
            for (const id of openRouterOpen) yield { type: "reasoning_end", id, ...replaySource };
            openRouterOpen.clear();
            if (openRouterDetailsPresent) {
              const details = openRouterDetails.every((item) => typeof item.index === "number")
                ? [...openRouterDetails].sort((a, b) => (a.index as number) - (b.index as number))
                : [...openRouterDetails];
              const id = openRouterLastId ?? "openrouter-details";
              if (openRouterLastId === undefined) {
                yield { type: "reasoning_start", id };
                yield { type: "reasoning_end", id, source: reasoningSource };
              }
              yield { type: "reasoning_replay_metadata", id, source: reasoningSource!, providerMetadata: { openrouter: { reasoningDetails: details } } };
            }
          }
          let event = translateStreamPart(outcome.value, {
            transport: this.config.transport,
            stepRawUsage,
            openRouter: new URL(this.config.baseUrl).hostname === "openrouter.ai",
          });
          if (event === null) {
            continue;
          }
          if (trackOpenRouter) {
            if (event.type === "reasoning_start") {
              openRouterOpen.add(event.id);
              openRouterLastId = event.id;
            } else if (event.type === "reasoning_end") {
              if (!openRouterOpen.delete(event.id)) continue;
              event = { ...event, ...replaySource };
            } else if (["text_start", "text_delta", "tool_input_start", "tool_call"].includes(event.type)) {
              for (const id of openRouterOpen) yield { type: "reasoning_end", id, ...replaySource };
              openRouterOpen.clear();
            }
          }
          if (event.type === "reasoning_end" && reasoningSource !== undefined) {
            const metadata = reasoningMetadata.get(event.id);
            reasoningMetadata.delete(event.id);
            event = { ...event, source: reasoningSource, ...(metadata !== undefined ? { providerMetadata: metadata } : {}) };
          }
          // Output may begin with reasoning or a tool block, not text; any of
          // them opens the generation window. `finish` itself is not a token,
          // so a step that produced billed output but never streamed any is
          // honestly left without a measurement (the popover shows a dash)
          // instead of reporting an infinite/understated rate.
          if (firstOutputAt === undefined && event.type !== "finish" && isModelOutputEvent(event)) {
            firstOutputAt = performance.now();
          }
          if (event.type === "finish" && event.finishReason !== "error" && firstOutputAt !== undefined) {
            const finishedAt = performance.now();
            event = { ...event, timeToFirstEventMs: Math.max(0, firstOutputAt - requestStartedAt), generationDurationMs: Math.max(0, finishedAt - firstOutputAt) };
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
          if (event.type === "error" && trackOpenRouter) {
            for (const id of openRouterOpen) yield { type: "reasoning_end", id, ...replaySource };
            openRouterOpen.clear();
          }
          if (event.type === "error") {
            captureProviderMessage(event.error, attemptKey);
            event = { ...event, error: contextualizeNetworkFailure(contextualizeMiniMaxBalance(event.error, this.config.providerName, attemptKey), this.config.baseUrl) };
          }
          if (event.type === "error" && correctReasoning(event.error)) {
            attemptController.abort(event.error);
            reasoningRetryNeeded = true;
            break;
          }
          // this pass IS a probe retry (started by a previous
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
          // start a probe when this pre-content 400 is the FIRST
          // sign the flag might be the cause.
          if (
            event.type === "error" && !reasoningCorrected &&
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
          if (event.type === "finish" && this.config.goModelPolicy && this.config.modelMetadata) {
            event = { ...event, endpointSnapshot: { model: this.config.model, baseUrl: this.config.baseUrl, transport: this.config.transport, metadata: this.config.modelMetadata } };
          }
          yield event;
          // emit the attempt's quota observation immediately
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
        captureProviderMessage(rawError, attemptKey);
        for (const id of openRouterOpen) yield { type: "reasoning_end", id, ...replaySource };
        openRouterOpen.clear();
        const error = contextualizeNetworkFailure(contextualizeMiniMaxBalance(rawError, this.config.providerName, attemptKey), this.config.baseUrl);
        // mirror of the error-part branch above, for a failure that
        // surfaced as a THROWN exception (e.g. a synchronous validation
        // error, or a rejection from `fullStream` iteration before any part
        // was read) instead of a stream part.
        if (correctReasoning(error)) {
          reasoningRetryNeeded = true;
        } else if (includeUsageProbe !== undefined) {
          pendingProbeFailure = { error, kind: "thrown" };
        } else if (
          !reasoningCorrected && includeUsageProbeEligible(
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

      for (const id of openRouterOpen) yield { type: "reasoning_end", id, ...replaySource };
      openRouterOpen.clear();

      if (reasoningRetryNeeded) continue;

      // resolve a deferred probe-retry failure OUTSIDE the
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

      // reaching here with a still-pending probe means THIS pass
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

      // a pre-content transient network failure with a waiter
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

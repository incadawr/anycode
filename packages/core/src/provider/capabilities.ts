/**
 * Image-input capability resolution (Phase 6 slice 6.2, design §2-B4). Pure and
 * fail-closed: given the current model id, its catalog entry (if any), an
 * optional explicit override and an optional live-modality lookup, decide
 * whether image attachments are allowed. The CLI wires this into a
 * MediaCapabilityPort closure so a /model switch is honored on the next call.
 *
 * Taskana 4088 (TASK.69) adds the `liveModality` rung: a connection-scoped set
 * of model ids a live `/v1/models` fetch declared image-capable
 * (`architecture.input_modalities` containing "image"). It sits BETWEEN the
 * override and the catalog and is ADDITIVE ONLY: a live `true` promotes an
 * unmarked or catalog-false model, but a live false/absent fact NEVER cancels
 * a catalog-true model — not every `/v1/models` speaks modalities, and stale
 * live data must not blind a model the static catalog vouches for.
 *
 * 4088-on-4118 integration: the live-modality facts ride 4118's
 * `LiveModelCapabilities` map (`imageInput?: true`, same per-model record as
 * the reasoning facts) instead of a separate model-id list; the lookup rung
 * and its additive-only semantics are unchanged.
 */

import type { CatalogProviderEntry } from "./catalog.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ReasoningEffort } from "../types/config.js";

/** Explicit user override for image input, sourced from ANYCODE_IMAGE_INPUT. */
export type ImageInputOverride = "on" | "off";

/**
 * Live-modality lookup (Taskana 4088): `true` when the connection-scoped live
 * `/v1/models` fetch declared THIS model image-capable; `false`/`undefined`
 * when it did not (or nobody fetched). Consulted BETWEEN the explicit override
 * and the static catalog; only `true` has any effect (additive rule above).
 */
export type ImageModalityLookup = (modelId: string) => boolean | undefined;

/**
 * Fail-closed capability verdict: an explicit override wins (`on` ⇒ true,
 * `off` ⇒ false); otherwise the live-modality rung may PROMOTE (true ⇒ true,
 * never demote — Taskana 4088); otherwise the static catalog hint decides (the
 * matched model's `imageInput === true`); otherwise false. An unknown model
 * id, a missing entry, or an unmarked model all resolve to false — the CLI
 * then returns an explicit, actionable error naming the override instead of
 * silently dropping the image.
 */
export function resolveImageInput(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: ImageInputOverride | undefined,
  liveModality?: ImageModalityLookup,
): boolean {
  if (override === "on") {
    return true;
  }
  if (override === "off") {
    return false;
  }
  if (liveModality?.(modelId) === true) {
    return true;
  }
  const model = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId));
  return model?.imageInput === true;
}

/**
 * Assumed context window for a model the catalog does not know (TASK.151 →
 * TASK.142). This is NOT a provider fact: it is an explicit, conservative
 * fallback that engages the degraded-window floor in the context budget rather
 * than letting an unknown model inherit a 24×-overstuffed default prompt.
 */
export const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 8_192;

/**
 * Where a resolved context window came from (Taskana 4127). `assumed` is the
 * conservative unknown-model fallback — the UI says so instead of letting a
 * large unknown model silently behave as 8K.
 */
export interface ContextWindowInfo {
  tokens: number;
  source: "override" | "catalog" | "assumed";
}

/**
 * Context-window resolution (Phase 6 slice 6.4, mirror of resolveImageInput):
 * an explicit override (env ANYCODE_CONTEXT_WINDOW) may carry a model binding
 * (`ANYCODE_CONTEXT_WINDOW_MODEL`); it applies only when the binding is absent
 * (a shell-global export, which wins everywhere) or equals the model being
 * resolved. Otherwise the matched catalog model's
 * `min(contextWindow, usableContextWindow ?? contextWindow)`; otherwise the
 * explicit `UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS` assumed fallback.
 */
export function resolveContextWindowInfo(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: number | undefined,
  overrideModel?: string,
): ContextWindowInfo {
  if (override !== undefined && (overrideModel === undefined || overrideModel === modelId)) {
    return { tokens: override, source: "override" };
  }
  const model = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId));
  if (model === undefined) {
    return { tokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS, source: "assumed" };
  }
  return { tokens: Math.min(model.contextWindow, model.usableContextWindow ?? model.contextWindow), source: "catalog" };
}

/** Thin wrapper over {@link resolveContextWindowInfo} for callers that need only the token count. */
export function resolveContextWindow(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: number | undefined,
  overrideModel?: string,
): number {
  return resolveContextWindowInfo(modelId, entry, override, overrideModel).tokens;
}

/**
 * Output-token resolution (TASK.150 → TASK.159 → TASK.170): precedence is an
 * explicit override clamped by the matched catalog model's `maxOutputTokens`
 * ceiling, else the catalog hint, else the DEFAULT / Claude-native fallbacks. A
 * below-catalog override is legal (deliberate economy) and passes through
 * untouched; an above-catalog one is clamped to the ceiling — a request the
 * provider will 400 is worth nothing. When there is no catalog entry, no model
 * match, or no declared ceiling there is nothing to clamp against and the
 * override wins as-is (TASK.151: an on-prem endpoint whose model the catalog
 * does not know must not gain a say). The claude- special case sits AFTER the
 * lookup, as before: a Claude model's undefined ceiling is intentional (the
 * anthropic-messages SDK carries its own accurate per-model default, measured
 * TASK.170) and is never treated as a stub.
 *
 * Neither fallback is silent. `onClamp`, when provided, fires exactly once,
 * only on an actual clamp — env handle and connection field arrive here
 * indistinguishably, so a stale catalog pinning a model low would otherwise
 * quietly swallow even the escape hatch, undiagnosable. `onStubFallback`
 * (TASK.170), when provided, fires exactly once when the DEFAULT_MAX_OUTPUT_TOKENS
 * stub is what actually gets applied — i.e. the model matched no catalog
 * ceiling (or matched nothing at all, e.g. every model on `vllm`/`custom`/
 * `openrouter`, whose `models: []` by construction) and no override was given
 * to fall back to instead. Without this, a subagent spawned on a
 * catalog-incomplete model silently got a ~4x-narrower ceiling than a sibling
 * the catalog does know (glm-5.3 131_072 vs. glm-5.3-flash's old gap), with no
 * log line or facade field anywhere naming the model or the number applied.
 */
export function resolveMaxOutputTokens(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: number | undefined,
  onClamp?: (requested: number, clamped: number, modelId: string) => void,
  onStubFallback?: (modelId: string, applied: number) => void,
): number | undefined {
  const matched = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId));
  const ceiling = matched?.maxOutputTokens;
  if (override !== undefined) {
    if (ceiling === undefined || override <= ceiling) return override;
    onClamp?.(override, ceiling, modelId);
    return ceiling;
  }
  if (ceiling !== undefined) return ceiling;
  if (modelId.startsWith("claude-")) return undefined;
  onStubFallback?.(modelId, DEFAULT_MAX_OUTPUT_TOKENS);
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * The effort tier actually in force for a session (TASK.131, extended by
 * Taskana 4894). Precedence:
 *
 * 1. an explicit choice — the user's pick, the connection's persisted tier, or
 *    the `ANYCODE_REASONING_EFFORT` env value — is validated fail-closed
 *    against the model's declared vocabulary and returned verbatim; an
 *    explicit `off` means "no reasoning" and resolves to `undefined` (the
 *    host's own "no effort" value) exactly as before;
 * 2. with NO explicit choice, the model's own recorded provider default
 *    (`CatalogModel.defaultEffort`, set only where the provider documents
 *    one). Before 4894 this rung did not exist, so a fresh DeepSeek session
 *    sent nothing while the renderer displayed the vocabulary's first level
 *    (`low`) — neither the shown nor the sent value was the provider's `high`;
 * 3. no recorded default ⇒ `undefined`, the pre-4894 behaviour: nothing is
 *    sent and the endpoint applies its own default.
 *
 * A live-only model (catalog miss, Taskana 4118) has no default fact: live
 * capabilities declare a vocabulary, never a default, so rung 2 is skipped.
 */
export function resolveReasoningEffort(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: ReasoningEffort | undefined,
  live?: LiveModelCapabilities,
  explicitLevels?: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (override === "off") {
    const model = entry?.models.find((candidate) => candidate.id === modelId);
    return model?.supportsExplicitOff && (explicitLevels === undefined || explicitLevels.includes("off")) ? "off" : undefined;
  }
  if (explicitLevels !== undefined) {
    const fallback = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId))?.defaultEffort;
    const selected = override ?? fallback;
    return selected !== undefined && selected !== "off" && explicitLevels.includes(selected) ? selected : undefined;
  }
  const matched = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId));
  if (matched === undefined) {
    if (override === undefined) return undefined;
    // Taskana 4118: catalog miss ⇒ consult live capabilities, if any. The
    // override must still be inside the live-mapped vocabulary (fail-closed:
    // a level the endpoint never declared never reaches the wire).
    const levels = liveEffortLevels(live);
    return levels !== undefined && levels.includes(override) ? override : undefined;
  }
  if (matched.reasoning !== true) return undefined;
  if (override === undefined) {
    // Taskana 4894: no explicit choice ⇒ the model's recorded provider default.
    // Validated against the declared vocabulary like any other level, so a
    // catalog row can never push a level its own model rejects.
    const fallback = matched.defaultEffort;
    if (fallback === undefined || fallback === "off") return undefined;
    if (!(matched.effortLevels ?? ["off", "low", "medium", "high"]).includes(fallback)) {
      return undefined;
    }
    return fallback;
  }
  // Validate against declared effortLevels: an undeclared level is rejected
  // (fail-closed) rather than silently coerced. Models without explicit
  // effortLevels accept the legacy four-level set.
  if (!(matched.effortLevels ?? ["off", "low", "medium", "high"]).includes(override)) {
    return undefined;
  }
  return override;
}

/**
 * Resolves the effort levels a reasoning-capable model supports, for UI
 * rendering and `set_reasoning_effort` validation. Returns undefined when the
 * model is unknown or not marked `reasoning: true` (the UI then hides the
 * selector). A reasoning model without explicit `effortLevels` falls back to
 * the legacy `["off", "low", "medium", "high"]` set (Anthropic budgetTokens).
 *
 * Taskana 4118: on a catalog miss (unknown id, or an entry like `openrouter`/
 * `vllm`/`custom` whose `models` is empty), live capabilities — when the model
 * is live-declared `reasoning: true` — supply the vocabulary instead. Live
 * never resurrects or narrows a catalog-known model: the catalog is checked
 * knowledge, live supplements only what it does not know.
 */
export function resolveEffortLevels(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  live?: LiveModelCapabilities,
  explicitLevels?: readonly ReasoningEffort[],
): ReasoningEffort[] | undefined {
  if (explicitLevels !== undefined) return [...explicitLevels];
  const matched = (entry?.models.find((candidate) => candidate.id === modelId) ?? entry?.retiredModels?.find((candidate) => candidate.id === modelId));
  if (matched === undefined) return liveEffortLevels(live); // Taskana 4118: catalog miss ⇒ live
  if (matched.reasoning !== true) return undefined; // live never resurrects a catalog model
  return matched.effortLevels ?? ["off", "low", "medium", "high"];
}

/** Resolve a child selection against its target model's effort vocabulary. */
export function resolveChildReasoningEffort(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: ReasoningEffort | undefined,
  live?: LiveModelCapabilities,
  explicitLevels?: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const levels = resolveEffortLevels(modelId, entry, live, explicitLevels);
  const selected = override === "xhigh" && levels !== undefined && !levels.includes("xhigh") && levels.includes("max")
    ? "max" : override;
  return resolveReasoningEffort(modelId, entry, selected, live, explicitLevels);
}

/** Live per-model capability facts a models-list endpoint declared (Taskana 4118). */
export interface LiveModelCapabilities {
  reasoning?: boolean;
  /** Raw foreign effort levels, UNMAPPED — mapped fail-closed at resolution. */
  effortLevels?: string[];
  /**
   * 4088-on-4118 integration: the endpoint declared this model
   * image-capable (`architecture.input_modalities` containing "image").
   * `true` only — absence means "no live fact", never a demotion.
   */
  imageInput?: true;
}

/**
 * Foreign effort level → our closed enum, by EXACT name only (Taskana 4118).
 * `minimal`/`none`/`default`/… are absent ⇒ dropped at mapping time —
 * never silently folded into a neighbouring level.
 *
 * A `Map` (NOT an object literal) so endpoint-controlled `supported_efforts`
 * entries naming inherited properties ("constructor", "toString", "__proto__",
 * …) resolve to `undefined` instead of the inherited `Object.prototype`
 * member — an object-literal lookup would pass the `!== undefined` guard with
 * a Function value inside a `ReasoningEffort[]` (cross-review finding 1).
 */
const EFFORT_LEVEL_PASSTHROUGH: ReadonlyMap<string, ReasoningEffort> = new Map([
  ["off", "off"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"],
]);

/** Maps foreign levels: keeps source order, drops unknowns, dedupes. */
export function mapForeignEffortLevels(levels: readonly string[]): ReasoningEffort[] {
  const out: ReasoningEffort[] = [];
  for (const raw of levels) {
    const mapped = EFFORT_LEVEL_PASSTHROUGH.get(raw);
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Live vocabulary for a model the catalog does not know (Taskana 4118):
 * `reasoning !== true` ⇒ undefined; no declared efforts ⇒ the legacy four
 * (same fallback a catalog reasoning model gets); declared efforts that map
 * to nothing ⇒ undefined (fail-closed — the endpoint spoke, nothing fits).
 */
export function liveEffortLevels(live: LiveModelCapabilities | undefined): ReasoningEffort[] | undefined {
  if (live?.reasoning !== true) return undefined;
  if (live.effortLevels === undefined || live.effortLevels.length === 0) {
    return ["off", "low", "medium", "high"];
  }
  const mapped = mapForeignEffortLevels(live.effortLevels);
  return mapped.length > 0 ? mapped : undefined;
}

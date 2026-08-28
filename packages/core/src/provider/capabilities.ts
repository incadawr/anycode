/**
 * Image-input capability resolution (Phase 6 slice 6.2, design §2-B4). Pure and
 * fail-closed: given the current model id, its catalog entry (if any) and an
 * optional explicit override, decide whether image attachments are allowed. The
 * CLI wires this into a MediaCapabilityPort closure so a /model switch is honored
 * on the next call.
 */

import type { CatalogProviderEntry } from "./catalog.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ReasoningEffort } from "../types/config.js";

/** Explicit user override for image input, sourced from ANYCODE_IMAGE_INPUT. */
export type ImageInputOverride = "on" | "off";

/**
 * Fail-closed capability verdict: an explicit override wins (`on` ⇒ true,
 * `off` ⇒ false); otherwise the static catalog hint decides (the matched model's
 * `imageInput === true`); otherwise false. An unknown model id, a missing entry,
 * or an unmarked model all resolve to false — the CLI then returns an explicit,
 * actionable error naming the override instead of silently dropping the image.
 */
export function resolveImageInput(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: ImageInputOverride | undefined,
): boolean {
  if (override === "on") {
    return true;
  }
  if (override === "off") {
    return false;
  }
  const model = entry?.models.find((candidate) => candidate.id === modelId);
  return model?.imageInput === true;
}

/**
 * Context-window resolution (Phase 6 slice 6.4, mirror of resolveImageInput):
 * an explicit override (env ANYCODE_CONTEXT_WINDOW) always wins; otherwise the
 * matched catalog model's contextWindow; otherwise undefined — the caller
 * omits the budget override and the DEFAULT_CONTEXT_WINDOW_TOKENS fallback
 * applies via DEFAULT_CONTEXT_BUDGET (an unknown model keeps today's bytes).
 */
export function resolveContextWindow(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: number | undefined,
): number | undefined {
  if (override !== undefined) {
    return override;
  }
  const model = entry?.models.find((candidate) => candidate.id === modelId);
  return model?.contextWindow;
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
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
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

export function resolveReasoningEffort(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
  override: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (override === undefined || override === "off") return undefined;
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
  if (matched === undefined || matched.reasoning !== true) return undefined;
  // Validate against declared effortLevels: an undeclared level is rejected
  // (fail-closed) rather than silently coerced. Models without explicit
  // effortLevels accept the legacy four-level set.
  if (matched.effortLevels !== undefined && !matched.effortLevels.includes(override)) {
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
 */
export function resolveEffortLevels(
  modelId: string,
  entry: CatalogProviderEntry | undefined,
): ReasoningEffort[] | undefined {
  const matched = entry?.models.find((candidate) => candidate.id === modelId);
  if (matched === undefined || matched.reasoning !== true) return undefined;
  return matched.effortLevels ?? ["off", "low", "medium", "high"];
}

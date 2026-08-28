/**
 * Child-model capability resolution (subagent-model track, TASK.162): a pure,
 * nonthrowing composition of the same capability resolvers the mid-session
 * `/model` switch already uses (`host/index.ts`'s `switchModelImpl`,
 * `cli/main.ts`'s `model.set`), so a subagent spawned with a model override
 * gets settings resolved for ITS OWN model instead of inheriting the parent's
 * already-resolved `maxOutputTokens`/`reasoningEffort`/context window (the F6
 * defect: `buildChildConfig` previously copied the parent's values verbatim).
 *
 * Conservative-on-failure by construction: a throwing resolver (a corrupt
 * catalog entry, for instance) or a catalog-unknown model id NEVER falls back
 * to anything parent-derived — that would silently reinstate the defect this
 * module exists to remove. Both cases resolve to the same unknown-model
 * shape: the env-override-or-DEFAULT output ceiling, no reasoning effort, and
 * the DEFAULT context window.
 */

import type { CatalogProviderEntry } from "./catalog.js";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, type ReasoningEffort } from "../types/config.js";
import { resolveContextWindow, resolveMaxOutputTokens, resolveReasoningEffort } from "./capabilities.js";

export interface ChildModelSettings {
  /** undefined is a legal resolution for claude-* models (no declared ceiling). */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  contextWindowTokens: number;
}

/**
 * Builds a resolver closure over the caller's catalog entry and the same
 * env/connection overrides the boot and the mid-session switch read. The
 * returned function takes the child's model id and the live selected
 * reasoning tier — a parameter, not a captured dependency, so the caller
 * supplies whatever tier is live (possibly mutated since boot) at each spawn
 * — and returns the settings that model gets.
 */
export function buildChildModelSettingsResolver(deps: {
  catalogEntry: CatalogProviderEntry | undefined;
  envMaxOutputTokens: number | undefined;
  envContextWindow: number | undefined;
  onClamp?: (requested: number, clamped: number, modelId: string) => void;
}): (modelId: string, selectedTier: ReasoningEffort | undefined) => ChildModelSettings {
  const { catalogEntry, envMaxOutputTokens, envContextWindow, onClamp } = deps;
  return (modelId, selectedTier) => {
    try {
      return {
        maxOutputTokens: resolveMaxOutputTokens(modelId, catalogEntry, envMaxOutputTokens, onClamp),
        reasoningEffort: resolveReasoningEffort(modelId, catalogEntry, selectedTier),
        contextWindowTokens: resolveContextWindow(modelId, catalogEntry, envContextWindow) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
    } catch {
      // Degrades to the same conservative unknown-model shape a catalog-miss
      // produces below — never to anything derived from the parent's already-
      // resolved settings, which would reinstate the defect this module
      // exists to remove.
      return {
        maxOutputTokens: resolveMaxOutputTokens(modelId, undefined, envMaxOutputTokens),
        reasoningEffort: undefined,
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
    }
  };
}

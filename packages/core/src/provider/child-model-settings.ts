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
 *
 * Taskana 4118: an optional `liveCapabilitiesFor` dep gives children live
 * /v1/models capabilities for catalog-unknown model ids too, mirroring what
 * host boot and the mid-session switch already consult.
 */

import type { CatalogProviderEntry } from "./catalog.js";
import type { ReasoningEffort } from "../types/config.js";
import { resolveContextWindow, resolveMaxOutputTokens, resolveChildReasoningEffort } from "./capabilities.js";
import type { LiveModelCapabilities } from "./capabilities.js";

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
  envContextWindowModel?: string;
  /** Connection-specific model overrides shared with the desktop parent resolver. */
  contextWindowFor?: (modelId: string) => number;
  onClamp?: (requested: number, clamped: number, modelId: string) => void;
  onStubFallback?: (modelId: string, applied: number) => void;
  /** Taskana 4118: live /v1/models capabilities, consulted on a catalog miss. */
  liveCapabilitiesFor?: (modelId: string) => LiveModelCapabilities | undefined;
}): (modelId: string, selectedTier: ReasoningEffort | undefined) => ChildModelSettings {
  const { catalogEntry, envMaxOutputTokens, envContextWindow, envContextWindowModel, onClamp, onStubFallback, liveCapabilitiesFor } = deps;
  return (modelId, selectedTier) => {
    try {
      return {
        maxOutputTokens: resolveMaxOutputTokens(modelId, catalogEntry, envMaxOutputTokens, onClamp, onStubFallback),
        reasoningEffort: resolveChildReasoningEffort(modelId, catalogEntry, selectedTier, liveCapabilitiesFor?.(modelId)),
        contextWindowTokens: deps.contextWindowFor?.(modelId) ?? resolveContextWindow(modelId, catalogEntry, envContextWindow, envContextWindowModel),
      };
    } catch {
      // Degrades to the same conservative unknown-model shape a catalog-miss
      // produces below — never to anything derived from the parent's already-
      // resolved settings, which would reinstate the defect this module
      // exists to remove. entry is undefined here, so onStubFallback can still
      // fire (no override ⇒ the DEFAULT stub applies) even though onClamp
      // structurally cannot (no ceiling to clamp against).
      return {
        maxOutputTokens: resolveMaxOutputTokens(modelId, undefined, envMaxOutputTokens, undefined, onStubFallback),
        reasoningEffort: undefined,
        contextWindowTokens: resolveContextWindow(modelId, undefined, envContextWindow, envContextWindowModel),
      };
    }
  };
}

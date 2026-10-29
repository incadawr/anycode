import {
  resolveContextWindowInfo,
  resolveReasoningEffort,
  type CatalogProviderEntry,
  type LiveModelCapabilities,
  type ReasoningEffort,
} from "@anycode/core";
import type { ProviderConnection } from "../shared/settings.js";
import { applyModelReasoningOverride, modelOverrideFor } from "../shared/model-overrides.js";

/** Shared by boot, live switches and child context budgets. Runtime choices stay host-local. */
export function createConnectionModelSettings(deps: {
  connection?: Pick<ProviderConnection, "modelOverrides" | "reasoningEffort">;
  catalogEntry?: CatalogProviderEntry;
  envReasoningEffort?: ReasoningEffort;
  envReasoningEffortModel?: string;
  envContextWindow?: number;
  envContextWindowModel?: string;
  liveCapabilitiesFor(model: string): LiveModelCapabilities | undefined;
}) {
  const selected = new Map<string, ReasoningEffort>();
  return {
    capabilitiesFor(model: string): LiveModelCapabilities | undefined {
      const live = deps.liveCapabilitiesFor(model);
      return applyModelReasoningOverride(live, modelOverrideFor(deps.connection, model)?.reasoningSupported === true);
    },
    contextFor(model: string) {
      const envApplies = deps.envContextWindow !== undefined &&
        (deps.envContextWindowModel === undefined || deps.envContextWindowModel === model);
      const override = envApplies ? deps.envContextWindow : modelOverrideFor(deps.connection, model)?.contextWindowTokens;
      return resolveContextWindowInfo(model, deps.catalogEntry, override, model);
    },
    remember(model: string, effort: ReasoningEffort) {
      selected.set(model, effort);
    },
    switchEffort(from: string, to: string, tier: ReasoningEffort, explicit = false): ReasoningEffort {
      if (!explicit) selected.set(from, tier);
      const envApplies = deps.envReasoningEffort !== undefined &&
        (deps.envReasoningEffortModel === undefined || deps.envReasoningEffortModel === to);
      const next = explicit ? tier : selected.get(to) ?? (envApplies ? deps.envReasoningEffort : undefined) ??
        modelOverrideFor(deps.connection, to)?.reasoningEffort ?? deps.connection?.reasoningEffort ??
        resolveReasoningEffort(to, deps.catalogEntry, undefined, this.capabilitiesFor(to)) ?? "off";
      selected.set(to, next);
      return next;
    },
  };
}

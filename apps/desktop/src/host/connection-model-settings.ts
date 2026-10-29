import {
  resolveContextWindowInfo,
  resolveReasoningEffort,
  type CatalogProviderEntry,
  type LiveModelCapabilities,
  type ReasoningEffort,
} from "@anycode/core";
import type { ProviderConnection } from "../shared/settings.js";
import { applyModelReasoningOverride, modelOverrideFor } from "../shared/model-overrides.js";

type ConnectionSettings = Pick<ProviderConnection, "modelOverrides" | "reasoningEffort" | "modelCapabilities" | "pricing">;

/** Refresh only at model switches and turn starts, never during a running model call. */
export function createConnectionModelSettings(deps: {
  connection?: ConnectionSettings;
  readConnection?: () => ConnectionSettings | undefined | null;
  initialReadSucceeded?: boolean;
  catalogEntry?: CatalogProviderEntry;
  envReasoningEffort?: ReasoningEffort;
  envReasoningEffortModel?: string;
  envReasoningEffortFromSettings?: boolean;
  envContextWindow?: number;
  envContextWindowModel?: string;
  envContextWindowFromSettings?: boolean;
  liveCapabilitiesFor(model: string): LiveModelCapabilities | undefined;
}) {
  let connection = deps.connection;
  let hasReadConnection = deps.connection !== undefined || deps.initialReadSucceeded === true;
  let fingerprint = JSON.stringify(connection);
  const selected = new Map<string, ReasoningEffort>();
  const invalidated = new Set<string>();

  function capabilitiesFor(model: string): LiveModelCapabilities | undefined {
    const map = connection?.modelCapabilities;
    const live = deps.readConnection !== undefined
      ? map !== undefined && Object.hasOwn(map, model) ? map[model] : undefined
      : deps.liveCapabilitiesFor(model);
    return applyModelReasoningOverride(live, modelOverrideFor(connection, model)?.reasoningSupported === true);
  }

  function effortFor(model: string): ReasoningEffort | undefined {
    const envApplies = (!deps.envReasoningEffortFromSettings || !hasReadConnection) && deps.envReasoningEffort !== undefined &&
      (deps.envReasoningEffortModel === undefined || deps.envReasoningEffortModel === model);
    return selected.get(model) ?? (envApplies ? deps.envReasoningEffort : undefined) ??
      modelOverrideFor(connection, model)?.reasoningEffort ?? connection?.reasoningEffort;
  }

  function refresh(): boolean {
    if (deps.readConnection === undefined) return false;
    const next = deps.readConnection();
    if (next === null) return false;
    const nextFingerprint = JSON.stringify(next);
    const becameReadable = !hasReadConnection;
    hasReadConnection = true;
    if (!becameReadable && nextFingerprint === fingerprint) return false;
    const models = new Set([...selected.keys(), ...Object.keys(connection?.modelOverrides ?? {}), ...Object.keys(next?.modelOverrides ?? {})]);
    for (const model of models) {
      const bootSettingsTier = becameReadable && deps.envReasoningEffortFromSettings &&
        (deps.envReasoningEffortModel === undefined || deps.envReasoningEffortModel === model) ? deps.envReasoningEffort : undefined;
      const before = modelOverrideFor(connection, model)?.reasoningEffort ?? connection?.reasoningEffort ?? bootSettingsTier;
      const after = modelOverrideFor(next, model)?.reasoningEffort ?? next?.reasoningEffort;
      if (before !== after && selected.get(model) !== after) {
        selected.delete(model);
        invalidated.add(model);
      }
    }
    connection = next;
    fingerprint = nextFingerprint;
    return true;
  }

  return {
    refresh,
    pricingSnapshot() { return hasReadConnection ? { fallback: connection?.pricing, models: Object.fromEntries(Object.entries(connection?.modelOverrides ?? {}).filter(([, value]) => value.pricing !== undefined).map(([id, value]) => [id, value.pricing])) } : undefined; },
    hasReadConnection() { return hasReadConnection; },
    capabilitiesFor,
    effortLevelsFor(model: string) { return modelOverrideFor(connection, model)?.effortLevels; },
    effortFor,
    contextFor(model: string) {
      const envApplies = (!deps.envContextWindowFromSettings || !hasReadConnection) && deps.envContextWindow !== undefined &&
        (deps.envContextWindowModel === undefined || deps.envContextWindowModel === model);
      const override = envApplies ? deps.envContextWindow : modelOverrideFor(connection, model)?.contextWindowTokens;
      return resolveContextWindowInfo(model, deps.catalogEntry, override, model);
    },
    remember(model: string, effort: ReasoningEffort) {
      selected.set(model, effort);
      invalidated.delete(model);
    },
    switchEffort(from: string, to: string, tier: ReasoningEffort, explicit = false): ReasoningEffort {
      refresh();
      // A new persisted choice must not be replaced by Session's previous tier.
      if (!explicit && !invalidated.has(from)) selected.set(from, tier);
      const next = explicit ? tier : effortFor(to) ??
        resolveReasoningEffort(to, deps.catalogEntry, undefined, capabilitiesFor(to), modelOverrideFor(connection, to)?.effortLevels) ?? "off";
      selected.set(to, next);
      invalidated.delete(to);
      return next;
    },
  };
}

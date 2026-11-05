import {
  modelDictionaryEntry,
  mapForeignEffortLevels,
  resolveContextWindowInfo,
  resolveEffortLevels,
  resolveReasoningEffort,
  UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  type CatalogProviderEntry,
  type LiveModelCapabilities,
  type ReasoningEffort,
} from "@anycode/core";
import type { ProviderConnection } from "../shared/settings.js";
import { applyModelReasoningOverride, modelOverrideFor } from "../shared/model-overrides.js";

const EFFORT_ORDER: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Pick the closest supported tier; ties favor the lower tier. */
export function nearestSupportedEffort(tier: ReasoningEffort, levels: ReasoningEffort[] | undefined): ReasoningEffort {
  if (!levels?.length || levels.includes(tier)) return tier;
  const rank = EFFORT_ORDER.indexOf(tier);
  return [...levels].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - rank) - Math.abs(EFFORT_ORDER.indexOf(b) - rank) || EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0]!;
}

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
  let adjustment: { from: ReasoningEffort; to: ReasoningEffort } | undefined;

  function entryFor(model: string) {
    const override = modelOverrideFor(connection, model);
    let entry = modelDictionaryEntry(model, deps.catalogEntry, override?.catalogMatchDisabled === true);
    const live = connection?.modelCapabilities?.[model];
    if (entry && (live?.contextWindow || live?.maxOutputTokens)) {
      const previous = entry.models.find(row => row.id === model);
      entry = { ...entry, models: [...entry.models.filter(row => row.id !== model), { ...previous, id: model, contextWindow: live.contextWindow ?? previous?.contextWindow ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS, ...(live.maxOutputTokens ? { maxOutputTokens: live.maxOutputTokens } : {}) }] };
    }
    if (entry && (entry !== deps.catalogEntry || override?.reasoningSupported === false)) {
      const live = capabilitiesFor(model);
      const off = (override?.reasoningEffort ?? connection?.reasoningEffort) === "off" || override?.effortLevels?.includes("off");
      const supported = override?.reasoningSupported;
      if (off || supported !== undefined || live) return { ...entry, models: entry.models.map((row) => row.id !== model ? row : {
        ...row,
        ...(live?.reasoning !== undefined ? { reasoning: live.reasoning } : {}),
        ...(live?.effortLevels !== undefined ? { effortLevels: mapForeignEffortLevels(live.effortLevels) } : {}),
        ...(live?.thinkingAlwaysOn !== undefined ? { thinkingAlwaysOn: live.thinkingAlwaysOn } : {}),
        ...(live?.defaultEffort !== undefined ? { defaultEffort: live.defaultEffort } : {}),
        ...(supported === true && !(live?.reasoning ?? row.reasoning) ? { reasoning: true, effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] as ReasoningEffort[] } : {}),
        ...(off ? { thinkingAlwaysOn: false, supportsExplicitOff: true, effortLevels: ["off" as const, ...(live?.effortLevels !== undefined ? mapForeignEffortLevels(live.effortLevels) : row.effortLevels ?? []).filter(level => level !== "off")] } : {}),
        ...(supported === false ? { reasoning: false, thinkingAlwaysOn: false, effortLevels: undefined, defaultEffort: undefined } : {}),
      }) };
    }
    return entry;
  }

  function capabilitiesFor(model: string): LiveModelCapabilities | undefined {
    const map = connection?.modelCapabilities;
    const live = deps.readConnection !== undefined
      ? map !== undefined && Object.hasOwn(map, model) ? map[model] : undefined
      : deps.liveCapabilitiesFor(model);
    return applyModelReasoningOverride(live, modelOverrideFor(connection, model)?.reasoningSupported);
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
    entryFor,
    pricingSnapshot() { return hasReadConnection ? { fallback: connection?.pricing, models: { ...Object.fromEntries(Object.entries(connection?.modelCapabilities ?? {}).filter(([, value]) => value.pricing !== undefined && connection?.pricing?.mode !== "rates" && connection?.pricing?.mode !== "subscription").map(([id, value]) => [id, value.pricing])), ...Object.fromEntries(Object.entries(connection?.modelOverrides ?? {}).filter(([, value]) => value.pricing !== undefined).map(([id, value]) => [id, value.pricing])) } } : undefined; },
    hasReadConnection() { return hasReadConnection; },
    capabilitiesFor,
    effortLevelsFor(model: string) { const override = modelOverrideFor(connection, model); return override?.reasoningSupported === false ? undefined : override?.effortLevels; },
    effortFor,
    contextFor(model: string) {
      const envApplies = (!deps.envContextWindowFromSettings || !hasReadConnection) && deps.envContextWindow !== undefined &&
        (deps.envContextWindowModel === undefined || deps.envContextWindowModel === model);
      const override = envApplies ? deps.envContextWindow : modelOverrideFor(connection, model)?.contextWindowTokens;
      const entry = connection?.modelCapabilities?.[model]?.contextWindow
        ? entryFor(model)
        : modelDictionaryEntry(model, deps.catalogEntry, modelOverrideFor(connection, model)?.catalogMatchDisabled === true);
      return resolveContextWindowInfo(model, entry, override, model);
    },
    remember(model: string, effort: ReasoningEffort) {
      selected.set(model, effort);
      invalidated.delete(model);
    },
    normalize(model: string, tier: ReasoningEffort): ReasoningEffort {
      return nearestSupportedEffort(tier, resolveEffortLevels(model, entryFor(model), capabilitiesFor(model), (modelOverrideFor(connection, model)?.reasoningSupported === false ? undefined : modelOverrideFor(connection, model)?.effortLevels)));
    },
    takeAdjustment() { const value = adjustment; adjustment = undefined; return value; },
    switchEffort(from: string, to: string, tier: ReasoningEffort, explicit = false): ReasoningEffort {
      refresh();
      // A new persisted choice must not be replaced by Session's previous tier.
      if (!explicit && !invalidated.has(from)) selected.set(from, tier);
      const targetOverride = modelOverrideFor(connection, to);
      const declaredLevels = targetOverride?.reasoningSupported === false ? undefined : targetOverride?.effortLevels;
      const levels = resolveEffortLevels(to, entryFor(to), capabilitiesFor(to), declaredLevels);
      const candidate = explicit ? tier : effortFor(to) ??
        resolveReasoningEffort(to, entryFor(to), undefined, capabilitiesFor(to), declaredLevels) ?? (levels?.length ? tier : "off");
      const next = nearestSupportedEffort(candidate, levels);
      adjustment = next !== candidate ? { from: candidate, to: next } : undefined;
      selected.set(to, next);
      invalidated.delete(to);
      return next;
    },
  };
}

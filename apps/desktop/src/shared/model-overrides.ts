import { isAutomaticGo } from "./provider-models.js";
import { resolveOpenCodeGoEndpointPolicy } from "@anycode/core/opencode-go";
import { findKnownModel, isGatewayProvider } from "@anycode/core/model-dictionary";
import type { ModelCapabilitiesDto, ModelOverrides, ProviderConnection } from "./settings.js";

type ConnectionOverrides = Pick<ProviderConnection, "modelOverrides" | "contextWindowTokens" | "contextWindowModel">;

/** Exact ids, including ids such as `constructor`, never resolve inherited properties. */
export function modelOverrideFor(connection: ConnectionOverrides | undefined, model: string): ModelOverrides | undefined {
  const saved = connection?.modelOverrides;
  const entry = saved !== undefined && Object.hasOwn(saved, model) ? saved[model] : undefined;
  const legacy = connection?.contextWindowModel?.trim() === model ? connection.contextWindowTokens : undefined;
  return legacy === undefined || entry?.contextWindowTokens !== undefined ? entry : { ...entry, contextWindowTokens: legacy };
}

/** Read-time migration; the next write persists only the map, without rebinding the old pair. */
export function migrateModelOverrides(connection: ProviderConnection): ProviderConnection {
  if (connection.contextWindowTokens === undefined && connection.contextWindowModel === undefined && connection.imageInputOverride === undefined && connection.imageInputModel === undefined && connection.preserveReasoning === undefined) return connection;
  const migrated = { ...connection };
  const model = connection.contextWindowModel?.trim();
  if (model && connection.contextWindowTokens !== undefined) {
    migrated.modelOverrides = { ...connection.modelOverrides, [model]: modelOverrideFor(connection, model)! };
  }
  const imageModel = connection.imageInputModel?.trim();
  if (imageModel && connection.imageInputOverride !== undefined && modelOverrideFor(migrated, imageModel)?.imageInput === undefined) {
    patchModelOverride(migrated, imageModel, { imageInput: connection.imageInputOverride });
  }
  const replayModel = connection.model?.trim();
  if (replayModel && connection.preserveReasoning !== undefined && modelOverrideFor(migrated, replayModel)?.preserveReasoning === undefined) {
    patchModelOverride(migrated, replayModel, { preserveReasoning: connection.preserveReasoning });
  }
  delete migrated.preserveReasoning;
  delete migrated.imageInputOverride;
  delete migrated.imageInputModel;
  delete migrated.contextWindowTokens;
  delete migrated.contextWindowModel;
  return migrated;
}

/** Patch one model under main's settings lock; siblings and unrelated fields survive. */
export function patchModelOverride(connection: ProviderConnection, model: string, patch: Partial<ModelOverrides>): void {
  const next = { ...modelOverrideFor(connection, model), ...patch };
  for (const key of Object.keys(next) as (keyof ModelOverrides)[]) {
    if (next[key] === undefined) delete next[key];
  }
  const map = { ...connection.modelOverrides, [model]: next };
  if (Object.keys(next).length === 0) delete map[model];
  if (Object.keys(map).length === 0) delete connection.modelOverrides;
  else connection.modelOverrides = map;
}


/** A manual declaration supplies controls only when the catalog has no facts. */
export function applyModelReasoningOverride(live: ModelCapabilitiesDto | undefined, supported: boolean | undefined): ModelCapabilitiesDto | undefined {
  if (supported === false) return { ...live, reasoning: false, effortLevels: undefined, thinkingAlwaysOn: false, defaultEffort: undefined };
  return supported ? {
    ...live, reasoning: true,
    effortLevels: live?.effortLevels ?? ["off", "low", "medium", "high", "xhigh", "max"],
  } : live;
}

export function modelCapabilitiesFor(
  connection: (ConnectionOverrides & Pick<ProviderConnection, "modelCapabilities" | "providerId"> & Partial<Pick<ProviderConnection, "reasoningEffort" | "modelRoutes" | "baseUrl" | "transport">>) | undefined,
  model: string,
  envOverrides?: readonly string[],
): ModelCapabilitiesDto | undefined {
  const live = connection?.modelCapabilities !== undefined && Object.hasOwn(connection.modelCapabilities, model)
    ? connection.modelCapabilities[model] : undefined;
  const override = modelOverrideFor(connection, model);
  const provider = connection?.providerId;
  const eligible = provider !== undefined && isGatewayProvider(provider);
  const known = eligible && !override?.catalogMatchDisabled ? findKnownModel(model) : undefined;
  const defaults: ModelCapabilitiesDto | undefined = known ? {
    ...(known.reasoning !== undefined ? { reasoning: known.reasoning } : {}),
    ...(known.effortLevels !== undefined ? { effortLevels: known.effortLevels } : {}),
    ...(known.defaultEffort !== undefined ? { defaultEffort: known.defaultEffort } : {}),
    ...(known.thinkingAlwaysOn !== undefined ? { thinkingAlwaysOn: known.thinkingAlwaysOn } : {}),
    ...(known.imageInput ? { imageInput: true as const } : {}),
  } : undefined;
  const go = isAutomaticGo(provider, connection?.baseUrl, connection?.transport, envOverrides) ? resolveOpenCodeGoEndpointPolicy(provider!, model, connection?.modelRoutes) : undefined;
  const policy = go?.kind === "route" ? go.route.policy : undefined;
  const reasoning = policy?.capabilities?.reasoning;
  const goLevels = (reasoning?.effort ?? []).map(level => level === "none" ? "off" : level);
  if (reasoning?.toggle && go?.kind === "route" && go.route.transport === "anthropic-messages" && !goLevels.includes("off")) goLevels.unshift("off");
  const goCaps: ModelCapabilitiesDto | undefined = go ? {
    goRoutePolicy: true,
    reasoning: reasoning?.supported === true,
    effortLevels: goLevels,
    defaultEffort: reasoning?.default?.value === "none" ? "off" : reasoning?.default?.value,
    ...(policy?.modalities?.input?.some(m => m.startsWith("image/")) ? { imageInput: true as const } : {}),
  } : undefined;
  const effective = go ? goCaps : defaults || live ? { ...defaults, ...live } : undefined;
  if (effective && ((override?.reasoningEffort ?? connection?.reasoningEffort) === "off" || override?.effortLevels?.includes("off"))) effective.thinkingAlwaysOn = false;
  if (override?.reasoningSupported === false) return applyModelReasoningOverride(effective, false);
  if (override?.effortLevels !== undefined) return { ...effective, reasoning: true, effortLevels: override.effortLevels };
  return applyModelReasoningOverride(effective, override?.reasoningSupported);
}


export function contextWindowTokensField(raw: string): { ok: true; value: number | "" } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: "" };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return { ok: false };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1024 || n > 1000000) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

/** Shell choice wins; settings are resolved again for each model, including hot swaps. */
export function modelReasoningReplay(connection: Pick<ProviderConnection, "modelOverrides" | "model" | "preserveReasoning"> | undefined, model: string, shellOverride?: boolean): boolean | undefined {
  const saved = modelOverrideFor(connection, model)?.preserveReasoning;
  return shellOverride ?? saved ?? (connection?.model?.trim() === model ? connection?.preserveReasoning : undefined);
}

/** Remembered Auto policy is separate from explicit preference and endpoint scoped. */
export function modelReplayPolicy(connection: Parameters<typeof modelReasoningReplay>[0], model: string, baseUrl: string, shellOverride?: boolean): { preserveReasoning: boolean | undefined; reasoningReplayRejected: boolean } {
  const rejection = modelOverrideFor(connection, model)?.reasoningReplayRejection;
  return { preserveReasoning: modelReasoningReplay(connection, model, shellOverride), reasoningReplayRejected: rejection?.reason === "provider-rejected" && rejection.baseUrl === baseUrl };
}

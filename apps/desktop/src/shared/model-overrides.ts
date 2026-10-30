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
  if (connection.contextWindowTokens === undefined && connection.contextWindowModel === undefined) return connection;
  const migrated = { ...connection };
  const model = connection.contextWindowModel?.trim();
  if (model && connection.contextWindowTokens !== undefined) {
    migrated.modelOverrides = { ...connection.modelOverrides, [model]: modelOverrideFor(connection, model)! };
  }
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
export function applyModelReasoningOverride(live: ModelCapabilitiesDto | undefined, supported: boolean): ModelCapabilitiesDto | undefined {
  return supported ? {
    ...live, reasoning: true,
    effortLevels: live?.effortLevels ?? ["off", "low", "medium", "high", "xhigh", "max"],
  } : live;
}

export function modelCapabilitiesFor(
  connection: (ConnectionOverrides & Pick<ProviderConnection, "modelCapabilities">) | undefined,
  model: string,
): ModelCapabilitiesDto | undefined {
  const live = connection?.modelCapabilities !== undefined && Object.hasOwn(connection.modelCapabilities, model)
    ? connection.modelCapabilities[model] : undefined;
  const override = modelOverrideFor(connection, model);
  if (override?.effortLevels !== undefined) return { ...live, reasoning: true, effortLevels: override.effortLevels };
  return applyModelReasoningOverride(live, override?.reasoningSupported === true);
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

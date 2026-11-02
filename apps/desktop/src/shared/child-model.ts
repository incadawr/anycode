import { getBuiltinCatalog } from "@anycode/core/catalog";
import type { AnycodeSettings } from "./settings.js";
import type { ProviderConnection } from "./settings.js";

export function connectionChildModels(connection: ProviderConnection | undefined, customModels: readonly string[], catalogModels: readonly string[], environmentModel?: string): string[] {
  return [...new Set([...(connection?.models ?? []), ...(connection?.visibleModels ?? []), ...customModels, ...catalogModels, ...(connection?.model ? [connection.model] : []), ...(environmentModel ? [environmentModel] : [])])];
}

/** A model override is an exact id on the selected connection, never an alias
 * sent speculatively to an unrelated compatible API. */
export function assertChildModel(model: string, allowedModels: readonly string[]): void {
  if (!allowedModels.includes(model)) {
    throw new Error("This model is not available on the selected connection. Use its exact model ID and choose a matching provider/connection, or retry without a model override.");
  }
}
export function readAllowedChildModels(raw: string | undefined, currentModel: string): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(value) && value.every(id => typeof id === "string")) return [...new Set([currentModel, ...value])];
  } catch { /* only the configured model is known */ }
  return [currentModel];
}

/** Enrich connections with the same model inventory used for child admission. */
export function connectionRoutingSettings(settings: AnycodeSettings, connectionId?: string, model?: string) {
  return { provider: { connections: settings.provider.connections.map(connection => {
    const custom = settings.provider.custom?.find(entry => entry.id === connection.providerId);
    const catalog = getBuiltinCatalog().providers.find(entry => entry.id === connection.providerId);
    return { ...connection, models: connectionChildModels(connection, custom?.models ?? [], catalog?.models.map(entry => entry.id) ?? [], connection.id === connectionId ? model : undefined) };
  }) } };
}

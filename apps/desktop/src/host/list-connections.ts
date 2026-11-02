import { getBuiltinCatalog } from "@anycode/core/catalog";
import type { ConnectionTargets } from "@anycode/core";
import type { AnycodeSettings } from "../shared/settings.js";

/** Project only routing information; never return connection records themselves. */
export function listConnectionTargets(settings: AnycodeSettings, connectionId?: string, model?: string): ConnectionTargets {
  return {
    current: { connectionId, model },
    connections: settings.provider.connections.map(connection => {
      const catalog = getBuiltinCatalog().providers.find(p => p.id === connection.providerId);
      const custom = settings.provider.custom?.find(p => p.id === connection.providerId);
      const ids = [...new Set([connection.model, ...(connection.models ?? []), ...(custom?.models ?? []), ...(catalog?.models.map(m => m.id) ?? [])].filter((id): id is string => Boolean(id)))];
      return {
        id: connection.id,
        label: connection.label,
        providerId: connection.providerId,
        transport: connection.transport ?? catalog?.defaultTransport,
        readiness: connection.lastHealth?.status ?? "unknown",
        models: ids.map(id => {
          const entry = catalog?.models.find(m => m.id === id);
          const live = connection.modelCapabilities?.[id];
          const override = connection.modelOverrides?.[id];
          const imageInput = connection.imageInputModel === id && connection.imageInputOverride !== undefined
            ? connection.imageInputOverride === "on" : live?.imageInput ?? entry?.imageInput;
          return {
            id, imageInput,
            contextWindow: override?.contextWindowTokens ?? live?.contextWindow ?? entry?.contextWindow,
            effortLevels: override?.effortLevels ?? live?.effortLevels ?? entry?.effortLevels,
            default: id === connection.model,
          };
        }),
      };
    }),
  };
}

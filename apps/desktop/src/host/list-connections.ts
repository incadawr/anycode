import { getBuiltinCatalog } from "@anycode/core/catalog";
import { openCodeGoCatalogEntry, resolveEffortLevels, resolveImageInput, type ConnectionTargets } from "@anycode/core";
import { connectionRoutingSettings } from "../shared/child-model.js";
import { migrateModelOverrides } from "../shared/model-overrides.js";
import { createConnectionModelSettings } from "./connection-model-settings.js";
import type { AnycodeSettings } from "../shared/settings.js";

/** Project only routing information; never return connection records themselves. */
export function listConnectionTargets(settings: AnycodeSettings, connectionId?: string, model?: string, manualEnvironment = false): ConnectionTargets {
  return {
    current: { connectionId, model },
    connections: connectionRoutingSettings(settings, connectionId, model, manualEnvironment).provider.connections.map(rawConnection => {
      const connection = migrateModelOverrides(rawConnection);
      const catalog = getBuiltinCatalog().providers.find(p => p.id === connection.providerId);
      const ids = connection.models ?? [];
      const automaticGo = catalog && ["opencode", "opencode-openai"].includes(connection.providerId) && !manualEnvironment && !connection.baseUrl?.trim() && !connection.transport?.trim();
      const effective = createConnectionModelSettings({ connection, catalogEntry: catalog, ...(automaticGo ? { catalogEntryFor: (id: string) => openCodeGoCatalogEntry(catalog, id, connection.modelRoutes) } : {}), liveCapabilitiesFor: id => connection.modelCapabilities?.[id] });
      return {
        id: connection.id,
        label: connection.label,
        providerId: connection.providerId,
        transport: connection.transport ?? catalog?.defaultTransport,
        readiness: connection.lastHealth?.status ?? "unknown",
        models: ids.map(id => {
          const imageOverride = effective.imageInputFor(id);
          return {
            id,
            imageInput: resolveImageInput(id, effective.entryFor(id), imageOverride, automaticGo ? undefined : modelId => connection.modelCapabilities?.[modelId]?.imageInput),
            contextWindow: effective.contextFor(id).tokens,
            effortLevels: resolveEffortLevels(id, effective.entryFor(id), effective.capabilitiesFor(id), effective.effortLevelsFor(id)),
            default: id === connection.model,
          };
        }),
      };
    }),
  };
}

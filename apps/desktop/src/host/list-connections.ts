import { getBuiltinCatalog } from "@anycode/core/catalog";
import { resolveEffortLevels, resolveImageInput, type ConnectionTargets } from "@anycode/core";
import { connectionRoutingSettings } from "../shared/child-model.js";
import { migrateModelOverrides } from "../shared/model-overrides.js";
import { createConnectionModelSettings } from "./connection-model-settings.js";
import type { AnycodeSettings } from "../shared/settings.js";

/** Project only routing information; never return connection records themselves. */
export function listConnectionTargets(settings: AnycodeSettings, connectionId?: string, model?: string): ConnectionTargets {
  return {
    current: { connectionId, model },
    connections: connectionRoutingSettings(settings, connectionId, model).provider.connections.map(rawConnection => {
      // Some callers hand this helper a raw `parseSettings` result rather than a
      // `loadSettings` one (the host's ListConnections tool does), so the legacy
      // image-input pair has to be folded into the per-model map here too — the
      // same read-time migration the settings loader applies.
      const connection = migrateModelOverrides(rawConnection);
      const catalog = getBuiltinCatalog().providers.find(p => p.id === connection.providerId);
      const ids = connection.models ?? [];
      const effective = createConnectionModelSettings({ connection, catalogEntry: catalog, liveCapabilitiesFor: id => connection.modelCapabilities?.[id] });
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
            imageInput: resolveImageInput(id, effective.entryFor(id), imageOverride, modelId => connection.modelCapabilities?.[modelId]?.imageInput),
            contextWindow: effective.contextFor(id).tokens,
            effortLevels: resolveEffortLevels(id, effective.entryFor(id), effective.capabilitiesFor(id), effective.effortLevelsFor(id)),
            default: id === connection.model,
          };
        }),
      };
    }),
  };
}

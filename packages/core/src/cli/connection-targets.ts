import type { ModelBoundCoreEnvConfig } from "../provider/env.js";
import type { CatalogProviderEntry, ProviderTransport } from "../provider/catalog.js";
import { resolveContextWindow, resolveEffortLevels, resolveImageInput } from "../provider/capabilities.js";
import type { ConnectionTargets } from "../tools/list-connections.js";

/** Describe the CLI's single configured endpoint without exposing its configuration. */
export function cliConnectionTargets(
  config: ModelBoundCoreEnvConfig,
  catalog: CatalogProviderEntry | undefined,
  transport: ProviderTransport,
  model: string,
): ConnectionTargets {
  const ids = [...new Set([config.model, model, ...((catalog?.models ?? []).map(entry => entry.id))])];
  return {
    current: { connectionId: "cli", model },
    connections: [{
      id: "cli", label: "CLI connection", providerId: catalog?.id ?? "custom", transport,
      readiness: "unknown",
      models: ids.map(id => ({
        id,
        imageInput: resolveImageInput(id, catalog, config.imageInput),
        contextWindow: resolveContextWindow(id, catalog, config.contextWindowTokens, config.contextWindowModel),
        effortLevels: resolveEffortLevels(id, catalog, undefined, config.effortLevels),
        default: id === config.model,
      })),
    }],
  };
}

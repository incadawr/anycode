import { openCodeGoCatalogEntry, openCodeGoModelIds, resolveOpenCodeGoEndpointPolicy } from "../provider/opencode-go-policy.js";
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
  const candidates = [...new Set([config.model, model, ...(config.automaticModelRouting ? openCodeGoModelIds(config.providerId ?? "") : (catalog?.models ?? []).map(entry => entry.id))])];
  const isGo = config.providerId === "opencode" || config.providerId === "opencode-openai";
  const ids = config.automaticModelRouting ? candidates.filter(id => resolveOpenCodeGoEndpointPolicy(config.providerId ?? "", id).kind === "route") : isGo ? candidates.filter(id => id !== "gemini-4-argon") : candidates;
  return {
    current: { connectionId: "cli", model },
    connections: [{
      id: "cli", label: "CLI connection", providerId: catalog?.id ?? "custom", transport,
      readiness: "unknown",
      models: ids.map(id => {
        const entry = config.automaticModelRouting && catalog ? openCodeGoCatalogEntry(catalog, id) : catalog;
        return { id,
          imageInput: resolveImageInput(id, entry, config.imageInput),
          contextWindow: resolveContextWindow(id, entry, config.contextWindowTokens, config.contextWindowModel),
          effortLevels: resolveEffortLevels(id, entry, undefined, config.effortLevels),
          default: id === config.model,
        };
      }),
    }],
  };
}

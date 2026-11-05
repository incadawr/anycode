import { resolveContextWindowInfo } from "@anycode/core/capabilities";
import { modelDictionaryEntry } from "@anycode/core/model-dictionary";
import { openCodeGoCatalogEntry, resolveOpenCodeGoEndpointPolicy } from "@anycode/core/opencode-go";
import type { CatalogProviderEntry } from "@anycode/core";
import type { ProviderConnection } from "./settings.js";
import { modelOverrideFor } from "./model-overrides.js";

type ContextConnection = Pick<ProviderConnection, "modelOverrides" | "modelCapabilities" | "contextWindowTokens" | "contextWindowModel"> & Partial<Pick<ProviderConnection, "providerId" | "baseUrl" | "transport" | "modelRoutes">>;

/** Resolve a window for the exact connection and model, including gateway metadata. */
export function connectionContextWindow(connection: ContextConnection | undefined, model: string, catalog: CatalogProviderEntry | undefined, explicit?: number, catalogEntryFor?: (model: string) => CatalogProviderEntry | undefined, manualEnvironment = false) {
  const saved = modelOverrideFor(connection, model);
  const automaticGo = !manualEnvironment && !!connection && (connection.providerId === "opencode" || connection.providerId === "opencode-openai") && !connection.baseUrl?.trim() && !connection.transport?.trim();
  if (catalogEntryFor || automaticGo) {
    const route = automaticGo ? resolveOpenCodeGoEndpointPolicy(connection!.providerId!, model, connection!.modelRoutes) : undefined;
    const entry = catalogEntryFor ? catalogEntryFor(model) : route?.kind === "route" && catalog ? openCodeGoCatalogEntry(catalog, model, connection!.modelRoutes) : undefined;
    return resolveContextWindowInfo(model, entry, explicit ?? saved?.contextWindowTokens, model);
  }
  let entry = modelDictionaryEntry(model, catalog, saved?.catalogMatchDisabled === true);
  const live = connection?.modelCapabilities?.[model];
  if (entry?.id === "openrouter" && live?.contextWindow) {
    const previous = entry.models.find((row) => row.id === model);
    entry = { ...entry, models: [...entry.models.filter((row) => row.id !== model), { ...previous, id: model, contextWindow: live.contextWindow, ...(live.maxOutputTokens ? { maxOutputTokens: live.maxOutputTokens } : {}) }] };
  }
  return resolveContextWindowInfo(model, entry, explicit ?? saved?.contextWindowTokens, model);
}

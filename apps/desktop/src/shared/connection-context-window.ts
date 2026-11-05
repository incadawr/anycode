import { resolveContextWindowInfo } from "@anycode/core/capabilities";
import { modelDictionaryEntry } from "@anycode/core/model-dictionary";
import type { CatalogProviderEntry } from "@anycode/core";
import type { ProviderConnection } from "./settings.js";
import { modelOverrideFor } from "./model-overrides.js";

type ContextConnection = Pick<ProviderConnection, "modelOverrides" | "modelCapabilities" | "contextWindowTokens" | "contextWindowModel">;

/** Resolve a window for the exact connection and model, including gateway metadata. */
export function connectionContextWindow(connection: ContextConnection | undefined, model: string, catalog: CatalogProviderEntry | undefined, explicit?: number) {
  const saved = modelOverrideFor(connection, model);
  let entry = modelDictionaryEntry(model, catalog, saved?.catalogMatchDisabled === true);
  const live = connection?.modelCapabilities?.[model];
  if (entry?.id === "openrouter" && live?.contextWindow) {
    const previous = entry.models.find((row) => row.id === model);
    entry = { ...entry, models: [...entry.models.filter((row) => row.id !== model), { ...previous, id: model, contextWindow: live.contextWindow, ...(live.maxOutputTokens ? { maxOutputTokens: live.maxOutputTokens } : {}) }] };
  }
  return resolveContextWindowInfo(model, entry, explicit ?? saved?.contextWindowTokens, model);
}

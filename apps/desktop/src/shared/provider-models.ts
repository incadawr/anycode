import { openCodeGoModelIds } from "@anycode/core/opencode-go";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection, ProviderTransportId } from "./settings.js";
import { mergeModelIds } from "./settings.js";

export function providerModelsFor(
  providerId: string | undefined,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  connectionModels?: readonly string[],
  visibleModels?: readonly string[],
  transport?: ProviderTransportId,
  connection?: ProviderConnection,
  envOverrides?: readonly string[],
): readonly { id: string; name?: string }[] | undefined {
  if (providerId === "opencode" || providerId === "opencode-openai") {
    connectionModels = connectionModels?.filter(id => id !== "gemini-4-argon");
    visibleModels = visibleModels?.filter(id => id !== "gemini-4-argon");
  }
  if (connection && (providerId === "opencode" || providerId === "opencode-openai") && !connection.baseUrl?.trim() && !connection.transport?.trim() && !envOverrides?.some(key => key === "ANYCODE_BASE_URL" || key === "ANYCODE_PROVIDER_TRANSPORT")) {
    const available = openCodeGoModelIds(providerId, connection.modelRoutes);
    const selected = visibleModels === undefined ? available : visibleModels.filter(id => available.includes(id));
    return selected.map(id => ({ id }));
  }
  const catalogHit = providerId === "opencode-openai" && transport === "openai-responses" ? [] : catalog?.find((entry) => entry.id === providerId)?.models;
  const customHit = custom?.find((entry) => entry.id === providerId);
  const baseHints: readonly { id: string; name?: string }[] | undefined =
    catalogHit ?? (customHit !== undefined ? customHit.models.map((id) => ({ id })) : undefined);
  if (visibleModels !== undefined) {
    return visibleModels.map((id) => {
      const hint = baseHints?.find((item) => item.id === id);
      return hint?.name !== undefined ? { id, name: hint.name } : { id };
    });
  }
  if (connectionModels !== undefined && connectionModels.length > 0) {
    const union = mergeModelIds(
      (baseHints ?? []).map((hint) => hint.id),
      connectionModels,
    );
    return union.map((id) => {
      const hint = baseHints?.find((m) => m.id === id);
      return hint?.name !== undefined ? { id, name: hint.name } : { id };
    });
  }
  if (catalogHit !== undefined) {
    return catalogHit;
  }
  if (customHit !== undefined) {
    return customHit.models.map((id) => ({ id }));
  }
  return undefined;
}

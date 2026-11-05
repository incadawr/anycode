import type { CatalogSummary, CustomProviderRecord, ProviderTransportId } from "./settings.js";
import { mergeModelIds } from "./settings.js";

export function providerModelsFor(
  providerId: string | undefined,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  connectionModels?: readonly string[],
  visibleModels?: readonly string[],
  transport?: ProviderTransportId,
): readonly { id: string; name?: string }[] | undefined {
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

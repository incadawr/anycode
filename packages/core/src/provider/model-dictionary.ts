import { getBuiltinCatalog } from "./catalog-data.js";
import type { CatalogModel } from "./catalog.js";

/** Normalize a gateway model ID without discarding model-variant suffixes. */
export function normalizeModelId(id: string): string {
  let name = id.trim().toLowerCase().split("/").pop() ?? "";
  // Only strip known deployment decorations. Unknown suffixes remain significant.
  const decoration = /[-_.](?:local|instruct|fp(?:8|16|32)|bf16|int(?:4|8)|awq|gguf|gptq|q[2-8](?:_k(?:_[sml])?)?)$/i;
  while (decoration.test(name)) name = name.replace(decoration, "");
  return name;
}

/** Find an unambiguous catalog model for a deployment ID. */
export function findKnownModel(id: string): CatalogModel | undefined {
  const key = normalizeModelId(id);
  if (!key) return undefined;
  const matches = getBuiltinCatalog().providers.flatMap((provider) => provider.models)
    .filter((model) => normalizeModelId(model.id) === key);
  if (!matches.length) return undefined;
  // Multiple providers can publish the same model with different rates or limits.
  // Refuse ambiguous facts instead of depending on catalog ordering.
  const first = matches[0]!;
  return matches.every((model) => JSON.stringify(model) === JSON.stringify(first)) ? first : undefined;
}

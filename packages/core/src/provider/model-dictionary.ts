import { getBuiltinCatalog } from "./catalog-data.js";
import type { CatalogModel, CatalogProviderEntry } from "./catalog.js";

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
  const matches = getBuiltinCatalog().providers.filter(provider => provider.id !== "opencode" && provider.id !== "opencode-openai").flatMap((provider) => provider.models)
    .filter((model) => normalizeModelId(model.id) === key);
  if (!matches.length) return undefined;
  // Multiple providers can publish the same model with different rates or limits.
  // Refuse ambiguous facts instead of depending on catalog ordering.
  const first = matches[0]!;
  return matches.every((model) => JSON.stringify(model) === JSON.stringify(first)) ? first : undefined;
}

export function isGatewayProvider(id: string): boolean {
  return id === "" || id === "custom" || id === "openrouter" || id === "vllm" || id.startsWith("custom:");
}

/** Supply capability defaults to gateways without applying their catalog prices. */
export function modelDictionaryEntry(id: string, entry: CatalogProviderEntry | undefined, disabled = false): CatalogProviderEntry | undefined {
  if (disabled || (entry !== undefined && !isGatewayProvider(entry.id))) return entry;
  if (entry?.models.some((model) => model.id === id) || entry?.retiredModels?.some((model) => model.id === id)) return entry;
  const model = findKnownModel(id);
  if (!model) return entry;
  const { pricing: _pricing, ...capabilities } = model;
  return { ...(entry ?? { id: "custom", name: "Custom", baseUrl: "", defaultTransport: "openai-chat-completions", supportedTransports: ["openai-chat-completions"], auth: { kind: "api_key" } }), models: [...(entry?.models ?? []), { ...capabilities, id }] };
}

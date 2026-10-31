import type { z } from "zod";
import type { accountCatalogSchema } from "@anycode/core/plugins-admin";
import type { AccountSourceModelOwnership, CustomProviderRecord, ModelOverrides, ProviderConnection, TokenRates } from "../../shared/settings.js";

type Catalog = z.output<typeof accountCatalogSchema>;
export type CatalogOwnership = Record<string, AccountSourceModelOwnership>;

/** Record a user edit even if its value happens to equal the last source value. */
export function markOverride(ownership: CatalogOwnership, id: string, field: "pricing" | "contextWindowTokens" | "model"): void {
  if (!Object.hasOwn(ownership, id)) Object.defineProperty(ownership, id, { value: {}, writable: true, configurable: true, enumerable: true });
  const entry = ownership[id]!;
  if (field === "model") entry.model = { value: true, overridden: true };
  else if (field === "pricing") entry.pricingOverride = true;
  else entry.contextWindowTokensOverride = true;
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function ratesFor(model: Catalog["models"][number]): TokenRates | undefined {
  if (model.billing === "free") return { input: 0, cachedInput: 0, output: 0, cacheWrite: 0 };
  const r = model.ratesMicrosPerMillionTokens;
  // A missing cache price is unknown, not a free cache price.
  if (!r || r.cachedInput === undefined) return undefined;
  return { input: Number(r.input) / 1e6, cachedInput: Number(r.cachedInput) / 1e6, output: Number(r.output) / 1e6,
    ...(r.cacheWrite !== undefined ? { cacheWrite: Number(r.cacheWrite) / 1e6 } : {}) };
}

/** Pure reconcile. Caller persists the result and its ownership atomically under the settings lock. */
export function reconcileCatalog(custom: CustomProviderRecord, connection: ProviderConnection, old: CatalogOwnership, catalog: Catalog) {
  const resultCustom = structuredClone(custom);
  const resultConnection = structuredClone(connection);
  const ownership = structuredClone(old);
  const models = new Set(resultCustom.models);
  const incoming = new Map(catalog.models.map((model) => [model.id, model]));
  for (const [id, owned] of Object.entries(ownership)) {
    if (owned.model && !models.has(id)) owned.model.overridden = true;
    if (!incoming.has(id) && owned.model && !owned.model.overridden) models.delete(id);
  }
  for (const model of catalog.models) {
    if (!Object.hasOwn(ownership, model.id)) Object.defineProperty(ownership, model.id, { value: {}, writable: true, configurable: true, enumerable: true });
    const owned = ownership[model.id]!;
    if (!owned.model && !models.has(model.id)) { models.add(model.id); owned.model = { value: true }; }
    else if (owned.model && !owned.model.overridden) models.add(model.id);
    const current: ModelOverrides = { ...(resultConnection.modelOverrides && Object.hasOwn(resultConnection.modelOverrides, model.id) ? resultConnection.modelOverrides[model.id] : undefined) };
    const capabilities = model.capabilities && { ...(model.capabilities.reasoning !== undefined ? { reasoning: model.capabilities.reasoning } : {}), ...(model.capabilities.effortLevels !== undefined ? { effortLevels: model.capabilities.effortLevels } : {}), ...(model.capabilities.imageInput ? { imageInput: true as const } : {}) };
    const currentCapabilities = resultConnection.modelCapabilities && Object.hasOwn(resultConnection.modelCapabilities, model.id) ? resultConnection.modelCapabilities[model.id] : undefined;
    if (owned.capabilities && !same(currentCapabilities, owned.capabilities.value)) owned.capabilities.overridden = true;
    if (!owned.capabilities?.overridden && (owned.capabilities || currentCapabilities === undefined)) {
      if (capabilities && Object.keys(capabilities).length) {
        Object.defineProperty(resultConnection.modelCapabilities ??= {}, model.id, { value: capabilities, writable: true, configurable: true, enumerable: true });
        owned.capabilities = { value: capabilities };
      } else if (owned.capabilities) {
        if (resultConnection.modelCapabilities) delete resultConnection.modelCapabilities[model.id];
        delete owned.capabilities;
      }
    }
    const values = { pricing: ratesFor(model), contextWindowTokens: model.capabilities?.contextWindowTokens };
    for (const key of ["pricing", "contextWindowTokens"] as const) {
      const prev = owned[key];
      const currentValue = current[key];
      if (prev && !same(currentValue, prev.value)) prev.overridden = true;
      if (owned[`${key}Override`] || prev?.overridden || (!prev && currentValue !== undefined)) continue;
      const next = values[key];
      if (key === "pricing") {
        if (next === undefined) { delete current.pricing; delete owned.pricing; }
        else { current.pricing = next as TokenRates; owned.pricing = { value: next as TokenRates }; }
      } else {
        if (typeof next !== "number" || next < 1024 || next > 1_000_000) { delete current.contextWindowTokens; delete owned.contextWindowTokens; }
        else { current.contextWindowTokens = next; owned.contextWindowTokens = { value: next }; }
      }
    }
    if (Object.keys(current).length) Object.defineProperty(resultConnection.modelOverrides ??= {}, model.id, { value: current, writable: true, configurable: true, enumerable: true });
    else if (resultConnection.modelOverrides) delete resultConnection.modelOverrides[model.id];
  }
  resultCustom.models = [...models];
  return { custom: resultCustom, connection: resultConnection, ownership };
}

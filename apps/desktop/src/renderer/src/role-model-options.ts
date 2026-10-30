import type { EngineModelChoice, EnginePresentation } from "../../shared/protocol.js";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../shared/settings.js";
import type { DraftEntry } from "./role-editor-model.js";
import { connectionOfferedModels } from "./components/start-model-picker.js";

export interface RoleModelSources {
  connections: readonly ProviderConnection[];
  activeConnectionId: string | undefined;
  catalog: CatalogSummary | undefined;
  custom: readonly CustomProviderRecord[] | undefined;
  engineModels: Partial<Record<"claude" | "codex", readonly EngineModelChoice[]>>;
}

/** Route-local models from the same sources as the composer; never add the saved value to the catalog. */
export function resolveRoleModels(entry: DraftEntry, sources: RoleModelSources): readonly { id: string; name?: string }[] {
  if (entry.engine !== "") {
    return (sources.engineModels[entry.engine] ?? []).filter((model) => model.id !== "default").map((model) => ({ id: model.id, ...(model.label !== undefined ? { name: model.label } : {}) }));
  }
  const id = entry.connection.trim() || sources.activeConnectionId;
  const connection = sources.connections.find((candidate) => candidate.id === id);
  return connection ? connectionOfferedModels(connection, sources.catalog, sources.custom) ?? [] : [];
}

/** UI values use indices so arbitrary model ids cannot collide with Default or Custom. */
export function roleModelSelection(model: string, models: readonly { id: string }[], engine: DraftEntry["engine"] = ""): string {
  if (model === "" || (engine !== "" && model === "default")) return "default";
  const index = models.findIndex((candidate) => candidate.id === model);
  return index === -1 ? "custom" : `model:${index}`;
}

/** Resolve the same live projection / shared draft catalogs used by composer. */
export function pickEngineModels(
  engine: Pick<EnginePresentation, "id" | "model"> | null,
  claudeDraft: readonly EngineModelChoice[],
  codexStore: readonly EngineModelChoice[],
) {
  return {
    claude: engine?.id === "claude" ? engine.model?.available ?? claudeDraft : claudeDraft,
    codex: engine?.id === "codex" ? engine.model?.available ?? codexStore : codexStore,
  };
}

/** Switching routes drops overrides from the previous route. */
export function routePatch(route: string): Partial<DraftEntry> {
  const engine = route === "engine:claude" ? "claude" : route === "engine:codex" ? "codex" : "";
  const id = route.startsWith("connection:") ? route.slice("connection:".length) : "";
  return { engine, connection: id === "active" ? "" : id, provider: undefined, model: "", customModel: false };
}

/** Only an unlisted value can remain custom; the flag also keeps an empty Custom input open. */
export function nextCustomMode(requested: boolean, model: string, models: readonly { id: string }[]): boolean {
  return requested && !models.some((candidate) => candidate.id === model);
}

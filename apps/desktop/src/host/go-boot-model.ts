import { openCodeGoModelIds, resolveOpenCodeGoEndpointPolicy } from "@anycode/core";
import type { ModelRouteSnapshot } from "@anycode/core/model-route";

export function resolveGoBootModel(provider: string, model: string, preferred: string | undefined, snapshot?: ModelRouteSnapshot<Record<string, unknown>>) {
  const result = resolveOpenCodeGoEndpointPolicy(provider, model, snapshot);
  if (result.kind === "route") return { model };
  const candidates = openCodeGoModelIds(provider, snapshot);
  const fallback = preferred && candidates.includes(preferred) ? preferred : candidates[0];
  if (!fallback) throw new Error("OpenCode Go has no available models; refresh the connection's models in Settings.");
  return { model: fallback, notice: `Model ${model} is unavailable (${result.reason}). Using ${fallback}; pick another model if needed.` };
}

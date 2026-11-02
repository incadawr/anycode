import type { ConnectionTargets } from "../tools/list-connections.js";
import { resolveCoreConnectionForModel } from "./core-model-connection.js";

/** Inline children share the parent's connection and can select one of its models. */
export function resolveInlineRoute(targets: ConnectionTargets, provider?: string, model?: string):
  | { ok: true; model?: string }
  | { ok: false; detail: string } {
  const connections = targets.connections.map(c => ({
    id: c.id, label: c.label, providerId: c.providerId,
    model: c.models.find(m => m.default)?.id,
    models: c.models.map(m => m.id),
  }));
  const settings = { provider: { connections } };
  let selected = connections.find(c => c.id === targets.current.connectionId);
  let selectedModel: string | undefined;
  if (provider !== undefined) {
    const result = resolveCoreConnectionForModel(settings, provider);
    if (!result.ok) return result;
    if (result.connectionId !== targets.current.connectionId) {
      return { ok: false, detail: `connection ${JSON.stringify(result.connectionId)} requires session tier; current connection: ${targets.current.connectionId ?? "unknown"}. Available connections: ${connections.map(c => c.id).join(", ")}` };
    }
    selected = connections.find(c => c.id === result.connectionId);
    selectedModel = result.model ?? (provider === selected?.model || provider === `${selected?.providerId}/${selected?.model}` ? selected?.model : undefined);
  }
  const wanted = model ?? selectedModel;
  if (wanted !== undefined) {
    const result = resolveCoreConnectionForModel({ provider: { connections: selected ? [selected] : [] } }, wanted);
    if (!result.ok) return result;
    // A connection selector is not a model and a provider prefix may name an unlisted model.
    const resolvedModel = result.model ?? (selected?.model === wanted || `${selected?.providerId}/${selected?.model}` === wanted ? selected?.model : undefined);
    if (resolvedModel === undefined || !selected?.models.includes(resolvedModel)) {
      return { ok: false, detail: `model ${JSON.stringify(wanted)} is not offered by ${selected?.id ?? "this connection"}; models: ${selected?.models.join(", ") || "none"}` };
    }
    return { ok: true, model: resolvedModel };
  }
  return { ok: true };
}

import { OPENCODE_GO_DEFAULT_MODEL, openCodeGoModelIds, resolveOpenCodeGoEndpointPolicy } from "@anycode/core";
import { describeModelRouteRefusal, type ModelRouteSnapshot } from "@anycode/core/model-route";

/**
 * The model the host boots on, and the reason it had to change.
 *
 * The fallback is picked HERE, not by the caller: the desktop host and the
 * main process both ask this helper, so they can never disagree about which
 * model a connection falls back to. The default comes from the core package
 * (one constant), and it is used only when the connection's own model list
 * actually offers it — otherwise the first routable model wins.
 */
export function resolveGoBootModel(provider: string, model: string, snapshot?: ModelRouteSnapshot<Record<string, unknown>>) {
  const result = resolveOpenCodeGoEndpointPolicy(provider, model, snapshot);
  if (result.kind === "route") return { model };
  const candidates = openCodeGoModelIds(provider, snapshot);
  const fallback = candidates.includes(OPENCODE_GO_DEFAULT_MODEL) ? OPENCODE_GO_DEFAULT_MODEL : candidates[0];
  if (!fallback) throw new Error("OpenCode Go has no available models; refresh the connection's models in Settings.");
  return { model: fallback, notice: `Model ${model} is unavailable because ${describeModelRouteRefusal(result.reason)}. Using ${fallback}; pick another model if needed.` };
}

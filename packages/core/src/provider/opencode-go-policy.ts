import { OPENCODE_GO_MODELS } from "./opencode-go.js";
import { resolveModelRoute, type ModelRouteSnapshot } from "./model-route.js";

/** Declared wire capabilities belong to this exact provider/model pair. */
export interface OpenCodeGoEndpointPolicy {
  providerId: "opencode" | "opencode-openai";
  model: string;
  capabilities: unknown;
  apiCapabilities: unknown;
  compatibility: unknown;
}

export function resolveOpenCodeGoEndpointPolicy(
  providerId: string,
  model: string,
  snapshot?: ModelRouteSnapshot<Record<string, unknown>>,
) {
  const entry = resolveModelRoute<Record<string, unknown>>(providerId, model, snapshot ?? OPENCODE_GO_MODELS);
  if (entry.kind === "refusal") return entry;
  const metadata = entry.route.metadata;
  return { kind: "route" as const, route: { ...entry.route, policy: {
    providerId: providerId as "opencode" | "opencode-openai", model,
    capabilities: metadata.capabilities, apiCapabilities: metadata.apiCapabilities, compatibility: metadata.compatibility,
  } satisfies OpenCodeGoEndpointPolicy } };
}

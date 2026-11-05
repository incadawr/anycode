import type { ProviderTransport } from "./catalog.js";

export const OPENCODE_GO_ANTHROPIC_URL = "https://opencode.ai/inference/go/anthropic/v1";
export const OPENCODE_GO_OPENAI_URL = "https://opencode.ai/inference/go/openai/v1";

export type ModelRouteRefusal = "unsupported-provider" | "unknown-model" | "unsupported-model" | "invalid-route";
export interface ModelRoute<Metadata> {
  transport: ProviderTransport;
  baseUrl: string;
  metadata: Metadata;
}
export type ModelRouteEntry<Metadata> =
  | { kind: "route"; route: ModelRoute<Metadata> }
  | { kind: "refusal"; reason: ModelRouteRefusal };
export interface ModelRouteSnapshot<Metadata> {
  version: 1;
  models: Record<string, ModelRouteEntry<Metadata>>;
}

/** Resolve only exact, validated Go routes; never infer a protocol from a model name. */
export function resolveModelRoute<Metadata>(
  providerId: string,
  modelId: string,
  snapshot: ModelRouteSnapshot<Metadata>,
): ModelRouteEntry<Metadata> {
  if (providerId !== "opencode" && providerId !== "opencode-openai") {
    return { kind: "refusal", reason: "unsupported-provider" };
  }
  const entry = Object.hasOwn(snapshot.models, modelId) ? snapshot.models[modelId] : undefined;
  if (!entry) return { kind: "refusal", reason: "unknown-model" };
  if (entry.kind === "refusal") return entry;
  const { transport, baseUrl } = entry.route;
  const expected = transport === "anthropic-messages" ? OPENCODE_GO_ANTHROPIC_URL
    : transport === "openai-chat-completions" || transport === "openai-responses" ? OPENCODE_GO_OPENAI_URL
    : undefined;
  if (!expected || baseUrl !== expected) return { kind: "refusal", reason: "invalid-route" };
  return entry;
}

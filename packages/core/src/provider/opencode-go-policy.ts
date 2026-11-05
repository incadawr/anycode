import { OPENCODE_GO_MODELS } from "./opencode-go.js";
import { resolveModelRoute, type ModelRouteSnapshot } from "./model-route.js";

export type OpenCodeGoEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Normalized fields of the model listing relevant to request serialization. */
export interface OpenCodeGoCapabilities {
  tools?: { supported?: boolean };
  reasoning?: {
    supported?: boolean;
    toggle?: boolean;
    effort?: OpenCodeGoEffort[];
    default?: { type: "effort"; value: OpenCodeGoEffort };
    budget?: { max?: number };
  };
  structured_output?: boolean;
  temperature?: boolean;
  top_p?: boolean;
  top_k?: boolean;
  system_updates?: boolean;
  effort_updates?: boolean;
}
export interface OpenCodeGoApiCapabilities {
  tools?: { strict?: boolean; choice?: ("auto" | "none" | "required" | "tool")[]; search?: boolean; freeform?: string[]; updates?: boolean };
}
export interface OpenCodeGoCompatibility { reasoning_field?: string }
export interface OpenCodeGoLimits { context?: number; input?: number; output?: number }
export interface OpenCodeGoModalities { input?: string[]; output?: string[] }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";
const stringArray = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(v => typeof v === "string"));
const efforts = new Set<unknown>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
function capabilities(value: unknown): OpenCodeGoCapabilities | undefined {
  if (!isObject(value)) return undefined;
  const r = value.reasoning;
  if (r !== undefined && (!isObject(r) || !optionalBoolean(r.supported) || !optionalBoolean(r.toggle)
    || (r.effort !== undefined && (!Array.isArray(r.effort) || !r.effort.every(v => efforts.has(v))))
    || (r.default !== undefined && (!isObject(r.default) || r.default.type !== "effort" || !efforts.has(r.default.value)))
    || (r.budget !== undefined && (!isObject(r.budget) || (r.budget.max !== undefined && typeof r.budget.max !== "number"))))) return undefined;
  if (value.tools !== undefined && (!isObject(value.tools) || !optionalBoolean(value.tools.supported))) return undefined;
  if (![value.structured_output, value.temperature, value.top_p, value.top_k, value.system_updates, value.effort_updates].every(optionalBoolean)) return undefined;
  return value as OpenCodeGoCapabilities;
}
function apiCapabilities(value: unknown): OpenCodeGoApiCapabilities | undefined {
  if (!isObject(value)) return undefined;
  const t = value.tools;
  if (t !== undefined && (!isObject(t) || !optionalBoolean(t.strict) || !optionalBoolean(t.search) || !optionalBoolean(t.updates)
    || !stringArray(t.freeform) || (t.choice !== undefined && (!Array.isArray(t.choice) || !t.choice.every(v => ["auto", "none", "required", "tool"].includes(v)))))) return undefined;
  return value as OpenCodeGoApiCapabilities;
}
function compatibility(value: unknown): OpenCodeGoCompatibility | undefined {
  return isObject(value) && (value.reasoning_field === undefined || typeof value.reasoning_field === "string") ? value as OpenCodeGoCompatibility : undefined;
}
function limits(value: unknown): OpenCodeGoLimits | undefined {
  if (!isObject(value)) return undefined;
  for (const key of ["context", "input", "output"]) {
    const n = value[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n <= 0)) return undefined;
  }
  return value as OpenCodeGoLimits;
}
function modalities(value: unknown): OpenCodeGoModalities | undefined {
  return isObject(value) && stringArray(value.input) && stringArray(value.output) ? value as OpenCodeGoModalities : undefined;
}

/** Declared wire capabilities belong to this exact provider/model pair. */
export interface OpenCodeGoEndpointPolicy {
  providerId: "opencode" | "opencode-openai";
  model: string;
  capabilities?: OpenCodeGoCapabilities;
  apiCapabilities?: OpenCodeGoApiCapabilities;
  compatibility?: OpenCodeGoCompatibility;
  modalities?: OpenCodeGoModalities;
  limits?: OpenCodeGoLimits;
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
    capabilities: capabilities(metadata.capabilities), apiCapabilities: apiCapabilities(metadata.apiCapabilities), compatibility: compatibility(metadata.compatibility), modalities: modalities(metadata.modalities), limits: limits(metadata.limit),
  } satisfies OpenCodeGoEndpointPolicy } };
}

/** The complete current inventory; a fetched snapshot replaces the built-in list. */
export function openCodeGoModelIds(providerId: string, snapshot?: ModelRouteSnapshot<Record<string, unknown>>): string[] {
  return Object.keys((snapshot ?? OPENCODE_GO_MODELS).models)
    .filter(id => resolveOpenCodeGoEndpointPolicy(providerId, id, snapshot).kind === "route");
}

/** Project this exact Go model's declared metadata into existing capability resolvers. */
export function openCodeGoCatalogEntry(
  entry: import("./catalog.js").CatalogProviderEntry,
  model: string,
  snapshot?: ModelRouteSnapshot<Record<string, unknown>>,
): import("./catalog.js").CatalogProviderEntry {
  const resolved = resolveOpenCodeGoEndpointPolicy(entry.id, model, snapshot);
  if (resolved.kind === "refusal") throw new Error(`OpenCode Go model ${model} unavailable: ${resolved.reason}`);
  const policy = resolved.route.policy;
  const reasoning = policy.capabilities?.reasoning;
  const levels = (reasoning?.effort ?? []).map(level => level === "none" ? "off" as const : level);
  if (reasoning?.toggle && resolved.route.transport === "anthropic-messages" && !levels.includes("off")) levels.unshift("off");
  const defaultEffort = reasoning?.default?.value === "none" ? "off" : reasoning?.default?.value;
  return { ...entry, models: [{
    id: model,
    contextWindow: policy.limits?.context ?? 8192,
    ...(policy.limits?.output !== undefined ? { maxOutputTokens: policy.limits.output } : {}),
    reasoning: reasoning?.supported === true,
    effortLevels: levels,
    supportsExplicitOff: levels.includes("off"),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    imageInput: policy.modalities?.input?.some(m => m.startsWith("image/")) === true,
  }], retiredModels: [] };
}

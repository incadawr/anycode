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
  if (modelId === "gemini-4-argon") return { kind: "refusal", reason: "unsupported-model" };
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

export interface OpenCodeGoSnapshot extends ModelRouteSnapshot<Record<string, unknown>> {
  fetchedAt: string;
}

/** Parse a complete listing without deriving routes from model names. */
export function parseOpenCodeGoSnapshot(rawJson: unknown, fetchedAt: string):
  | { ok: true; snapshot: OpenCodeGoSnapshot }
  | { ok: false; reason: "malformed-response" } {
  let raw = rawJson;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { ok: false, reason: "malformed-response" }; }
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { data?: unknown }).data)) return { ok: false, reason: "malformed-response" };
  const rows = (raw as { data: unknown[] }).data;
  if (!rows.length || rows.some(row => !row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string" || !(row as { id: string }).id)) return { ok: false, reason: "malformed-response" };
  const models: OpenCodeGoSnapshot["models"] = Object.create(null);
  for (const item of rows) {
    const row = item as Record<string, unknown> & { id: string };
    if (Object.hasOwn(models, row.id)) { models[row.id] = { kind: "refusal", reason: "unsupported-model" }; continue; }
    const api = row.api;
    if (row.id === "gemini-4-argon" || !api || typeof api !== "object" || Array.isArray(api)) { models[row.id] = { kind: "refusal", reason: "unsupported-model" }; continue; }
    const keys = Object.keys(api);
    const key = keys[0];
    const transport = key === "messages" ? "anthropic-messages" : key === "chat-completions" ? "openai-chat-completions" : key === "responses" ? "openai-responses" : undefined;
    if (keys.length !== 1 || !transport) { models[row.id] = { kind: "refusal", reason: "unsupported-model" }; continue; }
    const details = (api as Record<string, unknown>)[key!];
    const baseUrl = transport === "anthropic-messages" ? OPENCODE_GO_ANTHROPIC_URL : OPENCODE_GO_OPENAI_URL;
    if (!details || typeof details !== "object" || (details as { base_url?: unknown }).base_url !== baseUrl) { models[row.id] = { kind: "refusal", reason: "invalid-route" }; continue; }
    models[row.id] = { kind: "route", route: { transport, baseUrl, metadata: normalizeGoMetadata(row, details as Record<string, unknown>, fetchedAt) } };
  }
  return { ok: true, snapshot: { version: 1, fetchedAt, models } };
}

// Keep live metadata independent of the raw wire envelope.
function normalizeGoMetadata(row: Record<string, any>, api: Record<string, any>, fetchedAt: string): Record<string, unknown> {
  const limit = { ...row.limit };
  if (row.id === "kimi-k2.7-code") delete limit.output;
  const input = row.cost?.text?.input;
  const output = row.cost?.text?.output;
  const metadata: Record<string, unknown> = { id: row.id, name: row.name, limit, modalities: row.modalities, capabilities: row.capabilities, apiCapabilities: api.capabilities ?? {}, compatibility: api.compatibility ?? {} };
  if (input && output && typeof input.price === "number" && typeof output.price === "number") {
    const multiplier = row.cost?.multipliers?.length ? 2 : 1;
    const rates = (i: any, o: any) => ({ input: i.price * multiplier, ...(i.cache?.read !== undefined ? { cachedInput: i.cache.read * multiplier } : {}), ...(i.cache?.write !== undefined ? { cacheWrite: i.cache.write * multiplier } : {}), output: o.price * multiplier });
    const thresholds = [...new Set<number>([...(input.overrides ?? []), ...(output.overrides ?? [])].map((x: any) => x.when?.context?.gt).filter((x: unknown): x is number => typeof x === "number"))].sort((a, b) => a - b);
    const tiers = thresholds.map(gt => ({ gt, ...rates((input.overrides ?? []).find((x: any) => x.when?.context?.gt === gt) ?? input, (output.overrides ?? []).find((x: any) => x.when?.context?.gt === gt) ?? output) }));
    metadata.pricing = { basisId: `${row.id}-opencode-go-${fetchedAt.slice(0, 10)}`, ...rates(input, output), ...(tiers.length ? { tiers } : {}), ...(multiplier === 2 ? { tariff: { peakUtcDays: [1, 2, 3, 4, 5], peakUtcHours: [[1, 4], [6, 10]], offPeakMultiplier: 0.5 } } : {}) };
  }
  return metadata;
}

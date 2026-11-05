import { getBuiltinCatalog } from "@anycode/core/catalog";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isHttpsOrLocalhostUrl, roleProfilesWriteSchema } from "../settings/schema.js";
import { normalizeModelId, type AnycodeSettings, type ProviderConnection } from "../shared/settings.js";
import { roleProfiles } from "../shared/role-profiles.js";

const name = z.string().trim().min(1).max(128);
const model = z.string().refine((value) => normalizeModelId(value) === value, "Invalid model id");
const effort = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
const rates = z.object({ input: z.number().finite().nonnegative(), cachedInput: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative().optional() }).strict();
const overrides = z.object({ imageInput: z.enum(["on", "off"]).optional(), catalogMatchDisabled: z.literal(true).optional(), effortLevels: z.array(effort).min(1).max(16).optional(), pricing: rates.optional(), contextWindowTokens: z.number().int().min(1024).max(1000000).optional(), reasoningEffort: effort.optional(), reasoningSupported: z.boolean().optional() }).strict();
const capability = z.object({ contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), pricing: rates.omit({ cacheWrite: true }).optional(), reasoning: z.boolean().optional(), effortLevels: z.array(z.string().max(64)).max(16).optional(), imageInput: z.literal(true).optional() }).strict();
const connectionSchema = z.object({
  name,
  provider: z.object({ catalogId: z.string().min(1).max(128).optional(), catalogBaseUrlOnly: z.literal(true).optional(), name, kind: z.enum(["openai-compatible", "anthropic", "openai"]), baseUrl: z.string().max(4096).refine((value) => isHttpsOrLocalhostUrl(value) && !new URL(value).search && !new URL(value).hash, "Invalid provider URL"), models: z.array(model).max(10000), authOptional: z.boolean().optional() }).strict(),
  transport: z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]).optional(),
  model: model.optional(), reasoningEffort: effort.optional(), authOptional: z.boolean().optional(),
  modelOverrides: z.record(model, overrides).optional(), modelCapabilities: z.record(model, capability).optional(),
  proxy: name.optional(),
}).strict();
const rolesSchema = roleProfilesWriteSchema;
const contentSchema = z.object({
  connections: z.array(connectionSchema).max(100),
  roleProfiles: z.array(z.object({ name, roles: z.unknown() }).strict()).max(100),
}).strict().superRefine((content, ctx) => {
  for (const [key, entries] of [["connections", content.connections], ["roleProfiles", content.roleProfiles]] as const) {
    if (new Set(entries.map((entry) => entry.name)).size !== entries.length) ctx.addIssue({ code: "custom", path: [key], message: "Duplicate local name" });
  }
  for (const [index, entry] of content.connections.entries()) {
    const catalog = entry.provider.catalogId && getBuiltinCatalog().providers.find((p) => p.id === entry.provider.catalogId);
    if (catalog && catalog.baseUrl && (!entry.provider.catalogBaseUrlOnly || entry.provider.baseUrl !== catalog.baseUrl)) ctx.addIssue({ code: "custom", path: ["connections", index, "provider", "baseUrl"], message: "Catalog destination override is not allowed" });
  }
  const names = new Set(content.connections.map((entry) => entry.name));
  for (const [index, profile] of content.roleProfiles.entries()) {
    const parsed = rolesSchema.safeParse({ profiles: [{ id: "profile", name: profile.name, roles: profile.roles }], projects: [] });
    if (!parsed.success) { ctx.addIssue({ code: "custom", path: ["roleProfiles", index], message: "Invalid roles" }); continue; }
    visitRoutes(parsed.data.profiles[0]!.roles, (route) => {
      if (route.provider?.startsWith("custom:")) ctx.addIssue({ code: "custom", path: ["roleProfiles", index], message: "Custom provider routes must use a local connection name" });
      if (route.connection && !names.has(route.connection)) ctx.addIssue({ code: "custom", path: ["roleProfiles", index], message: `Missing connection ${route.connection}` });
    });
  }
});

type Roles = NonNullable<AnycodeSettings["roles"]>;
type Route = NonNullable<Roles["planner"]>["primary"];
export interface SetupContent {
  connections: z.output<typeof connectionSchema>[];
  roleProfiles: Array<{ name: string; roles: Roles }>;
}
export type SetupChoice = "update-existing" | "add-copy" | "skip";
export interface SetupSelection { connectionIds: string[]; roleProfileIds: string[] }
export interface SetupPlan {
  content: SetupContent;
  settings: AnycodeSettings;
  connections: Array<{ name: string; matches: string[]; baseUrl: string; existingBaseUrls: string[]; runtimeBaseUrl: string; canUpdate: boolean }>;
  roleProfiles: Array<{ name: string; matches: string[] }>;
}

function visitRoutes(roles: Roles, visit: (route: Route) => void): void {
  for (const key of ["orchestrator", "planner", "executor", "reviewer", "explore"] as const) {
    const role = roles[key];
    if (role) for (const route of [role.primary, ...(role.fallbacks ?? [])]) visit(route);
  }
}

export function validateSetupContent(raw: unknown): SetupContent {
  let serialized: string;
  try { serialized = JSON.stringify(raw); } catch { throw new Error("Invalid setup content"); }
  if (!serialized || Buffer.byteLength(serialized) > 2_000_000) throw new Error("Setup content exceeds size limit or is invalid");
  const parsed = contentSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid setup content: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data as SetupContent;
}

export function buildSetupContent(settings: AnycodeSettings, selection: SetupSelection): SetupContent {
  const selected = selection.connectionIds.map((id) => {
    const connection = settings.provider.connections.find((c) => c.id === id);
    if (!connection) throw new Error("Selected connection does not exist");
    const provider = settings.provider.custom?.find((p) => p.id === connection.providerId);
    const catalog = getBuiltinCatalog().providers.find((p) => p.id === connection.providerId);
    if (!provider && (!catalog || !(catalog.baseUrl || connection.baseUrl))) throw new SetupExportError(`Connection ${safeName(connection.label?.trim() || connection.providerId)}: unknown provider or missing baseUrl`);
    const source = provider ?? { name: catalog!.name, kind: "openai-compatible" as const, baseUrl: catalog!.baseUrl, models: [] as string[], authOptional: undefined };
    const localName = connection.label?.trim() || source.name;
    if (!provider && catalog?.baseUrl && connection.baseUrl) throw new SetupExportError(`Connection ${safeName(localName)}: baseUrl overrides a catalog destination`);
    const proxy = connection.proxyRef === "direct" ? "direct" : settings.network?.proxyProfiles?.find((p) => p.id === connection.proxyRef)?.name;
    if (connection.proxyRef && connection.proxyRef !== "direct" && proxy === "direct") throw new SetupExportError(`Connection ${safeName(localName)}: proxy profile name direct is reserved`);
    if (connection.proxyUrl || (connection.proxyRef && !proxy)) throw new SetupExportError(`Connection ${safeName(localName)}: unsupported proxy`);
    return { id, entry: { name: localName, provider: { ...(!provider ? { catalogId: connection.providerId } : {}), name: source.name, kind: source.kind, baseUrl: provider ? provider.baseUrl : (connection.baseUrl || source.baseUrl), ...(!provider && !connection.baseUrl && source.baseUrl ? { catalogBaseUrlOnly: true as const } : {}), models: source.models, ...(source.authOptional !== undefined ? { authOptional: source.authOptional } : {}) }, ...(connection.transport ? { transport: connection.transport } : {}), ...(connection.model ? { model: connection.model } : {}), ...(connection.reasoningEffort ? { reasoningEffort: connection.reasoningEffort } : {}), ...(connection.authOptional !== undefined ? { authOptional: connection.authOptional } : {}), ...(connection.modelOverrides ? { modelOverrides: connection.modelOverrides } : {}), ...(connection.modelCapabilities ? { modelCapabilities: connection.modelCapabilities } : {}), ...(proxy ? { proxy } : {}) } };
  });
  const names = new Map(selected.map((item) => [item.id, item.entry.name]));
  const profiles = selection.roleProfileIds.map((id) => {
    const profile = roleProfiles(settings).profiles.find((p) => p.id === id);
    if (!profile) throw new Error("Selected role profile does not exist");
    const roles = structuredClone(profile.roles);
    visitRoutes(roles, (route) => { if (route.connection) { const local = names.get(route.connection); if (!local) throw new Error(`Role profile ${profile.name} references an unselected connection`); route.connection = local; } });
    return { name: profile.name, roles };
  });
  const raw = { connections: selected.map((item) => item.entry), roleProfiles: profiles };
  rejectSecretText(raw);
  const exportNames = new Set<string>();
  for (const entry of raw.connections) {
    if (exportNames.has(entry.name)) throw new SetupExportError(`Connection ${safeName(entry.name)}: duplicate name`);
    exportNames.add(entry.name);
    const parsed = connectionSchema.safeParse(entry);
    if (!parsed.success) throw new SetupExportError(`Connection ${safeName(entry.name)}: invalid ${parsed.error.issues[0]?.path.join(".") || "settings"}`);
  }
  const content = validateSetupContent(raw);
  return content;
}

function catalogEntry(id: string) { return getBuiltinCatalog().providers.find((p) => p.id === id); }

function resolveSetupProxy(settings: AnycodeSettings, proxy: string | undefined): string | undefined {
  if (!proxy) return undefined;
  if (proxy === "direct") return "direct";
  const matches = settings.network?.proxyProfiles?.filter((p) => p.name === proxy) ?? [];
  if (matches.length !== 1) throw new Error("Proxy profile is missing or ambiguous");
  return matches[0]!.id;
}

function incomingIdentity(settings: AnycodeSettings, entry: SetupContent["connections"][number]) {
  const catalog = entry.provider.catalogId ? catalogEntry(entry.provider.catalogId) : undefined;
  if (entry.provider.catalogId && !catalog) throw new Error("Unknown catalog provider");
  if (catalog?.baseUrl && (!entry.provider.catalogBaseUrlOnly || entry.provider.baseUrl !== catalog.baseUrl)) throw new Error("Catalog destination override is not allowed");
  if (entry.provider.catalogBaseUrlOnly && (!catalog?.baseUrl || entry.provider.baseUrl !== catalog.baseUrl)) throw new Error("Invalid catalog destination");
  return { id: catalog?.id ?? "custom", kind: catalog ? catalog.auth.kind : entry.provider.kind,
    baseUrl: catalog ? (entry.provider.catalogBaseUrlOnly ? undefined : entry.provider.baseUrl) : entry.provider.baseUrl,
    connectionBaseUrl: catalog && !entry.provider.catalogBaseUrlOnly ? entry.provider.baseUrl : undefined,
    transport: entry.transport, authOptional: entry.authOptional,
    proxyRef: resolveSetupProxy(settings, entry.proxy), proxyUrl: undefined as string | undefined };
}

function existingIdentity(settings: AnycodeSettings, connection: ProviderConnection) {
  const custom = settings.provider.custom?.find((p) => p.id === connection.providerId);
  const catalog = catalogEntry(connection.providerId);
  return { id: custom ? "custom" : connection.providerId, kind: custom?.kind ?? catalog?.auth.kind ?? "unknown",
    baseUrl: custom?.baseUrl ?? connection.baseUrl, connectionBaseUrl: connection.baseUrl,
    transport: connection.transport, authOptional: connection.authOptional,
    proxyRef: connection.proxyRef, proxyUrl: connection.proxyUrl };
}

function sameIdentity(a: ReturnType<typeof incomingIdentity>, b: ReturnType<typeof existingIdentity>): boolean {
  return a.id === b.id && a.kind === b.kind && a.baseUrl === b.baseUrl && a.connectionBaseUrl === b.connectionBaseUrl &&
    a.transport === b.transport && a.authOptional === b.authOptional && a.proxyRef === b.proxyRef && a.proxyUrl === b.proxyUrl;
}

function hasTokenOrReference(text: string): boolean {
  return /(?:^|[^a-z0-9_-])(?:eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+|[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})(?:$|[^a-z0-9_-])/i.test(text) ||
    /\b(?:provider\.(?:[a-z0-9:_-]+\.)*(?:apiKey|oauth)|proxy\.profile\.[a-z0-9_-]+\.password|mcp\.secret\.[a-z0-9_-]+)/i.test(text);
}

export class SetupExportError extends Error {}
function safeName(value: string): string {
  return /\bsk-|\bbearer\s|(?:provider\.|proxy\.profile\.|mcp\.secret\.)|eyJ[a-z0-9_-]*\./i.test(value) || value.length > 64 || /[a-z0-9_~+\/=.-]{32,}/i.test(value) ? "[redacted]" : value;
}

function rejectSecretText(value: SetupContent): void {
  const inspect = (text: string, modelId: boolean): boolean => {
    if (/\bsk-[a-z0-9_-]{8,}/i.test(text) || /\bbearer\s+[a-z0-9._~+\/-]{12,}/i.test(text) || /\b(?:provider\.(?:[a-z0-9:_-]+\.)*(?:apiKey|oauth)|proxy\.profile\.[a-z0-9_-]+\.password|mcp\.secret\.[a-z0-9_-]+)/i.test(text)) return true;
    if (modelId) return false;
    let url: URL | undefined;
    try { url = new URL(text); } catch { /* ordinary text */ }
    const tokens: string[] = [];
    if (url) {
      if (url.username || url.password || url.search || url.hash) return true;
      for (const raw of url.pathname.split("/")) {
        try { tokens.push(decodeURIComponent(raw)); } catch { return true; }
      }
    } else tokens.push(...text.split(/[^a-z0-9_~+\/=.:-]+/i).flatMap((part) => part.split("/")));
    return tokens.some((token) => {
      if (hasTokenOrReference(token) || /\bsk-[a-z0-9_-]{8,}/i.test(token) || /(?:^|[;?&])(?:key|token|secret|apikey)=/i.test(token)) return true;
      const cleaned = token.replace(/^[.:]+|[.:]+$/g, "");
      return cleaned.length >= 32 && !/^[a-f0-9]+$/i.test(cleaned) && /^[a-z0-9_~+\/=.-]+$/i.test(cleaned) && new Set(cleaned).size >= 12;
    });
  };
  const visit = (item: unknown, path: string[], label: string): void => {
    const field = path.join(".") || "value";
    const isModel = path.includes("model") || path.includes("models") || path.includes("modelOverrides") || path.includes("modelCapabilities");
    if (typeof item === "string") { if (inspect(item, isModel)) throw new SetupExportError(`${label}: ${field} contains secret-like text`); }
    else if (Array.isArray(item)) item.forEach((v, i) => visit(v, [...path, String(i)], label));
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      const keyIsModel = path.includes("modelOverrides") || path.includes("modelCapabilities");
      if (inspect(key, keyIsModel)) throw new SetupExportError(`${label}: ${field} contains a secret-like key`);
      visit(child, [...path, key], label);
    }
  };
  value.connections.forEach((connection) => visit(connection, [], `Connection ${safeName(connection.name)}`));
  value.roleProfiles.forEach((profile) => visit(profile, [], `Role profile ${safeName(profile.name)}`));
}

function customProviderMatches(settings: AnycodeSettings, existing: ProviderConnection, entry: SetupContent["connections"][number]): boolean {
  if (entry.provider.catalogId) return true;
  const old = settings.provider.custom?.find((p) => p.id === existing.providerId);
  return !!old && old.name === entry.provider.name && old.kind === entry.provider.kind && old.baseUrl === entry.provider.baseUrl && JSON.stringify(old.models) === JSON.stringify(entry.provider.models) && old.authOptional === entry.provider.authOptional;
}

export function planSetupImport(raw: unknown, settings: AnycodeSettings): SetupPlan {
  const content = validateSetupContent(raw);
  return { content, settings: structuredClone(settings), connections: content.connections.map((entry) => {
    const identity = incomingIdentity(settings, entry);
    const matches = settings.provider.connections.filter((existing) => (existing.label?.trim() || (settings.provider.custom?.find((p) => p.id === existing.providerId)?.name ?? catalogEntry(existing.providerId)?.name)) === entry.name);
    return { name: entry.name, baseUrl: identity.baseUrl ?? catalogEntry(entry.provider.catalogId ?? "")?.baseUrl ?? "", runtimeBaseUrl: catalogEntry(entry.provider.catalogId ?? "")?.baseUrl || identity.baseUrl || "", matches: matches.map((c) => c.id), existingBaseUrls: matches.map((c) => existingIdentity(settings, c).baseUrl ?? catalogEntry(c.providerId)?.baseUrl ?? ""), canUpdate: matches.length === 1 && sameIdentity(identity, existingIdentity(settings, matches[0]!)) && customProviderMatches(settings, matches[0]!, entry) };
  }), roleProfiles: content.roleProfiles.map((p) => ({ name: p.name, matches: roleProfiles(settings).profiles.filter((existing) => existing.name === p.name).map((existing) => existing.id) })) };
}

export function applySetupImport(plan: SetupPlan, choices: { connections: Record<string, SetupChoice>; roleProfiles: Record<string, SetupChoice> }): AnycodeSettings {
  const content = validateSetupContent(plan.content);
  const currentPlan = planSetupImport(content, plan.settings);
  const settings = structuredClone(currentPlan.settings);
  const remap = new Map<string, string>();
  function decision(name: string, matches: string[], choice: SetupChoice | undefined): string | undefined | null {
    if (!choice && matches.length) throw new Error(`Choose how to handle ${name}`);
    if (choice && !["update-existing", "add-copy", "skip"].includes(choice)) throw new Error(`Invalid choice for ${name}`);
    if (choice === "skip") return null;
    if (choice === "update-existing" && matches.length !== 1) throw new Error(`Cannot uniquely update ${name}`);
    return choice === "update-existing" ? matches[0] : undefined;
  }
  const uniqueName = (base: string, names: string[]) => { let result = base; let i = 2; while (names.includes(result)) result = `${base} (${i++})`; return result; };
  for (const entry of content.connections) {
    const target = decision(entry.name, currentPlan.connections.find((c) => c.name === entry.name)!.matches, (Object.hasOwn(choices.connections, entry.name) ? choices.connections[entry.name] : undefined));
    if (target === null) continue;
    const previous = settings.provider.connections.find((c) => c.id === target);
    if (previous && !sameIdentity(incomingIdentity(settings, entry), existingIdentity(settings, previous))) throw new Error(`Destination changed for ${entry.name}; choose add copy`);
    if (previous && !customProviderMatches(settings, previous, entry)) throw new Error(`Provider changed for ${entry.name}; choose add copy`);
    const oldProvider = settings.provider.custom?.find((p) => p.id === previous?.providerId);
    const sameProvider = oldProvider && oldProvider.name === entry.provider.name && oldProvider.kind === entry.provider.kind && oldProvider.baseUrl === entry.provider.baseUrl && JSON.stringify(oldProvider.models) === JSON.stringify(entry.provider.models) && oldProvider.authOptional === entry.provider.authOptional;
    if (entry.provider.catalogId && !catalogEntry(entry.provider.catalogId)) throw new Error("Unknown catalog provider");
    const providerId = entry.provider.catalogId ?? (sameProvider ? oldProvider.id : `custom:${randomUUID()}`);
    if (!entry.provider.catalogId && !sameProvider) { const { catalogId: _catalogId, catalogBaseUrlOnly: _catalogBaseUrlOnly, ...provider } = entry.provider; (settings.provider.custom ??= []).push({ id: providerId, ...provider }); }
    let proxyRef: string | undefined;
    if (entry.proxy === "direct") proxyRef = "direct";
    else if (entry.proxy) { const proxies = settings.network?.proxyProfiles?.filter((p) => p.name === entry.proxy) ?? []; if (proxies.length !== 1) throw new Error(`Proxy profile ${entry.proxy} is missing or ambiguous`); proxyRef = proxies[0]!.id; }
    const { name: localName, provider: _provider, proxy: _proxy, ...fields } = entry;
    const id = previous?.id ?? `conn-${randomUUID()}`;
    const label = previous ? localName : uniqueName(localName, settings.provider.connections.map((c) => c.label?.trim() || settings.provider.custom?.find((p) => p.id === c.providerId)?.name || getBuiltinCatalog().providers.find((p) => p.id === c.providerId)?.name || ""));
    const { baseUrl: _baseUrl, authOptional: _authOptional, model: _model, transport: _transport, reasoningEffort: _effort, modelOverrides: _overrides, modelCapabilities: _capabilities, proxyRef: _proxyRef, proxyUrl: _proxyUrl, lastHealth: _health, lastQuota: _quota, modelsFetchedAt: _fetched, ...rest } = previous ?? {} as ProviderConnection;
    const connection: ProviderConnection = { ...rest, ...fields, id, providerId, label, ...(entry.provider.catalogId && !entry.provider.catalogBaseUrlOnly ? { baseUrl: entry.provider.baseUrl } : {}), ...(proxyRef ? { proxyRef } : {}) };
    if (previous) settings.provider.connections[settings.provider.connections.indexOf(previous)] = connection; else settings.provider.connections.push(connection);
    remap.set(entry.name, id);
  }
  const registry = structuredClone(roleProfiles(settings));
  for (const entry of content.roleProfiles) {
    const target = decision(entry.name, currentPlan.roleProfiles.find((p) => p.name === entry.name)!.matches, (Object.hasOwn(choices.roleProfiles, entry.name) ? choices.roleProfiles[entry.name] : undefined));
    if (target === null) continue;
    const roles = structuredClone(entry.roles);
    visitRoutes(roles, (route) => { if (route.connection) { const id = remap.get(route.connection); if (!id) throw new Error(`Connection ${route.connection} was skipped`); route.connection = id; } });
    const existing = registry.profiles.find((p) => p.id === target);
    const profile = { id: existing?.id ?? randomUUID(), name: existing ? entry.name : uniqueName(entry.name, registry.profiles.map((p) => p.name)), roles };
    if (existing) registry.profiles[registry.profiles.indexOf(existing)] = profile; else registry.profiles.push(profile);
  }
  if (content.roleProfiles.length) settings.roleProfiles = registry;
  return settings;
}

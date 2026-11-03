import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isHttpsOrLocalhostUrl, roleProfilesWriteSchema } from "../settings/schema.js";
import { normalizeModelId, type AnycodeSettings, type ProviderConnection } from "../shared/settings.js";
import { roleProfiles } from "../shared/role-profiles.js";

const name = z.string().trim().min(1).max(128);
const model = z.string().refine((value) => normalizeModelId(value) === value, "Invalid model id");
const effort = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
const rates = z.object({ input: z.number().finite().nonnegative(), cachedInput: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative().optional() }).strict();
const overrides = z.object({ catalogMatchDisabled: z.literal(true).optional(), effortLevels: z.array(effort).min(1).max(16).optional(), pricing: rates.optional(), contextWindowTokens: z.number().int().min(1024).max(1000000).optional(), reasoningEffort: effort.optional(), reasoningSupported: z.boolean().optional() }).strict();
const capability = z.object({ contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), pricing: rates.omit({ cacheWrite: true }).optional(), reasoning: z.boolean().optional(), effortLevels: z.array(z.string().max(64)).max(16).optional(), imageInput: z.literal(true).optional() }).strict();
const connectionSchema = z.object({
  name,
  provider: z.object({ name, kind: z.enum(["openai-compatible", "anthropic", "openai"]), baseUrl: z.string().max(4096).refine(isHttpsOrLocalhostUrl, "Invalid provider URL"), models: z.array(model).max(10000), authOptional: z.boolean().optional() }).strict(),
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
  connections: Array<{ name: string; matches: string[]; baseUrl: string; existingBaseUrls: string[] }>;
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
    if (!provider) throw new Error("Only custom providers can be shared");
    const localName = connection.label?.trim() || provider.name;
    const proxy = connection.proxyRef === "direct" ? "direct" : settings.network?.proxyProfiles?.find((p) => p.id === connection.proxyRef)?.name;
    if (connection.proxyUrl || (connection.proxyRef && !proxy)) throw new Error(`Connection ${localName} has an unsupported proxy`);
    return { id, entry: { name: localName, provider: { name: provider.name, kind: provider.kind, baseUrl: connection.baseUrl ?? provider.baseUrl, models: provider.models, ...(provider.authOptional !== undefined ? { authOptional: provider.authOptional } : {}) }, ...(connection.transport ? { transport: connection.transport } : {}), ...(connection.model ? { model: connection.model } : {}), ...(connection.reasoningEffort ? { reasoningEffort: connection.reasoningEffort } : {}), ...(connection.authOptional !== undefined ? { authOptional: connection.authOptional } : {}), ...(connection.modelOverrides ? { modelOverrides: connection.modelOverrides } : {}), ...(connection.modelCapabilities ? { modelCapabilities: connection.modelCapabilities } : {}), ...(proxy ? { proxy } : {}) } };
  });
  const names = new Map(selected.map((item) => [item.id, item.entry.name]));
  const profiles = selection.roleProfileIds.map((id) => {
    const profile = roleProfiles(settings).profiles.find((p) => p.id === id);
    if (!profile) throw new Error("Selected role profile does not exist");
    const roles = structuredClone(profile.roles);
    visitRoutes(roles, (route) => { if (route.connection) { const local = names.get(route.connection); if (!local) throw new Error(`Role profile ${profile.name} references an unselected connection`); route.connection = local; } });
    return { name: profile.name, roles };
  });
  return validateSetupContent({ connections: selected.map((item) => item.entry), roleProfiles: profiles });
}

export function planSetupImport(raw: unknown, settings: AnycodeSettings): SetupPlan {
  const content = validateSetupContent(raw);
  return { content, settings: structuredClone(settings), connections: content.connections.map((c) => ({ name: c.name, baseUrl: c.provider.baseUrl, matches: settings.provider.connections.filter((existing) => (existing.label?.trim() || settings.provider.custom?.find((p) => p.id === existing.providerId)?.name) === c.name).map((c) => c.id), existingBaseUrls: settings.provider.connections.filter((existing) => (existing.label?.trim() || settings.provider.custom?.find((p) => p.id === existing.providerId)?.name) === c.name).map((existing) => existing.baseUrl ?? settings.provider.custom?.find((p) => p.id === existing.providerId)?.baseUrl ?? "") })), roleProfiles: content.roleProfiles.map((p) => ({ name: p.name, matches: roleProfiles(settings).profiles.filter((existing) => existing.name === p.name).map((existing) => existing.id) })) };
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
    const target = decision(entry.name, currentPlan.connections.find((c) => c.name === entry.name)!.matches, choices.connections[entry.name]);
    if (target === null) continue;
    const previous = settings.provider.connections.find((c) => c.id === target);
    const oldProvider = settings.provider.custom?.find((p) => p.id === previous?.providerId);
    const sameProvider = oldProvider && oldProvider.name === entry.provider.name && oldProvider.kind === entry.provider.kind && oldProvider.baseUrl === entry.provider.baseUrl && JSON.stringify(oldProvider.models) === JSON.stringify(entry.provider.models) && oldProvider.authOptional === entry.provider.authOptional;
    const providerId = sameProvider ? oldProvider.id : `custom:${randomUUID()}`;
    if (!sameProvider) (settings.provider.custom ??= []).push({ id: providerId, ...entry.provider });
    let proxyRef: string | undefined;
    if (entry.proxy === "direct") proxyRef = "direct";
    else if (entry.proxy) { const proxies = settings.network?.proxyProfiles?.filter((p) => p.name === entry.proxy) ?? []; if (proxies.length !== 1) throw new Error(`Proxy profile ${entry.proxy} is missing or ambiguous`); proxyRef = proxies[0]!.id; }
    const { name: localName, provider: _provider, proxy: _proxy, ...fields } = entry;
    const id = previous?.id ?? `conn-${randomUUID()}`;
    const label = previous ? localName : uniqueName(localName, settings.provider.connections.map((c) => c.label?.trim() || settings.provider.custom?.find((p) => p.id === c.providerId)?.name || ""));
    const { baseUrl: _baseUrl, authOptional: _authOptional, model: _model, transport: _transport, reasoningEffort: _effort, modelOverrides: _overrides, modelCapabilities: _capabilities, proxyRef: _proxyRef, proxyUrl: _proxyUrl, lastHealth: _health, lastQuota: _quota, modelsFetchedAt: _fetched, ...rest } = previous ?? {} as ProviderConnection;
    const connection: ProviderConnection = { ...rest, ...fields, id, providerId, label, ...(proxyRef ? { proxyRef } : {}) };
    if (previous) settings.provider.connections[settings.provider.connections.indexOf(previous)] = connection; else settings.provider.connections.push(connection);
    remap.set(entry.name, id);
  }
  const registry = structuredClone(roleProfiles(settings));
  for (const entry of content.roleProfiles) {
    const target = decision(entry.name, currentPlan.roleProfiles.find((p) => p.name === entry.name)!.matches, choices.roleProfiles[entry.name]);
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

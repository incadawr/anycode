import { createHash, randomUUID } from "node:crypto";
import { loadSettings, saveSettings, withSettingsFileLock } from "../../settings/files.js";
import { accountSourceTransportCompatible, type AccountSourceKey, type AccountSourcePreviewResult } from "../../shared/account-sources.js";
import type { AnycodeSettings, SecretKey } from "../../shared/settings.js";
import { customProviderSecretKey } from "../host-env.js";
import { AccountHttpError, fetchAccountDocument } from "./client.js";
import type { AccountSourceCandidate } from "./candidates.js";

interface Deps {
  settingsPath: string;
  candidates(): Promise<AccountSourceCandidate[]>;
  getSecret(key: SecretKey): Promise<string | undefined>;
  fetchFor(connectionId: string): (url: string, init: RequestInit) => Promise<Response>;
  changed(): void | Promise<void>;
  now?: () => number;
}
interface Pending { candidate: AccountSourceCandidate; connectionId: string; accountId: string; credentialDigest: string; expires: number }
function credentialDigest(secret: string | undefined): string { return createHash("sha256").update(secret ?? "").digest("hex"); }
function equalUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return false; } }
export function eligible(settings: AnycodeSettings, candidate: AccountSourceCandidate, connectionId: string): string | undefined {
  const connection = settings.provider.connections.find((c) => c.id === connectionId);
  if (!connection?.providerId.startsWith("custom:")) return;
  const record = settings.provider.custom?.find((c) => c.id === connection.providerId);
  if (!record || record.kind !== candidate.descriptor.gateway.kind || !equalUrl(record.baseUrl, candidate.descriptor.gateway.baseUrl) || (connection.baseUrl && !equalUrl(connection.baseUrl, record.baseUrl))) return;
  if (!accountSourceTransportCompatible(record.kind, connection.transport)) return;
  if (settings.provider.connections.filter((c) => c.providerId === record.id).length !== 1) return;
  if ((settings.plugins?.accountSources ?? []).some((b) => b.connectionId === connectionId && (b.plugin !== candidate.plugin || b.source !== candidate.descriptor.id))) return;
  return record.id;
}
export class AccountBindingService {
  private pending = new Map<string, Pending>();
  private epoch = 0;
  private previews = new Set<AbortController>();
  constructor(private deps: Deps) {}
  invalidate(): void { this.epoch++; this.pending.clear(); for (const preview of this.previews) preview.abort(); this.previews.clear(); }
  async preview(key: AccountSourceKey, connectionId: string): Promise<AccountSourcePreviewResult> {
    const epoch = this.epoch;
    const candidate = (await this.deps.candidates()).find((c) => c.plugin === key.plugin && c.descriptor.id === key.source);
    if (!candidate) return { ok: false, reason: "not_found" };
    const credentials = await withSettingsFileLock(this.deps.settingsPath, async () => {
      const loaded = await loadSettings(this.deps.settingsPath);
      const id = eligible(loaded.settings, candidate, connectionId);
      if (!id || loaded.readOnly || epoch !== this.epoch) return undefined;
      const record = loaded.settings.provider.custom!.find((c) => c.id === id)!;
      const secret = await this.deps.getSecret(customProviderSecretKey(id));
      if (!secret && !record.authOptional) return undefined;
      return epoch === this.epoch ? { secret } : undefined;
    });
    if (!credentials) return { ok: false, reason: "connection_invalid" };
    const controller = new AbortController();
    try {
      if (epoch !== this.epoch) return { ok: false, reason: "stale" };
      this.previews.add(controller);
      const timer = setTimeout(() => controller.abort(), 10_000);
      let result;
      try { result = await fetchAccountDocument(this.deps.fetchFor(connectionId), candidate.descriptor.apiBaseUrl, "catalog", credentials.secret, controller.signal); } finally { clearTimeout(timer); this.previews.delete(controller); }
      if (result.kind !== "catalog") return { ok: false, reason: "invalid" };
      const fresh = (await this.deps.candidates()).find((c) => c.plugin === key.plugin && c.descriptor.id === key.source && c.descriptorHash === candidate.descriptorHash);
      if (!fresh || epoch !== this.epoch) return { ok: false, reason: "stale" };
      const token = randomUUID();
      this.pending.set(token, { candidate: fresh, connectionId, accountId: result.data.accountId, credentialDigest: credentialDigest(credentials.secret), expires: (this.deps.now ?? Date.now)() + 300_000 });
      return { ok: true, token, models: result.data.models.map(({ id, displayName, billing, ratesMicrosPerMillionTokens }) => ({ id, ...(displayName ? { displayName } : {}), billing, ...(ratesMicrosPerMillionTokens ? { ratesMicrosPerMillionTokens } : {}) })) };
    } catch (error) { return { ok: false, reason: error instanceof AccountHttpError && error.status === 401 ? "auth_required" : error instanceof AccountHttpError && error.status === 403 ? "access_denied" : controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ? "timeout" : "unavailable" }; }
  }
  async bind(token: string): Promise<boolean> {
    const pending = this.pending.get(token);
    const epoch = this.epoch;
    this.pending.delete(token);
    if (!pending || pending.expires < (this.deps.now ?? Date.now)()) return false;
    const candidate = (await this.deps.candidates()).find((c) => c.plugin === pending.candidate.plugin && c.descriptor.id === pending.candidate.descriptor.id && c.descriptorHash === pending.candidate.descriptorHash);
    if (!candidate) return false;
    const result = await withSettingsFileLock(this.deps.settingsPath, async () => {
      const loaded = await loadSettings(this.deps.settingsPath);
      const id = eligible(loaded.settings, candidate, pending.connectionId);
      if (loaded.readOnly || !id || epoch !== this.epoch) return false;
      if (credentialDigest(await this.deps.getSecret(customProviderSecretKey(id))) !== pending.credentialDigest) return false;
      if (epoch !== this.epoch) return false;
      const current = loaded.settings.plugins?.accountSources ?? [];
      const previous = current.find((b) => b.plugin === candidate.plugin && b.source === candidate.descriptor.id);
      const others = current.filter((b) => b.plugin !== candidate.plugin || b.source !== candidate.descriptor.id);
      const ownership = previous?.connectionId === pending.connectionId && previous.accountId === pending.accountId ? previous.ownership : {};
      await saveSettings(this.deps.settingsPath, { ...loaded.settings, plugins: { ...loaded.settings.plugins, accountSources: [...others, { plugin: candidate.plugin, source: candidate.descriptor.id, descriptorHash: candidate.descriptorHash, connectionId: pending.connectionId, accountId: pending.accountId, ownership }] } });
      return true;
    });
    if (result) await this.deps.changed();
    return result;
  }
  async unbind(key: AccountSourceKey): Promise<void> {
    await withSettingsFileLock(this.deps.settingsPath, async () => {
      const loaded = await loadSettings(this.deps.settingsPath);
      if (loaded.readOnly || !loaded.settings.plugins?.accountSources) return;
      const accountSources = loaded.settings.plugins.accountSources.filter((b) => b.plugin !== key.plugin || b.source !== key.source);
      await saveSettings(this.deps.settingsPath, { ...loaded.settings, plugins: { ...loaded.settings.plugins, accountSources } });
    });
    await this.deps.changed();
  }
  async removePlugin(plugin: string): Promise<void> {
    await withSettingsFileLock(this.deps.settingsPath, async () => {
      const loaded = await loadSettings(this.deps.settingsPath);
      if (loaded.readOnly || !loaded.settings.plugins?.accountSources) return;
      const accountSources = loaded.settings.plugins.accountSources.filter((b) => b.plugin !== plugin);
      if (accountSources.length === loaded.settings.plugins.accountSources.length) return;
      await saveSettings(this.deps.settingsPath, { ...loaded.settings, plugins: { ...loaded.settings.plugins, accountSources } });
    });
    await this.deps.changed();
  }
  async reset(key: AccountSourceKey): Promise<void> {
    const candidate = (await this.deps.candidates()).find((c) => c.plugin === key.plugin && c.descriptor.id === key.source);
    if (!candidate) return;
    await withSettingsFileLock(this.deps.settingsPath, async () => {
      const loaded = await loadSettings(this.deps.settingsPath);
      const bindings = loaded.settings.plugins?.accountSources ?? [];
      const binding = bindings.find((b) => b.plugin === key.plugin && b.source === key.source);
      if (loaded.readOnly || !binding || binding.descriptorHash !== candidate.descriptorHash || !eligible(loaded.settings, candidate, binding.connectionId)) return;
      const connection = loaded.settings.provider.connections.find((c) => c.id === binding.connectionId);
      const custom = loaded.settings.provider.custom?.find((p) => p.id === connection?.providerId);
      if (!connection || !custom) return;
      const updated = structuredClone(loaded.settings);
      const nextConnection = updated.provider.connections.find((c) => c.id === binding.connectionId)!;
      const nextCustom = updated.provider.custom!.find((p) => p.id === custom.id)!;
      const nextBinding = updated.plugins!.accountSources!.find((b) => b.plugin === key.plugin && b.source === key.source)!;
      for (const [id, owned] of Object.entries(binding.ownership)) {
        if (owned.model && !nextCustom.models.includes(id)) nextCustom.models.push(id);
        const override = nextConnection.modelOverrides && Object.hasOwn(nextConnection.modelOverrides, id) ? nextConnection.modelOverrides[id] : undefined;
        if (override) {
          if (owned.pricing || owned.pricingOverride) delete override.pricing;
          if (owned.contextWindowTokens || owned.contextWindowTokensOverride) delete override.contextWindowTokens;
          if (!Object.keys(override).length) delete nextConnection.modelOverrides![id];
        }
        if (owned.capabilities && nextConnection.modelCapabilities) delete nextConnection.modelCapabilities[id];
      }
      nextBinding.ownership = Object.fromEntries(Object.entries(binding.ownership).filter(([, owned]) => owned.model).map(([id]) => [id, { model: { value: true as const } }]));
      await saveSettings(this.deps.settingsPath, updated);
    });
    await this.deps.changed();
  }
}

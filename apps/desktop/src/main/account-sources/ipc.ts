import { guardedIpcHandle } from "../ipc-guard.js";
import { z } from "zod";
import { accountCatalogSchema } from "@anycode/core/plugins-admin";
import type { FileSystemPort } from "@anycode/core";
import { loadSettings, withSettingsFileLock } from "../../settings/files.js";
import { ACCOUNT_SOURCES_BIND_CHANNEL, ACCOUNT_SOURCES_CATALOG_CHANGED_CHANNEL, ACCOUNT_SOURCES_CHANGED_CHANNEL, ACCOUNT_SOURCES_GET_CHANNEL, ACCOUNT_SOURCES_PREVIEW_CHANNEL, ACCOUNT_SOURCES_REFRESH_CHANNEL, ACCOUNT_SOURCES_RESET_CHANNEL, ACCOUNT_SOURCES_UNBIND_CHANNEL, type AccountSourceCandidateView } from "../../shared/account-sources.js";
import type { AnycodeSettings, SecretKey } from "../../shared/settings.js";
import { customProviderSecretKey } from "../host-env.js";
import { AccountBindingService, eligible } from "./binding.js";
import { listAccountSourceCandidates } from "./candidates.js";
import { AccountSourcesController, type AccountSourceRuntime } from "./controller.js";
import { persistCatalog } from "./persist.js";
import { withPluginStateLock } from "../plugins/store.js";

interface Deps {
  fs: FileSystemPort; home: string; appVersion: string; settingsPath: string;
  allowLoopback?: boolean;
  getSecret(key: SecretKey): Promise<string | undefined>;
  fetchFor(id: string): (url: string, init: RequestInit) => Promise<Response>;
  publish(channel: string, value: unknown): void;
  settingsChanged(settings: AnycodeSettings): void | Promise<void>;
}
const keySchema = z.object({ plugin: z.string().min(1).max(64), source: z.string().min(1).max(64) }).strict();
export function registerAccountSourcesIpc(deps: Deps) {
  const candidates = () => listAccountSourceCandidates(deps.fs, deps.home, deps.appVersion, deps.allowLoopback === true);
  const controller = new AccountSourcesController((snapshot) => deps.publish(ACCOUNT_SOURCES_CHANGED_CHANNEL, snapshot));
  let generation = 0;
  let disposed = false;
  let fingerprint = "";
  let binding: AccountBindingService;
  let candidateViews: AccountSourceCandidateView[] = [];
  async function reconcile(force = false): Promise<void> {
    const turn = ++generation;
    if (force) { binding?.invalidate(); fingerprint = ""; controller.replace([]); }
    const found = await candidates().catch(() => []);
    if (turn !== generation || disposed) return;
    const loaded = await loadSettings(deps.settingsPath);
    const settings = loaded.settings;
    const bound = settings.plugins?.accountSources ?? [];
    const nextFingerprint = JSON.stringify([found.map((c) => [c.plugin, c.descriptor.id, c.descriptorHash]), bound.map((b) => {
      const c = settings.provider.connections.find((x) => x.id === b.connectionId);
      const custom = settings.provider.custom?.find((x) => x.id === c?.providerId);
      return [b.plugin, b.source, b.descriptorHash, b.connectionId, b.accountId, c?.providerId, c?.baseUrl, c?.transport, c?.proxyRef, c?.proxyUrl, custom?.baseUrl, custom?.kind, custom?.authOptional];
    })]);
    if (!force && nextFingerprint === fingerprint) return;
    controller.replace([]);
    candidateViews = found.map(({ plugin, descriptor }) => ({ key: { plugin, source: descriptor.id }, displayName: descriptor.displayName, gatewayName: descriptor.gateway.name, gatewayBaseUrl: descriptor.gateway.baseUrl, gatewayKind: descriptor.gateway.kind, apiBaseUrl: descriptor.apiBaseUrl }));
    const sources: AccountSourceRuntime[] = [];
    for (const b of bound) {
      const candidate = found.find((c) => c.plugin === b.plugin && c.descriptor.id === b.source && c.descriptorHash === b.descriptorHash);
      if (!candidate) continue;
      const credential = await withSettingsFileLock(deps.settingsPath, async () => {
        const fresh = await loadSettings(deps.settingsPath);
        const current = fresh.settings.plugins?.accountSources?.find((x) => x.plugin === b.plugin && x.source === b.source && x.descriptorHash === b.descriptorHash && x.connectionId === b.connectionId && x.accountId === b.accountId);
        const id = current && eligible(fresh.settings, candidate, b.connectionId);
        if (!id) return undefined;
        const record = fresh.settings.provider.custom?.find((x) => x.id === id);
        const secret = await deps.getSecret(customProviderSecretKey(id));
        return { secret, needsCredential: !secret && !record?.authOptional };
      });
      if (turn !== generation || disposed) return;
      if (!credential) continue;
      sources.push({ key: { plugin: b.plugin, source: b.source }, displayName: candidate.descriptor.displayName, apiBaseUrl: candidate.descriptor.apiBaseUrl, accountId: b.accountId, connectionId: b.connectionId, apiKey: credential.secret, needsCredential: credential.needsCredential, fetcher: deps.fetchFor(b.connectionId), withAuthorization: (publish) => withPluginStateLock(deps.home, async () => {
        const live = (await candidates()).some((item) => item.plugin === b.plugin && item.descriptor.id === b.source && item.descriptorHash === b.descriptorHash);
        if (live) await withSettingsFileLock(deps.settingsPath, async () => {
          const fresh = (await loadSettings(deps.settingsPath)).settings;
          const binding = fresh.plugins?.accountSources?.find((x) => x.plugin === b.plugin && x.source === b.source && x.descriptorHash === b.descriptorHash && x.connectionId === b.connectionId && x.accountId === b.accountId);
          if (binding && eligible(fresh, candidate, b.connectionId)) publish();
        });
      }), applyCatalog: async (catalog, current) => {
        const parsed = accountCatalogSchema.safeParse(catalog);
        if (!parsed.success) return;
        await withPluginStateLock(deps.home, async () => {
          const live = (await candidates()).some((item) => item.plugin === b.plugin && item.descriptor.id === b.source && item.descriptorHash === b.descriptorHash);
          if (!live || !current()) return;
          await persistCatalog(deps.settingsPath, { ...b, gatewayBaseUrl: candidate.descriptor.gateway.baseUrl, gatewayKind: candidate.descriptor.gateway.kind }, parsed.data, current, async (fresh) => { await deps.settingsChanged(fresh); deps.publish(ACCOUNT_SOURCES_CATALOG_CHANGED_CHANNEL, null); });
        });
      } });
    }
    if (turn === generation && !disposed) { fingerprint = nextFingerprint; controller.replace(sources); }
  }
  binding = new AccountBindingService({ settingsPath: deps.settingsPath, candidates, getSecret: deps.getSecret, fetchFor: deps.fetchFor, changed: async () => {
    const refreshing = reconcile(true);
    const loaded = await loadSettings(deps.settingsPath);
    await deps.settingsChanged(loaded.settings);
    deps.publish(ACCOUNT_SOURCES_CATALOG_CHANGED_CHANNEL, null);
    await refreshing;
  } });
  guardedIpcHandle(ACCOUNT_SOURCES_GET_CHANNEL, () => ({ snapshot: controller.snapshot(), candidates: candidateViews }));
  guardedIpcHandle(ACCOUNT_SOURCES_PREVIEW_CHANNEL, async (_event, raw: unknown) => {
    const parsed = z.object({ key: keySchema, connectionId: z.string().min(1).max(128) }).strict().safeParse(raw);
    return parsed.success ? binding.preview(parsed.data.key, parsed.data.connectionId) : { ok: false, reason: "invalid" };
  });
  guardedIpcHandle(ACCOUNT_SOURCES_BIND_CHANNEL, async (_event, raw: unknown) => typeof raw === "string" && raw.length <= 128 ? binding.bind(raw) : false);
  guardedIpcHandle(ACCOUNT_SOURCES_UNBIND_CHANNEL, async (_event, raw: unknown) => { const key = keySchema.safeParse(raw); if (key.success) await binding.unbind(key.data); });
  guardedIpcHandle(ACCOUNT_SOURCES_RESET_CHANNEL, async (_event, raw: unknown) => { const key = keySchema.safeParse(raw); if (key.success) await binding.reset(key.data); });
  guardedIpcHandle(ACCOUNT_SOURCES_REFRESH_CHANNEL, async (_event, raw: unknown) => { const key = keySchema.safeParse(raw); if (key.success) await controller.refresh(key.data); });
  void reconcile(true);
  return { reconcile, removePlugin: (name: string) => binding.removePlugin(name), dispose: () => { disposed = true; generation++; binding.invalidate(); controller.dispose(); } };
}

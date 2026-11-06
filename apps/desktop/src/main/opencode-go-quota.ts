import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import { isOpenCodeGoConnection, type GoQuotaSnapshot } from "../shared/opencode-go-quota.js";
import type { SystemProxyResolver } from "../shared/proxy.js";
import { prepareModelFetchContext } from "./model-fetch-guard.js";
import type { ProxyRoute } from "./provider-proxy-fetch.js";
import { parseOpenCodeGoQuota } from "./opencode-go-quota-adapter.js";

const TARGET = "https://opencode.ai/zen/go/v1/usage";
type Context = { apiKey: string; guard: string; route: ProxyRoute };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function targetGoConnection(settings: AnycodeSettings, id: string): ProviderConnection | undefined {
  const connection = settings.provider.connections.find(item => item.id === id);
  if (!connection || !["opencode", "opencode-openai"].includes(connection.providerId)) return undefined;
  if (settings.provider.custom?.some(item => item.id === connection.providerId)) return undefined;
  return isOpenCodeGoConnection(connection) ? connection : undefined;
}

export function createOpenCodeGoQuotaPoller(deps: {
  resolve(id: string): Promise<Context | undefined>;
  fetch(route: ProxyRoute): FetchLike;
  record(id: string, guard: string, snapshot: GoQuotaSnapshot | undefined): Promise<void>;
  now?: () => number;
}) {
  const last = new Map<string, number>();
  const flights = new Map<string, Promise<void>>();
  const now = deps.now ?? Date.now;
  function refresh(id: string): Promise<void> {
    const existing = flights.get(id);
    if (existing) return existing;
    const time = now();
    if (time - (last.get(id) ?? -Infinity) < 60_000) return Promise.resolve();
    last.set(id, time);
    const task = (async () => {
      let context: Context | undefined;
      try { context = await deps.resolve(id); } catch { return; }
      if (!context) return;
      let snapshot: GoQuotaSnapshot | undefined;
      try {
        const response = await deps.fetch(context.route)(TARGET, { method: "GET", headers: { Authorization: `Bearer ${context.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const raw: unknown = await response.json();
          const time = now();
          const windows = parseOpenCodeGoQuota(raw, time);
          if (windows) snapshot = { observedAt: new Date(time).toISOString(), windows };
        }
      } catch { /* Failed requests clear the advisory snapshot. */ }
      try { await deps.record(id, context.guard, snapshot); } catch { /* Advisory only. */ }
    })();
    flights.set(id, task);
    void task.finally(() => flights.delete(id));
    return task;
  }
  return { refresh };
}

export function createOpenCodeGoQuotaService(deps: {
  settingsPath: string;
  vault: { getSecretValue(key: SecretKey): Promise<string | undefined> };
  systemProxy?: SystemProxyResolver;
  fetch(route: ProxyRoute): FetchLike;
  onPersisted(): void;
  now?: () => number;
}) {
  async function context(settings: AnycodeSettings, id: string): Promise<Context | undefined> {
    const connection = targetGoConnection(settings, id);
    if (!connection) return undefined;
    const prepared = await prepareModelFetchContext(settings, connection, deps.vault, TARGET, deps.systemProxy);
    if (!prepared.ok || !prepared.apiKey || (prepared.route.kind === "direct" && prepared.route.why === "dangling-ref")) return undefined;
    return { apiKey: prepared.apiKey, guard: prepared.guard, route: prepared.route };
  }
  const poller = createOpenCodeGoQuotaPoller({
    resolve: id => withSettingsFileLock(deps.settingsPath, async () => context((await loadSettings(deps.settingsPath)).settings, id)),
    fetch: deps.fetch,
    now: deps.now,
    record: async (id, guard, snapshot) => {
      let changed = false;
      await withSettingsFileLock(deps.settingsPath, async () => {
        const loaded = await loadSettings(deps.settingsPath);
        if (loaded.readOnly || (await context(loaded.settings, id))?.guard !== guard) return;
        const connection = loaded.settings.provider.connections.find(item => item.id === id);
        if (!connection || (!snapshot && !connection.lastGoQuota)) return;
        if (snapshot) connection.lastGoQuota = snapshot;
        else delete connection.lastGoQuota;
        await saveSettings(deps.settingsPath, loaded.settings);
        changed = true;
      });
      if (changed) deps.onPersisted();
    },
  });
  return { async refresh(id?: string): Promise<void> {
    if (id !== undefined) return poller.refresh(id);
    try {
      const settings = (await loadSettings(deps.settingsPath)).settings;
      await Promise.all(settings.provider.connections.filter(c => targetGoConnection(settings, c.id)).map(c => poller.refresh(c.id)));
    } catch { /* Advisory only. */ }
  } };
}

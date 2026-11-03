import { findCatalogEntry } from "@anycode/core/catalog";
import { loadSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import type { SystemProxyResolver } from "../shared/proxy.js";
import { prepareModelFetchContext } from "./model-fetch-guard.js";
import type { ProxyRoute } from "./provider-proxy-fetch.js";
import { recordConnectionQuota } from "./connection-quota.js";
import { parseMiniMaxQuota } from "./minimax-quota-adapter.js";

const TARGET = "https://api.minimax.io/v1/token_plan/remains";
type Context = { apiKey: string; guard: string; route: ProxyRoute; model?: string };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createMiniMaxQuotaPoller(deps: {
  resolve(id: string): Promise<Context | undefined>;
  fetch(route: ProxyRoute): FetchLike;
  record(id: string, guard: string, quota: NonNullable<NonNullable<ReturnType<typeof parseMiniMaxQuota>>["primary"]> & { secondary?: NonNullable<NonNullable<ReturnType<typeof parseMiniMaxQuota>>["secondary"]> }): Promise<void>;
  now?: () => number;
}) {
  const last = new Map<string, number>();
  const flights = new Map<string, Promise<void>>();
  const unsupported = new Map<string, string>();
  function refresh(id: string): Promise<void> {
    const existing = flights.get(id);
    if (existing) return existing;
    const now = (deps.now ?? Date.now)();
    if (now - (last.get(id) ?? -Infinity) < 60_000) return Promise.resolve();
    last.set(id, now);
    const task = (async () => {
      try {
        const context = await deps.resolve(id);
        if (!context) return;
        if (unsupported.get(id) === context.guard) return;
        unsupported.delete(id);
        const response = await deps.fetch(context.route)(TARGET, {
          method: "GET", headers: { Authorization: `Bearer ${context.apiKey}` },
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "base_resp" in body && body.base_resp && typeof body.base_resp === "object" && "status_code" in body.base_resp && body.base_resp.status_code === 1004) {
          unsupported.set(id, context.guard);
          return;
        }
        const quota = parseMiniMaxQuota(body, Date.now(), context.model);
        if (quota?.primary) await deps.record(id, context.guard, { ...quota.primary, ...(quota.secondary ? { secondary: quota.secondary } : {}) });
      } catch {
        // Quota is advisory; failures leave the last observation untouched.
      }
    })();
    flights.set(id, task);
    void task.finally(() => flights.delete(id));
    return task;
  }
  return { refresh };
}

function targetConnection(settings: AnycodeSettings, id: string): ProviderConnection | undefined {
  const connection = settings.provider.connections.find(item => item.id === id);
  if (!connection) return undefined;
  const custom = settings.provider.custom?.find(item => item.id === connection.providerId);
  const baseUrl = custom?.baseUrl ?? (connection.baseUrl?.trim() || findCatalogEntry(connection.providerId)?.baseUrl);
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["api.minimax.io", "www.minimax.io"].includes(url.hostname)) return undefined;
    return connection;
  } catch { return undefined; }
}

export function createMiniMaxQuotaService(deps: {
  settingsPath: string;
  vault: { getSecretValue(key: SecretKey): Promise<string | undefined> };
  systemProxy?: SystemProxyResolver;
  fetch(route: ProxyRoute): FetchLike;
  onPersisted(): void;
}) {
  async function context(settings: AnycodeSettings, id: string): Promise<Context | undefined> {
    const connection = targetConnection(settings, id);
    if (!connection) return undefined;
    const prepared = await prepareModelFetchContext(settings, connection, deps.vault, TARGET, deps.systemProxy);
    if (!prepared.ok || !prepared.apiKey || (prepared.route.kind === "direct" && prepared.route.why === "dangling-ref")) return undefined;
    return { apiKey: prepared.apiKey, guard: `${prepared.guard}:${JSON.stringify(connection.model ?? null)}`, route: prepared.route, model: connection.model };
  }
  const poller = createMiniMaxQuotaPoller({
    resolve: id => withSettingsFileLock(deps.settingsPath, async () => context((await loadSettings(deps.settingsPath)).settings, id)),
    fetch: deps.fetch,
    record: async (id, guard, quota) => {
      if (!quota) return;
      await recordConnectionQuota({ settingsPath: deps.settingsPath }, id, quota, "minimax-token-plan", deps.onPersisted,
        async settings => (await context(settings, id))?.guard === guard);
    },
  });
  return {
    async refresh(id?: string): Promise<void> {
      if (id !== undefined) return poller.refresh(id);
      try {
        const settings = (await loadSettings(deps.settingsPath)).settings;
        await Promise.all(settings.provider.connections.filter(c => targetConnection(settings, c.id)).map(c => poller.refresh(c.id)));
      } catch { /* Advisory only. */ }
    },
  };
}

/**
 * GLM coding-plan quota polling (Z.AI), the MiniMax M Plan tile's exact
 * mechanism (`minimax-quota.ts`) pointed at the Z.AI monitor endpoint:
 * a 60 s-throttled, in-flight-deduplicated, redirect-refusing GET that maps
 * the response onto the generic quota shape and persists it through the
 * SAME `recordConnectionQuota` → `lastQuota` path — so the connection card
 * renders it with zero renderer-side special cases (the tile's quota line,
 * the 5h/Weekly labels and the reset age are all provider-agnostic).
 *
 * Differences from the MiniMax poller, both dictated by the endpoint:
 *  - `Authorization: <key>` RAW — the coding-plan monitor API rejects the
 *    Bearer form, so the key goes out verbatim (never logged anywhere);
 *  - the gate is provider Z.AI at the CODING-PLAN base only
 *    (`api.z.ai`, path under `/api/anthropic`): pay-as-you-go keys live on
 *    `/api/paas/v4` bases and are never polled.
 *
 * There is no MiniMax-style 1004 "unsupported" cache: the endpoint gives
 * no verified definitive "not a coding-plan key" body, so an unusable
 * response just records nothing (the shared 60 s throttle bounds the cost),
 * identical to the MiniMax poller's non-2xx path.
 */

import { findCatalogEntry } from "@anycode/core/catalog";
import { loadSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import type { SystemProxyResolver } from "../shared/proxy.js";
import { prepareModelFetchContext } from "./model-fetch-guard.js";
import type { ProxyRoute } from "./provider-proxy-fetch.js";
import { recordConnectionQuota } from "./connection-quota.js";
import { GLM_QUOTA_SOURCE, parseGlmQuota } from "./glm-quota-adapter.js";

const TARGET = "https://api.z.ai/api/monitor/usage/quota/limit";
type Context = { apiKey: string; guard: string; route: ProxyRoute };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type QuotaWindows = NonNullable<NonNullable<ReturnType<typeof parseGlmQuota>>["primary"]> & { secondary?: NonNullable<NonNullable<ReturnType<typeof parseGlmQuota>>["secondary"]> };

export function createGlmQuotaPoller(deps: {
  resolve(id: string): Promise<Context | undefined>;
  fetch(route: ProxyRoute): FetchLike;
  record(id: string, guard: string, quota: QuotaWindows): Promise<void>;
  now?: () => number;
}) {
  const last = new Map<string, number>();
  const flights = new Map<string, Promise<void>>();
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
        // RAW key — the monitor endpoint rejects `Bearer <key>`.
        const response = await deps.fetch(context.route)(TARGET, {
          method: "GET", headers: { Authorization: context.apiKey },
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
        const quota = parseGlmQuota(await response.json(), Date.now());
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

/**
 * Eligibility: the connection's EFFECTIVE base URL (custom provider record,
 * then the connection's own override, then the catalog) must be https on
 * `api.z.ai` with the coding-plan `/api/anthropic` prefix — never the
 * pay-as-you-go `/api/paas/v4` base or any other host. Structural, the same
 * law as the MiniMax poller's hostname allow-list.
 */
function targetConnection(settings: AnycodeSettings, id: string): ProviderConnection | undefined {
  const connection = settings.provider.connections.find(item => item.id === id);
  if (!connection) return undefined;
  const custom = settings.provider.custom?.find(item => item.id === connection.providerId);
  const baseUrl = custom?.baseUrl ?? (connection.baseUrl?.trim() || findCatalogEntry(connection.providerId)?.baseUrl);
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== "api.z.ai" || !url.pathname.startsWith("/api/anthropic")) return undefined;
    return connection;
  } catch { return undefined; }
}

export function createGlmQuotaService(deps: {
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
    return { apiKey: prepared.apiKey, guard: prepared.guard, route: prepared.route };
  }
  const poller = createGlmQuotaPoller({
    resolve: id => withSettingsFileLock(deps.settingsPath, async () => context((await loadSettings(deps.settingsPath)).settings, id)),
    fetch: deps.fetch,
    record: async (id, guard, quota) => {
      if (!quota) return;
      await recordConnectionQuota({ settingsPath: deps.settingsPath }, id, quota, GLM_QUOTA_SOURCE, deps.onPersisted,
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

import { createHmac, randomBytes } from "node:crypto";
import { hostForkProxyChain, proxyProfileSecretKey, resolveProxyLadder, type SystemProxyResolver } from "../shared/proxy.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import { resolveProxyRoute, type ProxyRoute } from "./provider-proxy-fetch.js";

const guardKey = randomBytes(32);
type VaultReader = { getSecretValue(key: SecretKey): Promise<string | undefined> };

/**
 * Resolve one immutable request context without consulting process-wide proxy
 * caches.
 *
 * Every proxy mode is resolved by the SAME `resolveProxyRoute`, `system`
 * included: a `system` profile asks the injected resolver for this exact
 * target and yields a proxy or a direct answer by the usual law. Because that
 * answer is not a cache entry, a system route that changes between this
 * resolution and the post-fetch re-check shows up as `stale_fetch`, which the
 * user clears by fetching again.
 */
export async function prepareModelFetchContext(
  settings: AnycodeSettings,
  connection: ProviderConnection,
  vault: VaultReader,
  targetUrl: string,
  systemProxy?: SystemProxyResolver,
): Promise<{ ok: true; apiKey: string | undefined; route: ProxyRoute; guard: string } | { ok: false; reason: "network_error" }> {
  const custom = settings.provider.custom?.find(item => item.id === connection.providerId);
  const chain = hostForkProxyChain(connection.id);
  const rung = resolveProxyLadder(settings, chain);
  const secretKey: SecretKey = custom ? `provider.${custom.id}.apiKey` : `provider.connection.${connection.id}.apiKey`;
  const apiKey = await vault.getSecretValue(secretKey);
  const profileId = rung?.profile?.id;
  // A `system` route carries no vault credential — the OS answer is the whole
  // proxy — so its password slot is never read.
  const proxyPassword = profileId !== undefined && rung?.profile?.mode !== "system"
    ? await vault.getSecretValue(proxyProfileSecretKey(profileId))
    : undefined;
  let route: ProxyRoute;
  try {
    route = await resolveProxyRoute(
      settings,
      chain,
      {
        proxyPassword: id => id === profileId ? proxyPassword : undefined,
        // A `system` answer is keyed by the target, and `resolveProxyForAsync`
        // reads that key from the deps, not from `targetUrl`'s own argument —
        // omitting it would silently materialize every system profile DIRECT.
        targetUrl,
        ...(systemProxy !== undefined ? { systemProxy } : {}),
      },
      targetUrl,
    );
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (route.kind === "misconfigured") return { ok: false, reason: "network_error" };
  const identity = [connection.id, connection.providerId, connection.baseUrl ?? "", connection.transport ?? "", custom?.baseUrl ?? null, custom?.kind ?? null, targetUrl, apiKey ?? null, route];
  const guard = createHmac("sha256", guardKey).update(JSON.stringify(identity)).digest("hex");
  if (route.kind === "proxy") Object.freeze(route.proxy);
  return Object.freeze({ ok: true, apiKey, route: Object.freeze(route), guard });
}

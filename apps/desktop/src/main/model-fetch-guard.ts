import { createHmac, randomBytes } from "node:crypto";
import { hostForkProxyChain, proxyProfileSecretKey, resolveProxyLadder } from "../shared/proxy.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import { resolveProxyRoute, type ProxyRoute } from "./provider-proxy-fetch.js";

const guardKey = randomBytes(32);
type VaultReader = { getSecretValue(key: SecretKey): Promise<string | undefined> };

/** Resolve one immutable request context without consulting process-wide proxy caches. */
export async function prepareModelFetchContext(
  settings: AnycodeSettings,
  connection: ProviderConnection,
  vault: VaultReader,
  targetUrl: string,
): Promise<{ ok: true; apiKey: string | undefined; route: ProxyRoute; guard: string } | { ok: false; reason: "system_proxy_unsupported" | "network_error" }> {
  const custom = settings.provider.custom?.find(item => item.id === connection.providerId);
  const chain = hostForkProxyChain(connection.id);
  const rung = resolveProxyLadder(settings, chain);
  if (rung?.profile?.mode === "system") return { ok: false, reason: "system_proxy_unsupported" };
  const secretKey: SecretKey = custom ? `provider.${custom.id}.apiKey` : `provider.connection.${connection.id}.apiKey`;
  const apiKey = await vault.getSecretValue(secretKey);
  const profileId = rung?.profile?.id;
  const proxyPassword = profileId ? await vault.getSecretValue(proxyProfileSecretKey(profileId)) : undefined;
  let route: ProxyRoute;
  try {
    route = await resolveProxyRoute(settings, chain, { proxyPassword: id => id === profileId ? proxyPassword : undefined }, targetUrl);
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (route.kind === "misconfigured") return { ok: false, reason: "network_error" };
  const identity = [connection.id, connection.providerId, connection.baseUrl ?? "", connection.transport ?? "", custom?.baseUrl ?? null, custom?.kind ?? null, targetUrl, apiKey ?? null, route];
  const guard = createHmac("sha256", guardKey).update(JSON.stringify(identity)).digest("hex");
  if (route.kind === "proxy") Object.freeze(route.proxy);
  return Object.freeze({ ok: true, apiKey, route: Object.freeze(route), guard });
}

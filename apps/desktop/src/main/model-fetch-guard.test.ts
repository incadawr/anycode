import { expect, it } from "vitest";
import type { SystemProxyResolver } from "../shared/proxy.js";
import type { AnycodeSettings, ProviderConnection, SecretKey } from "../shared/settings.js";
import { prepareModelFetchContext } from "./model-fetch-guard.js";

it("tracks the connection key and selected proxy without reading unrelated passwords", async () => {
  const connection = { id: "one", providerId: "vllm", proxyRef: "proxy-one" } as ProviderConnection;
  const settings = { provider: { connections: [connection] }, network: { proxyProfiles: [
    { id: "proxy-one", name: "One", mode: "manual", url: "http://localhost:8080", login: "fixture-user" },
    { id: "proxy-two", name: "Two", mode: "manual", url: "http://localhost:8081" },
  ] } } as AnycodeSettings;
  const values = new Map<string, string>();
  const reads: string[] = [];
  const vault = { async getSecretValue(key: SecretKey) { reads.push(key); return values.get(key); } };
  const getGuard = async () => { const result = await prepareModelFetchContext(settings, connection, vault, "https://model.example/v1/models"); if (!result.ok) throw new Error(result.reason); return result.guard; };
  const initial = await getGuard();
  expect(reads).toEqual(["provider.connection.one.apiKey", "proxy.profile.proxy-one.password"]);
  values.set("proxy.profile.proxy-two.password", "unrelated");
  expect(await getGuard()).toBe(initial);
  values.set("proxy.profile.proxy-one.password", "changed");
  expect(await getGuard()).not.toBe(initial);
  values.delete("proxy.profile.proxy-one.password");
  values.set("provider.connection.one.apiKey", "changed");
  expect(await getGuard()).not.toBe(initial);
});

/**
 * A `system` profile is resolved through the SAME route resolver as every other
 * mode — the OS answer for this exact target decides proxy vs direct. It is NOT
 * refused (that would be a regression: fetching worked with a system proxy
 * before) and the vault is not consulted for a route that carries no stored
 * credential.
 */
it("resolves a system proxy through the injected resolver instead of refusing", async () => {
  const connection = { id: "one", providerId: "vllm", proxyRef: "proxy-system" } as ProviderConnection;
  const settings = { provider: { connections: [connection] }, network: { proxyProfiles: [
    { id: "proxy-system", name: "System", mode: "system" },
    { id: "unrelated", name: "Other", mode: "manual", url: "http://other.test:8080", login: "someone" },
  ] } } as AnycodeSettings;
  const reads: string[] = [];
  const vault = { async getSecretValue(key: SecretKey) { reads.push(key); return "unrelated-secret"; } };
  const asked: string[] = [];
  const resolver: SystemProxyResolver = {
    cached: () => ({ kind: "unresolved" }),
    resolve: async (targetUrl) => { asked.push(targetUrl); return { kind: "proxy", url: "http://system-proxy.test:3128/" }; },
  };

  const result = await prepareModelFetchContext(settings, connection, vault, "https://model.example/v1/models", resolver);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // A PROXY answer is a real proxy route for THIS target...
  expect(result.route).toMatchObject({ kind: "proxy", proxy: { url: "http://system-proxy.test:3128/" } });
  expect(asked).toEqual(["https://model.example/v1/models"]);
  // ...and only the connection's own key was read: no other profile's secret.
  expect(reads).toEqual(["provider.connection.one.apiKey"]);
});

it("takes the direct answer a system resolver gives, without inventing a proxy", async () => {
  const connection = { id: "one", providerId: "vllm", proxyRef: "proxy-system" } as ProviderConnection;
  const settings = { provider: { connections: [connection] }, network: { proxyProfiles: [{ id: "proxy-system", name: "System", mode: "system" }] } } as AnycodeSettings;
  const vault = { async getSecretValue(_key: SecretKey) { return undefined; } };
  const resolver: SystemProxyResolver = { cached: () => ({ kind: "unresolved" }), resolve: async () => ({ kind: "direct" }) };

  const result = await prepareModelFetchContext(settings, connection, vault, "https://example.test/v1/models", resolver);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.route).toEqual({ kind: "direct", why: "system-answer" });
  expect(result.apiKey).toBeUndefined();
});

it("still refuses when no system answer can be taken at all", async () => {
  // A resolver that rejects is a network failure of the route resolution, not a
  // licence to fall back to direct: the caller must retry, not silently egress.
  const connection = { id: "one", providerId: "vllm", proxyRef: "proxy-system" } as ProviderConnection;
  const settings = { provider: { connections: [connection] }, network: { proxyProfiles: [{ id: "proxy-system", name: "System", mode: "system" }] } } as AnycodeSettings;
  const vault = { async getSecretValue(_key: SecretKey) { return undefined; } };
  const resolver: SystemProxyResolver = { cached: () => ({ kind: "unresolved" }), resolve: async () => { throw new Error("resolver down"); } };

  expect(await prepareModelFetchContext(settings, connection, vault, "https://example.test/v1/models", resolver)).toEqual({ ok: false, reason: "network_error" });
});

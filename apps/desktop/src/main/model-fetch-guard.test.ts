import { expect, it } from "vitest";
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

it("fails closed for system proxy without reading unrelated secrets", async () => {
  const connection = { id: "one", providerId: "vllm", proxyRef: "proxy-system" } as ProviderConnection;
  const settings = { provider: { connections: [connection] }, network: { proxyProfiles: [{ id: "proxy-system", name: "System", mode: "system" }] } } as AnycodeSettings;
  const reads: string[] = [];
  const vault = { async getSecretValue(key: SecretKey) { reads.push(key); return undefined; } };
  expect(await prepareModelFetchContext(settings, connection, vault, "https://example.test/v1/models")).toEqual({ ok: false, reason: "system_proxy_unsupported" });
  expect(reads).toEqual([]);
});

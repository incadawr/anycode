/**
 * Unit tests for the TokenBroker + resolveProviderSelection (design
 * slice-2.5-cut.md §3.3/§1). Covers the live-token cache, single-flight refresh
 * (N concurrent callers -> 1 network refresh), rotation persistence, the
 * revoked-vs-transient refresh-failure split, and the catalog selection matrix
 * (legacy/unknown/api_key/custom/oauth).
 */

import { describe, expect, it, vi } from "vitest";
import type { AnycodeSettings } from "../shared/settings.js";
import { providerV2, type SingletonFixture } from "../shared/provider-v2-fixture.js";
import type { FetchLike, OAuthProviderConfig } from "./oauth.js";
import {
  TokenBroker,
  resolveProviderSelection,
  type CatalogSelectionInfo,
  type TokenBrokerVault,
} from "./token-broker.js";
import type { OAuthTokenBlob } from "./vault.js";

/** In-memory TokenBrokerVault. */
class FakeVault implements TokenBrokerVault {
  store = new Map<string, OAuthTokenBlob>();
  cleared: string[] = [];
  async getOAuthTokens(providerId: string): Promise<OAuthTokenBlob | undefined> {
    return this.store.get(providerId);
  }
  async setOAuthTokens(providerId: string, blob: OAuthTokenBlob): Promise<{ ok: boolean }> {
    this.store.set(providerId, blob);
    return { ok: true };
  }
  async clearOAuthTokens(providerId: string): Promise<void> {
    this.cleared.push(providerId);
    this.store.delete(providerId);
  }
}

const CONFIG: OAuthProviderConfig = {
  providerId: "acme",
  authorizationUrl: "https://idp/authorize",
  tokenUrl: "https://idp/token",
  clientId: "client-123",
  scopes: ["a"],
};

/** A fetch fake returning a JSON body with a call counter + optional status. */
function fetchFake(opts: { status?: number; json?: unknown } = {}): { fn: FetchLike; calls: () => number; lastBody: () => Record<string, string> } {
  let calls = 0;
  let lastBody: Record<string, string> = {};
  const fn: FetchLike = async (_url, init) => {
    calls += 1;
    lastBody = Object.fromEntries(new URLSearchParams(init.body));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => opts.json ?? { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 },
    };
  };
  return { fn, calls: () => calls, lastBody: () => lastBody };
}

describe("TokenBroker.getAccessToken — live cache", () => {
  it("returns the cached token while it is still valid (no refresh)", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-live", refreshToken: "rt", expiresAt: 10_000_000 });
    const fetchRig = fetchFake();
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });
    expect(await broker.getAccessToken("acme", "acme")).toBe("at-live");
    expect(fetchRig.calls()).toBe(0);
  });

  it("returns undefined when not signed in", async () => {
    const vault = new FakeVault();
    const broker = new TokenBroker({ vault, resolveConfig: () => CONFIG, allowWeak: () => false });
    expect(await broker.getAccessToken("acme", "acme")).toBeUndefined();
  });
});

describe("TokenBroker.getAccessToken — refresh + rotation", () => {
  it("refreshes an expired token, returns the fresh one, and persists the rotation", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-old", expiresAt: 500 });
    const fetchRig = fetchFake();
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });

    const token = await broker.getAccessToken("acme", "acme");
    expect(token).toBe("at-new");
    expect(fetchRig.calls()).toBe(1);
    // The refresh_token grant was used.
    expect(fetchRig.lastBody().grant_type).toBe("refresh_token");
    expect(fetchRig.lastBody().refresh_token).toBe("rt-old");
    // The rotated blob is persisted (survives a respawn).
    expect(vault.store.get("acme")).toEqual({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
  });

  it("keeps the old refresh token when the response omits a new one", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-keep", expiresAt: 500 });
    const fetchRig = fetchFake({ json: { access_token: "at-2", expires_in: 100 } });
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 0,
    });
    await broker.getAccessToken("acme", "acme");
    expect(vault.store.get("acme")?.refreshToken).toBe("rt-keep");
  });

  it("is single-flight: 2 concurrent callers trigger exactly 1 refresh", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-old", expiresAt: 500 });
    const fetchRig = fetchFake();
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });

    const [a, b] = await Promise.all([broker.getAccessToken("acme", "acme"), broker.getAccessToken("acme", "acme")]);
    expect(a).toBe("at-new");
    expect(b).toBe("at-new");
    expect(fetchRig.calls()).toBe(1);
  });

  it("allows a fresh refresh after the in-flight one settles", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-old", expiresAt: 500 });
    // The rotated blob is again expired under this clock, so a second call refreshes anew.
    const fetchRig = fetchFake({ json: { access_token: "at-x", refresh_token: "rt-x", expires_in: 0 } });
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });
    await broker.getAccessToken("acme", "acme");
    await broker.getAccessToken("acme", "acme");
    expect(fetchRig.calls()).toBe(2);
  });
});

describe("TokenBroker.getAccessToken — refresh failure", () => {
  it("revoked (4xx) clears the entry so the UI prompts a fresh sign-in", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-old", expiresAt: 500 });
    const fetchRig = fetchFake({ status: 400, json: { error: "invalid_grant" } });
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });
    expect(await broker.getAccessToken("acme", "acme")).toBeUndefined();
    expect(vault.cleared).toEqual(["acme"]);
    expect(vault.store.has("acme")).toBe(false);
  });

  it("a transient (5xx) failure does NOT clear the entry", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "rt-old", expiresAt: 500 });
    const fetchRig = fetchFake({ status: 503, json: {} });
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
      logger: { warn: vi.fn() },
    });
    expect(await broker.getAccessToken("acme", "acme")).toBeUndefined();
    expect(vault.cleared).toEqual([]);
    expect(vault.store.has("acme")).toBe(true);
  });

  it("returns undefined without a refresh when the blob has no refresh token", async () => {
    const vault = new FakeVault();
    vault.store.set("acme", { accessToken: "at-old", refreshToken: "", expiresAt: 500 });
    const fetchRig = fetchFake();
    const broker = new TokenBroker({
      vault,
      resolveConfig: () => CONFIG,
      allowWeak: () => false,
      fetchFn: fetchRig.fn,
      now: () => 1_000_000,
    });
    expect(await broker.getAccessToken("acme", "acme")).toBeUndefined();
    expect(fetchRig.calls()).toBe(0);
  });
});

describe("resolveProviderSelection — catalog selection matrix", () => {
  function settings(singleton: SingletonFixture = {}): AnycodeSettings {
    return {
      version: 2,
      provider: providerV2(singleton),
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
  }
  const catalog: Record<string, CatalogSelectionInfo> = {
    "z-ai": { baseUrl: "https://api.z.ai/api/anthropic", authKind: "api_key", isCustom: false },
    custom: { baseUrl: "", authKind: "api_key", isCustom: true },
    subd: { baseUrl: "https://sub/anthropic", authKind: "oauth", isCustom: false },
    vllm: {
      baseUrl: "",
      authKind: "api_key",
      isCustom: false,
      needsBaseUrl: true,
      defaultTransport: "openai-chat-completions",
      supportedTransports: ["openai-chat-completions"],
    },
  };
  // TASK.45 v2: the api-key read is keyed by CONNECTION id (`conn-<providerId>`
  // for the fixture); the access token is minted per connection too.
  const deps = (s: AnycodeSettings) => ({
    settings: s,
    resolveCatalog: (id: string) => catalog[id],
    getApiKey: async (connectionId: string) => `key-${connectionId}`,
    getAccessToken: async (connectionId: string) => `oauth-token-${connectionId}`,
  });

  it("legacy: no active connection -> undefined (buildHostEnv takes the 2.2 path)", async () => {
    expect(await resolveProviderSelection(deps(settings()))).toBeUndefined();
  });

  it("unknown id -> undefined (legacy fallback)", async () => {
    expect(await resolveProviderSelection(deps(settings({ id: "nope" })))).toBeUndefined();
  });

  it("api_key catalog provider: baseUrl from catalog, apiKey from the connection key", async () => {
    const sel = await resolveProviderSelection(deps(settings({ id: "z-ai", model: "glm-4.6" })));
    expect(sel).toEqual({
      baseUrl: "https://api.z.ai/api/anthropic",
      model: "glm-4.6",
      apiKey: "key-conn-z-ai",
      authKind: "api_key",
    });
  });

  it("custom provider -> undefined: folds into the legacy 2.2 path (ruling §7-R6)", async () => {
    // Custom uses the bare `provider.apiKey` vault key + connection baseUrl/model,
    // exactly like "no selection" — buildHostEnv's legacy branch reads the active
    // connection's key, matching the renderer's providerSecretKey. Returning a
    // selection here would desync the key the UI writes from the key the fork reads.
    const sel = await resolveProviderSelection(deps(settings({ id: "custom", baseUrl: "https://my/endpoint", model: "m" })));
    expect(sel).toBeUndefined();
  });

  it("oauth provider: credential is the broker access token, authKind oauth", async () => {
    const sel = await resolveProviderSelection(deps(settings({ id: "subd", model: "m" })));
    expect(sel).toEqual({
      baseUrl: "https://sub/anthropic",
      model: "m",
      apiKey: "oauth-token-conn-subd",
      authKind: "oauth",
    });
  });

  describe("needsBaseUrl (TASK.43 W5): a non-custom template entry (vLLM) still sources baseUrl from the connection", () => {
    it("substitutes the connection's baseUrl for a needsBaseUrl entry, unlike isCustom's bypass-to-legacy", async () => {
      const sel = await resolveProviderSelection(
        deps(settings({ id: "vllm", model: "m", baseUrl: "http://localhost:8000/v1" })),
      );
      // Unlike "custom" above, vllm does NOT return undefined — it keeps its
      // own per-provider connection key + catalog defaults; only the baseUrl comes
      // from the connection.
      expect(sel).toEqual({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
        apiKey: "key-conn-vllm",
        authKind: "api_key",
        defaultTransport: "openai-chat-completions",
      });
    });
  });

  describe("transport projection (TASK.43 W5-FIX): resolveProviderSelection carries the RAW catalog default, never the resolved ladder", () => {
    // A dedicated fixture (not "z-ai" above) so this describe block's assertions
    // never perturb the pre-existing exact-`toEqual` tests elsewhere in this file.
    const transportCatalog: Record<string, CatalogSelectionInfo> = {
      ...catalog,
      gw: {
        baseUrl: "https://gw.example/anthropic",
        authKind: "api_key",
        isCustom: false,
        defaultTransport: "anthropic-messages",
        supportedTransports: ["anthropic-messages", "openai-chat-completions"],
      },
    };
    const transportDeps = (s: AnycodeSettings) => ({ ...deps(s), resolveCatalog: (id: string) => transportCatalog[id] });

    it("surfaces the catalog entry's defaultTransport when settings carries none", async () => {
      const sel = await resolveProviderSelection(transportDeps(settings({ id: "gw", model: "m" })));
      expect(sel?.defaultTransport).toBe("anthropic-messages");
    });

    it("still surfaces the RAW catalog defaultTransport even when settings.provider.transport is set (the env>settings>default ladder is applied downstream by buildHostEnv, not here)", async () => {
      const sel = await resolveProviderSelection(
        transportDeps(settings({ id: "gw", model: "m", transport: "openai-chat-completions" })),
      );
      expect(sel?.defaultTransport).toBe("anthropic-messages");
    });
  });

  describe("active-connection model (TASK.45 v2: no defaults folding)", () => {
    it("carries the active connection's model straight through (no defaults lookup)", async () => {
      const sel = await resolveProviderSelection(deps(settings({ id: "z-ai", model: "connection-model" })));
      expect(sel?.model).toBe("connection-model");
    });

    it("also carries the connection model for an oauth provider", async () => {
      const sel = await resolveProviderSelection(deps(settings({ id: "subd", model: "connection-model" })));
      expect(sel).toEqual({
        baseUrl: "https://sub/anthropic",
        model: "connection-model",
        apiKey: "oauth-token-conn-subd",
        authKind: "oauth",
      });
    });
  });
});

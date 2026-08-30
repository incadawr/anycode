/**
 * Unit tests for host-env composition + the env-scrub primitives (design §6/§1

 * (env > vault > settings), envOverrides, the readiness matrix, and the
 * snapshot/scrub discipline (bootEnv retains the key, live env is scrubbed, the
 * host fork still gets the key, a simulated Bash child does not).
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings, SecretKey } from "../shared/settings.js";
import {
  ENV_INCLUDE_USAGE,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_PROVIDER_TRANSPORT,
  ENV_REASONING_EFFORT,
  applyCodexProfilesHomeOverride,
  applyConnectionProxy,
  applySubagentsHomeOverride,
  buildHostEnv,
  computeProviderReady,
  customKindDefaultTransport,
  customProviderIds,
  customProviderSecretKey,
  customSupportedTransports,
  engineProxyCarrierValue,
  engineProxyCarriers,
  envOverrides,
  findCustomProviderRecord,
  isCustomProviderRecordId,
  isKnownSecretKey,
  materializeProxyRung,
  resolveEffectiveTransport,
  resolveProxyFor,
  scrubSecretEnv,
  secretEnvFor,
  shouldSkipConnectionHealthBinding,
  snapshotBootEnv,
  type ProxyMaterializationDeps,
} from "./host-env.js";
import {
  hostForkProxyChain,
  proxyProfileSecretKey,
  resolveProxyLadder,
  PROXY_REF_DIRECT,
  type ProxyProfile,
  type SystemProxyOutcome,
  type SystemProxyResolver,
} from "../shared/proxy.js";
import {
  applyEngineProxyOverride,
  decodeEngineProxyCarrier,
  encodeEngineProxyCarrier,
  LOOPBACK_NO_PROXY,
  PROXY_CARRIER_DIRECT,
} from "../shared/engines.js";
import { resolveProviderSelection, type ProviderSelectionDeps } from "./token-broker.js";
import { connectionFixture, providerV2, providerV2Multi, type SingletonFixture } from "../shared/provider-v2-fixture.js";

/**
 * A v2 settings object whose `provider` block is built from a legacy-singleton
 * description (TASK.45 fixture): `settings({ provider: { id, model, ... } })`
 * yields ONE active connection so `activeProviderView` reads it back as the
 * former singleton. Every other section can be overridden via `over`.
 */
type SettingsOver = Partial<Omit<AnycodeSettings, "provider" | "version">> & { provider?: SingletonFixture };

function settings(over: SettingsOver = {}): AnycodeSettings {
  const { provider, ...rest } = over;
  return {
    version: 2,
    provider: providerV2(provider ?? {}),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...rest,
  };
}

const noSecret = async (_key: SecretKey): Promise<string | undefined> => undefined;
const vaultSecret = (value: string) => async (_key: SecretKey): Promise<string | undefined> => value;

describe("buildHostEnv — I2 priority (env > vault > settings)", () => {
  it("env wins over the vault for the API key", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_API_KEY: "sk-env" },
      settings: settings(),
      getSecret: vaultSecret("sk-vault"),
    });
    expect(env.ANYCODE_API_KEY).toBe("sk-env");
  });

  it("falls back to the vault when env has no API key", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings(),
      getSecret: vaultSecret("sk-vault"),
    });
    expect(env.ANYCODE_API_KEY).toBe("sk-vault");
  });

  it("env wins over settings for the model; settings fills the gap otherwise", async () => {
    const withEnv = await buildHostEnv({
      bootEnv: { ANYCODE_MODEL: "env-model" },
      settings: settings({ provider: { model: "settings-model" } }),
      getSecret: noSecret,
    });
    expect(withEnv.ANYCODE_MODEL).toBe("env-model");

    const withSettings = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { model: "settings-model", baseUrl: "https://x" } }),
      getSecret: noSecret,
    });
    expect(withSettings.ANYCODE_MODEL).toBe("settings-model");
    expect(withSettings.ANYCODE_BASE_URL).toBe("https://x");
  });

  it("projects numeric tools settings as strings", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ tools: { concurrency: 4, stallTimeoutMs: 9000, maxTurns: 100 } }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_TOOL_CONCURRENCY).toBe("4");
    expect(env.ANYCODE_STALL_TIMEOUT_MS).toBe("9000");
    expect(env.ANYCODE_MAX_TURNS).toBe("100");
  });

  it("carries the rest of the boot env through untouched (PATH etc.)", async () => {
    const env = await buildHostEnv({
      bootEnv: { PATH: "/usr/bin", ANYCODE_WORKSPACE: "/ws" },
      settings: settings(),
      getSecret: noSecret,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANYCODE_WORKSPACE).toBe("/ws");
  });

  it("leaves the API key unset when neither env nor vault has one", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env.ANYCODE_API_KEY).toBeUndefined();
  });
});

describe("buildHostEnv — catalog selection path (slice 2.5)", () => {
  it("materialises the catalog baseUrl/model/credential for an api_key provider", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://api.z.ai/api/anthropic",
        model: "glm-4.6",
        apiKey: "sk-provider",
        authKind: "api_key",
      }),
    });
    expect(env.ANYCODE_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANYCODE_MODEL).toBe("glm-4.6");
    expect(env.ANYCODE_API_KEY).toBe("sk-provider");
    // ANYCODE_AUTH_MODE is set ONLY for oauth providers.
    expect(env.ANYCODE_AUTH_MODE).toBeUndefined();
  });

  it("sets ANYCODE_AUTH_MODE=oauth and the access token as the key for an oauth provider", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://provider/anthropic",
        model: "m",
        apiKey: "oauth-access-token",
        authKind: "oauth",
      }),
    });
    expect(env.ANYCODE_AUTH_MODE).toBe("oauth");
    expect(env.ANYCODE_API_KEY).toBe("oauth-access-token");
  });

  it("env still wins over the catalog selection (I2 unchanged)", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_API_KEY: "sk-env", ANYCODE_BASE_URL: "https://env", ANYCODE_MODEL: "env-model" },
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://catalog",
        model: "catalog-model",
        apiKey: "catalog-key",
        authKind: "oauth",
      }),
    });
    expect(env.ANYCODE_API_KEY).toBe("sk-env");
    expect(env.ANYCODE_BASE_URL).toBe("https://env");
    expect(env.ANYCODE_MODEL).toBe("env-model");
    // The oauth flag is still set even when env overrides the token.
    expect(env.ANYCODE_AUTH_MODE).toBe("oauth");
  });

  it("resolveSelection returning undefined falls back to the byte-for-byte legacy path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { model: "settings-model", baseUrl: "https://legacy" } }),
      getSecret: vaultSecret("sk-vault"),
      resolveSelection: async () => undefined,
    });
    expect(env.ANYCODE_API_KEY).toBe("sk-vault");
    expect(env.ANYCODE_MODEL).toBe("settings-model");
    expect(env.ANYCODE_BASE_URL).toBe("https://legacy");
    expect(env.ANYCODE_AUTH_MODE).toBeUndefined();
  });
});

describe("buildHostEnv — active-connection model/effort (TASK.45 v2, F14 §2.4)", () => {
  // W9′: the v1 `defaults[pid]` fold is gone — the active connection carries
  // model/reasoningEffort directly, and buildHostEnv reads them via
  // `activeProviderView`. These prove the ladder OUTPUT is unchanged.
  it("legacy/custom path: emits the active connection's model", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { model: "persisted-model" } }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_MODEL).toBe("persisted-model");
  });

  it("sets ANYCODE_REASONING_EFFORT from the active connection on the legacy/custom path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { reasoningEffort: "high" } }),
      getSecret: noSecret,
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("high");
  });

  it("reads the effort off the active connection even when the id names a catalog provider", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", reasoningEffort: "max" } }),
      getSecret: noSecret,
      resolveSelection: async () => undefined, // legacy branch (e.g. custom/no-catalog)
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("max");
  });

  it("sets ANYCODE_REASONING_EFFORT on the catalog selection path too (from the active connection)", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", reasoningEffort: "high" } }),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://api.z.ai/api/anthropic",
        model: "glm-4.6",
        apiKey: "sk-provider",
        authKind: "api_key",
      }),
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("high");
  });

  it("env still wins over the persisted effort (I2 unchanged)", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_REASONING_EFFORT: "low" },
      settings: settings({ provider: { reasoningEffort: "max" } }),
      getSecret: noSecret,
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("low");
  });

  it("leaves ANYCODE_REASONING_EFFORT unset when the active connection persists no effort (no hardcoded literal)", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env[ENV_REASONING_EFFORT]).toBeUndefined();
  });

  it("a fresh install (no active connection) emits neither model nor effort (backward-compat)", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { model: "settings-model" } }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_MODEL).toBe("settings-model");
    expect(env[ENV_REASONING_EFFORT]).toBeUndefined();
  });
});

describe("buildHostEnv — ANYCODE_MAX_OUTPUT_TOKENS (TASK.150)", () => {
  it("emits the active connection's explicit output-token ceiling", async () => {
    const conn = { ...connectionFixture({ id: "z-ai", model: "m" }), maxOutputTokens: 65536 };
    const env = await buildHostEnv({
      bootEnv: {},
      settings: { ...settings(), provider: providerV2Multi(conn.id, [conn]) },
      getSecret: noSecret,
    });
    expect(env[ENV_MAX_OUTPUT_TOKENS]).toBe("65536");
  });

  it("leaves it unset when the active connection persists no ceiling (no hardcoded literal)", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", model: "m" } }),
      getSecret: noSecret,
    });
    expect(env[ENV_MAX_OUTPUT_TOKENS]).toBeUndefined();
  });

  it("env still wins over the persisted ceiling (I2 unchanged) — settings never overwrites a present value", async () => {
    const conn = { ...connectionFixture({ id: "z-ai", model: "m" }), maxOutputTokens: 65536 };
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_MAX_OUTPUT_TOKENS: "8192" },
      settings: { ...settings(), provider: providerV2Multi(conn.id, [conn]) },
      getSecret: noSecret,
    });
    expect(env[ENV_MAX_OUTPUT_TOKENS]).toBe("8192");
  });
});

describe("buildHostEnv — ANYCODE_PROVIDER_TRANSPORT (TASK.43 W5)", () => {
  it("fills the transport from settings.provider.transport on the legacy/custom path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { model: "m", baseUrl: "https://x", transport: "openai-chat-completions" } }),
      getSecret: noSecret,
    });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-chat-completions");
  });

  it("fills the transport from the resolved selection's (non-anthropic) catalog default on the catalog path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1",
        apiKey: "sk-openai",
        authKind: "api_key",
        defaultTransport: "openai-responses",
      }),
    });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-responses");
  });

  it("env still wins over both the legacy and catalog transport fills (I2 unchanged)", async () => {
    const legacy = await buildHostEnv({
      bootEnv: { [ENV_PROVIDER_TRANSPORT]: "anthropic-messages" },
      settings: settings({ provider: { transport: "openai-chat-completions" } }),
      getSecret: noSecret,
    });
    expect(legacy[ENV_PROVIDER_TRANSPORT]).toBe("anthropic-messages");

    const catalog = await buildHostEnv({
      bootEnv: { [ENV_PROVIDER_TRANSPORT]: "anthropic-messages" },
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1",
        apiKey: "sk-openai",
        authKind: "api_key",
        defaultTransport: "openai-responses",
      }),
    });
    expect(catalog[ENV_PROVIDER_TRANSPORT]).toBe("anthropic-messages");
  });

  it("leaves the var unset when neither env, settings, nor the selection carries a transport", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBeUndefined();
  });
});

describe("buildHostEnv — ANYCODE_PROVIDER_TRANSPORT emission rule (TASK.43 W5-FIX, cut Risk #3)", () => {
  // The REAL production seam: main wires `resolveSelection = () =>
  // resolveProviderSelection(...)` and feeds it to buildHostEnv. This exercises
  // that seam end-to-end so the fork-env byte-parity fix is proven where it lives.
  const anthropicFamilyDeps = (s: AnycodeSettings): ProviderSelectionDeps => ({
    settings: s,
    resolveCatalog: (id) =>
      id === "z-ai"
        ? {
            baseUrl: "https://api.z.ai/api/anthropic",
            authKind: "api_key",
            isCustom: false,
            defaultTransport: "anthropic-messages",
            supportedTransports: ["anthropic-messages"],
          }
        : undefined,
    getApiKey: async () => "sk-glm",
    getAccessToken: async () => undefined,
  });

  it("anthropic-family catalog default with UNSET settings.transport leaves the var ABSENT (pre-W5 fork-env byte parity)", async () => {
    const s = settings({ provider: { id: "z-ai", model: "glm-4.6" } });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: s,
      getSecret: noSecret,
      resolveSelection: () => resolveProviderSelection(anthropicFamilyDeps(s)),
    });
    // Pre-W5-FIX this injected ANYCODE_PROVIDER_TRANSPORT=anthropic-messages
    // (settings.transport ?? defaultTransport), breaking anthropic/GLM fork-env
    // byte-compat. An implicit anthropic-family default must emit NOTHING.
    expect(env[ENV_PROVIDER_TRANSPORT]).toBeUndefined();
  });

  it("an explicit settings.provider.transport still wins over an anthropic-family catalog default in the fork env", async () => {
    const s = settings({ provider: { id: "z-ai", model: "glm-4.6", transport: "openai-chat-completions" } });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: s,
      getSecret: noSecret,
      resolveSelection: () => resolveProviderSelection(anthropicFamilyDeps(s)),
    });
    // The user opted in explicitly (source "settings") — that IS emitted, unlike
    // the implicit default above. Proves the ladder moved intact to buildHostEnv.
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-chat-completions");
  });
});

describe("buildHostEnv — custom-provider route (F-G-B, cut §9.2)", () => {
  /** Vault fake that records EVERY key it is asked for (custody assertions below). */
  function recordingVault(secrets: Record<string, string>) {
    const reads: string[] = [];
    const getSecret = async (key: SecretKey): Promise<string | undefined> => {
      reads.push(key);
      return secrets[key];
    };
    return { getSecret, reads };
  }

  /** Settings with ONE active connection at `custom:abc` + its custom record (unless `record: false`). */
  function customSettings(over: { record?: boolean; kind?: "openai-compatible" | "anthropic" | "openai"; transport?: "anthropic-messages" | "openai-chat-completions" | "openai-responses"; connectionBaseUrl?: string } = {}): AnycodeSettings {
    const s = settings({
      provider: {
        id: "custom:abc",
        model: "my-model",
        ...(over.transport !== undefined ? { transport: over.transport } : {}),
        ...(over.connectionBaseUrl !== undefined ? { baseUrl: over.connectionBaseUrl } : {}),
      },
    });
    if (over.record !== false) {
      s.provider.custom = [
        {
          id: "custom:abc",
          name: "My endpoint",
          baseUrl: "https://llm.example.com/v1",
          kind: over.kind ?? "openai-compatible",
          models: ["my-model"],
        },
      ];
    }
    return s;
  }

  it("RED-PROOF (a): a custom:* connection carries the RECORD's baseUrl and the per-provider vault secret — never the legacy/connection credential", async () => {
    const vault = recordingVault({ "provider.custom:abc.apiKey": "sk-custom" });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: customSettings(),
      getSecret: vault.getSecret,
      // A rollback to the legacy branch would take THIS credential (the active
      // connection's key) and an EMPTY baseUrl — both asserts below go red.
      resolveActiveCredential: async () => "sk-connection",
    });
    expect(env.ANYCODE_BASE_URL).toBe("https://llm.example.com/v1");
    expect(env.ANYCODE_API_KEY).toBe("sk-custom");
    expect(env.ANYCODE_MODEL).toBe("my-model");
    // Custom providers are api_key by construction — never the oauth flag.
    expect(env.ANYCODE_AUTH_MODE).toBeUndefined();
    expect(vault.reads).toContain("provider.custom:abc.apiKey");
  });

  it("the record's baseUrl wins VERBATIM even when the connection carries its own baseUrl", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: customSettings({ connectionBaseUrl: "https://connection-level.example.com" }),
      getSecret: recordingVault({ "provider.custom:abc.apiKey": "sk-custom" }).getSecret,
    });
    expect(env.ANYCODE_BASE_URL).toBe("https://llm.example.com/v1");
  });

  it("ONE shared provider key serves every connection of the provider — the connection-scoped key namespace is never consulted", async () => {
    const vault = recordingVault({ "provider.custom:abc.apiKey": "sk-custom" });
    const s = customSettings();
    // Second connection of the SAME custom provider, made active: still the
    // one `provider.custom:abc.apiKey` (design §9.2 — key per provider, not
    // per connection).
    s.provider.connections.push({ id: "conn-second", providerId: "custom:abc", model: "my-model" });
    s.provider.activeConnectionId = "conn-second";
    const env = await buildHostEnv({ bootEnv: {}, settings: s, getSecret: vault.getSecret });
    expect(env.ANYCODE_API_KEY).toBe("sk-custom");
    expect(vault.reads).toContain("provider.custom:abc.apiKey");
    expect(vault.reads.filter((key) => key.startsWith("provider.connection."))).toEqual([]);
  });

  it("RED-PROOF (b): a DELETED record fails closed — keyless, baseUrl-less, and NEITHER the bare legacy key NOR the connection credential is ever read", async () => {
    const vault = recordingVault({ "provider.apiKey": "sk-legacy" });
    let activeCredentialCalls = 0;
    const env = await buildHostEnv({
      bootEnv: {},
      settings: customSettings({ record: false }),
      getSecret: vault.getSecret,
      // Restoring the legacy fallback would call this (or the bare
      // `provider.apiKey` read) and boot the fork on ANOTHER account's
      // credential — every assert below goes red against that.
      resolveActiveCredential: async () => {
        activeCredentialCalls += 1;
        return "sk-connection";
      },
    });
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_BASE_URL).toBeUndefined();
    expect(vault.reads).not.toContain("provider.apiKey");
    expect(activeCredentialCalls).toBe(0);
    // The custom route is decided by the id PREFIX, so the deleted-record case
    // must not have fallen through to resolveSelection/legacy either: the only
    // vault read permitted at all is the provider's own (absent) key.
    expect(vault.reads.every((key) => key === "provider.custom:abc.apiKey")).toBe(true);
  });

  it("kind 'openai-compatible' mirrors the openrouter/vllm-family default: ANYCODE_PROVIDER_TRANSPORT=openai-chat-completions", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: customSettings(), getSecret: noSecret });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-chat-completions");
  });

  it("kind 'openai' mirrors the builtin openai entry's default: openai-responses", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: customSettings({ kind: "openai" }), getSecret: noSecret });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-responses");
  });

  it("kind 'anthropic' mirrors the anthropic-family emission rule: the var stays ABSENT", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: customSettings({ kind: "anthropic" }), getSecret: noSecret });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBeUndefined();
  });

  it("an explicit connection transport still wins over the kind-implied default (same ladder as builtin entries)", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: customSettings({ transport: "openai-responses" }),
      getSecret: noSecret,
    });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBe("openai-responses");
  });

  it("the builtin `custom` SENTINEL (bare literal, no colon) keeps the legacy branch untouched", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "custom", model: "m", baseUrl: "https://legacy-base.example.com" } }),
      getSecret: noSecret,
      resolveActiveCredential: async () => "sk-connection",
    });
    // The prefix check must not overreach onto the sentinel: connection
    // baseUrl + connection credential, byte-for-byte the pre-F-G-B path.
    expect(env.ANYCODE_BASE_URL).toBe("https://legacy-base.example.com");
    expect(env.ANYCODE_API_KEY).toBe("sk-connection");
  });
});

describe("buildHostEnv — connection proxy (TASK.132)", () => {
  /** Carries `user:pass@` userinfo on purpose — the authenticated-proxy case the field exists for. */
  const PROXY = "http://user:pass@proxy.example.com:3128";
  const SHELL_PROXY = "http://shell-proxy.internal:8080";
  /** The COMPLETE env surface `applyConnectionProxy` may ever touch — the byte-identity guarantee is asserted over exactly this set. */
  const PROXY_KEYS = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ] as const;

  it("emits the whole family, the loopback NO_PROXY and NODE_USE_ENV_PROXY for a proxied connection", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    // Verbatim, userinfo intact — a re-encoded or stripped credential would
    // authenticate against the proxy differently than the shell export does.
    expect(env.HTTPS_PROXY).toBe(PROXY);
    expect(env.HTTP_PROXY).toBe(PROXY);
    expect(env.https_proxy).toBe(PROXY);
    expect(env.http_proxy).toBe(PROXY);
    // Both IPv6 spellings: a bare `::1` parses as host `:` port `1` under
    // undici's `host:port` split and matches nothing — measured on Electron 43,
    // `http://[::1]:PORT` still reached the proxy with `::1` alone. Dropping
    // `[::1]` here silently un-exempts every IPv6 loopback endpoint.
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,[::1],::1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,[::1],::1");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  // Byte-identity guarantee #1: a shell that already exports a proxy sees the
  // EXACT pre-TASK.132 env — the vars ride the {...bootEnv} spread and stay as
  // inert as they were, because NODE_USE_ENV_PROXY is never added unprompted.
  it("with no connection proxy, a shell-exported proxy is passed through untouched and NODE_USE_ENV_PROXY is NOT added", async () => {
    const env = await buildHostEnv({
      bootEnv: { HTTPS_PROXY: SHELL_PROXY },
      settings: settings({ provider: { id: "z-ai", model: "m" } }),
      getSecret: noSecret,
    });
    expect(env.HTTPS_PROXY).toBe(SHELL_PROXY);
    for (const key of PROXY_KEYS.filter((k) => k !== "HTTPS_PROXY")) {
      expect(env[key]).toBeUndefined();
    }
  });

  // Byte-identity guarantee #2: nothing at all on a clean env.
  it("with no connection proxy and a clean boot env, not one proxy var is emitted", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", model: "m" } }),
      getSecret: noSecret,
    });
    for (const key of PROXY_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  // Family-ATOMIC env-wins. Per-var `fillFromSettings` would fill the three
  // vars the shell left blank, and the settings value would then beat the
  // shell's `HTTPS_PROXY` under lowercase-first precedence — reverting to a
  // per-var fill turns this red on `http_proxy`/`https_proxy`.
  //
  // CHANGED BY DESIGN REVIEW B-01. This test used to pin the opposite of the
  // owner's rule: it asserted that a shell-owned family STILL got `NO_PROXY`
  // plus `NODE_USE_ENV_PROXY=1` from settings. Both of those are emissions, and
  // "the shell owns the family ⇒ settings emit NOTHING" admits none: writing
  // `NO_PROXY` rewrites the shell's exemption list, and `NODE_USE_ENV_PROXY=1`
  // switches the host's own fetch onto the shell's proxy — neither was asked
  // for. The named cost is that the host's fetch goes direct here, exactly as it
  // did before TASK.132; a shell wanting otherwise exports NODE_USE_ENV_PROXY
  // itself.
  it("B-01: a shell-set HTTPS_PROXY makes settings emit NOTHING — not even the exemption or the flag", async () => {
    const env = await buildHostEnv({
      bootEnv: { HTTPS_PROXY: SHELL_PROXY },
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    expect(env.HTTPS_PROXY).toBe(SHELL_PROXY);
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });

  // The same early return, reached through each of the other three spellings —
  // the gate is the FAMILY, not one variable.
  it("B-01: any one of the four family names is enough to silence the settings", async () => {
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const) {
      const env = await buildHostEnv({
        bootEnv: { [name]: SHELL_PROXY },
        settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
        getSecret: noSecret,
      });
      expect(env[name]).toBe(SHELL_PROXY);
      expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
      expect(env.NO_PROXY).toBeUndefined();
    }
  });

  // The exemption list is atomic too, and for a sharper reason than the family:
  // undici resolves `no_proxy` BEFORE `NO_PROXY`, so filling the lowercase twin
  // beside a shell-set uppercase one SHADOWS the user's exemptions entirely.
  // Measured on Electron 43 — with both keys set this way, a request to the
  // shell-exempted host reached the proxy; with the lowercase key absent it
  // went direct. A per-var fill here turns this red on `no_proxy`.
  it("a shell-set NO_PROXY owns BOTH exemption keys — the lowercase twin must not shadow it", async () => {
    const env = await buildHostEnv({
      bootEnv: { NO_PROXY: "corp.internal" },
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    expect(env.NO_PROXY).toBe("corp.internal");
    expect(env.no_proxy).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe(PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  // Same rule from the other side: a shell that exported only the LOWERCASE
  // key keeps it, and no uppercase default appears next to it.
  it("a shell-set lowercase no_proxy also owns both exemption keys", async () => {
    const env = await buildHostEnv({
      bootEnv: { no_proxy: "corp.internal" },
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    expect(env.no_proxy).toBe("corp.internal");
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe(PROXY);
  });

  // CHANGED BY DESIGN REVIEW B-01, and the change is the whole point of the
  // finding. This used to assert that `HTTPS_PROXY=""` counts as UNSET and lets
  // settings fill the family. Under the owner's rule «the shell wins by family»
  // read literally, `export HTTPS_PROXY=` is a STATEMENT — "this shell wants no
  // proxy for https" — and filling the family behind it overrides an explicit
  // shell decision with a stored one. Declaration, not value, is what the gate
  // reads; every other var in this module keeps the present-AND-non-blank
  // reading (`envPresent`), and that difference has its own predicate
  // (`shellOwnsProxyFamily`) so it cannot be "tidied" back by accident.
  it("B-01: an EMPTY shell family var still counts as declared — settings emit nothing", async () => {
    const env = await buildHostEnv({
      bootEnv: { HTTPS_PROXY: "" },
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    expect(env.HTTPS_PROXY).toBe("");
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });

  // Fail-soft: a hand-edited settings.json (the persisted schema is lenient on
  // purpose) degrades to "no proxy", never to a broken fork env.
  it("a malformed or unsupported-scheme proxyUrl emits nothing at all", async () => {
    for (const bad of ["proxy:3128", "socks5://p", "not a url", "https://"]) {
      const env = await buildHostEnv({
        bootEnv: {},
        settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: bad } }),
        getSecret: noSecret,
      });
      for (const key of PROXY_KEYS) {
        expect(env[key]).toBeUndefined();
      }
    }
  });

  it("a shell-set NODE_USE_ENV_PROXY wins — an explicit 0 is never overwritten to 1", async () => {
    const env = await buildHostEnv({
      bootEnv: { NODE_USE_ENV_PROXY: "0" },
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: PROXY } }),
      getSecret: noSecret,
    });
    expect(env.NODE_USE_ENV_PROXY).toBe("0");
    expect(env.HTTPS_PROXY).toBe(PROXY);
  });

  // Per-tab pin parity: `buildHostEnvFor(settingsPinnedTo(...))` (main/index.ts)
  // only swaps which connection is active, so the proxy must follow the ACTIVE
  // connection and nothing else.
  it("only the ACTIVE connection's proxy is emitted (per-tab pin parity)", async () => {
    const proxied = connectionFixture({ connectionId: "conn-proxied", id: "z-ai", model: "m", proxyUrl: PROXY });
    const direct = connectionFixture({ connectionId: "conn-direct", id: "z-ai", model: "m" });
    const pinnedTo = (activeConnectionId: string): AnycodeSettings => ({
      ...settings(),
      provider: providerV2Multi(activeConnectionId, [proxied, direct]),
    });

    const viaProxied = await buildHostEnv({ bootEnv: {}, settings: pinnedTo("conn-proxied"), getSecret: noSecret });
    expect(viaProxied.HTTPS_PROXY).toBe(PROXY);
    expect(viaProxied.NODE_USE_ENV_PROXY).toBe("1");

    const viaDirect = await buildHostEnv({ bootEnv: {}, settings: pinnedTo("conn-direct"), getSecret: noSecret });
    for (const key of PROXY_KEYS) {
      expect(viaDirect[key]).toBeUndefined();
    }
  });
});

describe("applyConnectionProxy (TASK.132) — the exported env mutator", () => {
  it("is a no-op for an absent or blank materialised proxy", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyConnectionProxy(env, {}, undefined);
    applyConnectionProxy(env, {}, { url: "   " });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  // The boot snapshot is main's long-lived read-only source (ruling §3.3) — a
  // mutator that wrote back into it would corrupt every later fork's env.
  it("never writes into the bootEnv snapshot it reads", () => {
    const bootEnv: NodeJS.ProcessEnv = {};
    const env: NodeJS.ProcessEnv = { ...bootEnv };
    applyConnectionProxy(env, bootEnv, { url: "https://proxy.example.com:8443" });
    expect(bootEnv).toEqual({});
    expect(env.https_proxy).toBe("https://proxy.example.com:8443");
  });
});

describe("custom-provider readiness-gate exports (FX4) — RED against the exports reverting to unexported/private", () => {
  it("customProviderSecretKey mints the SAME per-provider vault key buildHostEnv reads", () => {
    expect(customProviderSecretKey("custom:abc")).toBe("provider.custom:abc.apiKey");
  });

  // W4-R1-M1 belt (defense-in-depth, second layer behind the schema `custom:`
  // refine): a custom-provider vault key must derive ONLY from the `custom:`
  // namespace. A cross-namespace id — a `connection.<victim>` connection key or
  // a bare catalog id — is refused fail-closed, so it can never mint
  // `provider.connection.<victim>.apiKey` / `provider.anthropic.apiKey` and
  // read a foreign namespace's secret. (The renderer-reachable fetch-models
  // exfil path is already closed one layer up by the schema drop; this belt
  // guards the readiness-gate callers in index.ts / settings-ipc.ts.)
  it("W4-R1-M1: customProviderSecretKey refuses a cross-namespace id (throws) — a foreign vault key can never be derived", () => {
    expect(() => customProviderSecretKey("connection.victim")).toThrow();
    expect(() => customProviderSecretKey("anthropic")).toThrow();
    expect(() => customProviderSecretKey("provider.apiKey")).toThrow();
    // The legitimate custom:* namespace still mints exactly as before.
    expect(customProviderSecretKey("custom:abc")).toBe("provider.custom:abc.apiKey");
  });

  it("isCustomProviderRecordId distinguishes a `custom:*` record id from the builtin `custom` sentinel and any catalog id", () => {
    expect(isCustomProviderRecordId("custom:abc")).toBe(true);
    expect(isCustomProviderRecordId("custom")).toBe(false);
    expect(isCustomProviderRecordId("anthropic")).toBe(false);
  });

  it("findCustomProviderRecord finds the record by id and returns undefined once deleted", () => {
    const withRecord = settings({ provider: { id: "custom:abc", model: "m" } });
    withRecord.provider.custom = [
      { id: "custom:abc", name: "My endpoint", baseUrl: "https://llm.example.com/v1", kind: "openai-compatible", models: [] },
    ];
    expect(findCustomProviderRecord(withRecord, "custom:abc")?.baseUrl).toBe("https://llm.example.com/v1");
    expect(findCustomProviderRecord(settings(), "custom:abc")).toBeUndefined();
  });

  it("customKindDefaultTransport mirrors the builtin catalog family defaults per kind", () => {
    expect(customKindDefaultTransport("anthropic")).toBe("anthropic-messages");
    expect(customKindDefaultTransport("openai")).toBe("openai-responses");
    expect(customKindDefaultTransport("openai-compatible")).toBe("openai-chat-completions");
  });

  it("customSupportedTransports mirrors the builtin catalog family's supported-transport list per kind", () => {
    expect(customSupportedTransports("anthropic")).toEqual(["anthropic-messages"]);
    expect(customSupportedTransports("openai")).toEqual(["openai-responses", "openai-chat-completions"]);
    expect(customSupportedTransports("openai-compatible")).toEqual(["openai-chat-completions", "openai-responses"]);
  });
});

describe("resolveEffectiveTransport — the ONE transport ladder authority (TASK.43 W5-FIX)", () => {
  it("nonblank env wins over settings and default (source env)", () => {
    expect(
      resolveEffectiveTransport({
        bootEnv: { [ENV_PROVIDER_TRANSPORT]: "openai-responses" },
        settingsTransport: "openai-chat-completions",
        defaultTransport: "anthropic-messages",
      }),
    ).toEqual({ value: "openai-responses", source: "env" });
  });

  it("a blank/whitespace-only env value is treated as absent (falls through to settings)", () => {
    expect(
      resolveEffectiveTransport({
        bootEnv: { [ENV_PROVIDER_TRANSPORT]: "   " },
        settingsTransport: "openai-chat-completions",
        defaultTransport: "anthropic-messages",
      }),
    ).toEqual({ value: "openai-chat-completions", source: "settings" });
  });

  it("settings wins over the catalog default when env is absent (source settings)", () => {
    expect(
      resolveEffectiveTransport({
        bootEnv: {},
        settingsTransport: "openai-responses",
        defaultTransport: "anthropic-messages",
      }),
    ).toEqual({ value: "openai-responses", source: "settings" });
  });

  it("falls to the catalog default when neither env nor settings selects one (source catalog-default)", () => {
    expect(resolveEffectiveTransport({ bootEnv: {}, defaultTransport: "anthropic-messages" })).toEqual({
      value: "anthropic-messages",
      source: "catalog-default",
    });
  });

  it("is unset when nothing selects a transport (source unset)", () => {
    expect(resolveEffectiveTransport({ bootEnv: {} })).toEqual({ source: "unset" });
  });
});

describe("envOverrides", () => {
  it("lists the provider ANYCODE_* vars present in the boot snapshot", () => {
    expect(
      envOverrides({ ANYCODE_API_KEY: "k", ANYCODE_MODEL: "m", PATH: "/x", ANYCODE_WORKSPACE: "/ws" }),
    ).toEqual(["ANYCODE_API_KEY", "ANYCODE_MODEL"]);
  });

  it("ignores blank values", () => {
    expect(envOverrides({ ANYCODE_API_KEY: "  " })).toEqual([]);
  });

  it("includes ANYCODE_REASONING_EFFORT (F14 §2.4 ladder addition)", () => {
    expect(envOverrides({ ANYCODE_REASONING_EFFORT: "high" })).toEqual([ENV_REASONING_EFFORT]);
  });

  it("includes ANYCODE_MAX_OUTPUT_TOKENS (TASK.150 ladder addition)", () => {
    expect(envOverrides({ ANYCODE_MAX_OUTPUT_TOKENS: "65536" })).toEqual([ENV_MAX_OUTPUT_TOKENS]);
  });

  it("includes ANYCODE_INCLUDE_USAGE (TASK.158 ladder addition)", () => {
    expect(envOverrides({ ANYCODE_INCLUDE_USAGE: "off" })).toEqual([ENV_INCLUDE_USAGE]);
  });
});

describe("shouldSkipConnectionHealthBinding (TASK.45 W11 env-override rule)", () => {
  it("skips binding when ANYCODE_API_KEY is a non-blank boot-snapshot override", () => {
    expect(shouldSkipConnectionHealthBinding({ ANYCODE_API_KEY: "sk-env-override" })).toBe(true);
  });

  it("does NOT skip when ANYCODE_API_KEY is absent", () => {
    expect(shouldSkipConnectionHealthBinding({})).toBe(false);
  });

  it("does NOT skip on a blank/whitespace-only ANYCODE_API_KEY (treated as absent)", () => {
    expect(shouldSkipConnectionHealthBinding({ ANYCODE_API_KEY: "   " })).toBe(false);
  });

  it("ignores an unrelated override (ANYCODE_MODEL alone does not gate health binding)", () => {
    expect(shouldSkipConnectionHealthBinding({ ANYCODE_MODEL: "gpt-5.1" })).toBe(false);
  });
});

describe("computeProviderReady — readiness matrix (§6)", () => {
  it("ready from env only (API key + model)", async () => {
    const ready = await computeProviderReady({
      bootEnv: { ANYCODE_API_KEY: "k", ANYCODE_MODEL: "m" },
      settings: settings(),
      getSecret: noSecret,
    });
    expect(ready).toBe(true);
  });

  it("ready from vault key + settings model", async () => {
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { model: "m" } }),
      getSecret: vaultSecret("sk-vault"),
    });
    expect(ready).toBe(true);
  });

  it("not ready with nothing configured", async () => {
    const ready = await computeProviderReady({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(ready).toBe(false);
  });

  it("not ready with an API key but no model", async () => {
    const ready = await computeProviderReady({
      bootEnv: { ANYCODE_API_KEY: "k" },
      settings: settings(),
      getSecret: noSecret,
    });
    expect(ready).toBe(false);
  });

  it("not ready when the vault entry cannot decrypt (returns undefined) and no env key", async () => {
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { model: "m" } }),
      getSecret: noSecret, // vault yields nothing (decrypt-fail modelled as undefined)
    });
    expect(ready).toBe(false);
  });

  it("oauth provider: ready when the credentialKey (provider.<id>.oauth) is present", async () => {
    const getSecret = async (key: SecretKey): Promise<string | undefined> =>
      key === "provider.acme.oauth" ? '{"accessToken":"a","refreshToken":"r","expiresAt":1}' : undefined;
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { id: "acme", model: "m" } }),
      getSecret,
      credentialKey: "provider.acme.oauth",
    });
    expect(ready).toBe(true);
  });

  it("api_key provider: not ready when the legacy key is set but the per-provider key is not", async () => {
    // The credentialKey targets provider.<id>.apiKey; only the legacy key exists.
    const getSecret = async (key: SecretKey): Promise<string | undefined> =>
      key === "provider.apiKey" ? "legacy" : undefined;
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", model: "m" } }),
      getSecret,
      credentialKey: "provider.z-ai.apiKey",
    });
    expect(ready).toBe(false);
  });
});

describe("computeProviderReady — auth-policy + unsupported-transport (TASK.43 W5, cut Risk #3)", () => {
  it("authOptional=true is ready with a model and NO key at all (vLLM/no-auth custom)", async () => {
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { id: "vllm", model: "m" } }),
      getSecret: noSecret,
      authOptional: true,
    });
    expect(ready).toBe(true);
  });

  it("authOptional=true still requires a model", async () => {
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { id: "vllm" } }),
      getSecret: noSecret,
      authOptional: true,
    });
    expect(ready).toBe(false);
  });

  it("authOptional absent/false keeps the byte-compat fail-closed default (a key is still required)", async () => {
    const ready = await computeProviderReady({
      bootEnv: {},
      settings: settings({ provider: { id: "openai", model: "m" } }),
      getSecret: noSecret,
    });
    expect(ready).toBe(false);
  });

  it("blocks readiness when the resolved transport is not in the entry's supportedTransports", async () => {
    const ready = await computeProviderReady({
      bootEnv: { ANYCODE_API_KEY: "k" },
      settings: settings({ provider: { id: "vllm", model: "m", transport: "openai-responses" } }),
      getSecret: noSecret,
      authOptional: true,
      resolvedTransport: "openai-responses",
      supportedTransports: ["openai-chat-completions"],
    });
    expect(ready).toBe(false);
  });

  it("ready when the resolved transport IS supported, even with the guard params present", async () => {
    const ready = await computeProviderReady({
      bootEnv: { ANYCODE_API_KEY: "k" },
      settings: settings({ provider: { id: "openai", model: "m", transport: "openai-responses" } }),
      getSecret: noSecret,
      resolvedTransport: "openai-responses",
      supportedTransports: ["openai-responses", "openai-chat-completions"],
    });
    expect(ready).toBe(true);
  });

  it("skips the unsupported-transport guard when supportedTransports is not supplied (legacy path)", async () => {
    const ready = await computeProviderReady({
      bootEnv: { ANYCODE_API_KEY: "k", ANYCODE_MODEL: "m" },
      settings: settings({ provider: { transport: "openai-responses" } }),
      getSecret: noSecret,
      resolvedTransport: "openai-responses",
    });
    expect(ready).toBe(true);
  });
});

describe("snapshot + scrub (ruling R3) — the exfil-vector closure", () => {
  it("bootEnv retains the key, the live env is scrubbed, the host fork still gets it, a Bash child does not", async () => {
    // A stand-in for the live process.env at boot.
    const liveEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANYCODE_API_KEY: "sk-live",
      ANYCODE_MODEL: "m",
      ANYCODE_AUTOMATION: "1",
    };

    // Step 3: snapshot BEFORE scrub, then scrub the live env.
    const bootEnv = snapshotBootEnv(liveEnv);
    scrubSecretEnv(liveEnv);

    // Live env no longer carries the secret; the non-secret automation gate stays.
    expect(liveEnv.ANYCODE_API_KEY).toBeUndefined();
    expect(liveEnv.ANYCODE_AUTOMATION).toBe("1");

    expect(bootEnv.ANYCODE_API_KEY).toBe("sk-live");

    // The host fork env (built from the snapshot) still carries the key.
    const hostEnv = await buildHostEnv({ bootEnv, settings: settings(), getSecret: noSecret });
    expect(hostEnv.ANYCODE_API_KEY).toBe("sk-live");

    // A Bash child of MAIN inherits the (scrubbed) live env -> no key.
    const bashChildEnv = { ...liveEnv };
    expect(bashChildEnv.ANYCODE_API_KEY).toBeUndefined();
  });

  it("scrubSecretEnv is idempotent and leaves non-secret keys alone", () => {
    const env: NodeJS.ProcessEnv = { ANYCODE_API_KEY: "x", ANYCODE_MODEL: "m" };
    scrubSecretEnv(env);
    scrubSecretEnv(env);
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_MODEL).toBe("m");
  });
});

describe("applySubagentsHomeOverride (dispatch-parity fix, design/slice-P7.21-cut.md)", () => {
  it("sets ANYCODE_SUBAGENTS_HOME when given a non-null override", () => {
    const env: NodeJS.ProcessEnv = {};
    applySubagentsHomeOverride(env, "/tmp/anycode-fixture-home");
    expect(env.ANYCODE_SUBAGENTS_HOME).toBe("/tmp/anycode-fixture-home");
  });

  it("deletes ANYCODE_SUBAGENTS_HOME on a null override, even when the env already carried it (packaged-production inertness)", () => {
    const env: NodeJS.ProcessEnv = { ANYCODE_SUBAGENTS_HOME: "/tmp/stale-dev-value" };
    applySubagentsHomeOverride(env, null);
    expect(env.ANYCODE_SUBAGENTS_HOME).toBeUndefined();
  });

  it("composes with buildHostEnv: a built host env gated null leaves the var absent", async () => {
    const hostEnv = await buildHostEnv({
      bootEnv: { ANYCODE_API_KEY: "sk-live", ANYCODE_SUBAGENTS_HOME: "/tmp/leftover" },
      settings: settings(),
      getSecret: noSecret,
    });
    // buildHostEnv itself never touches ANYCODE_SUBAGENTS_HOME; the gate is applied
    // separately by main (byte-for-byte packaged-production path: gate always null there).
    applySubagentsHomeOverride(hostEnv, null);
    expect(hostEnv.ANYCODE_SUBAGENTS_HOME).toBeUndefined();
    expect(hostEnv.ANYCODE_API_KEY).toBe("sk-live");
  });
});

describe("applyCodexProfilesHomeOverride (codex-profiles W4-F0b, Fable ruling iter-10)", () => {
  it("sets ANYCODE_CODEX_PROFILES_HOME when given a non-null (main-vetted) override", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCodexProfilesHomeOverride(env, "/tmp/anycode-lever-root");
    expect(env.ANYCODE_CODEX_PROFILES_HOME).toBe("/tmp/anycode-lever-root");
  });

  it("RED-proof (main-scrub): deletes ANYCODE_CODEX_PROFILES_HOME on a null override, even when the env already carried it", () => {
    const env: NodeJS.ProcessEnv = { ANYCODE_CODEX_PROFILES_HOME: "/tmp/stale-ambient-value" };
    applyCodexProfilesHomeOverride(env, null);
    expect(env.ANYCODE_CODEX_PROFILES_HOME).toBeUndefined();
  });

  it("composes with buildHostEnv: the bootEnv-spread hazard is REAL, and the gated-null scrub removes it", async () => {
    const hostEnv = await buildHostEnv({
      bootEnv: { ANYCODE_API_KEY: "sk-live", ANYCODE_CODEX_PROFILES_HOME: "/tmp/ambient-from-owner-shell" },
      settings: settings(),
      getSecret: noSecret,
    });
    // Without the scrub, the raw ambient var rides the bootEnv spread straight
    // into the host fork — this assertion documents the hazard the delete
    // branch exists to close.
    expect(hostEnv.ANYCODE_CODEX_PROFILES_HOME).toBe("/tmp/ambient-from-owner-shell");
    // Gate refused (no automation / packaged) ⇒ structural delete.
    applyCodexProfilesHomeOverride(hostEnv, null);
    expect(hostEnv.ANYCODE_CODEX_PROFILES_HOME).toBeUndefined();
    expect(hostEnv.ANYCODE_API_KEY).toBe("sk-live");
  });
});

describe("secretEnvFor (slice 2.5 §4, replaces SECRET_KEY_ENV)", () => {
  it("maps the legacy key to ANYCODE_API_KEY, byte-for-byte 2.2", () => {
    expect(secretEnvFor("provider.apiKey")).toBe("ANYCODE_API_KEY");
  });

  it("maps per-provider api-key and oauth keys to the single secret env slot", () => {
    expect(secretEnvFor("provider.z-ai.apiKey")).toBe("ANYCODE_API_KEY");
    expect(secretEnvFor("provider.anthropic.oauth")).toBe("ANYCODE_API_KEY");
  });
});

describe("isKnownSecretKey (slice 2.5 §4, generalises SECRET_KEYS)", () => {
  const catalogIds = ["anthropic", "z-ai", "deepseek", "moonshot", "custom"];

  it("accepts the legacy/custom key regardless of catalog", () => {
    expect(isKnownSecretKey("provider.apiKey", [])).toBe(true);
  });

  it("accepts per-provider apiKey/oauth keys for a catalog id", () => {
    expect(isKnownSecretKey("provider.z-ai.apiKey", catalogIds)).toBe(true);
    expect(isKnownSecretKey("provider.anthropic.oauth", catalogIds)).toBe(true);
  });

  it("rejects per-provider keys whose id is not in the catalog", () => {
    expect(isKnownSecretKey("provider.evil.apiKey", catalogIds)).toBe(false);
    expect(isKnownSecretKey("provider.evil.oauth", catalogIds)).toBe(false);
  });

  it("rejects malformed / arbitrary keys", () => {
    expect(isKnownSecretKey("provider..apiKey", catalogIds)).toBe(false);
    expect(isKnownSecretKey("provider.z-ai.token", catalogIds)).toBe(false);
    expect(isKnownSecretKey("anything.else", catalogIds)).toBe(false);
    expect(isKnownSecretKey("", catalogIds)).toBe(false);
  });
});

describe("customProviderIds (owner-decision #6, cut §9.2, TASK.54)", () => {
  it("returns every id in settings.provider.custom", () => {
    const withCustom: AnycodeSettings = {
      ...settings(),
      provider: {
        ...settings().provider,
        custom: [
          { id: "custom:foo", name: "Foo", baseUrl: "https://foo.example", kind: "openai-compatible", models: [] },
          { id: "custom:bar", name: "Bar", baseUrl: "https://bar.example", kind: "anthropic", models: ["m1"] },
        ],
      },
    };
    expect(customProviderIds(withCustom)).toEqual(["custom:foo", "custom:bar"]);
  });

  it("returns an empty array when settings.provider.custom is absent", () => {
    expect(customProviderIds(settings())).toEqual([]);
  });

  // RED-PROOF: this is exactly the seam TASK.54 flags at main/index.ts — a
  // custom provider's vault key is only recognized once its id is unioned
  // into `catalogIds`. Reverting to `catalogProviderIds()` alone (no union)
  // reproduces this red case.
  it("RED-PROOF: a custom provider's secret key is unknown until its id is unioned into catalogIds", () => {
    const withCustom: AnycodeSettings = {
      ...settings(),
      provider: {
        ...settings().provider,
        custom: [{ id: "custom:foo", name: "Foo", baseUrl: "https://foo.example", kind: "openai-compatible", models: [] }],
      },
    };
    const builtinOnly = ["anthropic", "z-ai"];
    // Without the union (today's `catalogProviderIds()` call site), the key is invisible.
    expect(isKnownSecretKey("provider.custom:foo.apiKey", builtinOnly)).toBe(false);
    // With the union `customProviderIds` provides, it resolves correctly.
    const unioned = [...builtinOnly, ...customProviderIds(withCustom)];
    expect(isKnownSecretKey("provider.custom:foo.apiKey", unioned)).toBe(true);
  });
});

describe("engineProxyCarriers — engine-level proxy (TASK.139)", () => {
  /** Carries `user:pass@` userinfo on purpose — the authenticated-proxy case the field exists for. */
  const CODEX_PROXY = "http://user:pass@codex-proxy.example.com:3128";
  const CLAUDE_PROXY = "https://claude-proxy.example.com:8443";
  const SHELL_PROXY = "http://shell-proxy.internal:8080";
  /** The COMPLETE key set this function may ever emit — byte-identity is asserted over exactly this. */
  const CARRIER_KEYS = ["ANYCODE_CODEX_PROXY_URL", "ANYCODE_CLAUDE_PROXY_URL"] as const;

  /**
   * The wire value main emits for a working engine proxy (design review B-02):
   * the url PLUS the exemption pair the child must write, since a boot env that
   * names no `NO_PROXY` leaves that pair ours to set. Composed through the real
   * encoder so the encoding cannot drift between main and the child builders.
   */
  const carrier = (url: string, noProxy: string = LOOPBACK_NO_PROXY): string =>
    encodeEngineProxyCarrier({ kind: "proxy", url, noProxy }) as string;

  it("emits nothing when neither engine has a proxy", () => {
    expect(engineProxyCarriers(settings(), {})).toEqual({});
  });

  it("emits only the codex carrier when only codex is configured", () => {
    const result = engineProxyCarriers(settings({ codex: { proxyUrl: CODEX_PROXY } }), {});
    expect(result).toEqual({ ANYCODE_CODEX_PROXY_URL: carrier(CODEX_PROXY) });
  });

  it("emits only the claude carrier when only claude is configured", () => {
    const result = engineProxyCarriers(settings({ claude: { proxyUrl: CLAUDE_PROXY } }), {});
    expect(result).toEqual({ ANYCODE_CLAUDE_PROXY_URL: carrier(CLAUDE_PROXY) });
  });

  it("emits both carriers, each with its own engine's value", () => {
    const result = engineProxyCarriers(
      settings({ codex: { proxyUrl: CODEX_PROXY }, claude: { proxyUrl: CLAUDE_PROXY } }),
      {},
    );
    expect(result).toEqual({
      ANYCODE_CODEX_PROXY_URL: carrier(CODEX_PROXY),
      ANYCODE_CLAUDE_PROXY_URL: carrier(CLAUDE_PROXY),
    });
  });

  // B-02: main withholds the exemption licence when the SHELL named the pair —
  // the child builder cannot make that call, since by the time it runs a
  // shell-exported NO_PROXY and a connection-derived one look identical.
  it("B-02: withholds the exemption licence when the shell owns NO_PROXY", () => {
    const result = engineProxyCarriers(settings({ codex: { proxyUrl: CODEX_PROXY } }), { NO_PROXY: "corp.internal" });
    expect(result).toEqual({
      ANYCODE_CODEX_PROXY_URL: encodeEngineProxyCarrier({ kind: "proxy", url: CODEX_PROXY }),
    });
  });

  // B-02: an engine PROFILE's own exemptions ride the carrier, appended to the
  // loopback default — never replacing it, or a local Ollama/vLLM endpoint would
  // be dialled through the proxy.
  it("B-02: carries an engine profile's own noProxy, appended to the loopback default", () => {
    const result = engineProxyCarriers(
      settings({
        network: {
          proxyProfiles: [
            { id: "proxy-1", name: "Corp", mode: "manual", url: CLAUDE_PROXY, noProxy: "engine.corp" },
          ],
        },
        codex: { proxyRef: "proxy-1" },
      }),
      {},
    );
    expect(result).toEqual({
      ANYCODE_CODEX_PROXY_URL: carrier(`${CLAUDE_PROXY}/`, `${LOOPBACK_NO_PROXY},engine.corp`),
    });
  });

  // Family-atomic shell-wins, and ONE check for BOTH engines: a shell that
  // configured any single proxy var owns the network path for everything this
  // app spawns. This is also the invariant that licenses
  // `applyEngineProxyOverride` to clobber the family unconditionally — if it
  // ever stopped holding, the builders would start beating the user's shell.
  for (const shellVar of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const) {
    it(`emits NOTHING for either engine when the shell exports ${shellVar}`, () => {
      const result = engineProxyCarriers(
        settings({ codex: { proxyUrl: CODEX_PROXY }, claude: { proxyUrl: CLAUDE_PROXY } }),
        { [shellVar]: SHELL_PROXY },
      );
      expect(result).toEqual({});
    });
  }

  // CHANGED BY DESIGN REVIEW B-01, in step with `applyConnectionProxy`: a
  // DECLARED family var — empty string included — is the shell claiming the
  // family, and the two gates must read the same predicate or a scope could be
  // silenced on the fork path and heard on the engine path.
  it("B-01: an empty shell family var silences both carriers too", () => {
    const result = engineProxyCarriers(settings({ codex: { proxyUrl: CODEX_PROXY } }), { HTTPS_PROXY: "  " });
    expect(result).toEqual({});
  });

  // Fail-soft: `settings.codex`/`settings.claude` validate LENIENTLY on disk
  // (settings/schema.ts) and the generic `settings-set` channel would accept an
  // unrefined value, so a garbage proxy must degrade to "no proxy for this
  // engine" — never to a broken child env, and never taking the other engine
  // down with it.
  it("drops a malformed value per-engine and keeps the valid sibling", () => {
    for (const garbage of ["proxy.example.com:3128", "socks5://proxy.example.com:1080", "", "   ", "http://"]) {
      const result = engineProxyCarriers(
        settings({ codex: { proxyUrl: garbage }, claude: { proxyUrl: CLAUDE_PROXY } }),
        {},
      );
      expect(result).toEqual({ ANYCODE_CLAUDE_PROXY_URL: carrier(CLAUDE_PROXY) });
    }
  });

  // Byte-identity of the fork overlay: with nothing configured the spread adds
  // no key at all, so a fork's env is exactly its pre-TASK.139 self.
  it("spreads into an env overlay without changing a byte when empty", () => {
    const overlay = {
      ANYCODE_ENGINE: "core",
      ANYCODE_HOST_GENERATION: "3",
      ...engineProxyCarriers(settings(), {}),
    };
    expect(overlay).toEqual({ ANYCODE_ENGINE: "core", ANYCODE_HOST_GENERATION: "3" });
    for (const key of CARRIER_KEYS) {
      expect(key in overlay).toBe(false);
    }
  });
});

describe("ambient engine-proxy carriers never reach a fork (TASK.139 F1)", () => {
  const CODEX_PROXY = "http://user:pass@codex-proxy.example.com:3128";
  const AMBIENT_PROXY = "http://ambient-carrier.invalid:9999";
  const SHELL_PROXY = "http://shell-proxy.internal:8080";
  /**
   * The COMPLETE key set an ambient carrier could disturb: the proxy family the
   * child builders overwrite from a carrier, the exemption pair, and the two
   * carrier names themselves. Byte-identity is asserted over exactly this set.
   */
  const AFFECTED_KEYS = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "ANYCODE_CODEX_PROXY_URL",
    "ANYCODE_CLAUDE_PROXY_URL",
  ] as const;

  const pick = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    Object.fromEntries(AFFECTED_KEYS.filter((key) => key in env).map((key) => [key, env[key]]));

  it("snapshotBootEnv drops both carrier names and keeps every other var", () => {
    const snapshot = snapshotBootEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANYCODE_MODEL: "m",
      ANYCODE_CODEX_PROXY_URL: AMBIENT_PROXY,
      ANYCODE_CLAUDE_PROXY_URL: AMBIENT_PROXY,
    });
    expect(snapshot).toEqual({ PATH: "/usr/bin", HOME: "/home/me", ANYCODE_MODEL: "m" });
  });

  // The contrast this slice is built on: every OTHER ambient ANYCODE_* is an
  // honoured override (fillFromSettings never overwrites an env value) — the
  // carriers are a private main->child transport and are stripped instead.
  it("still honours an ambient ANYCODE_MODEL as an override while stripping the carriers", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_MODEL: "env-model", ANYCODE_CODEX_PROXY_URL: AMBIENT_PROXY },
      settings: settings({ provider: { model: "settings-model" } }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_MODEL).toBe("env-model");
    expect(env.ANYCODE_CODEX_PROXY_URL).toBeUndefined();
  });

  // The regression: a shell that exports its own proxy owns the family, so
  // `engineProxyCarriers` emits nothing — an ambient carrier riding the
  // `{...bootEnv}` spread would then be the ONLY carrier in the fork, and the
  // child builder's unconditional overwrite would beat the shell's own proxy.
  it("with a shell proxy and ambient carriers, the fork env is byte-identical to the shell's own", async () => {
    const bootEnv = {
      PATH: "/usr/bin",
      HTTPS_PROXY: SHELL_PROXY,
      ANYCODE_CODEX_PROXY_URL: AMBIENT_PROXY,
      ANYCODE_CLAUDE_PROXY_URL: AMBIENT_PROXY,
    };
    const current = settings({ provider: { id: "z-ai", model: "m" } });
    const env = await buildHostEnv({ bootEnv, settings: current, getSecret: noSecret });
    const overlay = { ...env, ...engineProxyCarriers(current, bootEnv) };
    expect(pick(overlay)).toEqual({ HTTPS_PROXY: SHELL_PROXY });
  });

  // And with an engine proxy configured, main's value is the one that lands —
  // the ambient one is gone rather than merely losing a spread order fight.
  it("main's configured carrier replaces an ambient one of the same name", async () => {
    const bootEnv = { PATH: "/usr/bin", ANYCODE_CODEX_PROXY_URL: AMBIENT_PROXY };
    const current = settings({ codex: { proxyUrl: CODEX_PROXY } });
    const env = await buildHostEnv({ bootEnv, settings: current, getSecret: noSecret });
    expect(env.ANYCODE_CODEX_PROXY_URL).toBeUndefined();
    const overlay = { ...env, ...engineProxyCarriers(current, bootEnv) };
    expect(pick(overlay)).toEqual({
      ANYCODE_CODEX_PROXY_URL: encodeEngineProxyCarrier({
        kind: "proxy",
        url: CODEX_PROXY,
        noProxy: LOOPBACK_NO_PROXY,
      }),
    });
  });
});

// ── TASK.141: the named proxy registry ──

describe("materializeProxyRung — a rung turned into what an env needs", () => {
  const MANUAL: ProxyProfile = { id: "proxy-corp", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" };
  const SYSTEM: ProxyProfile = { id: "proxy-sys", name: "System", mode: "system" };

  const rungFor = (profile: ProxyProfile): AnycodeSettings =>
    settings({ network: { proxyProfiles: [profile], proxyRef: profile.id } });

  const materialize = (current: AnycodeSettings, deps: ProxyMaterializationDeps = {}) =>
    materializeProxyRung(resolveProxyLadder(current, [{ kind: "app" }]), deps);

  /** A target-keyed resolver that answers the SAME outcome for every target. */
  const systemResolver = (outcome: SystemProxyOutcome): SystemProxyResolver => ({
    cached: () => outcome,
    resolve: async () => outcome,
  });
  const TARGET = "https://api.anthropic.com";

  it("materialises a manual profile's URL", () => {
    expect(materialize(rungFor(MANUAL))).toEqual({ url: "http://proxy.corp:3128/" });
  });

  it("carries the profile's exemptions alongside the URL", () => {
    expect(materialize(rungFor({ ...MANUAL, noProxy: "a.corp,b.corp" }))).toEqual({
      url: "http://proxy.corp:3128/",
      noProxy: "a.corp,b.corp",
    });
  });

  // Lane A's shipped default for the system-resolve cache is "no value", and
  // that is a real answer: before `app.whenReady` there is no Chromium session
  // to ask, and inventing a proxy would be worse than not using one.
  it("materialises a system profile to DIRECT while the resolve cache is empty", () => {
    expect(materialize(rungFor(SYSTEM))).toBeUndefined();
    expect(
      materialize(rungFor(SYSTEM), { systemProxy: systemResolver({ kind: "unresolved" }), targetUrl: TARGET }),
    ).toBeUndefined();
  });

  it("materialises a system profile from the injected resolve cache once it has a value", () => {
    expect(
      materialize(rungFor(SYSTEM), {
        systemProxy: systemResolver({ kind: "proxy", url: "http://pac-resolved:8080" }),
        targetUrl: TARGET,
      }),
    ).toEqual({ url: "http://pac-resolved:8080/" });
  });

  // B-10: the cache is keyed by TARGET, so an answer taken for one host is not
  // an answer for another. A materialisation that does not know its own target
  // must go DIRECT rather than borrow whatever the last resolve produced.
  it("B-10: a system profile with no target materialises DIRECT even when the cache holds a proxy", () => {
    expect(
      materialize(rungFor(SYSTEM), { systemProxy: systemResolver({ kind: "proxy", url: "http://pac:8080" }) }),
    ).toBeUndefined();
  });

  it("B-10: a system profile resolves the answer for ITS OWN target, not for another's", () => {
    const byTarget = new Map<string, SystemProxyOutcome>([
      ["https://a.example", { kind: "proxy", url: "http://proxy-a:3128" }],
      ["https://b.example", { kind: "proxy", url: "http://proxy-b:3128" }],
    ]);
    const systemProxy: SystemProxyResolver = {
      cached: (target) => byTarget.get(target) ?? { kind: "unresolved" },
      resolve: async (target) => byTarget.get(target) ?? { kind: "unresolved" },
    };
    expect(materialize(rungFor(SYSTEM), { systemProxy, targetUrl: "https://a.example" })).toEqual({
      url: "http://proxy-a:3128/",
    });
    expect(materialize(rungFor(SYSTEM), { systemProxy, targetUrl: "https://b.example" })).toEqual({
      url: "http://proxy-b:3128/",
    });
  });

  // The three non-`proxy` outcomes are three different facts about the OS, and
  // all three materialise DIRECT — an explicit rung whose value cannot be
  // honoured must not fall through into another rung's proxy.
  it("B-10: `direct` and `socks_unsupported` both materialise DIRECT", () => {
    expect(materialize(rungFor(SYSTEM), { systemProxy: systemResolver({ kind: "direct" }), targetUrl: TARGET }))
      .toBeUndefined();
    expect(
      materialize(rungFor(SYSTEM), { systemProxy: systemResolver({ kind: "socks_unsupported" }), targetUrl: TARGET }),
    ).toBeUndefined();
  });

  // The password never lives in settings.json — it comes from the vault via
  // main's in-memory cache, and it is percent-encoded on the way into the URL.
  it("composes login + the cached password into percent-encoded userinfo", () => {
    const withLogin = rungFor({ ...MANUAL, login: "user@corp" });
    expect(materialize(withLogin, { proxyPassword: () => "p@ss:word" })).toEqual({
      url: "http://user%40corp:p%40ss%3Aword@proxy.corp:3128/",
    });
  });

  it("emits the login alone when the password cache holds nothing for the profile", () => {
    expect(materialize(rungFor({ ...MANUAL, login: "user" }))).toEqual({ url: "http://user@proxy.corp:3128/" });
  });

  it("asks the password cache for THIS profile's id", () => {
    const seen: string[] = [];
    materialize(rungFor({ ...MANUAL, login: "user" }), {
      proxyPassword: (id) => {
        seen.push(id);
        return "pw";
      },
    });
    expect(seen).toEqual([MANUAL.id]);
  });

  // Every broken value collapses to DIRECT rather than to the rung below — the
  // law that keeps a typo from routing a scope's traffic into another rung's
  // proxy.
  it("materialises a dangling ref, a broken URL and a userinfo-bearing URL all to DIRECT", () => {
    expect(materializeProxyRung({ source: { kind: "app" }, ref: "proxy-gone" })).toBeUndefined();
    expect(materialize(rungFor({ ...MANUAL, url: "proxy.corp:3128" }))).toBeUndefined();
    // Hand-edited userinfo in the host field is refused for the same reason the
    // editor refuses it: it would put a password back into the 0644 file.
    expect(materialize(rungFor({ ...MANUAL, url: "http://u:p@proxy.corp:3128" }))).toBeUndefined();
    expect(materialize(rungFor({ ...MANUAL, url: undefined }))).toBeUndefined();
  });

  it("materialises an explicit `direct` ref and an absent ladder to the same nothing", () => {
    expect(materializeProxyRung(undefined)).toBeUndefined();
    expect(materializeProxyRung({ source: { kind: "app" }, ref: PROXY_REF_DIRECT })).toBeUndefined();
  });

  it("materialises a legacy string verbatim — byte-for-byte its TASK.132 semantics", () => {
    const legacy = settings({ provider: { id: "z-ai", model: "m", proxyUrl: "http://user:pass@legacy:8080" } });
    expect(resolveProxyFor(legacy, hostForkProxyChain("conn-z-ai"))).toEqual({
      url: "http://user:pass@legacy:8080",
    });
  });
});

describe("applyConnectionProxy — profile exemptions (TASK.141)", () => {
  const PROXY = { url: "http://proxy.corp:3128" };

  // Grabli: the list is APPENDED. A profile list that REPLACED the loopback
  // default would send a local Ollama/vLLM endpoint (and every loopback MCP
  // server) through the corporate proxy.
  it("appends the profile's exemptions to the loopback default, in both cases", () => {
    const env: NodeJS.ProcessEnv = {};
    applyConnectionProxy(env, {}, { ...PROXY, noProxy: "a.corp,b.corp" });
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,[::1],::1,a.corp,b.corp");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,[::1],::1,a.corp,b.corp");
  });

  it("writes the loopback default alone when the profile names no exemptions", () => {
    const env: NodeJS.ProcessEnv = {};
    applyConnectionProxy(env, {}, { ...PROXY, noProxy: "   " });
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,[::1],::1");
  });

  // TASK.132's law is untouched: a shell that named its own exemptions keeps
  // BOTH keys, and a profile's list never shadows them.
  it("leaves a shell-exported NO_PROXY completely untouched", () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: "corp.internal" };
    applyConnectionProxy(env, { NO_PROXY: "corp.internal" }, { ...PROXY, noProxy: "a.corp" });
    expect(env.NO_PROXY).toBe("corp.internal");
    expect("no_proxy" in env).toBe(false);
    expect(env.HTTPS_PROXY).toBe(PROXY.url);
  });
});

describe("engineProxyCarrierValue — the engine rung, with and without the app rung", () => {
  const PROFILE: ProxyProfile = { id: "proxy-corp", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" };

  it("emits nothing when the engine scope is silent and no app rung is consulted", () => {
    const current = settings({ network: { proxyProfiles: [PROFILE], proxyRef: PROFILE.id } });
    expect(engineProxyCarrierValue(current, {}, "codex", false)).toBeUndefined();
  });

  // The doctor has no connection rung and no host fork env to inherit from, so
  // the application default reaches it through this value or not at all.
  it("picks up the app rung for a doctor child", () => {
    const current = settings({ network: { proxyProfiles: [PROFILE], proxyRef: PROFILE.id } });
    expect(decodeEngineProxyCarrier(engineProxyCarrierValue(current, {}, "codex", true))).toEqual({
      kind: "proxy",
      url: "http://proxy.corp:3128/",
      noProxy: LOOPBACK_NO_PROXY,
    });
  });

  // An explicit `direct` must be SAID: the connection's proxy is already in the
  // child env through the passthrough list, and silence would leave the engine
  // on it.
  it("emits the DIRECT sentinel for an explicit `direct` engine ref", () => {
    const current = settings({ codex: { proxyRef: PROXY_REF_DIRECT } });
    expect(engineProxyCarrierValue(current, {}, "codex", false)).toBe(PROXY_CARRIER_DIRECT);
  });

  it("emits the DIRECT sentinel for a dangling ref and for a system profile with an empty cache", () => {
    expect(engineProxyCarrierValue(settings({ codex: { proxyRef: "proxy-gone" } }), {}, "codex", false)).toBe(
      PROXY_CARRIER_DIRECT,
    );
    const systemRef = settings({
      claude: { proxyRef: "proxy-sys" },
      network: { proxyProfiles: [{ id: "proxy-sys", name: "System", mode: "system" }] },
    });
    expect(engineProxyCarrierValue(systemRef, {}, "claude", false)).toBe(PROXY_CARRIER_DIRECT);
  });

  // The shell-wins gate lives here and nowhere else — it is what licenses the
  // child builder's unconditional clobber, sentinel included.
  it("emits NOTHING — not even the sentinel — when the shell owns the proxy family", () => {
    const current = settings({ codex: { proxyRef: PROXY_REF_DIRECT }, claude: { proxyRef: PROXY_REF_DIRECT } });
    expect(engineProxyCarrierValue(current, { http_proxy: "http://shell:8080" }, "codex", false)).toBeUndefined();
    expect(engineProxyCarriers(current, { http_proxy: "http://shell:8080" })).toEqual({});
  });

  it("keeps the two engines' carriers independent", () => {
    const current = settings({
      codex: { proxyRef: PROFILE.id },
      claude: { proxyRef: PROXY_REF_DIRECT },
      network: { proxyProfiles: [PROFILE] },
    });
    expect(engineProxyCarriers(current, {})).toEqual({
      ANYCODE_CODEX_PROXY_URL: encodeEngineProxyCarrier({
        kind: "proxy",
        url: "http://proxy.corp:3128/",
        noProxy: LOOPBACK_NO_PROXY,
      }),
      ANYCODE_CLAUDE_PROXY_URL: PROXY_CARRIER_DIRECT,
    });
  });

  it("lets a profile ref beat the legacy string on the same engine block", () => {
    const current = settings({
      codex: { proxyUrl: "http://legacy:8080", proxyRef: PROFILE.id },
      network: { proxyProfiles: [PROFILE] },
    });
    expect(engineProxyCarriers(current, {})).toEqual({
      ANYCODE_CODEX_PROXY_URL: encodeEngineProxyCarrier({
        kind: "proxy",
        url: "http://proxy.corp:3128/",
        noProxy: LOOPBACK_NO_PROXY,
      }),
    });
  });
});

describe("TASK.141 byte-identity — a registry-free document changes not one byte", () => {
  /** Every env var this slice could conceivably touch; byte-identity is asserted over exactly this set. */
  const PROXY_SURFACE = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "ANYCODE_CODEX_PROXY_URL",
    "ANYCODE_CLAUDE_PROXY_URL",
  ] as const;

  const bootEnv = { PATH: "/usr/bin", HOME: "/home/me" };

  it("a fork env with no network section is deep-equal to one with an EMPTY registry", async () => {
    const plain = await buildHostEnv({
      bootEnv,
      settings: settings({ provider: { id: "z-ai", model: "m" } }),
      getSecret: noSecret,
    });
    const withEmptyRegistry = await buildHostEnv({
      bootEnv,
      settings: settings({ provider: { id: "z-ai", model: "m" }, network: { proxyProfiles: [] } }),
      getSecret: noSecret,
    });
    expect(withEmptyRegistry).toEqual(plain);
    // And the whole object, not a filtered view: no proxy var exists at all.
    expect(plain).toEqual({ PATH: "/usr/bin", HOME: "/home/me", ANYCODE_MODEL: "m" });
  });

  // The DoD's second half: a document carrying ONLY legacy strings produces the
  // exact pre-slice env, including the four family vars and the loopback pair.
  it("a legacy-only document produces the exact pre-slice fork env", async () => {
    const env = await buildHostEnv({
      bootEnv,
      settings: settings({ provider: { id: "z-ai", model: "m", proxyUrl: "http://user:pass@legacy:8080" } }),
      getSecret: noSecret,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANYCODE_MODEL: "m",
      HTTPS_PROXY: "http://user:pass@legacy:8080",
      HTTP_PROXY: "http://user:pass@legacy:8080",
      https_proxy: "http://user:pass@legacy:8080",
      http_proxy: "http://user:pass@legacy:8080",
      NO_PROXY: "localhost,127.0.0.1,[::1],::1",
      no_proxy: "localhost,127.0.0.1,[::1],::1",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  // The DoD is byte-identity of the CHILD env, not of the carrier: the carrier
  // is main's private transport, consumed by the builder and never forwarded.
  // B-02 changed the carrier's SHAPE, so this asserts what actually has to hold
  // — apply the carrier to a child env and compare against the exact pre-slice
  // result (four family vars + the loopback pair).
  it("a legacy-only engine block produces the exact pre-slice CHILD env", () => {
    const current = settings({
      codex: { proxyUrl: "http://codex-legacy:3128" },
      claude: { proxyUrl: "http://claude-legacy:3128" },
    });
    const carriers = engineProxyCarriers(current, {});
    for (const [engine, url] of [
      ["ANYCODE_CODEX_PROXY_URL", "http://codex-legacy:3128"],
      ["ANYCODE_CLAUDE_PROXY_URL", "http://claude-legacy:3128"],
    ] as const) {
      const childEnv: NodeJS.ProcessEnv = { HOME: "/home/me", PATH: "/usr/bin" };
      applyEngineProxyOverride(childEnv, carriers, engine);
      expect(childEnv).toEqual({
        HOME: "/home/me",
        PATH: "/usr/bin",
        HTTPS_PROXY: url,
        HTTP_PROXY: url,
        https_proxy: url,
        http_proxy: url,
        NO_PROXY: LOOPBACK_NO_PROXY,
        no_proxy: LOOPBACK_NO_PROXY,
      });
    }
  });

  // Fail-soft on a hand-edited legacy string is preserved verbatim: it is NOT a
  // rung, so nothing is emitted and nothing falls through to a `direct`
  // sentinel that would newly clobber the connection's proxy.
  it("a malformed legacy engine string still emits no carrier at all (never the sentinel)", () => {
    for (const garbage of ["proxy.example.com:3128", "socks5://p", "http://", "   "]) {
      expect(engineProxyCarriers(settings({ codex: { proxyUrl: garbage } }), {})).toEqual({});
    }
  });

  it("the doctor stubs' ladder emits nothing for a registry-free document", () => {
    const current = settings({ provider: { id: "z-ai", model: "m" } });
    expect(engineProxyCarrierValue(current, {}, "codex", true)).toBeUndefined();
    expect(engineProxyCarrierValue(current, {}, "claude", true)).toBeUndefined();
    for (const key of PROXY_SURFACE) {
      expect(key in bootEnv).toBe(false);
    }
  });
});

describe("proxy-profile vault key (TASK.141 §5)", () => {
  // The whole custody point of keying by the immutable id: `isKnownSecretKey`
  // recognising the key is ALSO what surfaces it in `Vault.statuses`, which is
  // the only way the renderer ever learns `passwordSet` — the value itself never
  // crosses back.
  it("is recognised by isKnownSecretKey with no catalog involvement", () => {
    expect(isKnownSecretKey("proxy.profile.proxy-abc.password", [])).toBe(true);
    expect(isKnownSecretKey(proxyProfileSecretKey("proxy-abc"), ["anthropic"])).toBe(true);
  });

  it("rejects a malformed proxy key rather than half-matching it", () => {
    expect(isKnownSecretKey("proxy.profile..password", [])).toBe(false);
    expect(isKnownSecretKey("proxy.profile.a.b.password", [])).toBe(false);
    expect(isKnownSecretKey("proxy.profile.proxy-abc.token", [])).toBe(false);
  });

  // The law: a proxy password has NO host-env materialisation — it is composed
  // into a proxy URL, never into `ANYCODE_API_KEY`. Answering that var for such
  // a key would boot a host fork on a proxy password as its provider credential,
  // so the call is refused loudly instead of silently mis-answered.
  it("secretEnvFor REFUSES a proxy-profile key", () => {
    expect(() => secretEnvFor(proxyProfileSecretKey("proxy-abc"))).toThrow(/proxy-profile key/);
  });

  it("secretEnvFor still answers every provider key exactly as before", () => {
    expect(secretEnvFor("provider.apiKey")).toBe("ANYCODE_API_KEY");
    expect(secretEnvFor("provider.connection.conn-1.apiKey")).toBe("ANYCODE_API_KEY");
    expect(secretEnvFor("provider.anthropic.oauth")).toBe("ANYCODE_API_KEY");
  });
});

// ── design-review regressions (TASK.141 lane A, gpt-5.6-sol xhigh) ──

describe("B-10 — the async fork path awaits a FRESH resolve for its own target", () => {
  const SYSTEM: ProxyProfile = { id: "proxy-sys", name: "System", mode: "system" };

  function recordingResolver(answers: Record<string, string>): {
    resolver: SystemProxyResolver;
    resolved: string[];
  } {
    const resolved: string[] = [];
    return {
      resolved,
      resolver: {
        // Deliberately EMPTY: the sync cache knows nothing, so a fork that did
        // not await a fresh resolve would materialise DIRECT and this test would
        // catch it.
        cached: () => ({ kind: "unresolved" }),
        resolve: async (target) => {
          resolved.push(target);
          const url = answers[target];
          return url === undefined ? { kind: "unresolved" } : { kind: "proxy", url };
        },
      },
    };
  }

  it("resolves the pinned connection's endpoint, not a global one", async () => {
    const { resolver, resolved } = recordingResolver({ "https://a.example": "http://proxy-a:3128" });
    const current = settings({
      provider: { baseUrl: "https://a.example", model: "m" },
      network: { proxyProfiles: [SYSTEM], proxyRef: SYSTEM.id },
    });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: current,
      getSecret: noSecret,
      proxy: { systemProxy: resolver },
    });
    expect(resolved).toEqual(["https://a.example"]);
    expect(env.HTTPS_PROXY).toBe("http://proxy-a:3128/");
  });

  // THE SCENARIO: a PAC routes a.example through proxy A and b.example through
  // proxy B; two live tabs pinned to two connections share ONE system profile.
  // A single targetless answer would hand both spawns whichever resolve ran
  // last.
  it("two pinned connections get two different proxies from the same profile", async () => {
    const { resolver } = recordingResolver({
      "https://a.example": "http://proxy-a:3128",
      "https://b.example": "http://proxy-b:3128",
    });
    const connections = [
      connectionFixture({ connectionId: "conn-a", baseUrl: "https://a.example", model: "m" }),
      connectionFixture({ connectionId: "conn-b", baseUrl: "https://b.example", model: "m" }),
    ];
    const envFor = async (activeConnectionId: string): Promise<NodeJS.ProcessEnv> =>
      buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings({ network: { proxyProfiles: [SYSTEM], proxyRef: SYSTEM.id } }),
          provider: providerV2Multi(activeConnectionId, connections),
        },
        getSecret: noSecret,
        proxy: { systemProxy: resolver },
      });
    expect((await envFor("conn-a")).HTTPS_PROXY).toBe("http://proxy-a:3128/");
    expect((await envFor("conn-b")).HTTPS_PROXY).toBe("http://proxy-b:3128/");
  });

  // A manual profile needs no resolve at all — the async path must not ask.
  it("never resolves for a non-system rung", async () => {
    const { resolver, resolved } = recordingResolver({ "https://a.example": "http://proxy-a:3128" });
    const manual: ProxyProfile = { id: "proxy-m", name: "M", mode: "manual", url: "http://manual:3128" };
    await buildHostEnv({
      bootEnv: {},
      settings: settings({
        provider: { id: "z-ai", model: "m", baseUrl: "https://a.example" },
        network: { proxyProfiles: [manual], proxyRef: manual.id },
      }),
      getSecret: noSecret,
      proxy: { systemProxy: resolver },
    });
    expect(resolved).toEqual([]);
  });
});

describe("B-03 — every explicit-direct outcome emits the sentinel", () => {
  // THE SCENARIO: a connection uses proxy A; the engine names a `system`
  // profile the OS answered DIRECT for (or a dangling id, or a hand-broken
  // url). Keying the sentinel on `ref === "direct"` emitted NOTHING for all
  // three, the builder left the connection's proxy in place, and the engine's
  // traffic went through a rung the user had explicitly overridden.
  it("emits it for a system profile that resolved DIRECT, for a dangling id, and for a broken url", () => {
    const cases: AnycodeSettings[] = [
      settings({
        codex: { proxyRef: "proxy-sys" },
        network: { proxyProfiles: [{ id: "proxy-sys", name: "S", mode: "system" }] },
      }),
      settings({ codex: { proxyRef: "proxy-vanished" } }),
      settings({
        codex: { proxyRef: "proxy-broken" },
        network: { proxyProfiles: [{ id: "proxy-broken", name: "B", mode: "manual", url: "not a url" }] },
      }),
      // Userinfo in the host field is refused by the same rule the editor
      // applies, so a hand-edited profile degrades to direct rather than
      // shipping a credential out of settings.json.
      settings({
        codex: { proxyRef: "proxy-creds" },
        network: {
          proxyProfiles: [{ id: "proxy-creds", name: "C", mode: "manual", url: "http://u:p@proxy:3128" }],
        },
      }),
      settings({ codex: { proxyRef: PROXY_REF_DIRECT } }),
    ];
    for (const current of cases) {
      expect(engineProxyCarrierValue(current, {}, "codex", false)).toBe(PROXY_CARRIER_DIRECT);
    }
  });

  // The opposite pole, unchanged: NO rung at all emits nothing, so the child
  // keeps what it inherited and a registry-free document stays byte-identical.
  it("emits nothing when no rung spoke at all", () => {
    expect(engineProxyCarrierValue(settings(), {}, "codex", false)).toBeUndefined();
    expect(engineProxyCarrierValue(settings(), {}, "claude", true)).toBeUndefined();
  });
});

describe("buildHostEnv — vision-fallback recognizer (TASK.198 E1)", () => {
  const visionConnection = connectionFixture({
    id: "openai",
    connectionId: "conn-vision",
    baseUrl: "https://vision.example.com",
    transport: "openai-chat-completions",
  });

  it("materialises ANYCODE_RECOGNIZER_* from the selected connection + settings.recognizer.modelId", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: {
        ...settings(),
        provider: providerV2Multi(undefined, [visionConnection]),
        recognizer: { connectionId: "conn-vision", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-vision"),
    });
    expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBe("openai-chat-completions");
    expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://vision.example.com");
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-vision");
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("vision-model");
    expect(env.ANYCODE_RECOGNIZER_PROVIDER_NAME).toBe("openai");
  });

  it("emits nothing when settings.recognizer is absent — byte-identical to today", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_PROVIDER_NAME).toBeUndefined();
  });

  it("emits nothing when the recognizer's connectionId no longer resolves (dangling) — fail-soft, never a stale credential", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: {
        ...settings(),
        recognizer: { connectionId: "conn-gone", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-vision"),
    });
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBeUndefined();
  });

  it("emits nothing for an OAuth-authenticated connection — unsupported as a recognizer source in slice 1 (coordinator decision)", async () => {
    const oauthConnection = connectionFixture({ id: "anthropic", connectionId: "conn-oauth-vision" });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: {
        ...settings(),
        provider: providerV2Multi(undefined, [oauthConnection]),
        recognizer: { connectionId: "conn-oauth-vision", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-should-never-be-read"),
      recognizerAuthKindFor: () => "oauth",
    });
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBeUndefined();
  });

  it("a bare/custom connection (providerId '') is always treated as api_key, never oauth", async () => {
    const bareConnection = connectionFixture({ connectionId: "conn-bare-vision", baseUrl: "https://bare.example.com" });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: {
        ...settings(),
        provider: providerV2Multi(undefined, [bareConnection]),
        recognizer: { connectionId: "conn-bare-vision", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-bare"),
      // A caller-supplied authKindFor is irrelevant for providerId === "" — it
      // is never even consulted for the bare/custom bucket.
      recognizerAuthKindFor: () => "oauth",
    });
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-bare");
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("vision-model");
  });

  // Pinned behavior (transport-ladder fix, task150-output-ceiling session): a
  // bare connection (providerId "") has NO catalog entry, so a MISSING
  // `transport` there resolves `resolveEffectiveTransport` to `"unset"` —
  // this is NOT a malformed input. The recognizer still resolves fully (a
  // real, explicitly-supported case: a hand-typed address with no transport
  // chosen), only `ANYCODE_RECOGNIZER_TRANSPORT` itself is left unemitted so
  // the host applies its own documented "anthropic-messages" default
  // downstream — the SAME default the primary provider path already shares.
  it("a bare connection with a real address and NO transport resolves fully — the transport var is simply not emitted, never a disabled recognizer", async () => {
    const bareNoTransportConnection = connectionFixture({
      connectionId: "conn-bare-vision-no-transport",
      baseUrl: "https://bare-no-transport.example.com",
    });
    const env = await buildHostEnv({
      bootEnv: {},
      settings: {
        ...settings(),
        provider: providerV2Multi(undefined, [bareNoTransportConnection]),
        recognizer: { connectionId: "conn-bare-vision-no-transport", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-bare-no-transport"),
    });
    expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://bare-no-transport.example.com");
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("vision-model");
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-bare-no-transport");
    expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBeUndefined();
  });

  it("an ambient ANYCODE_RECOGNIZER_* override in the boot env always wins (env > settings, same law as every other var here)", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_RECOGNIZER_MODEL: "shell-model" },
      settings: {
        ...settings(),
        provider: providerV2Multi(undefined, [visionConnection]),
        recognizer: { connectionId: "conn-vision", modelId: "vision-model" },
      },
      getSecret: vaultSecret("sk-vision"),
    });
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("shell-model");
  });

  // Recovery path (finding #1): buildHostEnv is a pure function of its
  // `settings` argument — a fork spawned AFTER a settings mutation that no
  // live host was around to receive as a push (the host crashed) still reads
  // the fresh value, with no dependency on any prior call or in-memory
  // broadcast/fingerprint state.
  it("is a pure function of settings — the NEXT fork always reads the current value regardless of any earlier call", async () => {
    const base = {
      ...settings(),
      provider: providerV2Multi(undefined, [visionConnection]),
      recognizer: { connectionId: "conn-vision", modelId: "model-a" },
    };
    const first = await buildHostEnv({ bootEnv: {}, settings: base, getSecret: vaultSecret("sk-1") });
    expect(first.ANYCODE_RECOGNIZER_MODEL).toBe("model-a");

    const updated = { ...base, recognizer: { connectionId: "conn-vision", modelId: "model-b" } };
    const second = await buildHostEnv({ bootEnv: {}, settings: updated, getSecret: vaultSecret("sk-1") });
    expect(second.ANYCODE_RECOGNIZER_MODEL).toBe("model-b");
  });

  // ⚠ Хвост от E1 (task198-state.md): resolveRecognizerConfig read
  // connection.baseUrl/a connection-scoped vault key directly and never
  // followed a `custom:<slug>` providerId to its CustomProviderRecord the
  // way buildHostEnv's own customId branch does above (line ~942) — a
  // recognizer pointed at a custom-provider connection got no baseUrl and no
  // credential at all, even though the record carried both.
  it("RED-PROOF: a custom-provider connection (providerId custom:<slug>) resolves baseUrl/apiKey from the CustomProviderRecord — mirrors buildHostEnv's own customId branch, not a second mechanism", async () => {
    const customConnection = connectionFixture({
      id: "custom:vision-slug",
      connectionId: "conn-vision-custom",
      model: "connection-level-model",
      // Deliberately no baseUrl of its own — only the CustomProviderRecord carries one.
    });
    const s: AnycodeSettings = {
      ...settings(),
      provider: providerV2Multi(undefined, [customConnection]),
      recognizer: { connectionId: "conn-vision-custom", modelId: "vision-model" },
    };
    s.provider.custom = [
      {
        id: "custom:vision-slug",
        name: "Vision endpoint",
        baseUrl: "https://vision-custom.example.com/v1",
        kind: "openai-compatible",
        models: ["vision-model"],
      },
    ];
    const reads: string[] = [];
    const env = await buildHostEnv({
      bootEnv: {},
      settings: s,
      getSecret: async (key) => {
        reads.push(key);
        return key === "provider.custom:vision-slug.apiKey" ? "sk-custom-vision" : undefined;
      },
    });
    expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://vision-custom.example.com/v1");
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-custom-vision");
    expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("vision-model");
    // The connection-scoped namespace must never be consulted for a custom
    // provider — mirrors buildHostEnv's own "ONE shared provider key" test.
    expect(reads.some((key) => key.startsWith("provider.connection."))).toBe(false);
  });

  it("RED-PROOF: a DELETED custom-provider record fails closed for the recognizer too — never falls back to the connection-scoped key", async () => {
    const customConnection = connectionFixture({
      id: "custom:gone-slug",
      connectionId: "conn-vision-gone",
      model: "connection-level-model",
    });
    const s: AnycodeSettings = {
      ...settings(),
      provider: providerV2Multi(undefined, [customConnection]),
      recognizer: { connectionId: "conn-vision-gone", modelId: "vision-model" },
    };
    // No `s.provider.custom` entry — the record was deleted.
    const reads: string[] = [];
    const env = await buildHostEnv({
      bootEnv: {},
      settings: s,
      getSecret: async (key) => {
        reads.push(key);
        return "sk-should-never-be-read";
      },
    });
    expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBeUndefined();
    expect(env.ANYCODE_RECOGNIZER_API_KEY).toBeUndefined();
    expect(reads.some((key) => key.startsWith("provider.connection."))).toBe(false);
  });

  // Live-run regression (task150-output-ceiling session, TASK.198 follow-up):
  // a CATALOG connection's own baseUrl/transport can be blank (`z-ai`/`kimi`
  // in real settings.json carry `baseUrl: ""` and no `transport` key at all —
  // the real endpoint lives in the CATALOG, mirrored today only for the
  // PRIMARY provider ladder via `ResolvedProviderSelection`/`resolveCatalog`,
  // never for the recognizer). Without a catalog fallback, `InspectImage`
  // registered and then failed twice with "Invalid Anthropic base URL: ''"
  // (resolved transport defaulted to anthropic-messages downstream). Mirrors
  // provider-ipc.ts's `handleConnectionFetchModels` resolution verbatim:
  // `connection.baseUrl?.trim() ? ... : entry.baseUrl` /
  // `connection.transport ?? entry.defaultTransport`.
  describe("catalog fallback for a blank connection baseUrl/transport (live-run fix)", () => {
    it("RED: falls back to the catalog's baseUrl/defaultTransport when the connection's own fields are blank/absent", async () => {
      const zaiConnection = connectionFixture({
        id: "z-ai",
        connectionId: "conn-vision-zai",
        // Deliberately mirrors the live settings.json record: blank baseUrl,
        // no `transport` key at all.
        baseUrl: "",
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [zaiConnection]),
          recognizer: { connectionId: "conn-vision-zai", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-zai-vision"),
        recognizerCatalogFor: (id) =>
          id === "z-ai" ? { baseUrl: "https://api.z.ai/api/anthropic", defaultTransport: "anthropic-messages" } : undefined,
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://api.z.ai/api/anthropic");
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBe("anthropic-messages");
      expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-zai-vision");
    });

    it("a catalog connection's OWN non-blank baseUrl/transport still win over the catalog default", async () => {
      const overrideConnection = connectionFixture({
        id: "z-ai",
        connectionId: "conn-vision-zai-override",
        baseUrl: "https://z.example.internal/proxy",
        transport: "anthropic-messages",
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [overrideConnection]),
          recognizer: { connectionId: "conn-vision-zai-override", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-zai-vision-2"),
        recognizerCatalogFor: () => ({ baseUrl: "https://api.z.ai/api/anthropic", defaultTransport: "openai-chat-completions" }),
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://z.example.internal/proxy");
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBe("anthropic-messages");
    });

    // Measurement-trap guard: `z-ai`'s/`kimi`'s catalog `defaultTransport` is
    // `"anthropic-messages"` — the SAME value the old, buggy hardcoded
    // default happened to produce, so a test built on them cannot tell
    // "resolved from the catalog" apart from "fell through to the default and
    // coincidentally matched". This one uses an openai-FAMILY catalog entry
    // (`openai`, `defaultTransport: "openai-responses"` — packages/core/src/
    // provider/catalog-data.ts) specifically so the asserted value can only
    // have come from the catalog ladder.
    it("resolves the catalog's defaultTransport for an openai-family provider — a value the old hardcoded anthropic default could never produce", async () => {
      const openaiConnection = connectionFixture({
        id: "openai",
        connectionId: "conn-vision-openai",
        baseUrl: "",
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [openaiConnection]),
          recognizer: { connectionId: "conn-vision-openai", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-openai-vision"),
        recognizerCatalogFor: (id) =>
          id === "openai" ? { baseUrl: "https://api.openai.com/v1", defaultTransport: "openai-responses" } : undefined,
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://api.openai.com/v1");
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBe("openai-responses");
    });

    // Pinned behavior (transport-ladder fix): an unresolvable transport
    // (`resolveEffectiveTransport` reaching `source: "unset"` — no
    // connection-level override AND no catalog default) does NOT disable a
    // recognizer whose address DID resolve — it only leaves the transport
    // var unemitted, mirroring the primary provider path's own handling of
    // "unset" (nothing emitted, the host applies its shared default).
    it("an unresolvable transport (no connection transport, no catalog default) leaves ANYCODE_RECOGNIZER_TRANSPORT unset — the resolvable address/model/key still come through", async () => {
      const noTransportConnection = connectionFixture({
        id: "unknown-legacy-provider",
        connectionId: "conn-vision-no-transport",
        baseUrl: "https://legacy.example.com",
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [noTransportConnection]),
          recognizer: { connectionId: "conn-vision-no-transport", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-legacy-no-transport"),
        recognizerCatalogFor: () => undefined,
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://legacy.example.com");
      expect(env.ANYCODE_RECOGNIZER_MODEL).toBe("vision-model");
      expect(env.ANYCODE_RECOGNIZER_API_KEY).toBe("sk-legacy-no-transport");
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBeUndefined();
    });

    it("an unknown/legacy providerId (absent from the catalog) keeps today's connection-verbatim behavior — no invented values", async () => {
      const legacyConnection = connectionFixture({
        id: "legacy-provider-no-longer-in-catalog",
        connectionId: "conn-vision-legacy",
        baseUrl: "https://legacy.example.com",
        transport: "openai-responses",
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [legacyConnection]),
          recognizer: { connectionId: "conn-vision-legacy", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-legacy-vision"),
        recognizerCatalogFor: () => undefined,
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://legacy.example.com");
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBe("openai-responses");
    });

    it("RED: a custom-provider connection never consults the catalog — the CustomProviderRecord fail-closed posture is unchanged", async () => {
      const customConnection = connectionFixture({
        id: "custom:vision-slug-2",
        connectionId: "conn-vision-custom-2",
      });
      const s: AnycodeSettings = {
        ...settings(),
        provider: providerV2Multi(undefined, [customConnection]),
        recognizer: { connectionId: "conn-vision-custom-2", modelId: "vision-model" },
      };
      s.provider.custom = [
        { id: "custom:vision-slug-2", name: "Vision endpoint 2", baseUrl: "https://vision-custom-2.example.com/v1", kind: "openai-compatible", models: [] },
      ];
      let catalogForCalled = false;
      const env = await buildHostEnv({
        bootEnv: {},
        settings: s,
        getSecret: async (key) => (key === "provider.custom:vision-slug-2.apiKey" ? "sk-custom-vision-2" : undefined),
        recognizerCatalogFor: () => {
          catalogForCalled = true;
          return { baseUrl: "https://should-never-be-used.example.com" };
        },
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBe("https://vision-custom-2.example.com/v1");
      expect(catalogForCalled).toBe(false);
    });

    it("RED: a resolved-but-still-blank address (an unconfigured needsBaseUrl catalog template, e.g. vLLM) disables the recognizer entirely — a broken tool must never register", async () => {
      const vllmConnection = connectionFixture({
        id: "vllm",
        connectionId: "conn-vision-vllm",
        // No baseUrl of its own either — mirrors an unconfigured needsBaseUrl
        // catalog template (vLLM/the bare `custom` sentinel).
      });
      const env = await buildHostEnv({
        bootEnv: {},
        settings: {
          ...settings(),
          provider: providerV2Multi(undefined, [vllmConnection]),
          recognizer: { connectionId: "conn-vision-vllm", modelId: "vision-model" },
        },
        getSecret: vaultSecret("sk-should-never-be-read"),
        recognizerCatalogFor: (id) => (id === "vllm" ? { baseUrl: "", defaultTransport: "openai-chat-completions" } : undefined),
      });
      expect(env.ANYCODE_RECOGNIZER_BASE_URL).toBeUndefined();
      expect(env.ANYCODE_RECOGNIZER_API_KEY).toBeUndefined();
      expect(env.ANYCODE_RECOGNIZER_MODEL).toBeUndefined();
      expect(env.ANYCODE_RECOGNIZER_TRANSPORT).toBeUndefined();
    });
  });
});

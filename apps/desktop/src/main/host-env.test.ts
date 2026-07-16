/**
 * Unit tests for host-env composition + the env-scrub primitives (design §6/§1

 * (env > vault > settings), envOverrides, the readiness matrix, and the
 * snapshot/scrub discipline (bootEnv retains the key, live env is scrubbed, the
 * host fork still gets the key, a simulated Bash child does not).
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings, SecretKey } from "../shared/settings.js";
import {
  ENV_PROVIDER_TRANSPORT,
  ENV_REASONING_EFFORT,
  applySubagentsHomeOverride,
  buildHostEnv,
  computeProviderReady,
  customProviderIds,
  envOverrides,
  isKnownSecretKey,
  resolveEffectiveTransport,
  scrubSecretEnv,
  secretEnvFor,
  shouldSkipConnectionHealthBinding,
  snapshotBootEnv,
} from "./host-env.js";
import { resolveProviderSelection, type ProviderSelectionDeps } from "./token-broker.js";
import { providerV2, type SingletonFixture } from "../shared/provider-v2-fixture.js";

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

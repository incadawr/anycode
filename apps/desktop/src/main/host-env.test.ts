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
  envOverrides,
  isKnownSecretKey,
  scrubSecretEnv,
  secretEnvFor,
  snapshotBootEnv,
} from "./host-env.js";

function settings(over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return {
    version: 1,
    provider: {},
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...over,
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

describe("buildHostEnv — provider.defaults inheritance (F14, slice-P7.15-cut.md §2.4)", () => {
  it("legacy/custom path: defaults['custom'].model wins over provider.model when no provider.id", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({
        provider: { model: "settings-model", defaults: { custom: { model: "persisted-model" } } },
      }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_MODEL).toBe("persisted-model");
  });

  it("legacy/custom path: falls back to provider.model when no matching default entry", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({
        provider: { model: "settings-model", defaults: { "z-ai": { model: "other-provider-model" } } },
      }),
      getSecret: noSecret,
    });
    expect(env.ANYCODE_MODEL).toBe("settings-model");
  });

  it("sets ANYCODE_REASONING_EFFORT from defaults[pid] on the legacy/custom path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { defaults: { custom: { reasoningEffort: "high" } } } }),
      getSecret: noSecret,
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("high");
  });

  it("keys the default lookup by provider.id when set (not 'custom')", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({
        provider: { id: "z-ai", defaults: { custom: { reasoningEffort: "high" }, "z-ai": { reasoningEffort: "max" } } },
      }),
      getSecret: noSecret,
      resolveSelection: async () => undefined, // e.g. custom/legacy-folding provider.id
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("max");
  });

  it("sets ANYCODE_REASONING_EFFORT on the catalog selection path too (provider-keyed, not selection-keyed)", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings({ provider: { id: "z-ai", defaults: { "z-ai": { reasoningEffort: "high" } } } }),
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

  it("env still wins over the persisted effort default (I2 unchanged)", async () => {
    const env = await buildHostEnv({
      bootEnv: { ANYCODE_REASONING_EFFORT: "low" },
      settings: settings({ provider: { defaults: { custom: { reasoningEffort: "max" } } } }),
      getSecret: noSecret,
    });
    expect(env[ENV_REASONING_EFFORT]).toBe("low");
  });

  it("leaves ANYCODE_REASONING_EFFORT unset when no default is persisted (no drop to a hardcoded literal)", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env[ENV_REASONING_EFFORT]).toBeUndefined();
  });

  it("an old settings.json with no provider.defaults behaves exactly as before (backward-compat)", async () => {
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

  it("fills the transport from the resolved selection on the catalog path", async () => {
    const env = await buildHostEnv({
      bootEnv: {},
      settings: settings(),
      getSecret: noSecret,
      resolveSelection: async () => ({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1",
        apiKey: "sk-openai",
        authKind: "api_key",
        transport: "openai-responses",
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
        transport: "openai-responses",
      }),
    });
    expect(catalog[ENV_PROVIDER_TRANSPORT]).toBe("anthropic-messages");
  });

  it("leaves the var unset when neither env, settings, nor the selection carries a transport", async () => {
    const env = await buildHostEnv({ bootEnv: {}, settings: settings(), getSecret: noSecret });
    expect(env[ENV_PROVIDER_TRANSPORT]).toBeUndefined();
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

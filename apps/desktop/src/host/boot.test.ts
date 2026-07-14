/**
 * Tests for the slice-2.2.3 boot additions (design slice-2.2-cut.md §5,
 * reviews/slice-2.2-forks-ruling.md §3):
 *
 *  - seedAlwaysAllowRules: a persisted `permissions.alwaysAllow` array seeds a
 *    SessionPermissionRules that behaves identically to whatever cli/main.ts's
 *    /allow wiring would produce; fail-soft on a missing/corrupt settings.json.
 *  - scrubSecretEnv: deletes SECRET_ENV_KEYS from a live env object, leaves
 *    everything else (including other ANYCODE_* vars) untouched, idempotent.
 *  - An integration-style reproduction of index.ts's boot() try/catch/finally
 *    shape (index.ts itself is not importable in a test — it touches
 *    process.parentPort at module scope, same reason boot.ts's helpers were
 *    split out in the first place): proves the model port still holds the key
 *    in its closure after the scrub, that a real Bash child spawned via
 *    node-execution.ts's exact env-composition no longer inherits it, and that
 *    the scrub still runs when the try block throws (init-failure path); this
 *    now covers BOTH the apiKey-mode and the oauth-mode wiring (slice 2.5.3).
 *
 * Tests for the slice-2.5.3 MainCredentialProvider (design slice-2.5-cut.md
 * §3.3): `createMainCredentialProvider` (parentPort req/resp, requestId
 * correlation, TTL cache, timeout->fallback) and `buildResolveApiKey` (the
 * apiKey-mode/oauth-mode wiring gate).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelPort, NodeExecutionAdapter } from "@anycode/core";
import { CREDENTIAL_RESPONSE_TYPE, type CredentialRequest, type CredentialResponse } from "../shared/credentials.js";
import {
  buildResolveApiKey,
  createMainCredentialProvider,
  hostDiagnosticSink,
  scrubSecretEnv,
  seedAlwaysAllowRules,
} from "./boot.js";

describe("seedAlwaysAllowRules", () => {
  let dir: string;
  const settingsPath = () => join(dir, "settings.json");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anycode-boot-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("seeds a persisted rule so a matching tool auto-allows from the very first check", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({
        version: 1,
        provider: {},
        tools: {},
        permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
      "utf8",
    );

    const rules = await seedAlwaysAllowRules(settingsPath());
    expect(rules.list()).toEqual([{ toolName: "Bash", pattern: "git *" }]);
    expect(rules.matches("Bash", { command: "git status" })).toBe(true);
    expect(rules.matches("Bash", { command: "rm -rf /" })).toBe(false);
  });

  it("seeds a pattern-less rule (matches the tool regardless of input)", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({
        version: 1,
        provider: {},
        tools: {},
        permissions: { alwaysAllow: [{ toolName: "WebFetch" }] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
      "utf8",
    );

    const rules = await seedAlwaysAllowRules(settingsPath());
    expect(rules.list()).toEqual([{ toolName: "WebFetch" }]);
    expect(rules.matches("WebFetch", { url: "https://example.com" })).toBe(true);
  });

  it("missing settings.json -> empty rules, never throws (fail-soft)", async () => {
    const rules = await seedAlwaysAllowRules(join(dir, "does-not-exist.json"));
    expect(rules.list()).toEqual([]);
  });

  it("corrupt JSON settings.json -> empty rules, never throws (fail-soft)", async () => {
    await writeFile(settingsPath(), "{ not valid json", "utf8");
    const rules = await seedAlwaysAllowRules(settingsPath());
    expect(rules.list()).toEqual([]);
  });

  it("schema-invalid settings.json -> empty rules, never throws (fail-soft)", async () => {
    await writeFile(settingsPath(), JSON.stringify({ version: 1, garbage: true }), "utf8");
    const rules = await seedAlwaysAllowRules(settingsPath());
    expect(rules.list()).toEqual([]);
  });
});

describe("scrubSecretEnv", () => {
  it("deletes ANYCODE_API_KEY but leaves non-secret ANYCODE_* vars and unrelated vars untouched", () => {
    const env = {
      ANYCODE_API_KEY: "sk-secret",
      ANYCODE_MODEL: "claude-x",
      ANYCODE_BASE_URL: "https://example.com",
      ANYCODE_AUTOMATION: "1",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;

    scrubSecretEnv(env);

    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_MODEL).toBe("claude-x");
    expect(env.ANYCODE_BASE_URL).toBe("https://example.com");
    expect(env.ANYCODE_AUTOMATION).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("is a safe no-op / idempotent on an env that never had the key", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(() => scrubSecretEnv(env)).not.toThrow();
    expect(() => scrubSecretEnv(env)).not.toThrow();
    expect(env.ANYCODE_API_KEY).toBeUndefined();
  });

  it("defaults to scrubbing the real process.env when called with no argument", () => {
    const original = process.env.ANYCODE_API_KEY;
    process.env.ANYCODE_API_KEY = "sk-test-default-arg";
    try {
      scrubSecretEnv();
      expect(process.env.ANYCODE_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ANYCODE_API_KEY;
      } else {
        process.env.ANYCODE_API_KEY = original;
      }
    }
  });
});

// ── integration: mirrors index.ts's boot() try/catch/finally shape exactly,
// without importing index.ts (it touches process.parentPort at module scope,
// which does not exist outside a real utilityProcess) ──

describe("boot() env-scrub integration (mirrors index.ts's try/catch/finally)", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANYCODE_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANYCODE_API_KEY;
    } else {
      process.env.ANYCODE_API_KEY = originalApiKey;
    }
  });

  it("success path: process.env is scrubbed, the model port still holds the key, a real Bash child no longer inherits it", async () => {
    process.env.ANYCODE_API_KEY = "sk-test-success-path";

    let modelPort: AiSdkModelPort | undefined;
    try {
      // Mirrors index.ts:120-124 — the key is read from process.env and
      // captured into AiSdkModelPort's constructor-held config BEFORE scrub.
      modelPort = new AiSdkModelPort({
        transport: "anthropic-messages",
        baseUrl: "https://example.com",
        apiKey: process.env.ANYCODE_API_KEY,
        model: "test-model",
      });
    } finally {
      scrubSecretEnv();
    }

    expect(process.env.ANYCODE_API_KEY).toBeUndefined();
    // TS privacy on AiSdkModelPort's `config` field is compile-time only; the
    // runtime object still carries it — proving the port itself is unaffected
    // by the scrub (it never re-reads process.env after construction).
    const capturedApiKey = (modelPort as unknown as { config: { apiKey: string } }).config.apiKey;
    expect(capturedApiKey).toBe("sk-test-success-path");

    // Real proof of the closed exfil vector: node-execution.ts:92 builds a
    // Bash child's env as `{...process.env, ...request.env}`. Now that
    // process.env has been scrubbed (as it always is by the time a turn --
    // hence a tool -- can run), that child genuinely does not see the key.
    const exec = new NodeExecutionAdapter();
    const result = await exec.run({
      command: "echo \"[$ANYCODE_API_KEY]\"",
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe("[]");
  });

  it("init-failure path: the finally block still scrubs process.env when the try block throws", () => {
    process.env.ANYCODE_API_KEY = "sk-test-init-failure-path";

    let caught: unknown;
    try {
      try {
        // Mirrors a mid-boot failure AFTER the model port has already captured
        // the key (e.g. persistence open failure further down boot()).
        new AiSdkModelPort({
          transport: "anthropic-messages",
          baseUrl: "https://example.com",
          apiKey: process.env.ANYCODE_API_KEY,
          model: "test-model",
        });
        throw new Error("simulated init failure (e.g. SqlitePersistenceAdapter open)");
      } finally {
        scrubSecretEnv();
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(process.env.ANYCODE_API_KEY).toBeUndefined();
  });

  it("oauth-mode success path: scrub still runs, resolveApiKey survives the scrub (its fallback is captured by value, not read from process.env), Bash child still doesn't inherit the key", async () => {
    process.env.ANYCODE_API_KEY = "sk-test-oauth-success-path";

    let modelPort: AiSdkModelPort | undefined;
    try {
      // Mirrors index.ts's boot(): buildResolveApiKey({authMode: "oauth", ...})
      // wires resolveApiKey INTO AiSdkModelPort before the finally-block scrub.
      const resolveApiKey = buildResolveApiKey({
        authMode: "oauth",
        send: () => {},
        // No response ever arrives; a short timeoutMs keeps this unit test
        // fast — the request/response/TTL semantics themselves are exercised
        // in the "createMainCredentialProvider" suite below.
        subscribe: () => () => {},
        timeoutMs: 10,
        fallbackApiKey: process.env.ANYCODE_API_KEY,
      });
      modelPort = new AiSdkModelPort({
        transport: "anthropic-messages",
        baseUrl: "https://example.com",
        apiKey: process.env.ANYCODE_API_KEY,
        model: "test-model",
        resolveApiKey,
      });
    } finally {
      scrubSecretEnv();
    }

    expect(process.env.ANYCODE_API_KEY).toBeUndefined();
    const config = (modelPort as unknown as { config: { apiKey: string; resolveApiKey?: () => Promise<string> } })
      .config;
    expect(config.apiKey).toBe("sk-test-oauth-success-path");
    expect(config.resolveApiKey).toBeInstanceOf(Function);
    // The resolver's fallback was captured by value at construction time (out
    // of a local variable, not a live process.env read), so it still resolves
    // correctly after the scrub — proving the scrub doesn't break oauth mode.
    await expect(config.resolveApiKey?.()).resolves.toBe("sk-test-oauth-success-path");

    const exec = new NodeExecutionAdapter();
    const result = await exec.run({
      command: "echo \"[$ANYCODE_API_KEY]\"",
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe("[]");
  });

  it("oauth-mode init-failure path: the finally block still scrubs process.env when the try block throws after resolveApiKey is wired", () => {
    process.env.ANYCODE_API_KEY = "sk-test-oauth-init-failure-path";

    let caught: unknown;
    try {
      try {
        const resolveApiKey = buildResolveApiKey({
          authMode: "oauth",
          send: () => {},
          subscribe: () => () => {},
          fallbackApiKey: process.env.ANYCODE_API_KEY,
        });
        new AiSdkModelPort({
          transport: "anthropic-messages",
          baseUrl: "https://example.com",
          apiKey: process.env.ANYCODE_API_KEY,
          model: "test-model",
          resolveApiKey,
        });
        throw new Error("simulated init failure (e.g. SqlitePersistenceAdapter open)");
      } finally {
        scrubSecretEnv();
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(process.env.ANYCODE_API_KEY).toBeUndefined();
  });
});

describe("buildResolveApiKey (wiring gate, design §3.3)", () => {
  const baseOptions = {
    send: (() => {}) as (request: CredentialRequest) => void,
    subscribe: (() => () => {}) as (listener: (response: CredentialResponse) => void) => () => void,
    fallbackApiKey: "sk-fallback",
  };

  it("authMode undefined (apiKey-mode, no ANYCODE_AUTH_MODE set) -> returns undefined", () => {
    expect(buildResolveApiKey({ authMode: undefined, ...baseOptions })).toBeUndefined();
  });

  it("authMode anything other than 'oauth' -> returns undefined (byte-for-byte apiKey-mode)", () => {
    expect(buildResolveApiKey({ authMode: "", ...baseOptions })).toBeUndefined();
    expect(buildResolveApiKey({ authMode: "apiKey", ...baseOptions })).toBeUndefined();
  });

  it("authMode 'oauth' -> returns a resolveApiKey function", () => {
    const resolveApiKey = buildResolveApiKey({ authMode: "oauth", ...baseOptions });
    expect(resolveApiKey).toBeInstanceOf(Function);
  });

  it("AiSdkModelPort config omits the `resolveApiKey` key entirely in apiKey-mode (not just undefined-valued) — byte-for-byte 2.2 config shape", () => {
    const resolveApiKey = buildResolveApiKey({ authMode: undefined, ...baseOptions });
    const config: Record<string, unknown> = {
      baseUrl: "https://example.com",
      apiKey: "sk-static",
      model: "test-model",
      ...(resolveApiKey !== undefined ? { resolveApiKey } : {}),
    };
    expect("resolveApiKey" in config).toBe(false);
  });
});

describe("createMainCredentialProvider (design §3.3)", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("sends a CREDENTIAL_REQUEST and resolves with the response apiKey; a second call within the TTL window sends no new request (caches)", async () => {
    const sent: CredentialRequest[] = [];
    let listener: ((response: CredentialResponse) => void) | undefined;
    let unsubscribed = false;

    const resolveApiKey = createMainCredentialProvider({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        return () => {
          unsubscribed = true;
        };
      },
      fallbackApiKey: "sk-fallback",
      ttlMs: 60_000,
    });

    const first = resolveApiKey();
    expect(sent).toHaveLength(1);
    expect(unsubscribed).toBe(false);

    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[0]!.requestId, apiKey: "sk-fresh-token" });
    await expect(first).resolves.toBe("sk-fresh-token");
    expect(unsubscribed).toBe(true);

    // Second call within the TTL window: cached, no new send.
    await expect(resolveApiKey()).resolves.toBe("sk-fresh-token");
    expect(sent).toHaveLength(1);
  });

  it("a request that times out resolves with the fallback apiKey (never rejects) and is NOT cached (the next call re-asks main)", async () => {
    vi.useFakeTimers();
    try {
      const sent: CredentialRequest[] = [];
      const resolveApiKey = createMainCredentialProvider({
        send: (request) => sent.push(request),
        subscribe: () => () => {},
        fallbackApiKey: "sk-env-fallback",
        timeoutMs: 5_000,
      });

      const pending = resolveApiKey();
      const assertion = expect(pending).resolves.toBe("sk-env-fallback");
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(sent).toHaveLength(1);

      // Fallback is not cached: the very next call asks main again.
      const secondPending = resolveApiKey();
      const secondAssertion = expect(secondPending).resolves.toBe("sk-env-fallback");
      await vi.advanceTimersByTimeAsync(5_000);
      await secondAssertion;
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a response with a blank/whitespace apiKey falls back without caching (never rejects)", async () => {
    let listener: ((response: CredentialResponse) => void) | undefined;
    const sent: CredentialRequest[] = [];

    const resolveApiKey = createMainCredentialProvider({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      fallbackApiKey: "sk-env-fallback",
    });

    const first = resolveApiKey();
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[0]!.requestId, apiKey: "   " });
    await expect(first).resolves.toBe("sk-env-fallback");

    // Not cached -> the next call sends a new request.
    resolveApiKey();
    expect(sent).toHaveLength(2);
  });

  it("a response with apiKey absent (undefined) falls back without caching", async () => {
    let listener: ((response: CredentialResponse) => void) | undefined;
    const sent: CredentialRequest[] = [];

    const resolveApiKey = createMainCredentialProvider({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      fallbackApiKey: "sk-env-fallback",
    });

    const first = resolveApiKey();
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[0]!.requestId });
    await expect(first).resolves.toBe("sk-env-fallback");
  });

  it("correlates by requestId: an unrelated response (stale/other request) is ignored", async () => {
    let listener: ((response: CredentialResponse) => void) | undefined;
    const sent: CredentialRequest[] = [];

    const resolveApiKey = createMainCredentialProvider({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      fallbackApiKey: "sk-env-fallback",
    });

    const { promise, resolve } = deferred<void>();
    const pending = resolveApiKey().then((apiKey) => {
      resolve();
      return apiKey;
    });

    // An unrelated response (wrong requestId) must not settle this call.
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: "some-other-request-id", apiKey: "sk-wrong" });
    let settledEarly = false;
    void promise.then(() => {
      settledEarly = true;
    });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    // The matching response settles it correctly.
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[0]!.requestId, apiKey: "sk-correct" });
    await expect(pending).resolves.toBe("sk-correct");
  });

  it("cache expiry: after the TTL window elapses, the next call re-asks main", async () => {
    let listener: ((response: CredentialResponse) => void) | undefined;
    const sent: CredentialRequest[] = [];
    let clock = 0;

    const resolveApiKey = createMainCredentialProvider({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      fallbackApiKey: "sk-env-fallback",
      ttlMs: 60_000,
      now: () => clock,
    });

    const first = resolveApiKey();
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[0]!.requestId, apiKey: "sk-token-1" });
    await expect(first).resolves.toBe("sk-token-1");
    expect(sent).toHaveLength(1);

    // Still within the TTL window: cached.
    clock += 59_000;
    await expect(resolveApiKey()).resolves.toBe("sk-token-1");
    expect(sent).toHaveLength(1);

    // Past the TTL window: re-asks main.
    clock += 2_000;
    const second = resolveApiKey();
    expect(sent).toHaveLength(2);
    listener?.({ type: CREDENTIAL_RESPONSE_TYPE, requestId: sent[1]!.requestId, apiKey: "sk-token-2" });
    await expect(second).resolves.toBe("sk-token-2");
  });
});

describe("hostDiagnosticSink (slice 6.DP-1, §6#7)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a provider_stream_artifact event emits EXACTLY the frozen '[host] dropping unparsable provider stream artifact: <sig>' format", () => {
    hostDiagnosticSink({ kind: "provider_stream_artifact", signature: "sha256:deadbeef" });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[host] dropping unparsable provider stream artifact: sha256:deadbeef",
    );
  });
});

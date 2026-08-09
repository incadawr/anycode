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
import { AiSdkModelPort, NodeExecutionAdapter, SqlitePersistenceAdapter } from "@anycode/core";
import { CREDENTIAL_RESPONSE_TYPE, type CredentialRequest, type CredentialResponse } from "../shared/credentials.js";
import {
  PREVIEW_EVENT_TYPE,
  PREVIEW_RESPONSE_TYPE,
  type PreviewEventMessage,
  type PreviewRequestMessage,
  type PreviewResponseMessage,
} from "../shared/preview.js";
import {
  buildResolveApiKey,
  createMainCredentialProvider,
  createPreviewRpcClient,
  hostDiagnosticSink,
  parseHostArgs,
  resolveBootSession,
  routePreviewMessage,
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

describe("createPreviewRpcClient (night-track wave-1 cut §2.3)", () => {
  function harness(overrides?: { timeoutMs?: number }) {
    const sent: PreviewRequestMessage[] = [];
    let listener: ((response: PreviewResponseMessage) => void) | undefined;
    let unsubscribed = false;

    const port = createPreviewRpcClient({
      send: (request) => sent.push(request),
      subscribe: (cb) => {
        listener = cb;
        unsubscribed = false;
        return () => {
          unsubscribed = true;
        };
      },
      ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    });

    return {
      port,
      sent,
      respond: (result: PreviewResponseMessage["result"], requestId?: string) => {
        listener?.({
          type: PREVIEW_RESPONSE_TYPE,
          requestId: requestId ?? sent[sent.length - 1]!.requestId,
          result,
        });
      },
      isUnsubscribed: () => unsubscribed,
    };
  }

  it("open() sends an 'open' op and resolves with the correlated response value", async () => {
    const { port, sent, respond } = harness();
    const pending = port.open({ path: "/repo/index.html" }, { signal: new AbortController().signal });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: { kind: "open", path: "/repo/index.html" } });
    expect(sent[0]!.op).not.toHaveProperty("allowRemote");

    respond({ ok: true, value: { previewId: "p1", url: "file:///repo/index.html", kind: "file" } });
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { previewId: "p1", url: "file:///repo/index.html", kind: "file" },
    });
  });

  it("open() forwards allowRemote:true ONLY when the caller passed it", async () => {
    const { sent, port } = harness();
    void port.open({ url: "https://example.com" }, { signal: new AbortController().signal, allowRemote: true });
    expect(sent[0]!.op).toMatchObject({ kind: "open", allowRemote: true });
  });

  it("read() sends every optional field under its wire name", async () => {
    const { sent, port, respond } = harness();
    const pending = port.read(
      { previewId: "p1", selector: "#app", format: "html", waitForSelector: "#ready", waitMs: 250, includeConsole: false },
      { signal: new AbortController().signal },
    );
    expect(sent[0]).toMatchObject({
      op: {
        kind: "read",
        previewId: "p1",
        selector: "#app",
        format: "html",
        waitForSelector: "#ready",
        waitMs: 250,
        includeConsole: false,
      },
    });
    respond({ ok: true, value: { previewId: "p1", url: "file:///x", text: "hi" } });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("screenshot() sends a 'screenshot' op", async () => {
    const { sent, port, respond } = harness();
    const pending = port.screenshot({ previewId: "p1" }, { signal: new AbortController().signal });
    expect(sent[0]).toMatchObject({ op: { kind: "screenshot", previewId: "p1" } });
    respond({
      ok: true,
      value: { previewId: "p1", url: "file:///x", mediaType: "image/png", data: "abc", width: 10, height: 10 },
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("correlates by requestId: an unrelated response is ignored, the matching one settles it", async () => {
    const { port, sent, respond } = harness();
    const pending = port.read({}, { signal: new AbortController().signal });

    respond({ ok: true, value: { previewId: "wrong", url: "file:///x", text: "nope" } }, "some-other-request-id");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    respond({ ok: true, value: { previewId: "p1", url: "file:///x", text: "yes" } }, sent[0]!.requestId);
    await expect(pending).resolves.toMatchObject({ ok: true, value: { text: "yes" } });
  });

  it("unsubscribes once the matching response arrives (no leaked listeners)", async () => {
    const { port, respond, isUnsubscribed } = harness();
    const pending = port.read({}, { signal: new AbortController().signal });
    expect(isUnsubscribed()).toBe(false);
    respond({ ok: true, value: { previewId: "p1", url: "file:///x", text: "hi" } });
    await pending;
    expect(isUnsubscribed()).toBe(true);
  });

  it("times out after the configured window with an honest {ok:false, errorKind:'timeout'} (never rejects)", async () => {
    vi.useFakeTimers();
    try {
      const { port } = harness({ timeoutMs: 45_000 });
      const pending = port.read({}, { signal: new AbortController().signal });
      const assertion = expect(pending).resolves.toMatchObject({ ok: false, errorKind: "timeout" });
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults the timeout to PREVIEW_REQUEST_TIMEOUT_MS (45s) when unset", async () => {
    vi.useFakeTimers();
    try {
      const { port } = harness();
      const pending = port.read({}, { signal: new AbortController().signal });
      const assertion = expect(pending).resolves.toMatchObject({ ok: false, errorKind: "timeout" });
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an already-aborted signal resolves cancelled immediately without sending a request", async () => {
    const { port, sent } = harness();
    const controller = new AbortController();
    controller.abort();

    const result = await port.open({ path: "/x.html" }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorKind: "cancelled" });
    expect(sent).toHaveLength(0);
  });

  it("aborting mid-flight resolves cancelled and unsubscribes (no response ever arrives)", async () => {
    const { port, sent, isUnsubscribed } = harness();
    const controller = new AbortController();

    const pending = port.read({}, { signal: controller.signal });
    expect(sent).toHaveLength(1);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, errorKind: "cancelled" });
    expect(isUnsubscribed()).toBe(true);
  });
});

describe("routePreviewMessage (night-track wave-1 cut §2.3 parentPort filter)", () => {
  it("recognizes PREVIEW_RESPONSE_TYPE and fans it out to onResponse, returning true", () => {
    const received: PreviewResponseMessage[] = [];
    const message: PreviewResponseMessage = {
      type: PREVIEW_RESPONSE_TYPE,
      requestId: "r1",
      result: { ok: true, value: { previewId: "p1", url: "file:///x", kind: "file" } },
    };

    const matched = routePreviewMessage(message, { onResponse: (m) => received.push(m) });

    expect(matched).toBe(true);
    expect(received).toEqual([message]);
  });

  it("recognizes PREVIEW_EVENT_TYPE as a seam: returns true and calls onEvent when provided", () => {
    const received: PreviewEventMessage[] = [];
    const message: PreviewEventMessage = {
      type: PREVIEW_EVENT_TYPE,
      previewId: "p1",
      entry: { level: "error", message: "boom", at: "2026-08-01T00:00:00.000Z" },
    };

    const matched = routePreviewMessage(message, {
      onResponse: () => {
        throw new Error("must not be called for an event message");
      },
      onEvent: (m) => received.push(m),
    });

    expect(matched).toBe(true);
    expect(received).toEqual([message]);
  });

  it("PREVIEW_EVENT_TYPE with no onEvent consumer registered is still recognized (silent no-op seam, slice 96-D not built)", () => {
    const message: PreviewEventMessage = {
      type: PREVIEW_EVENT_TYPE,
      previewId: "p1",
      entry: { level: "log", message: "hi", at: "2026-08-01T00:00:00.000Z" },
    };

    const matched = routePreviewMessage(message, {
      onResponse: () => {
        throw new Error("must not be called for an event message");
      },
    });

    expect(matched).toBe(true);
  });

  it("an unrelated message type, and non-object data, are both left unmatched", () => {
    const onResponse = vi.fn();
    expect(routePreviewMessage({ type: "anycode:credential-response" }, { onResponse })).toBe(false);
    expect(routePreviewMessage({ type: "shutdown" }, { onResponse })).toBe(false);
    expect(routePreviewMessage(undefined, { onResponse })).toBe(false);
    expect(routePreviewMessage(null, { onResponse })).toBe(false);
    expect(routePreviewMessage("just a string", { onResponse })).toBe(false);
    expect(onResponse).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TASK.102 CUT-S2 §2.6.2 (slice S2b B4): child-mode argv + resolveBootSession
// ═════════════════════════════════════════════════════════════════════════════

describe("parseHostArgs — child-mode flags (TASK.102 CUT-S2 §2.6.2)", () => {
  it("parses --child-parent/--child-spawn-call/--child-mode (space form) into args.child", () => {
    const result = parseHostArgs([
      "--session",
      "child-1",
      "--child-parent",
      "parent-1",
      "--child-spawn-call",
      "call-1",
      "--child-mode",
      "plan",
    ]);
    expect(result).toEqual({
      sessionId: "child-1",
      resume: false,
      child: { parentSessionId: "parent-1", spawnToolCallId: "call-1", initialMode: "plan" },
    });
  });

  it("parses the same triple in --flag=value form", () => {
    const result = parseHostArgs([
      "--child-parent=parent-2",
      "--child-spawn-call=call-2",
      "--child-mode=edit",
    ]);
    expect(result.child).toEqual({ parentSessionId: "parent-2", spawnToolCallId: "call-2", initialMode: "edit" });
  });

  it("a plain (non-child) argv has no `child` field at all", () => {
    const result = parseHostArgs(["--session", "root-1"]);
    expect(result).toEqual({ sessionId: "root-1", resume: false });
    expect("child" in result).toBe(false);
  });

  it("requires ALL THREE child flags — any one missing leaves args.child undefined (never half-populated)", () => {
    expect(parseHostArgs(["--child-parent", "p", "--child-spawn-call", "c"]).child).toBeUndefined();
    expect(parseHostArgs(["--child-parent", "p", "--child-mode", "build"]).child).toBeUndefined();
    expect(parseHostArgs(["--child-spawn-call", "c", "--child-mode", "build"]).child).toBeUndefined();
  });

  it("an unrecognized --child-mode value is dropped (fail-closed), not accepted as a PermissionMode", () => {
    const result = parseHostArgs([
      "--child-parent",
      "p",
      "--child-spawn-call",
      "c",
      "--child-mode",
      "not-a-real-mode",
    ]);
    expect(result.child).toBeUndefined();
  });

  it("accepts every real PermissionMode value for --child-mode", () => {
    for (const mode of ["plan", "build", "edit", "auto", "yolo"] as const) {
      const result = parseHostArgs(["--child-parent", "p", "--child-spawn-call", "c", "--child-mode", mode]);
      expect(result.child?.initialMode).toBe(mode);
    }
  });
});

describe("resolveBootSession — child-mode session rows (TASK.102 CUT-S2 §2.6.2)", () => {
  it("--session <childId> with args.child writes parentSessionId/spawnToolCallId and mode from initialMode (NOT the hardcoded \"build\")", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: {
          sessionId: "child-1",
          resume: false,
          child: { parentSessionId: "parent-1", spawnToolCallId: "call-1", initialMode: "plan" },
        },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.parentSessionId).toBe("parent-1");
      expect(result.sessionMeta.spawnToolCallId).toBe("call-1");
      expect(result.sessionMeta.mode).toBe("plan");

      const persisted = await persistence.getSessionById("child-1");
      expect(persisted?.parentSessionId).toBe("parent-1");
      expect(persisted?.spawnToolCallId).toBe("call-1");
      expect(persisted?.mode).toBe("plan");
    } finally {
      await persistence.close();
    }
  });

  it("a non-child boot is unaffected: no parent fields, mode defaults to \"build\" (byte-identical to pre-S2b)", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: { sessionId: "root-1", resume: false },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.parentSessionId).toBeUndefined();
      expect(result.sessionMeta.spawnToolCallId).toBeUndefined();
      expect(result.sessionMeta.mode).toBe("build");
    } finally {
      await persistence.close();
    }
  });

  it(
    "TASK.102 CUT-S2 §10.4 residual: --resume <childId> of an ABSENT row (respawn racing the write-behind queue) " +
      "still writes parentSessionId/spawnToolCallId/mode from args.child — it must NOT silently fall back to a " +
      "parent-less ROOT row that would sit forever in the Sidebar",
    async () => {
      const persistence = new SqlitePersistenceAdapter(":memory:");
      try {
        const result = await resolveBootSession(persistence, {
          args: {
            sessionId: "ghost-child",
            resume: true,
            child: { parentSessionId: "parent-9", spawnToolCallId: "call-9", initialMode: "auto" },
          },
          workspace: "/ws",
          model: "m1",
        });
        expect(result.resumedMissing).toBe(true);
        expect(result.sessionMeta.parentSessionId).toBe("parent-9");
        expect(result.sessionMeta.spawnToolCallId).toBe("call-9");
        expect(result.sessionMeta.mode).toBe("auto");

        // The strongest form of the assertion: the row must be genuinely
        // invisible to every root-only consumer (Sidebar/StartScreen/
        // CommandPalette/CLI all route through listRootSessions), not merely
        // carry the right columns while still being reachable as a root.
        const roots = await persistence.listRootSessions();
        expect(roots.some((s) => s.id === "ghost-child")).toBe(false);
        expect((await persistence.getRootSession("ghost-child"))).toBeNull();

        // And it IS reachable as a proper child of its parent.
        const child = await persistence.getChildSession("parent-9", "call-9");
        expect(child?.id).toBe("ghost-child");
      } finally {
        await persistence.close();
      }
    },
  );

  it("--resume of an absent id with NO args.child still falls back to a root row with mode \"build\" (pre-existing behavior, unaffected)", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: { sessionId: "plain-ghost", resume: true },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.resumedMissing).toBe(true);
      expect(result.sessionMeta.parentSessionId).toBeUndefined();
      expect(result.sessionMeta.mode).toBe("build");
      const roots = await persistence.listRootSessions();
      expect(roots.some((s) => s.id === "plain-ghost")).toBe(true);
    } finally {
      await persistence.close();
    }
  });

  it("--resume of an EXISTING child row keeps its own persisted parent-fields/mode untouched, regardless of args.child", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      await persistence.createSession({
        id: "existing-child",
        workspace: "/ws",
        model: "m1",
        mode: "edit",
        parentSessionId: "parent-orig",
        spawnToolCallId: "call-orig",
      });
      const result = await resolveBootSession(persistence, {
        args: {
          sessionId: "existing-child",
          resume: true,
          // A respawn's argv still carries the child triple — must never overwrite the loaded row.
          child: { parentSessionId: "parent-orig", spawnToolCallId: "call-orig", initialMode: "yolo" },
        },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.resumedMissing).toBe(false);
      expect(result.sessionMeta.mode).toBe("edit"); // persisted mode wins, not initialMode "yolo"
      expect(result.sessionMeta.parentSessionId).toBe("parent-orig");
    } finally {
      await persistence.close();
    }
  });
});

/**
 * Unit tests for the custom-provider IPC handlers (owner-decision #6, cut
 * §9.2, TASK.54) — CRUD off a FAKE vault + scratch settings path (no
 * Electron `ipcMain`), and the guarded models-list fetch against REAL local
 * `node:http` servers (not a mocked `fetch`) so the redirect/body-cap/timeout
 * behavior is exercised for real, not asserted against a stub that could be
 * gamed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "../settings/files.js";
import type { AnycodeSettings, CustomProviderRecord, SecretKey } from "../shared/settings.js";
import {
  catalogModelsBaseUrl,
  connectionApiKeySecretKey,
  CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL,
  customProviderSecretKey,
  fetchCustomProviderModels,
  handleCustomProviderCreate,
  handleCustomProviderDelete,
  handleCustomProviderFetchModels,
  handleCustomProviderUpdate,
  isAllowedCustomProviderUrl,
  registerProviderIpc,
  settingsWatchEventMatchesTarget,
  startSettingsFileWatcher,
  type FetchLike,
  type FetchModelsParams,
  type ProviderIpcDeps,
  type ProviderVaultLike,
} from "./provider-ipc.js";
import type { SecretSetResult } from "./vault.js";
import { createProxyChainFetch, type ProxyDispatchRequest } from "./provider-proxy-fetch.js";
import { hostForkProxyChain } from "../shared/proxy.js";

// Capture ipcMain.handle registrations so a test can drive the real
// `registerProviderIpc` wiring without an Electron runtime. `mock`-prefixed so
// the hoisted vi.mock factory may close over it.
const { mockHandlers } = vi.hoisted(() => ({
  mockHandlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
      mockHandlers.set(channel, listener);
    },
  },
}));

/** `saveSettings` call counter (F-C zero-trace red-proofs — asserted by spy, not just by re-reading the file). */
const saveSettingsSpy = vi.hoisted(() => ({ count: 0 }));
/**
 * W4-R1-L1 probe: tracks whether `loadSettings` runs INSIDE a
 * `withSettingsFileLock` critical section. `depth` inc/decrements around each
 * lock callback; `loadUnderLock` records the depth at the most-recent
 * `loadSettings`. A test resets `loadUnderLock` right before the call it cares
 * about, so the module-global is unambiguous.
 */
const lockProbe = vi.hoisted(() => ({ depth: 0, loadUnderLock: undefined as boolean | undefined }));
vi.mock("../settings/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/files.js")>();
  return {
    ...actual,
    withSettingsFileLock: (<T>(path: string, fn: () => Promise<T>): Promise<T> =>
      actual.withSettingsFileLock(path, async () => {
        lockProbe.depth++;
        try {
          return await fn();
        } finally {
          lockProbe.depth--;
        }
      })) as typeof actual.withSettingsFileLock,
    loadSettings: async (...args: Parameters<typeof actual.loadSettings>) => {
      lockProbe.loadUnderLock = lockProbe.depth > 0;
      return actual.loadSettings(...args);
    },
    saveSettings: async (...args: Parameters<typeof actual.saveSettings>) => {
      saveSettingsSpy.count++;
      return actual.saveSettings(...args);
    },
  };
});

// ── fake vault (mirrors settings-ipc.test.ts's FakeVault, trimmed to this module's surface) ──

class FakeVault implements ProviderVaultLike {
  store = new Map<string, string>();
  weakConsentRequired = false;
  setSecretCallCount = 0;
  async setSecret(key: SecretKey, value: string): Promise<SecretSetResult> {
    this.setSecretCallCount++;
    if (this.weakConsentRequired) {
      return { ok: false, reason: "weak_storage_needs_consent" };
    }
    this.store.set(key, value);
    return { ok: true };
  }
  async clearSecret(key: SecretKey): Promise<void> {
    this.store.delete(key);
  }
  async getSecretValue(key: SecretKey): Promise<string | undefined> {
    return this.store.get(key);
  }
}

let dir: string;
let settingsPath: string;
let vault: FakeVault;

function makeDeps(over: Partial<ProviderIpcDeps> = {}): ProviderIpcDeps {
  return { vault, settingsPath, genId: () => "custom:fixed-id", ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-provider-ipc-"));
  settingsPath = join(dir, "settings.json");
  vault = new FakeVault();
  saveSettingsSpy.count = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Recursively scan any value for a secret string (custody assertion, mirrors settings-ipc.test.ts). */
function containsSecret(value: unknown, secret: string): boolean {
  return JSON.stringify(value)?.includes(secret) ?? false;
}

const READ_ONLY_FIXTURE = JSON.stringify({
  version: 3,
  provider: { connections: [] },
  tools: {},
  permissions: { alwaysAllow: [] },
  ui: { theme: "system" },
  security: { allowWeakSecretStorage: false },
});

describe("isAllowedCustomProviderUrl (cut §9.2 URL policy, enumerate-good)", () => {
  it("accepts https for any host", () => {
    expect(isAllowedCustomProviderUrl("https://api.example.com")).toBe(true);
    expect(isAllowedCustomProviderUrl("https://192.168.1.5:9999/v1")).toBe(true);
  });

  it("accepts http ONLY for loopback hosts", () => {
    expect(isAllowedCustomProviderUrl("http://localhost:8080")).toBe(true);
    expect(isAllowedCustomProviderUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isAllowedCustomProviderUrl("http://[::1]:8080")).toBe(true);
  });

  // RED-PROOF: this is the exact case a `protocol === "http:"` check with no
  // hostname guard would wrongly accept.
  it("RED-PROOF: rejects http for a non-loopback host", () => {
    expect(isAllowedCustomProviderUrl("http://evil.example.com")).toBe(false);
    expect(isAllowedCustomProviderUrl("http://10.0.0.5")).toBe(false);
  });

  it("rejects malformed URLs and other protocols", () => {
    expect(isAllowedCustomProviderUrl("not a url")).toBe(false);
    expect(isAllowedCustomProviderUrl("ftp://localhost")).toBe(false);
    expect(isAllowedCustomProviderUrl("")).toBe(false);
  });

  // RED-PROOF (F-C, amendment-1 FX2-1): a `protocol`/`hostname` check with no
  // userinfo guard would accept this — a secret placed in userinfo would then
  // round-trip into settings.json in plaintext and back out to the renderer.
  it("RED-PROOF: rejects a URL carrying embedded userinfo, on any allowed scheme", () => {
    expect(isAllowedCustomProviderUrl("https://user:sekrit-pw@api.example.com")).toBe(false);
    expect(isAllowedCustomProviderUrl("https://justauser@api.example.com")).toBe(false);
    expect(isAllowedCustomProviderUrl("http://user:pw@localhost:8080")).toBe(false);
  });
});

describe("fetchCustomProviderModels — guarded /v1/models GET (real local HTTP servers)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; origin: string }> {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ server, origin: `http://127.0.0.1:${port}` });
      });
    });
  }

  it("does not even attempt a network call for a disallowed URL", async () => {
    const result = await fetchCustomProviderModels({ baseUrl: "http://evil.example.com" });
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
  });

  // RED-PROOF (F-C, surface c — fetch-models path): a userinfo-carrying
  // baseUrl must be refused BEFORE any network attempt, same as an
  // origin-mismatched URL above.
  it("RED-PROOF: rejects a userinfo-carrying baseUrl without attempting a network call", async () => {
    let called = false;
    const result = await fetchCustomProviderModels({
      baseUrl: "https://user:sekrit-pw@api.example.com",
      fetchImpl: async () => {
        called = true;
        throw new Error("must not be called — userinfo baseUrl should be rejected before any fetch");
      },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
    expect(called).toBe(false);
  });

  // S5-2: baseUrl carries the endpoint's own `/v1` (the session-wire
  // convention `normalizeExplicitBaseUrl` in packages/core/src/provider/endpoint.ts
  // expects), so the fetch must land on `/v1/models`, not `/v1/v1/models`.
  it("RED-PROOF (S5-2): fetches against a baseUrl that already includes /v1, landing on /v1/models (not /v1/v1/models), sending the key ONLY as an Authorization header", async () => {
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    const { origin } = await listen((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: `${origin}/v1`, apiKey: "sekrit-key" });
    expect(result).toEqual({ ok: true, models: [{ id: "model-a" }, { id: "model-b" }] });
    expect(receivedAuth).toBe("Bearer sekrit-key");
    expect(receivedPath).toBe("/v1/models");
  });

  // S5-2 negative control: a baseUrl WITHOUT `/v1` now hits `/models`, not
  // `/v1/models` — an intentional contract change (not a regression) that
  // brings this fetch in line with the session wire's convention that a
  // baseUrl without `/v1` is a base the session wire would POST to at
  // `{baseUrl}/chat/completions` (i.e. the endpoint genuinely has no `/v1`
  // segment, so the models listing shouldn't invent one either).
  it("RED-PROOF (S5-2): a baseUrl WITHOUT /v1 now hits /models, not /v1/models", async () => {
    let receivedPath: string | undefined;
    const { origin } = await listen((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: true, models: [{ id: "m" }] });
    expect(receivedPath).toBe("/models");
  });

  it("sends an anthropic-kind key as x-api-key, not Authorization", async () => {
    let receivedAuth: string | undefined;
    let receivedXApiKey: string | undefined;
    const { origin } = await listen((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedXApiKey = req.headers["x-api-key"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin, apiKey: "sekrit-key", kind: "anthropic" });
    expect(result).toEqual({ ok: true, models: [{ id: "claude" }] });
    expect(receivedXApiKey).toBe("sekrit-key");
    expect(receivedAuth).toBeUndefined();
  });

  it("strips a trailing slash on baseUrl before appending /models", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: `${origin}/` });
    expect(result).toEqual({ ok: true, models: [{ id: "m" }] });
  });

  // ── Taskana 4118: the fetch keeps declared per-model reasoning meta ──

  it("Taskana 4118: an OpenRouter-style body keeps reasoning + RAW supported_efforts; bare items stay bare", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "a",
              supported_parameters: ["reasoning", "tools"],
              reasoning: { supported_efforts: ["xhigh", "high", "low"] },
            },
            { id: "b" },
          ],
        }),
      );
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({
      ok: true,
      models: [
        // RAW foreign strings as spelled — mapping into the closed enum is
        // core's job at resolution, never the parser's.
        { id: "a", reasoning: true, effortLevels: ["xhigh", "high", "low"] },
        { id: "b" },
      ],
    });
  });

  it("Taskana 4118 (DoD): an OpenAI-style body without meta parses to plain ids — the fetch does not degrade", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-x", object: "model", created: 1, owned_by: "o" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: true, models: [{ id: "gpt-x" }] });
  });

  it("Taskana 4118: garbage meta drops ONLY that item's meta — the id survives and the fetch stays ok", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "bad-1", reasoning: { supported_efforts: "high" } },
            { id: "bad-2", supported_parameters: "reasoning" },
            {
              id: "ok-3",
              supported_parameters: ["reasoning"],
              reasoning: { supported_efforts: ["low", "high"] },
            },
          ],
        }),
      );
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({
      ok: true,
      models: [{ id: "bad-1" }, { id: "bad-2" }, { id: "ok-3", reasoning: true, effortLevels: ["low", "high"] }],
    });
  });

  it("Taskana 4118 review: a null/garbage reasoning block does not discard a supported_parameters reasoning declaration", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "r-null", supported_parameters: ["reasoning"], reasoning: null },
            { id: "e-null", supported_parameters: ["reasoning"], reasoning: { supported_efforts: null } },
            { id: "plain", reasoning: null },
          ],
        }),
      );
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({
      ok: true,
      models: [{ id: "r-null", reasoning: true }, { id: "e-null", reasoning: true }, { id: "plain" }],
    });
  });

  // RED-PROOF: without `redirect: "error"`, a plain `fetch` follows this 302
  // and would both return the target's models AND leak the Authorization
  // header to a DIFFERENT origin than the one the user configured.
  it("RED-PROOF: blocks a redirect and never sends the key to the redirect target", async () => {
    let targetHit = false;
    const { origin: targetOrigin } = await listen((req, res) => {
      targetHit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "should-not-be-seen" }] }));
    });
    const { origin: redirectOrigin } = await listen((req, res) => {
      res.writeHead(302, { location: `${targetOrigin}/v1/models` });
      res.end();
    });
    const result = await fetchCustomProviderModels({ baseUrl: redirectOrigin, apiKey: "sekrit-key" });
    expect(result).toEqual({ ok: false, reason: "redirect_blocked" });
    expect(targetHit).toBe(false);
  });

  it("rejects a non-2xx response", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "http_error" });
  });

  // TASK.67: Moonshot's Anthropic-compatible proxy answers 404 on this route
  // while POST /v1/messages works — the endpoint is fine, it just publishes no
  // model list. Collapsing that into `http_error` ("The endpoint returned an
  // error response") reads as "your connection is broken" and is the single
  // reason every affected user hit.
  it("RED-PROOF (TASK.67): reports a 404 on the models route as models_not_supported, not http_error", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "url.not_found" } }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "models_not_supported" });
  });

  // Same class, different shape: an endpoint that routes /models but refuses GET.
  it("reports a 405 on the models route as models_not_supported", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(405);
      res.end();
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "models_not_supported" });
  });

  // Discriminant: a rejected credential is NOT "this provider has no model
  // list" — 401/403 must keep the generic http_error so the fix suggested to
  // the user stays "check the key", not "type the model by hand".
  it("keeps 401 on the models route as http_error", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(401);
      res.end();
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "http_error" });
  });

  it("rejects a non-JSON body", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json at all");
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("rejects a JSON body with the wrong shape", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  // ── TASK.113: HTTP 200 bodies that are NOT successes ──

  // RED-PROOF: the exact live Z.AI anthropic-compat behavior measured 2026-08-15
  // (no key → 200 + {"code":1001,"msg":"Authentication...","success":false}).
  // `response.ok` passes this; only the body says "refused". Before TASK.113 this
  // fell into `invalid_response` by luck of the missing `data` field, and any
  // provider answering `data: []` in the same envelope would have surfaced as a
  // silent "fetch succeeded, zero models".
  it("RED-PROOF (TASK.113): reports a 200 body carrying success:false + code as error_payload, not ok", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 1001,
          msg: "Authentication parameter not received in Header, unable to authenticate",
          success: false,
        }),
      );
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "error_payload" });
  });

  // Error-envelope shape without a `success` flag: an own `code` field and no
  // data array is an error body, not "unrecognizable" — the user should see the
  // cause, not a shrug.
  it("RED-PROOF (TASK.113): reports a 200 error-envelope with code (no data) as error_payload, not invalid_response", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" }, code: "invalid_api_key" }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "error_payload" });
  });

  // Discriminants — real successes must not trip the error-payload detector:
  it("keeps a 200 body with success:true and a models list as ok", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [{ id: "glm-5.3" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: true, models: [{ id: "glm-5.3" }] });
  });

  it("keeps a 200 body whose data array wins over a benign code field as ok", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "ok", data: [{ id: "m" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: true, models: [{ id: "m" }] });
  });

  // data: [] is a distinct, honest outcome (TASK.113): the endpoint answered and
  // listed zero models — neither a success the pickers would render as "fetched,
  // nothing here" nor a generic http_error. It must differ from a non-empty list.
  it("RED-PROOF (TASK.113): distinguishes a well-formed empty list (empty_models) from a non-empty success", async () => {
    const empty = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const emptyResult = await fetchCustomProviderModels({ baseUrl: empty.origin });
    expect(emptyResult).toEqual({ ok: false, reason: "empty_models" });

    const nonEmpty = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    const nonEmptyResult = await fetchCustomProviderModels({ baseUrl: nonEmpty.origin });
    expect(nonEmptyResult).toEqual({ ok: true, models: [{ id: "m" }] });
  });

  // Shape-without-meaning stays invalid_response (TASK.67/TASK.113 boundary):
  // no data, no code, no success:false — merely an unrecognizable body.
  it("keeps a 200 body without data/code/success as invalid_response (not error_payload)", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", results: [] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin });
    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  // RED-PROOF: a cap that only checked Content-Length would pass this case —
  // the server declares no length at all (chunked) and streams past the cap.
  it("RED-PROOF: caps an oversized body even with no Content-Length header (streamed)", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // No content-length -> chunked transfer; the client must cap by
      // actually counting streamed bytes, not by trusting a header.
      res.write(`{"data":[{"id":"${"x".repeat(1000)}"}]}`);
      res.end();
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin, maxBodyBytes: 32 });
    expect(result).toEqual({ ok: false, reason: "response_too_large" });
  });

  it("rejects an oversized body up-front via a declared Content-Length", async () => {
    const bigBody = JSON.stringify({ data: [{ id: "x".repeat(1000) }] });
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(bigBody.length) });
      res.end(bigBody);
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin, maxBodyBytes: 32 });
    expect(result).toEqual({ ok: false, reason: "response_too_large" });
  });

  it("times out against a slow server", async () => {
    const { origin } = await listen((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }, 500);
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin, timeoutMs: 30 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("handleCustomProviderCreate", () => {
  it("refuses an invalid payload", async () => {
    expect(await handleCustomProviderCreate(makeDeps(), { name: "x" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a non-localhost http baseUrl", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "Evil",
      baseUrl: "http://evil.example.com",
      kind: "openai-compatible",
      apiKey: "k",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("creates a record, stores the key in the vault, and never echoes it back", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "My Endpoint",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "top-secret-value",
      models: ["m1", "m2"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const record = res.providers[0] as CustomProviderRecord;
    expect(record).toEqual({
      id: "custom:fixed-id",
      name: "My Endpoint",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      models: ["m1", "m2"],
    });
    // Custody: the response never carries the plaintext key (renderer never sees it).
    expect(containsSecret(res, "top-secret-value")).toBe(false);
    // The vault DOES hold it, under the documented key.
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("top-secret-value");
    // And it round-trips onto disk under settings.provider.custom.
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom).toEqual([record]);
  });

  it("refuses read_only and touches neither the vault nor the file", async () => {
    await writeFile(settingsPath, READ_ONLY_FIXTURE);
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "X",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "k",
    });
    expect(res).toEqual({ ok: false, reason: "read_only" });
    expect(vault.store.size).toBe(0);
  });

  // RED-PROOF: an implementation that saved settings.json BEFORE the vault
  // write would leave a keyless record on disk here; asserting the file is
  // UNCHANGED on refusal catches that ordering bug directly.
  it("RED-PROOF: a weak-storage-consent refusal leaves ZERO trace (no keyless record persisted)", async () => {
    vault.weakConsentRequired = true;
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "X",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "k",
    });
    expect(res).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom ?? []).toEqual([]);
  });

  // RED-PROOF (F-C, surface a — create): a userinfo-carrying baseUrl must be
  // refused BEFORE either side effect — neither the vault nor settings.json
  // is ever touched (asserted via the setSecret/saveSettings call-count spies,
  // not merely by re-reading the reloaded state).
  it("RED-PROOF: a userinfo baseUrl is refused and leaves ZERO trace (no vault write, no settings.json write)", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "Leaky",
      baseUrl: "https://user:sekrit-pw@api.example.com",
      kind: "openai-compatible",
      apiKey: "k",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.setSecretCallCount).toBe(0);
    expect(saveSettingsSpy.count).toBe(0);
  });

  // F-D (amendment-1 FX2-1): [::1] is allowed end-to-end now that
  // provider-ipc.ts's re-check and settings/schema.ts's persisted-shape
  // validation share the SAME predicate — previously the create path's own
  // check allowed [::1] but the subsequent `settingsSchema.safeParse` (which
  // did not) silently downgraded the outcome to a generic `invalid`.
  it("accepts http://[::1] end-to-end (F-D unified URL policy)", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "IPv6 loopback",
      baseUrl: "http://[::1]:8080",
      kind: "openai-compatible",
      apiKey: "k",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.providers[0]?.baseUrl).toBe("http://[::1]:8080");
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.baseUrl).toBe("http://[::1]:8080");
  });

  // ── TASK.58: keyless local endpoints ──

  it("creates a KEYLESS record with authOptional:true and touches the vault ZERO times", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "LM Studio",
      baseUrl: "http://localhost:1234/v1",
      kind: "openai-compatible",
      authOptional: true,
      models: ["m1"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.providers[0]).toEqual({
      id: "custom:fixed-id",
      name: "LM Studio",
      baseUrl: "http://localhost:1234/v1",
      kind: "openai-compatible",
      models: ["m1"],
      authOptional: true,
    });
    // No key was supplied → the vault is never written.
    expect(vault.setSecretCallCount).toBe(0);
    expect(vault.store.size).toBe(0);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.authOptional).toBe(true);
  });

  it("refuses a record that is NEITHER keyed NOR explicitly keyless (invalid, no side effects)", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "Neither",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.setSecretCallCount).toBe(0);
    expect(saveSettingsSpy.count).toBe(0);
    // An empty-string key is the same as absent.
    const emptyKey = await handleCustomProviderCreate(makeDeps(), {
      name: "EmptyKey",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "",
    });
    expect(emptyKey).toEqual({ ok: false, reason: "invalid" });
  });

  it("a non-empty key is authoritative even when authOptional:true is also sent (record stays keyed)", async () => {
    const res = await handleCustomProviderCreate(makeDeps(), {
      name: "Ambiguous",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "real-key",
      authOptional: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    // Keyed → the keyless flag is NOT persisted, and the key IS stored.
    expect(res.providers[0]?.authOptional).toBeUndefined();
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("real-key");
  });

  // TASK.202: only a keyed create writes a vault key, so only it may arm the
  // recognizer force-push hook — and it fires BEFORE the mutation broadcast.
  it("TASK.202: a keyed create fires onSecretWritten with the record's vault key before onMutation; a keyless create does not fire it", async () => {
    const order: string[] = [];
    const keyed = await handleCustomProviderCreate(
      makeDeps({
        onSecretWritten: (key) => void order.push(`secret:${key}`),
        onMutation: () => void order.push("mutation"),
      }),
      { name: "Keyed", baseUrl: "https://api.example.com", kind: "openai-compatible", apiKey: "k" },
    );
    expect(keyed.ok).toBe(true);
    expect(order).toEqual(["secret:provider.custom:fixed-id.apiKey", "mutation"]);

    const onSecretWritten = vi.fn();
    const keyless = await handleCustomProviderCreate(
      makeDeps({ onSecretWritten, genId: () => "custom:keyless-id" }),
      { name: "Keyless", baseUrl: "https://api.example.com", kind: "openai-compatible", authOptional: true },
    );
    expect(keyless.ok).toBe(true);
    expect(onSecretWritten).not.toHaveBeenCalled();
  });
});

describe("handleCustomProviderUpdate", () => {
  async function seed(): Promise<void> {
    await handleCustomProviderCreate(makeDeps(), {
      name: "Original",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "orig-key",
      models: ["m1"],
    });
  }

  it("returns not_found for an unknown id", async () => {
    const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:nope", name: "X" });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("patches the curated model list without touching the stored key", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", models: ["m1", "m2", "m3"] });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.providers[0]?.models).toEqual(["m1", "m2", "m3"]);
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("orig-key");
  });

  it("rotates the key only when a non-empty apiKey is supplied", async () => {
    await seed();
    await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", apiKey: "rotated-key" });
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("rotated-key");
  });

  // TASK.202: a rotation through update is the second channel that must arm
  // the recognizer force-push; a models-only update writes no key, so it must
  // stay silent.
  it("TASK.202: a key rotation via update fires onSecretWritten; a models-only update does not", async () => {
    await seed();
    const order: string[] = [];
    const rotation = await handleCustomProviderUpdate(
      makeDeps({
        onSecretWritten: (key) => void order.push(`secret:${key}`),
        onMutation: () => void order.push("mutation"),
      }),
      { id: "custom:fixed-id", apiKey: "rotated-key" },
    );
    expect(rotation.ok).toBe(true);
    expect(order).toEqual(["secret:provider.custom:fixed-id.apiKey", "mutation"]);

    const onSecretWritten = vi.fn();
    const modelsOnly = await handleCustomProviderUpdate(makeDeps({ onSecretWritten }), {
      id: "custom:fixed-id",
      models: ["m1", "m2"],
    });
    expect(modelsOnly.ok).toBe(true);
    expect(onSecretWritten).not.toHaveBeenCalled();
  });

  it("refuses a non-localhost http baseUrl on update", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", baseUrl: "http://evil.example.com" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  // RED-PROOF (F-C, surface b — update): a userinfo-carrying baseUrl is
  // refused before the lock is even taken — the existing record (baseUrl AND
  // stored key) is left completely untouched, and neither side effect fires.
  it("RED-PROOF: a userinfo baseUrl is refused on update, leaving the existing record and vault key untouched", async () => {
    await seed();
    saveSettingsSpy.count = 0; // reset past the seed's own create-time save
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "http://user:pw@localhost:8080",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(saveSettingsSpy.count).toBe(0);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.baseUrl).toBe("https://api.example.com");
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("orig-key");
  });
});

describe("handleCustomProviderUpdate — origin-rebind custody guard (FX3-L1 G-A)", () => {
  async function seed(baseUrl = "https://api.example.com"): Promise<void> {
    await handleCustomProviderCreate(makeDeps(), {
      name: "Original",
      baseUrl,
      kind: "openai-compatible",
      apiKey: "orig-key",
      models: ["m1"],
    });
  }

  it("refuses a cross-origin baseUrl change without an apiKey (needs_api_key) — nothing persisted, vault untouched", async () => {
    await seed();
    saveSettingsSpy.count = 0;
    vault.setSecretCallCount = 0;
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://attacker.example",
    });
    expect(res).toEqual({ ok: false, reason: "needs_api_key" });
    expect(saveSettingsSpy.count).toBe(0);
    expect(vault.setSecretCallCount).toBe(0);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.baseUrl).toBe("https://api.example.com");
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("orig-key");
  });

  it("an empty-string apiKey does NOT satisfy the guard (same refusal as absent)", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://attacker.example",
      apiKey: "",
    });
    expect(res).toEqual({ ok: false, reason: "needs_api_key" });
  });

  it("a cross-origin re-bind WITH a fresh key succeeds and rotates the vault entry (vault-before-save order unchanged)", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://new.example.com",
      apiKey: "rebind-key",
    });
    expect(res.ok).toBe(true);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.baseUrl).toBe("https://new.example.com");
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("rebind-key");
  });

  it("a same-origin baseUrl change (path only) needs no key", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://api.example.com/v2",
    });
    expect(res.ok).toBe(true);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom?.[0]?.baseUrl).toBe("https://api.example.com/v2");
  });

  it("loopback→loopback origin change (corrected local port) needs no key, and fetch-models sends the stored key to the NEW port", async () => {
    let receivedAuth: string | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-local" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const newOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await seed("http://localhost:1");
      const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", baseUrl: newOrigin });
      expect(res.ok).toBe(true);
      const fetched = await handleCustomProviderFetchModels(makeDeps(), { id: "custom:fixed-id" });
      expect(fetched).toEqual({ ok: true, models: [{ id: "m-local" }] });
      expect(receivedAuth).toBe("Bearer orig-key");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // RED-PROOF (G-A, the exfil primitive itself): keyless update to an attacker
  // origin, then fetch-models by id. Without the origin-rebind guard the
  // update persists and the recorder receives `Bearer orig-key` ON
  // https://attacker.example/models — with the guard, the decrypted key
  // travels ONLY to the origin it was presented for. The recorder is wired
  // through the REAL fetchCustomProviderModels so the asserted request is the
  // exact one that would leave the machine.
  it("RED-PROOF (G-A): after a rejected re-bind, fetch-models sends NO auth-bearing request to the attacker origin", async () => {
    await seed();
    const rebind = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://attacker.example",
    });
    expect(rebind).toEqual({ ok: false, reason: "needs_api_key" });
    const requests: { url: string; auth: string | undefined }[] = [];
    const recorder: FetchLike = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      requests.push({ url, auth: headers.Authorization ?? headers["x-api-key"] });
      // TASK.113: `{data:[]}` is no longer a silent success (empty_models), so
      // this stub (whose body was always empty) now serves one non-empty model —
      // the assertion under test is WHERE the key travels, not the list content.
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const deps = makeDeps({ fetchModels: (params) => fetchCustomProviderModels({ ...params, fetchImpl: recorder }) });
    const res = await handleCustomProviderFetchModels(deps, { id: "custom:fixed-id" });
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.com/models");
    expect(requests[0]?.auth).toBe("Bearer orig-key");
    expect(requests.filter((r) => r.url.includes("attacker.example"))).toEqual([]);
  });

  // ── TASK.58: a KEYLESS record has no stored key to leak, so it may rebind
  // cross-origin without a fresh key — provided it STAYS keyless. ──
  async function seedKeyless(baseUrl = "https://api.example.com"): Promise<void> {
    await handleCustomProviderCreate(makeDeps(), {
      name: "Keyless",
      baseUrl,
      kind: "openai-compatible",
      authOptional: true,
    });
  }

  it("a keyless record may change origin without a fresh key (nothing can leak)", async () => {
    await seedKeyless();
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://elsewhere.example.com",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.providers[0]?.baseUrl).toBe("https://elsewhere.example.com");
    expect(res.providers[0]?.authOptional).toBe(true);
  });

  it("a keyed record STILL needs a fresh key to change origin (regress — keyless waiver must not weaken the keyed guard)", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), {
      id: "custom:fixed-id",
      baseUrl: "https://attacker.example",
    });
    expect(res).toEqual({ ok: false, reason: "needs_api_key" });
  });

  it("a keyed→keyless transition drops the stored key so the 'keyless' record can never boot with a stale key", async () => {
    await seed();
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBe("orig-key");
    const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", authOptional: true });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.providers[0]?.authOptional).toBe(true);
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBeUndefined();
  });
});

describe("handleCustomProviderDelete", () => {
  it("returns not_found for an unknown id", async () => {
    expect(await handleCustomProviderDelete(makeDeps(), { id: "custom:nope" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("clears the vault key and removes the record", async () => {
    await handleCustomProviderCreate(makeDeps(), {
      name: "X",
      baseUrl: "https://api.example.com",
      kind: "openai-compatible",
      apiKey: "k",
    });
    const res = await handleCustomProviderDelete(makeDeps(), { id: "custom:fixed-id" });
    expect(res).toEqual({ ok: true, providers: [] });
    expect(await vault.getSecretValue(customProviderSecretKey("custom:fixed-id"))).toBeUndefined();
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.custom ?? []).toEqual([]);
  });
});

describe("handleCustomProviderFetchModels", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it("previews a not-yet-saved endpoint with a directly-supplied key", async () => {
    let receivedAuth: string | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await handleCustomProviderFetchModels(makeDeps(), { baseUrl: origin, apiKey: "preview-key" });
    expect(res).toEqual({ ok: true, models: [{ id: "m1" }] });
    expect(receivedAuth).toBe("Bearer preview-key");
  });

  it("resolves an already-saved record's baseUrl + vault key by id", async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m2" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await handleCustomProviderCreate(makeDeps(), { name: "X", baseUrl: origin, kind: "openai-compatible", apiKey: "saved-key" });
    const res = await handleCustomProviderFetchModels(makeDeps(), { id: "custom:fixed-id" });
    expect(res).toEqual({ ok: true, models: [{ id: "m2" }] });
  });

  // W4-R1-L1: the saved-record {id} branch used to loadSettings + read the vault
  // key OUTSIDE any lock, so a concurrent custom-provider-update rotating a
  // record cross-origin (setSecret NEW key → saveSettings NEW baseUrl, both under
  // the mutation lock) could interleave and hand this read the OLD baseUrl paired
  // with the NEW key — POSTing the freshly-rotated key to the origin the user just
  // migrated away from. Serializing the (baseUrl, key) resolution under the SAME
  // lock closes the window; the network fetch itself stays outside it.
  it("W4-R1-L1: resolves a saved record's baseUrl + key UNDER the settings lock (serialized against a concurrent cross-origin key rotation)", async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m3" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await handleCustomProviderCreate(makeDeps(), { name: "X", baseUrl: origin, kind: "openai-compatible", apiKey: "saved-key" });

    lockProbe.loadUnderLock = undefined;
    const res = await handleCustomProviderFetchModels(makeDeps(), { id: "custom:fixed-id" });
    expect(res).toEqual({ ok: true, models: [{ id: "m3" }] });
    // The record resolution (loadSettings + vault read) ran inside the lock.
    expect(lockProbe.loadUnderLock).toBe(true);
  });

  it("returns invalid_request for an unknown id", async () => {
    const res = await handleCustomProviderFetchModels(makeDeps(), { id: "custom:nope" });
    expect(res).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("returns invalid_request for a malformed payload", async () => {
    const res = await handleCustomProviderFetchModels(makeDeps(), { nonsense: true });
    expect(res).toEqual({ ok: false, reason: "invalid_request" });
  });

  // RED-PROOF (F-C, surface c — fetch-models IPC handler, not-yet-saved preview path).
  it("RED-PROOF: rejects a userinfo-carrying baseUrl in the not-yet-saved preview path with invalid_url", async () => {
    const res = await handleCustomProviderFetchModels(makeDeps(), {
      baseUrl: "https://user:sekrit-pw@api.example.com",
      apiKey: "preview-key",
    });
    expect(res).toEqual({ ok: false, reason: "invalid_url" });
  });
});

describe("catalogModelsBaseUrl (connection-scoped fetch URL rule)", () => {
  it("appends /v1 to an anthropic-family catalog baseUrl (complete prefix without it)", () => {
    expect(catalogModelsBaseUrl("https://api.kimi.com/coding")).toBe("https://api.kimi.com/coding/v1");
    expect(catalogModelsBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
  });

  it("leaves an OpenAI-family baseUrl already ending in /v1 untouched", () => {
    expect(catalogModelsBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(catalogModelsBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
  });

  it("normalizes trailing slashes before deciding", () => {
    expect(catalogModelsBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(catalogModelsBaseUrl("https://api.kimi.com/coding//")).toBe("https://api.kimi.com/coding/v1");
  });
});

describe("handleCustomProviderFetchModels — catalog connection ({connectionId})", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  /** Minimal v2 settings fixture carrying ONE provider connection. */
  async function seedConnection(connection: Record<string, unknown>): Promise<void> {
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        provider: { connections: [connection], activeConnectionId: connection.id },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
  }

  /** Deps with a fake catalog + spy fetch — asserts WHAT the handler resolves, not the wire (covered by the real-server test). */
  function makeCatalogDeps(over: Partial<ProviderIpcDeps> = {}): {
    deps: ProviderIpcDeps;
    calls: FetchModelsParams[];
  } {
    const calls: FetchModelsParams[] = [];
    const deps = makeDeps({
      now: () => "2026-07-18T00:00:00.000Z",
      catalogEntryById: (id) =>
        (
          {
            kimi: { id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" },
            openai: { id: "openai", baseUrl: "https://api.openai.com/v1", defaultTransport: "openai-responses" },
            vllm: { id: "vllm", baseUrl: "", defaultTransport: "openai-chat-completions" },
            custom: { id: "custom", baseUrl: "", defaultTransport: "anthropic-messages" },
          } as Record<string, { id: string; baseUrl: string; defaultTransport?: string }>
        )[id],
      fetchModels: async (params) => {
        calls.push(params);
        return { ok: true, models: [{ id: "live-a" }, { id: "live-b" }] };
      },
      ...over,
    });
    return { deps, calls };
  }

  it("resolves entry baseUrl (+/v1), anthropic auth kind from the transport, and the connection vault key; persists the fetched ids", async () => {
    await seedConnection({ id: "conn-1", providerId: "kimi" });
    vault.store.set(connectionApiKeySecretKey("conn-1"), "sk-kimi-secret");
    const { deps, calls } = makeCatalogDeps();
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-1" });
    expect(res).toEqual({ ok: true, models: [{ id: "live-a" }, { id: "live-b" }] });
    expect(calls).toEqual([
      { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-secret", kind: "anthropic" },
    ]);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]).toMatchObject({
      id: "conn-1",
      models: ["live-a", "live-b"],
      modelsFetchedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("an OpenAI-family entry keeps its /v1 baseUrl and maps to Bearer auth (openai-compatible kind), keyless when no vault entry", async () => {
    await seedConnection({ id: "conn-2", providerId: "openai" });
    const { deps, calls } = makeCatalogDeps();
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-2" });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ baseUrl: "https://api.openai.com/v1", apiKey: undefined, kind: "openai-compatible" }]);
  });

  it("a connection-level baseUrl override wins over the entry's (vllm template)", async () => {
    await seedConnection({ id: "conn-3", providerId: "vllm", baseUrl: "http://localhost:8000/v1" });
    const { deps, calls } = makeCatalogDeps();
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-3" });
    expect(res.ok).toBe(true);
    expect(calls[0]).toMatchObject({ baseUrl: "http://localhost:8000/v1", kind: "openai-compatible" });
  });

  it("an empty resolved baseUrl (vllm template with no override) is invalid_url and never fetches", async () => {
    await seedConnection({ id: "conn-4", providerId: "vllm" });
    const { deps, calls } = makeCatalogDeps();
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-4" });
    expect(res).toEqual({ ok: false, reason: "invalid_url" });
    expect(calls).toEqual([]);
  });

  it("refuses an unknown connection, a custom:<slug> providerId, and the literal `custom` sentinel (each invalid_request, no fetch)", async () => {
    const { deps, calls } = makeCatalogDeps();
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-none" })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    await seedConnection({ id: "conn-5", providerId: "custom:my-record" });
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-5" })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    await seedConnection({ id: "conn-6", providerId: "custom", baseUrl: "https://api.example.com" });
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-6" })).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(calls).toEqual([]);
  });

  it("fail-closed without the injected catalog lookup (invalid_request)", async () => {
    await seedConnection({ id: "conn-7", providerId: "kimi" });
    const res = await handleCustomProviderFetchModels(makeDeps(), { connectionId: "conn-7" });
    expect(res).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("resolves the connection (settings + vault key) UNDER the settings lock (same W4-R1-L1 rationale as the {id} branch)", async () => {
    await seedConnection({ id: "conn-8", providerId: "kimi" });
    const { deps } = makeCatalogDeps();
    lockProbe.loadUnderLock = undefined;
    await handleCustomProviderFetchModels(deps, { connectionId: "conn-8" });
    expect(lockProbe.loadUnderLock).toBe(true);
  });

  it("a failed fetch persists nothing", async () => {
    await seedConnection({ id: "conn-9", providerId: "kimi" });
    const { deps } = makeCatalogDeps({
      fetchModels: async () => ({ ok: false, reason: "http_error" }),
    });
    saveSettingsSpy.count = 0;
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-9" });
    expect(res).toEqual({ ok: false, reason: "http_error" });
    expect(saveSettingsSpy.count).toBe(0);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.models).toBeUndefined();
  });

  it("an EMPTY fetched list is returned but never persisted (static-hints fallback stays intact)", async () => {
    await seedConnection({ id: "conn-10", providerId: "kimi" });
    const { deps } = makeCatalogDeps({ fetchModels: async () => ({ ok: true, models: [] }) });
    saveSettingsSpy.count = 0;
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-10" });
    expect(res).toEqual({ ok: true, models: [] });
    expect(saveSettingsSpy.count).toBe(0);
  });

  // ── Taskana 4118: the connection persists live per-model capabilities ──

  it("Taskana 4118: a fetch outcome with caps persists modelCapabilities merged over the stored map (fetched wins on collision)", async () => {
    await seedConnection({
      id: "conn-caps",
      providerId: "kimi",
      modelCapabilities: {
        "stale-model": { reasoning: true },
        "live-a": { reasoning: true, effortLevels: ["off", "medium"] }, // fetched below overwrites this key
      },
    });
    const { deps } = makeCatalogDeps({
      fetchModels: async () => ({
        ok: true,
        models: [
          { id: "live-a", reasoning: true, effortLevels: ["high", "max"] },
          { id: "live-b" },
          { id: "live-c", reasoning: true },
        ],
      }),
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-caps" });
    expect(res.ok).toBe(true);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.modelCapabilities).toEqual({
      // pre-seeded key absent from the fetch survives (spread existing first).
      "stale-model": { reasoning: true },
      // key collision: the fetched entry wins.
      "live-a": { reasoning: true, effortLevels: ["high", "max"] },
      // capable model absent from the stored map is added.
      "live-c": { reasoning: true },
    });
  });

  it("Taskana 4118: a later fetch with NO capable models leaves the stored map intact (never deleted on empty)", async () => {
    await seedConnection({
      id: "conn-caps-2",
      providerId: "kimi",
      modelCapabilities: { "stale-model": { reasoning: true, effortLevels: ["low"] } },
    });
    const { deps } = makeCatalogDeps({
      fetchModels: async () => ({ ok: true, models: [{ id: "plain-a" }, { id: "plain-b" }] }),
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-caps-2" });
    expect(res.ok).toBe(true);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.modelCapabilities).toEqual({
      "stale-model": { reasoning: true, effortLevels: ["low"] },
    });
  });

  it("Taskana 4118: a FAILED fetch persists nothing (caps included)", async () => {
    await seedConnection({ id: "conn-caps-3", providerId: "kimi" });
    const { deps } = makeCatalogDeps({
      fetchModels: async () => ({ ok: false, reason: "http_error" }),
    });
    saveSettingsSpy.count = 0;
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-caps-3" });
    expect(res).toEqual({ ok: false, reason: "http_error" });
    expect(saveSettingsSpy.count).toBe(0);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.modelCapabilities).toBeUndefined();
  });

  it("REAL SERVER: an anthropic-family catalog baseUrl with a path prefix lands on <prefix>/v1/models with x-api-key auth", async () => {
    let receivedPath: string | undefined;
    let receivedApiKey: string | string[] | undefined;
    let receivedAuth: string | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedPath = req.url;
      receivedApiKey = req.headers["x-api-key"];
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "kimi-for-coding" }, { id: "k3" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await seedConnection({ id: "conn-11", providerId: "kimi" });
    vault.store.set(connectionApiKeySecretKey("conn-11"), "sk-kimi-live");
    const { deps } = makeCatalogDeps({
      fetchModels: undefined, // the REAL guarded fetch
      catalogEntryById: () => ({ id: "kimi", baseUrl: `${origin}/coding`, defaultTransport: "anthropic-messages" }),
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-11" });
    expect(res).toEqual({ ok: true, models: [{ id: "kimi-for-coding" }, { id: "k3" }] });
    expect(receivedPath).toBe("/coding/v1/models");
    expect(receivedApiKey).toBe("sk-kimi-live");
    expect(receivedAuth).toBeUndefined();
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.models).toEqual(["kimi-for-coding", "k3"]);
  });

  // ── TASK.133: INTEGRATED production-seam tests (proxy routing through the
  // real guarded fetch, fake ONLY at the Electron net boundary) ──

  it("TASK.133: proxied connection fetches models through the production proxy dispatcher", async () => {
    await seedConnection({
      id: "conn-1",
      providerId: "kimi",
      proxyRef: "proxy-1",
    });
    await writeFile(
      settingsPath,
      JSON.stringify({
        ...(JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>),
        network: { proxyProfiles: [{ id: "proxy-1", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" }] },
      }),
    );
    vault.store.set(connectionApiKeySecretKey("conn-1"), "sk-kimi-secret");

    // A fake boundary whose requests respond 200 with a models list.
    const listenersByRequest: Array<Map<string, Array<(...args: unknown[]) => void>>> = [];
    const dispatches: ProxyDispatchRequest[] = [];
    const requestFactory = (dispatch: ProxyDispatchRequest): unknown => {
      dispatches.push(dispatch);
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      listenersByRequest.push(listeners);
      const base: Record<string, unknown> = {
        on(event: string, listener: (...args: never[]) => void) {
          const arr = listeners.get(event) ?? [];
          arr.push(listener as (...args: unknown[]) => void);
          listeners.set(event, arr);
          return base;
        },
        write: () => true,
        end: () => undefined,
        abort: () => undefined,
      };
      return base;
    };
    const productionFetch = createProxyChainFetch({
      readSettings: () => JSON.parse(readFileSync(settingsPath, "utf8")) as AnycodeSettings,
      materializationFor: () => ({ proxyPassword: () => "pw" }),
      requestFactory,
      setProxyFor: async () => undefined,
      fallbackFetch: (async (url: string, init: RequestInit) => new Response("fallback", { status: 599 })) as typeof globalThis.fetch,
    })(hostForkProxyChain("conn-1"));

    // Drive the fake wire as soon as the dispatch lands.
    const drive = (async () => {
      for (let i = 0; i < 100 && dispatches.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 2));
      }
      const listeners = listenersByRequest[0];
      if (listeners === undefined) {
        return;
      }
      let dataFn: ((chunk: Buffer) => void) | undefined;
      let endFn: (() => void) | undefined;
      const incoming = {
        statusCode: 200,
        statusMessage: "",
        headers: { "content-type": "application/json" },
        on(event: "data" | "end" | "error", l: unknown) {
          if (event === "data") dataFn = l as (chunk: Buffer) => void;
          if (event === "end") endFn = l as () => void;
          return incoming;
        },
      };
      for (const l of listeners.get("response") ?? []) l(incoming);
      await new Promise((r) => setTimeout(r, 2));
      dataFn?.(Buffer.from('{"data":[{"id":"live-a"}]}'));
      endFn?.();
    })();

    const { deps, calls } = makeCatalogDeps({
      fetchModels: undefined, // the REAL guarded fetch
      connectionFetch: () => productionFetch as FetchLike,
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-1" });
    await drive;
    expect(res).toEqual({ ok: true, models: [{ id: "live-a" }] });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.url).toBe("https://api.kimi.com/coding/v1/models");
    expect(dispatches[0]?.redirect).toBe("manual"); // manual transport; redirect:error is enforced in the redirect event
    expect(dispatches[0]?.headers["x-api-key"]).toBe("sk-kimi-secret");
    expect(calls).toEqual([]);
  });

  it("TASK.133: malformed proxy refuses with renderer-compatible reason and a credential-free log", async () => {
    await seedConnection({ id: "conn-1", providerId: "kimi", proxyUrl: "socks5://x:1" });
    vault.store.set(connectionApiKeySecretKey("conn-1"), "sk-kimi-secret");
    const dispatches: ProxyDispatchRequest[] = [];
    const fallbackCalls: Array<{ url: string }> = [];
    const productionFetch = createProxyChainFetch({
      readSettings: () => JSON.parse(readFileSync(settingsPath, "utf8")) as AnycodeSettings,
      materializationFor: () => ({ proxyPassword: () => "pw" }),
      requestFactory: (dispatch) => {
        dispatches.push(dispatch);
        throw new Error("factory must not be called");
      },
      setProxyFor: async () => undefined,
      fallbackFetch: (async (url: string) => {
        fallbackCalls.push({ url });
        return new Response("fallback", { status: 599 });
      }) as typeof globalThis.fetch,
    })(hostForkProxyChain("conn-1"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { deps } = makeCatalogDeps({
        fetchModels: undefined,
        connectionFetch: () => productionFetch as FetchLike,
      });
      const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-1" });
      expect(res).toEqual({ ok: false, reason: "network_error" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("pw");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("socks5");
      expect(dispatches).toEqual([]);
      expect(fallbackCalls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("TASK.133: unproxied connection routes through the wired production chain to the UNCHANGED fallback (no session/dispatcher config)", async () => {
    // Production ALWAYS wires connectionFetch; an unproxied connection must
    // reach the fallback with the URL/init the caller passed, and never
    // configure a partition or dispatch a proxied request.
    await seedConnection({ id: "conn-2", providerId: "kimi" }); // NO proxy fields
    vault.store.set(connectionApiKeySecretKey("conn-2"), "sk-kimi-secret");
    const dispatches: ProxyDispatchRequest[] = [];
    const fallbackCalls: Array<{ url: string; init: RequestInit }> = [];
    const fallbackFetch = (async (url: string, init: RequestInit) => {
      fallbackCalls.push({ url, init });
      return new Response('{"data":[{"id":"fb-1"}]}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    // The REAL chain factory with the production-shaped deps; the chain is
    // constructed for THIS connection id (as main's connectionFetch does).
    const productionFetch = createProxyChainFetch({
      readSettings: () => JSON.parse(readFileSync(settingsPath, "utf8")) as AnycodeSettings,
      materializationFor: () => ({ proxyPassword: () => "pw" }),
      requestFactory: (dispatch) => {
        dispatches.push(dispatch);
        throw new Error("dispatcher must not be called for an unproxied connection");
      },
      setProxyFor: async () => {
        throw new Error("setProxyFor must not be called for an unproxied connection");
      },
      fallbackFetch,
    })(hostForkProxyChain("conn-2"));
    const { deps } = makeCatalogDeps({
      fetchModels: undefined,
      connectionFetch: () => productionFetch as FetchLike,
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-2" });
    expect(res).toEqual({ ok: true, models: [{ id: "fb-1" }] });
    expect(dispatches).toEqual([]);
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]?.url).toBe("https://api.kimi.com/coding/v1/models");
  });

  it("TASK.133: unproxied connection adds no fetchImpl when the seam is unwired", async () => {
    await seedConnection({ id: "conn-12", providerId: "kimi" });
    const { deps, calls } = makeCatalogDeps();
    await handleCustomProviderFetchModels(deps, { connectionId: "conn-12" });
    expect("fetchImpl" in (calls[0] as object)).toBe(false);
  });
});

// ── 4244: complete-URL models seam (no real server, injected fetchImpl only) ──

describe("fetchCustomProviderModels — modelsUrl complete-URL seam (4244)", () => {
  /** Capturing fake fetch returning an OpenAI-style {object:"list",data:[{id}]} body. */
  function makeCapturingFetch(models: { id: string }[]): {
    fetchImpl: typeof globalThis.fetch;
    calls: { url: string; init: RequestInit }[];
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ object: "list", data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    return { fetchImpl, calls };
  }

  it("uses modelsUrl VERBATIM — no /v1 insertion, no double /models — with GET, redirect:error, and Bearer auth", async () => {
    const { fetchImpl, calls } = makeCapturingFetch([{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]);
    const outcome = await fetchCustomProviderModels({
      baseUrl: "https://api.deepseek.com/anthropic",
      modelsUrl: "https://api.deepseek.com/models",
      apiKey: "sk-ds",
      kind: "anthropic",
      fetchImpl,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("error");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-ds");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
    expect(outcome).toEqual({ ok: true, models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
  });

  it("refuses a non-https/non-localhost modelsUrl as invalid_url without fetching", async () => {
    const { fetchImpl, calls } = makeCapturingFetch([{ id: "m" }]);
    const outcome = await fetchCustomProviderModels({
      baseUrl: "https://api.deepseek.com/anthropic",
      modelsUrl: "http://api.deepseek.com/models",
      apiKey: "sk-ds",
      kind: "anthropic",
      fetchImpl,
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid_url" });
    expect(calls.length).toBe(0);
  });

  it("trailing-slash modelsUrl is trimmed, not doubled", async () => {
    const { fetchImpl, calls } = makeCapturingFetch([{ id: "m" }]);
    await fetchCustomProviderModels({
      baseUrl: "https://api.deepseek.com/anthropic",
      modelsUrl: "https://api.deepseek.com/models/",
      apiKey: "sk-ds",
      kind: "anthropic",
      fetchImpl,
    });
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
  });

  it("absent modelsUrl keeps the derived path byte-identical", async () => {
    const { fetchImpl, calls } = makeCapturingFetch([{ id: "m" }]);
    await fetchCustomProviderModels({
      baseUrl: catalogModelsBaseUrl("https://api.kimi.com/coding"),
      apiKey: "sk-kimi",
      kind: "anthropic",
      fetchImpl,
    });
    expect(calls[0]!.url).toBe("https://api.kimi.com/coding/v1/models");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-kimi");
  });
});

describe("handleCustomProviderFetchModels — 4244 modelsUrl catalog wiring", () => {
  async function seed4244(connection: Record<string, unknown>): Promise<void> {
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        provider: { connections: [connection], activeConnectionId: connection.id },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
  }

  it("4244: a deepseek connection fetches https://api.deepseek.com/models with Bearer and persists the ids", async () => {
    await seed4244({ id: "conn-ds", providerId: "deepseek" });
    vault.store.set(connectionApiKeySecretKey("conn-ds"), "sk-ds-secret");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const deps = makeDeps({
      now: () => "2026-07-18T00:00:00.000Z",
      catalogEntryById: (id) =>
        id === "deepseek"
          ? { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", defaultTransport: "anthropic-messages" }
          : undefined,
      connectionFetch: () => fetchImpl,
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-ds" });
    expect(res).toEqual({ ok: true, models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("error");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-ds-secret");
    expect(headers["x-api-key"]).toBeUndefined();
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]).toMatchObject({
      id: "conn-ds",
      models: ["deepseek-flash", "deepseek-v4-pro"],
      modelsFetchedAt: "2026-07-18T00:00:00.000Z",
    });
  });
  it("4244: a deepseek connection with an overridden baseUrl uses the derived URL, not the catalog modelsUrl", async () => {
    await seed4244({ id: "conn-gw", providerId: "deepseek", baseUrl: "https://gw.example/anthropic" });
    vault.store.set(connectionApiKeySecretKey("conn-gw"), "sk-gw");
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const deps = makeDeps({
      catalogEntryById: (id) =>
        id === "deepseek"
          ? { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", defaultTransport: "anthropic-messages" }
          : undefined,
      connectionFetch: () => fetchImpl,
    });
    await handleCustomProviderFetchModels(deps, { connectionId: "conn-gw" });
    expect(calls).toEqual(["https://gw.example/anthropic/v1/models"]);
  });
});

// ── TASK.183: durable manually entered connection models ──

/** Minimal v2 settings fixture carrying an explicit `provider` object. */
function v2Settings(provider: Record<string, unknown>): AnycodeSettings {
  return {
    version: 2,
    provider,
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  } as unknown as AnycodeSettings;
}

async function writeSettingsFixture(provider: Record<string, unknown>): Promise<void> {
  await writeFile(settingsPath, JSON.stringify(v2Settings(provider)));
}

async function readConnections(): Promise<Record<string, unknown>[]> {
  const reloaded = await loadSettings(settingsPath);
  return reloaded.settings.provider.connections as unknown as Record<string, unknown>[];
}

describe("handleConnectionAddModels — manual ids ({connectionId, addModels})", () => {
  /** A fetch that would THROW if the add path ever attempted the network. */
  const noNetwork = (): Partial<ProviderIpcDeps> => ({
    fetchModels: async () => {
      throw new Error("addModels must never touch the network");
    },
  });

  it("adds a valid id on a connection with no prior fetch; a fresh restart (reload) sees it", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi" }] });
    const res = await handleCustomProviderFetchModels(makeDeps(noNetwork()), {
      connectionId: "conn-1",
      addModels: ["my-manual-id"],
    });
    expect(res).toEqual({ ok: true, models: [{ id: "my-manual-id" }] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ id: "conn-1", models: ["my-manual-id"] });
  });

  // Taskana 4118: manual ids carry no meta by definition — the branch must
  // never write (or erase) modelCapabilities.
  it("Taskana 4118: the addModels branch never writes modelCapabilities", async () => {
    await writeSettingsFixture({
      connections: [{ id: "conn-1", providerId: "kimi", modelCapabilities: { "fetched-model": { reasoning: true } } }],
    });
    const res = await handleCustomProviderFetchModels(makeDeps(noNetwork()), {
      connectionId: "conn-1",
      addModels: ["my-manual-id"],
    });
    expect(res).toEqual({ ok: true, models: [{ id: "my-manual-id" }] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({
      models: ["my-manual-id"],
      modelCapabilities: { "fetched-model": { reasoning: true } },
    });
    // And on a connection with NO stored map, none appears.
    await writeSettingsFixture({ connections: [{ id: "conn-2", providerId: "kimi" }] });
    await handleCustomProviderFetchModels(makeDeps(noNetwork()), { connectionId: "conn-2", addModels: ["m"] });
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]).not.toHaveProperty("modelCapabilities");
  });

  it("succeeds for every connection kind without a network or vault read", async () => {
    const kinds = ["kimi", "openrouter", "vllm", "custom", "custom:my-record"];
    await writeSettingsFixture({ connections: kinds.map((providerId, i) => ({ id: `conn-${i}`, providerId })) });
    const deps = makeDeps(noNetwork());
    for (let i = 0; i < kinds.length; i += 1) {
      const res = await handleCustomProviderFetchModels(deps, { connectionId: `conn-${i}`, addModels: [`m-${i}`] });
      expect(res).toEqual({ ok: true, models: [{ id: `m-${i}` }] });
    }
    expect(vault.store.size).toBe(0);
    const conns = await readConnections();
    expect(conns.map((c) => c.models)).toEqual(kinds.map((_, i) => [`m-${i}`]));
  });

  it("rejects invalid / blank / control-char / non-string / mixed valid+invalid requests with NO write", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi" }] });
    const deps = makeDeps();
    saveSettingsSpy.count = 0;
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-1", addModels: ["good-id", "bad id"] })).toEqual({ ok: false, reason: "invalid_request" });
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-1", addModels: [""] })).toEqual({ ok: false, reason: "invalid_request" });
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-1", addModels: ["bad\nid"] })).toEqual({ ok: false, reason: "invalid_request" });
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-1", addModels: [7] })).toEqual({ ok: false, reason: "invalid_request" });
    expect(saveSettingsSpy.count).toBe(0);
    const [conn] = await readConnections();
    expect(conn).not.toHaveProperty("models");
  });

  it("fails an unknown target and a read-only file (unchanged bytes)", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi" }] });
    expect(await handleCustomProviderFetchModels(makeDeps(), { connectionId: "nope", addModels: ["m"] })).toEqual({ ok: false, reason: "invalid_request" });
    await writeFile(settingsPath, READ_ONLY_FIXTURE);
    const before = await readFile(settingsPath, "utf8");
    saveSettingsSpy.count = 0;
    expect(await handleCustomProviderFetchModels(makeDeps(), { connectionId: "conn-1", addModels: ["m"] })).toEqual({ ok: false, reason: "read_only" });
    expect(saveSettingsSpy.count).toBe(0);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("a duplicate existing entry is a no-op — no save, no callback, no reorder", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi", models: ["a", "b"] }] });
    const onMutation = vi.fn();
    saveSettingsSpy.count = 0;
    const res = await handleCustomProviderFetchModels(makeDeps({ onMutation }), { connectionId: "conn-1", addModels: ["b"] });
    expect(res).toEqual({ ok: true, models: [{ id: "a" }, { id: "b" }] });
    expect(saveSettingsSpy.count).toBe(0);
    expect(onMutation).not.toHaveBeenCalled();
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ models: ["a", "b"] });
  });

  it("appends to the existing stored order and normalizes surrounding spaces", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi", models: ["a", "b"] }] });
    const res = await handleCustomProviderFetchModels(makeDeps(), { connectionId: "conn-1", addModels: [" c "] });
    expect(res).toEqual({ ok: true, models: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ models: ["a", "b", "c"] });
  });

  it("leaves model, activeConnectionId, modelsFetchedAt, siblings and custom records untouched", async () => {
    const custom = { id: "custom:rec", name: "Rec", baseUrl: "https://api.example.com", kind: "openai-compatible", models: ["rec-model"] };
    await writeSettingsFixture({
      activeConnectionId: "conn-1",
      connections: [
        { id: "conn-1", providerId: "kimi", model: "glm-4.6", modelsFetchedAt: "2026-01-02T00:00:00.000Z" },
        { id: "conn-2", providerId: "kimi", models: ["sibling"] },
      ],
      custom: [custom],
    });
    const res = await handleCustomProviderFetchModels(makeDeps(), { connectionId: "conn-1", addModels: ["added"] });
    expect(res.ok).toBe(true);
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.activeConnectionId).toBe("conn-1");
    expect(reloaded.settings.provider.custom).toEqual([custom]);
    expect(reloaded.settings.provider.connections).toMatchObject([
      { id: "conn-1", providerId: "kimi", model: "glm-4.6", modelsFetchedAt: "2026-01-02T00:00:00.000Z", models: ["added"] },
      { id: "conn-2", providerId: "kimi", models: ["sibling"] },
    ]);
  });

  it("keeps two same-provider connections isolated", async () => {
    await writeSettingsFixture({
      connections: [
        { id: "conn-a", providerId: "kimi" },
        { id: "conn-b", providerId: "kimi" },
      ],
    });
    await handleCustomProviderFetchModels(makeDeps(), { connectionId: "conn-a", addModels: ["manual-a"] });
    const conns = await readConnections();
    expect(conns[0]).toMatchObject({ id: "conn-a", models: ["manual-a"] });
    expect(conns[1]).not.toHaveProperty("models");
  });

  it("a manual add made DURING an in-flight network fetch survives the fetch's final locked merge", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi" }] });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      catalogEntryById: () => ({ id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" }),
      fetchModels: async () => {
        await gate;
        return { ok: true, models: [{ id: "live-a" }, { id: "live-b" }] };
      },
    });
    const fetchPromise = handleCustomProviderFetchModels(deps, { connectionId: "conn-1" });
    // The manual add lands while the fetch is still awaiting the network.
    expect(await handleCustomProviderFetchModels(deps, { connectionId: "conn-1", addModels: ["manual-x"] })).toEqual({ ok: true, models: [{ id: "manual-x" }] });
    release?.();
    expect(await fetchPromise).toEqual({ ok: true, models: [{ id: "live-a" }, { id: "live-b" }] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ models: ["live-a", "live-b", "manual-x"] });
  });

  it("a fetch dedupes repeated ids and keeps fetched-first then stored-manual order", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi", models: ["manual-1"] }] });
    const deps = makeDeps({
      now: () => "2026-07-18T00:00:00.000Z",
      catalogEntryById: () => ({ id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" }),
      fetchModels: async () => ({ ok: true, models: [{ id: "live-a" }, { id: "live-a" }, { id: "manual-1" }] }),
    });
    const res = await handleCustomProviderFetchModels(deps, { connectionId: "conn-1" });
    expect(res).toEqual({ ok: true, models: [{ id: "live-a" }, { id: "live-a" }, { id: "manual-1" }] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ models: ["live-a", "manual-1"] });
  });

  it("a failed or empty fetch leaves the stored manual list intact; a deleted-mid-fetch target is not resurrected", async () => {
    await writeSettingsFixture({ connections: [{ id: "conn-1", providerId: "kimi", models: ["manual-1"] }] });
    const failed = makeDeps({
      catalogEntryById: () => ({ id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" }),
      fetchModels: async () => ({ ok: false, reason: "http_error" }),
    });
    expect(await handleCustomProviderFetchModels(failed, { connectionId: "conn-1" })).toEqual({ ok: false, reason: "http_error" });
    const empty = makeDeps({
      catalogEntryById: () => ({ id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" }),
      fetchModels: async () => ({ ok: true, models: [] }),
    });
    expect(await handleCustomProviderFetchModels(empty, { connectionId: "conn-1" })).toEqual({ ok: true, models: [] });
    const [conn] = await readConnections();
    expect(conn).toMatchObject({ models: ["manual-1"] });
    // Deleted mid-fetch: the transient result returns, but nothing is written back.
    const resurrect = makeDeps({
      catalogEntryById: () => ({ id: "kimi", baseUrl: "https://api.kimi.com/coding", defaultTransport: "anthropic-messages" }),
      fetchModels: async () => {
        await writeSettingsFixture({ connections: [] });
        return { ok: true, models: [{ id: "live-a" }] };
      },
    });
    expect(await handleCustomProviderFetchModels(resurrect, { connectionId: "conn-1" })).toEqual({ ok: true, models: [{ id: "live-a" }] });
    const conns = await readConnections();
    expect(conns).toEqual([]);
  });
});

describe("settingsWatchEventMatchesTarget", () => {
  it("treats a null filename as a conservative match and decodes Buffer filenames", () => {
    expect(settingsWatchEventMatchesTarget(null, "settings.json")).toBe(true);
    expect(settingsWatchEventMatchesTarget("settings.json", "settings.json")).toBe(true);
    expect(settingsWatchEventMatchesTarget("other.json", "settings.json")).toBe(false);
    expect(settingsWatchEventMatchesTarget(Buffer.from("settings.json"), "settings.json")).toBe(true);
    expect(settingsWatchEventMatchesTarget(Buffer.from("other.json"), "settings.json")).toBe(false);
  });
});

describe("startSettingsFileWatcher — external settings edits (real temp dir, production saveSettings)", () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitUntil timed out");
      }
      await delay(20);
    }
  }

  const handles: Array<() => void> = [];
  afterEach(() => {
    handles.splice(0).forEach((close) => close());
  });
  function watch(
    logger: Parameters<typeof startSettingsFileWatcher>[1],
    onChange: (settings: AnycodeSettings) => void | Promise<void>,
  ): void {
    handles.push(startSettingsFileWatcher(settingsPath, logger, onChange));
  }

  it("delivers two sequential external replacements as two serialized callbacks", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a"] }] });
    const seen: string[] = [];
    watch(undefined, (settings) => {
      seen.push((settings.provider.connections[0]?.models ?? []).join(","));
    });
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a", "b"] }] });
    await waitUntil(() => seen.length === 1);
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a", "b", "c"] }] });
    await waitUntil(() => seen.length === 2);
    expect(seen).toEqual(["a,b", "a,b,c"]);
  });

  it("skips repeated identical bytes (no callback)", async () => {
    const text = JSON.stringify(v2Settings({ connections: [{ id: "c1", providerId: "kimi" }] }));
    await writeFile(settingsPath, text);
    const seen: AnycodeSettings[] = [];
    watch(undefined, (settings) => {
      seen.push(settings);
    });
    await writeFile(settingsPath, text);
    await delay(500);
    expect(seen).toEqual([]);
  });

  it("ignores invalid JSON and schema-invalid content, never rewriting the file, and still catches a later valid edit", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi" }] });
    const logger = { warn: vi.fn() };
    const seen: string[] = [];
    watch(logger, (settings) => {
      seen.push((settings.provider.connections[0]?.models ?? []).join(","));
    });
    const invalidJson = "{ not json";
    await writeFile(settingsPath, invalidJson);
    await waitUntil(() => logger.warn.mock.calls.length >= 1);
    expect(await readFile(settingsPath, "utf8")).toBe(invalidJson);
    const schemaInvalid = JSON.stringify({ version: 2, provider: { connections: [{ id: 1 }] } });
    await writeFile(settingsPath, schemaInvalid);
    await waitUntil(() => logger.warn.mock.calls.length >= 2);
    expect(await readFile(settingsPath, "utf8")).toBe(schemaInvalid);
    expect(seen).toEqual([]);
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["recovered"] }] });
    await waitUntil(() => seen.length === 1);
    expect(seen).toEqual(["recovered"]);
  });

  it("ignores an unrelated filename in the directory", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi" }] });
    const seen: AnycodeSettings[] = [];
    watch(undefined, (settings) => {
      seen.push(settings);
    });
    await writeFile(join(dir, "other.json"), JSON.stringify({ hello: "world" }));
    await delay(500);
    expect(seen).toEqual([]);
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["x"] }] });
    await waitUntil(() => seen.length === 1);
  });

  it("handles delete then recreation", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a"] }] });
    const seen: string[] = [];
    watch(undefined, (settings) => {
      seen.push((settings.provider.connections[0]?.models ?? []).join(","));
    });
    await rm(settingsPath, { force: true });
    await delay(300);
    expect(seen).toEqual([]);
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a", "recreated"] }] });
    await waitUntil(() => seen.length === 1);
    expect(seen).toEqual(["a,recreated"]);
  });

  it("close() cancels pending work", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi" }] });
    const seen: AnycodeSettings[] = [];
    const close = startSettingsFileWatcher(settingsPath, undefined, (settings) => {
      seen.push(settings);
    });
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["late"] }] });
    close();
    await delay(500);
    expect(seen).toEqual([]);
  });

  it("logs a rejecting callback and keeps later changes operable", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a"] }] });
    const logger = { warn: vi.fn() };
    const seen: string[] = [];
    let fail = true;
    watch(logger, (settings) => {
      if (fail) {
        throw new Error("handler boom");
      }
      seen.push((settings.provider.connections[0]?.models ?? []).join(","));
    });
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a", "b"] }] });
    await waitUntil(() => logger.warn.mock.calls.length >= 1);
    fail = false;
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["a", "b", "c"] }] });
    await waitUntil(() => seen.length === 1);
    expect(seen).toEqual(["a,b,c"]);
  });

  it("bounds an own-write callback to a stable count (no mutation loop)", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["x"] }] });
    let count = 0;
    watch(undefined, async (settings) => {
      count += 1;
      await saveSettings(settingsPath, settings);
    });
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["x", "y"] }] });
    await waitUntil(() => count >= 1);
    await delay(600);
    const settled = count;
    await delay(400);
    expect(count).toBe(settled);
    expect(count).toBeLessThanOrEqual(3);
  });

  it("registerProviderIpc wires the existing onMutation to external edits and returns a disposer", async () => {
    mockHandlers.clear();
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi" }] });
    const onMutation = vi.fn();
    const handle = registerProviderIpc(makeDeps({ onMutation }));
    expect(mockHandlers.has(CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL)).toBe(true);
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["m"] }] });
    await waitUntil(() => onMutation.mock.calls.length === 1);
    expect(onMutation.mock.calls[0]?.[0]).toMatchObject({ provider: { connections: [{ id: "c1", models: ["m"] }] } });
    handle.dispose();
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi", models: ["m2"] }] });
    await delay(500);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("without an onMutation hook, registerProviderIpc starts no watcher and returns a safe disposer", async () => {
    mockHandlers.clear();
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "kimi" }] });
    const handle = registerProviderIpc(makeDeps());
    expect(() => handle.dispose()).not.toThrow();
  });
});

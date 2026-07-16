/**
 * Unit tests for the custom-provider IPC handlers (owner-decision #6, cut
 * §9.2, TASK.54) — CRUD off a FAKE vault + scratch settings path (no
 * Electron `ipcMain`), and the guarded `/v1/models` fetch against REAL local
 * `node:http` servers (not a mocked `fetch`) so the redirect/body-cap/timeout
 * behavior is exercised for real, not asserted against a stub that could be
 * gamed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../settings/files.js";
import type { CustomProviderRecord, SecretKey } from "../shared/settings.js";
import {
  customProviderSecretKey,
  fetchCustomProviderModels,
  handleCustomProviderCreate,
  handleCustomProviderDelete,
  handleCustomProviderFetchModels,
  handleCustomProviderUpdate,
  isAllowedCustomProviderUrl,
  type ProviderIpcDeps,
  type ProviderVaultLike,
} from "./provider-ipc.js";
import type { SecretSetResult } from "./vault.js";

// ── fake vault (mirrors settings-ipc.test.ts's FakeVault, trimmed to this module's surface) ──

class FakeVault implements ProviderVaultLike {
  store = new Map<string, string>();
  weakConsentRequired = false;
  async setSecret(key: SecretKey, value: string): Promise<SecretSetResult> {
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

  it("fetches and parses a normal models list, sending the key ONLY as an Authorization header", async () => {
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    const { origin } = await listen((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: origin, apiKey: "sekrit-key" });
    expect(result).toEqual({ ok: true, models: [{ id: "model-a" }, { id: "model-b" }] });
    expect(receivedAuth).toBe("Bearer sekrit-key");
    expect(receivedPath).toBe("/v1/models");
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

  it("strips a trailing slash on baseUrl before appending /v1/models", async () => {
    const { origin } = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    const result = await fetchCustomProviderModels({ baseUrl: `${origin}/` });
    expect(result).toEqual({ ok: true, models: [{ id: "m" }] });
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

  it("refuses a non-localhost http baseUrl on update", async () => {
    await seed();
    const res = await handleCustomProviderUpdate(makeDeps(), { id: "custom:fixed-id", baseUrl: "http://evil.example.com" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
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

  it("returns invalid_request for an unknown id", async () => {
    const res = await handleCustomProviderFetchModels(makeDeps(), { id: "custom:nope" });
    expect(res).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("returns invalid_request for a malformed payload", async () => {
    const res = await handleCustomProviderFetchModels(makeDeps(), { nonsense: true });
    expect(res).toEqual({ ok: false, reason: "invalid_request" });
  });
});

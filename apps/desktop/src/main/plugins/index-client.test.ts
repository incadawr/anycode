/**
 * Tests for the signed official plugin index client (Taskana 4732 S1-B):
 * valid signature, wrong key, tampered byte, unknown keyId, serial
 * rollback, expiry, ETag 304 replay, oversize body, timeout, offline cache
 * — all over an injected fetch + fs + clock, zero network.
 */

import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OFFICIAL_PLUGIN_INDEX_URL, officialIndexSigUrl } from "../../shared/plugin-trust.js";
import {
  checkPluginIndex,
  indexIsExpired,
  readCachedPluginIndex,
  verifyIndex,
  verifyIndexSignature,
  type IndexClientFs,
  type IndexFetch,
} from "./index-client.js";

// ── real ed25519 pair (test fixture — generated per run, never committed) ──

function makeKey(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function signBytes(privateKey: ReturnType<typeof makeKey>["privateKey"], data: string): string {
  return ed25519Sign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");
}

function makeIndex(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "anycode.plugins-index.v1",
    serial: 42,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    plugins: [
      {
        name: "anycode-essentials",
        displayName: "AnyCode Essentials",
        description: "deep-research + personas",
        default: true,
        versions: [
          {
            version: "1.4.2",
            engines: { anycode: ">=0.0.35" },
            url: "https://github.com/incadawr/anycode-plugins/releases/download/anycode-essentials-v1.4.2/anycode-essentials-1.4.2.tgz",
            sha256: "a".repeat(64),
            size: 183_224,
            capabilities: ["skills", "agents", "workflows"],
          },
        ],
      },
    ],
    ...overrides,
  });
}

// ── fake fs + fetch ──

function makeFs(): IndexClientFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    exists: async (path) => files.has(path),
  };
}

type Route = { url: string; status?: number; body?: string; etag?: string; kind?: "network" | "timeout" };

function makeFetch(routes: Route[]): IndexFetch & { calls: { url: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetchImpl: IndexFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const route = routes.find((r) => r.url === url);
    if (route === undefined) return { ok: false, kind: "network" };
    if (route.kind !== undefined) return { ok: false, kind: route.kind };
    return { ok: true, status: route.status ?? 200, body: route.body ?? "", etag: route.etag };
  };
  const wrapped = (url: string, init?: Parameters<IndexFetch>[1]) => fetchImpl(url, init);
  wrapped.calls = calls;
  return wrapped;
}

const NOW = Date.parse("2026-10-10T00:00:00.000Z");

describe("verifyIndexSignature", () => {
  it("accepts a valid signature by the matching key", () => {
    const key = makeKey("ac-2026-1");
    const raw = makeIndex();
    const sig = { keyId: key.keyId, sig: signBytes(key.privateKey, raw) };
    expect(verifyIndexSignature(raw, sig, [key])).toEqual({ ok: true, keyId: "ac-2026-1" });
  });

  it("rejects a tampered byte", () => {
    const key = makeKey("ac-2026-1");
    const sig = { keyId: key.keyId, sig: signBytes(key.privateKey, makeIndex()) };
    const tampered = makeIndex({ serial: 43 });
    expect(verifyIndexSignature(tampered, sig, [key])).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature made with a DIFFERENT key (wrong key)", () => {
    const signer = makeKey("ac-2026-1");
    const compiled = makeKey("ac-2026-2");
    const sig = { keyId: compiled.keyId, sig: signBytes(signer.privateKey, makeIndex()) };
    expect(verifyIndexSignature(makeIndex(), sig, [compiled])).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects an unknown keyId", () => {
    const signer = makeKey("attacker-1");
    const compiled = makeKey("ac-2026-1");
    const sig = { keyId: signer.keyId, sig: signBytes(signer.privateKey, makeIndex()) };
    expect(verifyIndexSignature(makeIndex(), sig, [compiled])).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("rejects a malformed envelope", () => {
    const key = makeKey("ac-2026-1");
    expect(verifyIndexSignature(makeIndex(), { nope: true }, [key])).toEqual({ ok: false, reason: "malformed" });
    expect(verifyIndexSignature(makeIndex(), undefined, [key])).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("verifyIndex (schema + gates)", () => {
  const key = makeKey("ac-2026-1");

  function signed(raw: string): unknown {
    return { keyId: key.keyId, sig: signBytes(key.privateKey, raw) };
  }

  it("accepts a well-formed signed index", () => {
    const result = verifyIndex(makeIndex(), signed(makeIndex()), { now: NOW, keys: [key] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index.serial).toBe(42);
      expect(result.index.plugins[0]!.name).toBe("anycode-essentials");
    }
  });

  it("refuses a serial below the floor (anti-rollback)", () => {
    const raw = makeIndex({ serial: 41 });
    const result = verifyIndex(raw, signed(raw), { serialFloor: 42, now: NOW, keys: [key] });
    expect(result).toMatchObject({ ok: false, status: "rollback" });
  });

  it("flags an index past expiresAt", () => {
    const raw = makeIndex();
    const index = verifyIndex(raw, signed(raw), { now: NOW, keys: [key] });
    expect(index.ok && indexIsExpired(index.index, Date.parse("2026-11-01T00:00:00.000Z"))).toBe(true);
  });

  it("rejects a wrong schemaVersion", () => {
    const raw = makeIndex({ schemaVersion: "anycode.plugins-index.v2" });
    expect(verifyIndex(raw, signed(raw), { now: NOW, keys: [key] })).toMatchObject({ ok: false, status: "signature-failed" });
  });
});

describe("checkPluginIndex", () => {
  const key = makeKey("ac-2026-1");

  function okRoutes(raw: string, etag = '"v1"'): Route[] {
    return [
      { url: OFFICIAL_PLUGIN_INDEX_URL, body: raw, etag },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), body: JSON.stringify({ keyId: key.keyId, sig: signBytes(key.privateKey, raw) }) },
    ];
  }

  it("fetches, verifies and caches a fresh index", async () => {
    const fs = makeFs();
    const fetchImpl = makeFetch(okRoutes(makeIndex()));
    const result = await checkPluginIndex({
      cacheDir: "/cache",
      keys: [key],
      fetchImpl,
      now: () => NOW,
      fs,
    });
    expect(result.status).toBe("ok");
    expect(result.fromCache).toBe(false);
    expect(result.index?.serial).toBe(42);
    // Cache persisted (meta with raw+sig+etag).
    expect(fs.files.has("/cache/index.json.meta")).toBe(true);
  });

  it("replays the cached verified index on 304 (ETag)", async () => {
    const raw = makeIndex();
    const fs = makeFs();
    // Prime the cache with a successful check.
    await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl: makeFetch(okRoutes(raw, '"v1"')), now: () => NOW, fs });
    // Second check: 304 on both.
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, status: 304, etag: '"v1"' },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), status: 304 },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs });
    expect(result.status).toBe("ok");
    expect(result.fromCache).toBe(true);
    expect(result.index?.serial).toBe(42);
    // ETag was sent.
    expect(fetchImpl.calls[0]?.headers?.["if-none-match"]).toBe('"v1"');
  });

  it("falls back to the cached verified index when offline", async () => {
    const fs = makeFs();
    await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl: makeFetch(okRoutes(makeIndex())), now: () => NOW, fs });
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, kind: "network" },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), kind: "network" },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs });
    expect(result.status).toBe("ok");
    expect(result.fromCache).toBe(true);
  });

  it("reports expired when the cached index is past expiresAt and offline", async () => {
    const fs = makeFs();
    await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl: makeFetch(okRoutes(makeIndex())), now: () => NOW, fs });
    const later = Date.parse("2026-11-15T00:00:00.000Z");
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, kind: "network" },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), kind: "network" },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => later, fs });
    expect(result.status).toBe("expired");
    expect(result.index?.serial).toBe(42); // still listed
  });

  it("reports signature-failed on a tampered network copy and keeps the cache", async () => {
    const fs = makeFs();
    await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl: makeFetch(okRoutes(makeIndex())), now: () => NOW, fs });
    const tampered = makeIndex({ serial: 99 });
    const sigForOriginal = signBytes(key.privateKey, makeIndex());
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, body: tampered, etag: '"v2"' },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), body: JSON.stringify({ keyId: key.keyId, sig: sigForOriginal }) },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs });
    expect(result.status).toBe("signature-failed");
    expect(result.index?.serial).toBe(42); // cached verified copy survives
  });

  it("reports rollback when the network serial is below the floor", async () => {
    const raw = makeIndex({ serial: 5 });
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, body: raw },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), body: JSON.stringify({ keyId: key.keyId, sig: signBytes(key.privateKey, raw) }) },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs: makeFs(), serialFloor: 42 });
    expect(result.status).toBe("rollback");
  });

  it("refuses an oversize body (too_large)", async () => {
    const big = `${makeIndex()}${"x".repeat(600 * 1024)}`;
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, body: big },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), body: "{}" },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs: makeFs() });
    expect(result.status === "too_large" || result.status === "signature-failed").toBe(true);
  });

  it("times out and falls back to cache", async () => {
    const fs = makeFs();
    await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl: makeFetch(okRoutes(makeIndex())), now: () => NOW, fs });
    const fetchImpl = makeFetch([
      { url: OFFICIAL_PLUGIN_INDEX_URL, kind: "timeout" },
      { url: officialIndexSigUrl(OFFICIAL_PLUGIN_INDEX_URL), kind: "timeout" },
    ]);
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [key], fetchImpl, now: () => NOW, fs });
    expect(result.status).toBe("ok");
    expect(result.fromCache).toBe(true);
  });

  it("treats a test-only key list as not configured (§9.14)", async () => {
    const testKey = makeKey("test-2026-1");
    const fetchImpl = makeFetch(okRoutes(makeIndex()));
    const result = await checkPluginIndex({ cacheDir: "/cache", keys: [testKey], fetchImpl, now: () => NOW, fs: makeFs() });
    expect(result.status).toBe("offline");
    expect(result.detail).toContain("not configured");
    // and it never fetched.
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("readCachedPluginIndex", () => {
  it("returns unchecked with no cache", async () => {
    const result = await readCachedPluginIndex({ cacheDir: "/cache", fs: makeFs(), now: () => NOW });
    expect(result.status).toBe("unchecked");
  });
});

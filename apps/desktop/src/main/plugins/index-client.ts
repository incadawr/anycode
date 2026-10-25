/**
 * Signed official plugin index client (Taskana 4732 S1-B, design §3/§4):
 * fetches `index.json` + `index.json.sig` from the official repo, verifies
 * the ed25519 signature over the EXACT index bytes, enforces
 * anti-rollback (`serial` monotonicity against the caller-supplied floor)
 * and expiry, and maintains an ETag cache under `~/.anycode/plugins/.cache/`.
 *
 * EVERYTHING is injectable (fetch, fs surface, clock) — unit tests never
 * touch the network (the brief's hard rule). The module is Electron-free
 * and core-barrel-free; zod validates the wire shape.
 *
 * Outcome discipline: the caller (store/scheduler) receives a DISCRIMINATED
 * result — `{status:"ok", index}` | `{status:"offline"|"signature-failed"|
 * "expired"|"rollback"|"network"|"too_large", cached?}` — never a throw.
 * On every failure the LAST VERIFIED cached index is offered as `cached`
 * (design §5 "offline → keep cached verified index"); a cached index past
 * its own `expiresAt` is flagged `expiredInCache: true` so callers can show
 * "index expired" while still listing what it held (installs from it are
 * the caller's refusal, design §4).
 */

import { createHash, verify as ed25519Verify, createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  OFFICIAL_PLUGIN_INDEX_URL,
  OFFICIAL_PLUGIN_KEYS,
  PLUGIN_FETCH_TIMEOUT_MS,
  PLUGIN_INDEX_MAX_BYTES,
  isOfficialChannelConfigured,
  officialIndexSigUrl,
  type OfficialPluginKey,
} from "../../shared/plugin-trust.js";

// ── wire schemas (design §3 index format) ──

const indexVersionSchema = z.object({
  version: z.string().min(1),
  engines: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 hex"),
  size: z.number().int().nonnegative(),
  capabilities: z.array(z.string()).default([]),
});

const indexEntrySchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().default(false),
  versions: z.array(indexVersionSchema).min(1),
});

const pluginsIndexSchema = z.object({
  schemaVersion: z.literal("anycode.plugins-index.v1"),
  serial: z.number().int().nonnegative(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  plugins: z.array(indexEntrySchema).default([]),
});

export type PluginIndexVersion = z.output<typeof indexVersionSchema>;
export type PluginIndexEntry = z.output<typeof indexEntrySchema>;
export type PluginIndex = z.output<typeof pluginsIndexSchema>;

/** The `.sig` sidecar shape (design §4). */
const signatureEnvelopeSchema = z.object({
  keyId: z.string().min(1),
  /** base64 ed25519 over the exact index.json bytes. */
  sig: z.string().min(1),
});

// ── injectable deps ──

/** The fs surface the client needs — structural, satisfied by fsp + a dir helper. */
export interface IndexClientFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export type IndexFetch = (url: string, init?: { headers?: Record<string, string>; redirect?: "error" | "follow"; signal?: AbortSignal; timeoutMs?: number }) => Promise<
  | { ok: true; status: number; body: string; etag?: string }
  | { ok: false; kind: "network" | "timeout" }
>;

export interface IndexClientOptions {
  /** Cache directory (`.cache`); index.json + index.json.sig live here. */
  cacheDir: string;
  /** Override of the compiled URL (settings.plugins.officialIndexUrl, dev/automation only). */
  indexUrl?: string;
  keys?: readonly OfficialPluginKey[];
  fetchImpl?: IndexFetch;
  now?: () => number;
  fs?: IndexClientFs;
}

export type IndexCheckStatus =
  | "ok"
  | "offline"
  | "expired"
  | "signature-failed"
  | "rollback"
  | "too_large"
  | "network"
  | "unchecked";

export interface IndexCheckResult {
  status: IndexCheckStatus;
  /** The verified index (fresh network copy, or the last verified cache on failure). */
  index?: PluginIndex;
  /** Set when `index` came from the cache rather than the network. */
  fromCache: boolean;
  /** True when the (cached) index is past its own expiresAt. */
  expired: boolean;
  /** Human-facing detail for the pane. */
  detail?: string;
}

interface CacheFile {
  fetchedAt: string;
  etag?: string;
  /** The exact signed bytes — signature verification replays over them. */
  raw: string;
  sig: string;
}

const CACHE_FILE = "index.json";
const CACHE_META_FILE = "index.json.meta";

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

/** Reads + structurally re-validates the cache; null on absence/corruption. */
async function readCache(fs: IndexClientFs, cacheDir: string): Promise<CacheFile | null> {
  const metaPath = `${cacheDir}/${CACHE_META_FILE}`;
  if (!(await fs.exists(metaPath))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(metaPath)) as Record<string, unknown>;
    if (typeof parsed.fetchedAt !== "string" || typeof parsed.raw !== "string" || typeof parsed.sig !== "string") {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
      raw: parsed.raw,
      sig: parsed.sig,
    };
  } catch {
    return null;
  }
}

/**
 * Signature verification over the EXACT bytes: ed25519 via node:crypto.
 * Returns the matching key when ANY compiled production/test key verifies.
 */
export function verifyIndexSignature(
  raw: string,
  sigEnvelope: unknown,
  keys: readonly OfficialPluginKey[] = OFFICIAL_PLUGIN_KEYS,
): { ok: true; keyId: string } | { ok: false; reason: "malformed" | "unknown-key" | "bad-signature" } {
  const parsed = signatureEnvelopeSchema.safeParse(sigEnvelope);
  if (!parsed.success) {
    return { ok: false, reason: "malformed" };
  }
  const key = keys.find((k) => k.keyId === parsed.data.keyId);
  if (key === undefined) {
    return { ok: false, reason: "unknown-key" };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(parsed.data.sig, "base64");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let verifies: boolean;
  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    verifies = ed25519Verify(null, Buffer.from(raw, "utf8"), publicKey, signature);
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  return verifies ? { ok: true, keyId: key.keyId } : { ok: false, reason: "bad-signature" };
}

/**
 * Full verification pipeline over a byte pair: signature → schema →
 * serial/expiry gates. Pure (no fs/network) — shared by the fetch path and
 * the cache-replay path, and directly unit-testable.
 */
export function verifyIndex(
  raw: string,
  sigEnvelope: unknown,
  opts: { serialFloor?: number; now: number; keys?: readonly OfficialPluginKey[] },
): { ok: true; index: PluginIndex } | { ok: false; status: IndexCheckStatus; detail: string } {
  const sig = verifyIndexSignature(raw, sigEnvelope, opts.keys);
  if (!sig.ok) {
    return { ok: false, status: "signature-failed", detail: `index signature rejected (${sig.reason})` };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, status: "signature-failed", detail: "index bytes are not JSON" };
  }
  const parsed = pluginsIndexSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, status: "signature-failed", detail: `index schema invalid: ${parsed.error.issues[0]?.message ?? "shape"}` };
  }
  const index = parsed.data;
  if (opts.serialFloor !== undefined && index.serial < opts.serialFloor) {
    return { ok: false, status: "rollback", detail: `index serial ${index.serial} < last seen ${opts.serialFloor} (rollback refused)` };
  }
  const expires = Date.parse(index.expiresAt);
  if (!Number.isFinite(expires)) {
    return { ok: false, status: "signature-failed", detail: "index expiresAt is not a date" };
  }
  return { ok: true, index };
}

/** True when `index` is past its own expiresAt at time `now` (ms). */
export function indexIsExpired(index: PluginIndex, now: number): boolean {
  const expires = Date.parse(index.expiresAt);
  return Number.isFinite(expires) && expires < now;
}

/** Bounded fetch race — an injected fetch that ignores the abort signal still fails closed. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function fetchText(
  fetchImpl: IndexFetch,
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number },
): Promise<{ ok: true; status: number; body: string; etag?: string } | { ok: false; kind: "network" | "timeout" | "too_large" }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: opts.headers,
        redirect: "error",
        signal: controller.signal,
        timeoutMs: opts.timeoutMs,
      });
      if (!response.ok) {
        return { ok: false, kind: "network" };
      }
      if (response.body.length > PLUGIN_INDEX_MAX_BYTES) {
        return { ok: false, kind: "too_large" };
      }
      return { ok: true, status: response.status, body: response.body, etag: response.etag };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("timeout")) {
      return { ok: false, kind: "timeout" };
    }
    return { ok: false, kind: "network" };
  }
}

/**
 * Runs one full check: fetch index + sig (ETag revalidation against the
 * cached verified copy), verify, gate serial/expiry, refresh the cache on
 * success. NEVER throws; every failure offers the cached verified index.
 */
export async function checkPluginIndex(options: IndexClientOptions & { serialFloor?: number }): Promise<IndexCheckResult> {
  const keys = options.keys ?? OFFICIAL_PLUGIN_KEYS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const fs = options.fs ?? defaultFs;
  const indexUrl = options.indexUrl ?? OFFICIAL_PLUGIN_INDEX_URL;

  // §9.14: with no production key compiled in, the channel is not configured.
  if (!isOfficialChannelConfigured(keys)) {
    const cached = await readCache(fs, options.cacheDir);
    if (cached !== null) {
      const verified = verifyIndex(cached.raw, safeJsonParse(cached.sig), { serialFloor: options.serialFloor, now: now(), keys });
      if (verified.ok) {
        return { status: "ok", index: verified.index, fromCache: true, expired: indexIsExpired(verified.index, now()) };
      }
    }
    return { status: "offline", fromCache: false, expired: false, detail: "official plugin index is not configured (test keys only)" };
  }

  const cached = await readCache(fs, options.cacheDir);
  const cachedFallback = async (): Promise<IndexCheckResult> => {
    if (cached === null) {
      return { status: "offline", fromCache: false, expired: false, detail: "offline and no verified cached index" };
    }
    const verified = verifyIndex(cached.raw, safeJsonParse(cached.sig), { serialFloor: options.serialFloor, now: now(), keys });
    if (!verified.ok) {
      return { status: verified.status === "rollback" ? "rollback" : "signature-failed", fromCache: true, expired: true, detail: verified.detail };
    }
    const expired = indexIsExpired(verified.index, now());
    return {
      status: expired ? "expired" : "ok",
      index: verified.index,
      fromCache: true,
      expired,
      ...(expired ? { detail: "offline — cached index is past its expiry" } : {}),
    };
  };

  const headers: Record<string, string> = { accept: "application/json" };
  if (cached?.etag !== undefined) {
    headers["if-none-match"] = cached.etag;
  }

  const [indexRes, sigRes] = await Promise.all([
    fetchText(fetchImpl, indexUrl, { headers, timeoutMs: PLUGIN_FETCH_TIMEOUT_MS }),
    fetchText(fetchImpl, officialIndexSigUrl(indexUrl), { headers: { accept: "application/json" }, timeoutMs: PLUGIN_FETCH_TIMEOUT_MS }),
  ]);

  if (!indexRes.ok || !sigRes.ok) {
    const kind = !indexRes.ok ? indexRes.kind : (sigRes as { ok: false; kind: string }).kind;
    const fallback = await cachedFallback();
    return kind === "too_large"
      ? { status: "too_large", index: fallback.index, fromCache: fallback.fromCache, expired: fallback.expired, detail: "index larger than cap" }
      : fallback;
  }

  if (indexRes.status === 304 && cached !== null) {
    // Not modified: replay verification over the cached bytes (also refreshes the serial/expiry gates).
    const verified = verifyIndex(cached.raw, safeJsonParse(cached.sig), { serialFloor: options.serialFloor, now: now(), keys });
    if (!verified.ok) {
      return { status: verified.status, fromCache: true, expired: true, detail: verified.detail };
    }
    // Touch fetchedAt so the cache stays the freshest truth.
    await writeCache(fs, options.cacheDir, { ...cached, fetchedAt: nowIso(now()) });
    const expired = indexIsExpired(verified.index, now());
    return { status: expired ? "expired" : "ok", index: verified.index, fromCache: true, expired };
  }
  if (indexRes.status !== 200 || sigRes.status !== 200) {
    return cachedFallback();
  }

  const verified = verifyIndex(indexRes.body, safeJsonParse(sigRes.body), { serialFloor: options.serialFloor, now: now(), keys });
  if (!verified.ok) {
    // A bad NETWORK copy must not poison the cache — fall back to the last verified one.
    const fallback = await cachedFallback();
    return { ...fallback, status: verified.status, detail: `${verified.detail}${fallback.index !== undefined ? " (using cached verified index)" : ""}` };
  }

  await writeCache(fs, options.cacheDir, {
    fetchedAt: nowIso(now()),
    ...(indexRes.etag !== undefined ? { etag: indexRes.etag } : {}),
    raw: indexRes.body,
    sig: sigRes.body,
  });
  const expired = indexIsExpired(verified.index, now());
  return {
    status: expired ? "expired" : "ok",
    index: verified.index,
    fromCache: false,
    expired,
    ...(expired ? { detail: "index is past its expiry — no new installs/updates from it" } : {}),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function writeCache(fs: IndexClientFs, cacheDir: string, cache: CacheFile): Promise<void> {
  try {
    await fs.writeFile(`${cacheDir}/${CACHE_META_FILE}`, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // Advisory cache: a failed persist never fails the check.
  }
}

/** Reads the last VERIFIED cached index (no network). For boot-time listing. */
export async function readCachedPluginIndex(options: {
  cacheDir: string;
  now?: () => number;
  keys?: readonly OfficialPluginKey[];
  fs?: IndexClientFs;
}): Promise<IndexCheckResult> {
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? Date.now;
  const cached = await readCache(fs, options.cacheDir);
  if (cached === null) {
    return { status: "unchecked", fromCache: false, expired: false };
  }
  const verified = verifyIndex(cached.raw, safeJsonParse(cached.sig), { now: now(), keys: options.keys });
  if (!verified.ok) {
    return { status: "signature-failed", fromCache: true, expired: true, detail: verified.detail };
  }
  const expired = indexIsExpired(verified.index, now());
  return { status: expired ? "expired" : "ok", index: verified.index, fromCache: true, expired };
}

/** sha256 hex of a byte string (archive integrity, shared with the store). */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── default (production) deps ──

const defaultFs: IndexClientFs = {
  readFile: async (path) => (await import("node:fs/promises")).readFile(path, "utf-8"),
  writeFile: async (path, content) => {
    const fsp = await import("node:fs/promises");
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, content, "utf-8");
  },
  exists: async (path) => {
    const fsp = await import("node:fs/promises");
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },
};

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Thin global-fetch adapter honouring the IndexFetch contract. */
const defaultFetch: IndexFetch = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? PLUGIN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: init?.headers,
      redirect: init?.redirect ?? "error",
      signal: controller.signal,
    });
    if (response.status === 304) {
      return { ok: true, status: 304, body: "" };
    }
    if (response.status !== 200) {
      return { ok: false, kind: "network" };
    }
    const body = await response.text();
    return { ok: true, status: 200, body, etag: response.headers.get("etag") ?? undefined };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, kind: "timeout" };
    }
    return { ok: false, kind: "network" };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Custom OpenAI-compatible model-provider IPC (owner-decision #6, cut §9.2,
 * TASK.54). Two concerns:
 *
 *  1. CRUD for `settings.provider.custom[]` — additive-optional records the
 *     user builds from a base URL + API key + a curated subset of that
 *     endpoint's models (settings/schema.ts already validates the SHAPE and
 *     the https/localhost URL policy per element; the handlers here re-check
 *     the URL policy explicitly so a rejection carries a specific reason
 *     instead of a generic schema-mismatch `invalid`).
 *  2. A guarded models-list fetch main runs on the user's behalf — the
 *     renderer never holds a key long enough to call an arbitrary origin
 *     itself (custody: a decrypted key only ever travels main-side, and only
 *     to the ONE origin the user configured).
 *
 * Mirrors main/settings-ipc.ts's deps-bag / exported-handle* / register*
 * pattern (unit-testable off a fake vault + scratch settings path, no
 * `ipcMain`) but is a DELIBERATELY SEPARATE module (settings-ipc.ts's file
 * zone belongs to a different lane, cut §13.1). Every mutating handler here
 * AND in settings-ipc.ts serializes through the ONE exported
 * `withSettingsFileLock` primitive in settings/files.ts (FX3-L1 G-C closed
 * the former two-private-locks residual), so a create/update/delete here can
 * never interleave with a `connection-*` mutation in the other module.
 *
 * WIRING (done outside this module): main/index.ts calls
 * `registerProviderIpc` with the live deps bag, the four channel names below
 * are bridged in preload/index.ts, and main's `catalogIds` unions
 * `customProviderIds(settings)` (host-env.ts) — all wired by FX2-4.
 *
 * THREAT MODEL for the fetch (cut §9.2 — SSRF/key-exfil via a user-supplied
 * origin):
 *  - only `https:`, or `http:` scoped to loopback (localhost/127.0.0.1/[::1]),
 *    and never a URL carrying embedded userinfo (`user:pass@host` — amendment-1
 *    FX2-1: a secret placed there would otherwise round-trip into
 *    settings.json in plaintext and back out to the renderer);
 *  - the request runs with `redirect: "error"` — ANY redirect (same-origin or
 *    cross-origin) aborts the fetch rather than being followed, closing the
 *    exfil vector without needing to inspect an opaque `Location` (Node's
 *    fetch makes a manual-mode redirect response opaque — status 0, no
 *    headers — so a same-origin/cross-origin distinction cannot be read back
 *    from it; refusing every redirect is the strictly safer superset);
 *  - the response body is capped both by a `Content-Length` pre-check and a
 *    running byte count while streaming (a lying/absent Content-Length does
 *    not bypass the cap);
 *  - the API key is sent ONLY as a header (`Authorization: Bearer`, or
 *    `x-api-key` for `kind: "anthropic"`) of this ONE request to this ONE
 *    origin — never anywhere else, never in a query string;
 *  - nothing here ever logs the URL, the key, or the body.
 */

import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { z } from "zod";
import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { isHttpsOrLocalhostUrl, isLoopbackUrl, settingsSchema } from "../settings/schema.js";
import type { AnycodeSettings, CustomProviderRecord, SecretKey } from "../shared/settings.js";
import type { SecretSetResult } from "./vault.js";

// ── URL policy (single source of truth is settings/schema.ts's
// `isHttpsOrLocalhostUrl`; re-exported under this module's original name so
// existing call sites here and the test import stay unchanged) ──

export const isAllowedCustomProviderUrl = isHttpsOrLocalhostUrl;

// ── guarded models-list fetch (S5-2: baseUrl already carries `/v1` like the session wire's `normalizeExplicitBaseUrl` expects, so appending `/models` still lands on `/v1/models`) ──

const DEFAULT_TIMEOUT_MS = 10_000;
/** A models list is small JSON; 2 MiB is generous headroom over any real catalog. */
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MODELS_PATH = "/models";

export type FetchModelsFailureReason =
  | "invalid_request"
  | "invalid_url"
  | "redirect_blocked"
  | "http_error"
  | "response_too_large"
  | "timeout"
  | "network_error"
  | "invalid_response";

export type FetchModelsOutcome =
  | { ok: true; models: { id: string }[] }
  | { ok: false; reason: FetchModelsFailureReason };

/** Minimal fetch surface this module needs (injectable; defaults to global fetch — mirrors oauth.ts's `FetchLike`). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export interface FetchModelsParams {
  baseUrl: string;
  apiKey?: string;
  /** Auth header shape (Anthropic's API wants `x-api-key`, not `Authorization: Bearer`). Defaults to "openai-compatible". */
  kind?: CustomProviderRecord["kind"];
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Injectable fetch (tests point this at a real local HTTP server). */
  fetchImpl?: FetchLike;
}

/** Auth headers for the ONE request to the configured origin — never logged, never sent anywhere else. */
function authHeaders(kind: CustomProviderRecord["kind"] | undefined, apiKey: string | undefined): Record<string, string> {
  if (apiKey === undefined || apiKey === "") {
    return {};
  }
  if (kind === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/** Runs the guarded models-list GET described in the module doc's threat model. */
export async function fetchCustomProviderModels(params: FetchModelsParams): Promise<FetchModelsOutcome> {
  if (!isAllowedCustomProviderUrl(params.baseUrl)) {
    return { ok: false, reason: "invalid_url" };
  }
  const fetchImpl = params.fetchImpl ?? defaultFetch;
  const url = `${params.baseUrl.replace(/\/+$/, "")}${MODELS_PATH}`;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...authHeaders(params.kind, params.apiKey),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    // Node's fetch rejects a `redirect: "error"` hit with a TypeError("fetch
    // failed") whose `.cause` carries the specific "unexpected redirect"
    // message — the outer message alone does not say "redirect".
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error && /redirect/i.test(cause.message)) {
      return { ok: false, reason: "redirect_blocked" };
    }
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) {
    return { ok: false, reason: "http_error" };
  }

  const body = await readBodyCapped(response, maxBodyBytes);
  if (body === undefined) {
    return { ok: false, reason: "response_too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
  const models = extractModelIds(parsed);
  if (models === undefined) {
    return { ok: false, reason: "invalid_response" };
  }
  return { ok: true, models };
}

/** Reads `response`'s body capped at `maxBytes`, undefined when it (or a lying/absent Content-Length) exceeds the cap. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return undefined;
  }
  if (response.body === null) {
    const text = await response.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** `{data:[{id}...]}` -> `{id}[]`; undefined for any other shape (fail-closed, never throws). */
function extractModelIds(value: unknown): { id: string }[] | undefined {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return undefined;
  }
  const data = (value as { data: unknown }).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const models: { id: string }[] = [];
  for (const item of data) {
    if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
      models.push({ id: (item as { id: string }).id });
    }
  }
  return models;
}

// ── custom-provider CRUD ──

/** The vault surface this module depends on (structural — `main/vault.ts`'s `Vault` satisfies it). */
export interface ProviderVaultLike {
  setSecret(key: SecretKey, value: string, opts: { allowWeak: boolean }): Promise<SecretSetResult>;
  clearSecret(key: SecretKey): Promise<void>;
  getSecretValue(key: SecretKey): Promise<string | undefined>;
}

export interface ProviderIpcDeps {
  vault: ProviderVaultLike;
  settingsPath: string;
  logger?: FileIoLogger;
  /** Mints a custom-provider id (`custom:<uuid>`). Injected for determinism in tests. */
  genId?: () => string;
  /** Injectable ISO-timestamp clock for `modelsFetchedAt` (tests only). */
  now?: () => string;
  /** The guarded fetch (tests inject a fake; default `fetchCustomProviderModels`). */
  fetchModels?: (params: FetchModelsParams) => Promise<FetchModelsOutcome>;
  /**
   * Fired after every successful mutation with the fresh settings object —
   * main re-derives catalogIds/catalog projection/readiness off it, mirroring
   * settings-ipc.ts's `onMutation`. Optional so unit tests can omit it.
   */
  onMutation?: (settings: AnycodeSettings) => void | Promise<void>;
}

function defaultGenId(): string {
  return `custom:${randomUUID()}`;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

export type CustomProviderMutationReason =
  | "invalid"
  | "read_only"
  | "not_found"
  | "needs_api_key"
  | "weak_storage_needs_consent";
export type CustomProviderMutationResult =
  | { ok: true; providers: CustomProviderRecord[] }
  | { ok: false; reason: CustomProviderMutationReason };

const kindSchema = z.enum(["openai-compatible", "anthropic", "openai"]);

/** The vault key one custom provider's credential lives under. */
export function customProviderSecretKey(id: string): SecretKey {
  return `provider.${id}.apiKey`;
}

// `.strict()` (custody, mirrors settings-ipc.ts's connection-create schema):
// an unexpected field on this metadata+credential channel is refused rather
// than silently ignored.
const createSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().min(1),
    kind: kindSchema,
    apiKey: z.string().min(1),
    models: z.array(z.string()).optional(),
  })
  .strict();

/**
 * custom-provider-create: mint a new `CustomProviderRecord` + store its key.
 * The key is written to the vault BEFORE settings.json (opposite of
 * connection-delete's secrets-LAST ordering — here the record is worthless
 * without a stored key, so a `weak_storage_needs_consent` refusal must leave
 * ZERO trace, not a keyless record the user has to notice and re-key).
 */
export async function handleCustomProviderCreate(deps: ProviderIpcDeps, raw: unknown): Promise<CustomProviderMutationResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const req = parsed.data;
  if (!isAllowedCustomProviderUrl(req.baseUrl)) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const id = (deps.genId ?? defaultGenId)();
    const record: CustomProviderRecord = {
      id,
      name: req.name,
      baseUrl: req.baseUrl,
      kind: req.kind,
      models: req.models ?? [],
    };
    const custom = [...(loaded.settings.provider.custom ?? []), record];
    const merged: AnycodeSettings = { ...loaded.settings, provider: { ...loaded.settings.provider, custom } };
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false, reason: "invalid" };
    }
    const secretResult = await deps.vault.setSecret(customProviderSecretKey(id), req.apiKey, {
      allowWeak: loaded.settings.security.allowWeakSecretStorage,
    });
    if (!secretResult.ok) {
      return { ok: false, reason: secretResult.reason };
    }
    await saveSettings(deps.settingsPath, merged);
    await deps.onMutation?.(merged);
    return { ok: true, providers: custom };
  });
}

const updateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    kind: kindSchema.optional(),
    apiKey: z.string().optional(),
    models: z.array(z.string()).optional(),
  })
  .strict();

/**
 * custom-provider-update: patch a record's metadata/curated model list, and
 * — only when `apiKey` is present and non-empty — rotate its vault key.
 * `not_found` for an unknown id.
 *
 * ORIGIN-REBIND CUSTODY GUARD (FX3-L1 G-A): the stored vault key is bound to
 * the origin it was presented for. A `baseUrl` change to a DIFFERENT origin
 * without a fresh non-empty `apiKey` in the same request is refused
 * `needs_api_key` with zero side effects (nothing persisted, vault
 * untouched) — otherwise a keyless metadata update could silently re-point
 * the record and the next fetch-models would decrypt the old key and send it
 * to the new origin (a renderer-side one-shot exfil primitive). This update
 * handler is the single enforcement point (no read-side pinning in
 * fetch-models). Waived when BOTH origins are loopback (`isLoopbackUrl` —
 * e.g. a corrected localhost port; the key never leaves this machine either
 * way). A same-origin baseUrl change (path/case) needs no key; a cross-origin
 * change WITH a key succeeds under the existing vault-before-save order.
 */
export async function handleCustomProviderUpdate(deps: ProviderIpcDeps, raw: unknown): Promise<CustomProviderMutationResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const req = parsed.data;
  if (req.baseUrl !== undefined && !isAllowedCustomProviderUrl(req.baseUrl)) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = (loaded.settings.provider.custom ?? []).find((p) => p.id === req.id);
    if (existing === undefined) {
      return { ok: false, reason: "not_found" };
    }
    // Origin-rebind custody guard (see the handler doc). Both URLs are
    // already policy-validated (request: the isAllowedCustomProviderUrl gate
    // above; existing: settings/schema.ts on load), so `new URL` cannot throw.
    if (req.baseUrl !== undefined && (req.apiKey === undefined || req.apiKey === "")) {
      const originChanged = new URL(req.baseUrl).origin !== new URL(existing.baseUrl).origin;
      if (originChanged && !(isLoopbackUrl(existing.baseUrl) && isLoopbackUrl(req.baseUrl))) {
        return { ok: false, reason: "needs_api_key" };
      }
    }
    const updatedRecord: CustomProviderRecord = {
      ...existing,
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.kind !== undefined ? { kind: req.kind } : {}),
      ...(req.models !== undefined
        ? { models: req.models, modelsFetchedAt: (deps.now ?? defaultNowIso)() }
        : {}),
    };
    const custom = (loaded.settings.provider.custom ?? []).map((p) => (p.id === req.id ? updatedRecord : p));
    const merged: AnycodeSettings = { ...loaded.settings, provider: { ...loaded.settings.provider, custom } };
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false, reason: "invalid" };
    }
    if (req.apiKey !== undefined && req.apiKey !== "") {
      const secretResult = await deps.vault.setSecret(customProviderSecretKey(req.id), req.apiKey, {
        allowWeak: loaded.settings.security.allowWeakSecretStorage,
      });
      if (!secretResult.ok) {
        return { ok: false, reason: secretResult.reason };
      }
    }
    await saveSettings(deps.settingsPath, merged);
    await deps.onMutation?.(merged);
    return { ok: true, providers: custom };
  });
}

const idSchema = z.object({ id: z.string().min(1) }).strict();

/**
 * custom-provider-delete: clear the vault key FIRST, then remove the record
 * (mirrors handleConnectionDelete's secrets-first ordering — a crash between
 * the two leaves a visible keyless record, never an orphaned vault entry).
 * Idempotent on an already-gone id is refused `not_found` (unlike
 * connection-delete) — there is no live-session pin to protect here, so a
 * clear "nothing to delete" is more useful feedback than a silent success.
 */
export async function handleCustomProviderDelete(deps: ProviderIpcDeps, raw: unknown): Promise<CustomProviderMutationResult> {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = loaded.settings.provider.custom ?? [];
    if (!existing.some((p) => p.id === parsed.data.id)) {
      return { ok: false, reason: "not_found" };
    }
    await deps.vault.clearSecret(customProviderSecretKey(parsed.data.id));
    const custom = existing.filter((p) => p.id !== parsed.data.id);
    const merged: AnycodeSettings = { ...loaded.settings, provider: { ...loaded.settings.provider, custom } };
    await saveSettings(deps.settingsPath, merged);
    await deps.onMutation?.(merged);
    return { ok: true, providers: custom };
  });
}

const fetchModelsSchema = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ baseUrl: z.string().min(1), apiKey: z.string().optional(), kind: kindSchema.optional() }).strict(),
]);

/**
 * custom-provider-fetch-models: the guarded models-list GET (module doc's
 * threat model), for either an ALREADY-SAVED record (`{id}` — main resolves
 * `baseUrl`/`kind`/the decrypted key itself) or a NOT-YET-SAVED endpoint the
 * user is still previewing (`{baseUrl, apiKey, kind}` — the plaintext key
 * crosses IPC here, exactly once, for this transient preview call; it is
 * never persisted or logged by this handler).
 */
export async function handleCustomProviderFetchModels(deps: ProviderIpcDeps, raw: unknown): Promise<FetchModelsOutcome> {
  const parsed = fetchModelsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_request" };
  }
  const fetchModels = deps.fetchModels ?? fetchCustomProviderModels;
  if ("id" in parsed.data) {
    const { id } = parsed.data;
    // W4-R1-L1: resolve the saved record's (baseUrl, key, kind) atomically under
    // the SAME settings lock every custom-provider mutation holds, so a
    // concurrent cross-origin key rotation (custom-provider-update: setSecret →
    // saveSettings) can never interleave and hand this read the NEW key paired
    // with the OLD baseUrl — which would POST the freshly-rotated key to the
    // origin the user just migrated away from. The network fetch itself runs
    // OUTSIDE the lock (the settings lock is never held across a network call).
    const resolved = await withSettingsFileLock(deps.settingsPath, async () => {
      const loaded = await loadSettings(deps.settingsPath, deps.logger);
      const record = (loaded.settings.provider.custom ?? []).find((p) => p.id === id);
      if (record === undefined) {
        return undefined;
      }
      const apiKey = await deps.vault.getSecretValue(customProviderSecretKey(record.id));
      return { baseUrl: record.baseUrl, apiKey, kind: record.kind };
    });
    if (resolved === undefined) {
      return { ok: false, reason: "invalid_request" };
    }
    return fetchModels(resolved);
  }
  return fetchModels({ baseUrl: parsed.data.baseUrl, apiKey: parsed.data.apiKey, kind: parsed.data.kind });
}

// ── ipcMain wiring (called by main/index.ts — see the module doc's WIRING note) ──

export const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
export const CUSTOM_PROVIDER_UPDATE_CHANNEL = "anycode:custom-provider-update";
export const CUSTOM_PROVIDER_DELETE_CHANNEL = "anycode:custom-provider-delete";
export const CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL = "anycode:custom-provider-fetch-models";

export function registerProviderIpc(deps: ProviderIpcDeps): void {
  ipcMain.handle(CUSTOM_PROVIDER_CREATE_CHANNEL, (_event, raw: unknown) => handleCustomProviderCreate(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_UPDATE_CHANNEL, (_event, raw: unknown) => handleCustomProviderUpdate(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_DELETE_CHANNEL, (_event, raw: unknown) => handleCustomProviderDelete(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL, (_event, raw: unknown) =>
    handleCustomProviderFetchModels(deps, raw),
  );
}

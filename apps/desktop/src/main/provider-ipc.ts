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
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import { findCatalogEntry } from "@anycode/core/catalog";
import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, normalizeActiveConnection, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { isHttpsOrLocalhostUrl, isLoopbackUrl, settingsSchema } from "../settings/schema.js";
import type { AnycodeSettings, CustomProviderRecord, ProviderConnection, SecretKey } from "../shared/settings.js";
import { mergeModelIds, normalizeModelId } from "../shared/settings.js";
import type { SecretSetResult } from "./vault.js";
import { ProxyMisconfiguredError } from "./provider-proxy-fetch.js";

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
  | "models_not_supported"
  | "response_too_large"
  | "timeout"
  | "network_error"
  | "invalid_response"
  // TASK.113: Z.AI's anthropic-compatible /v1/models answers an auth failure
  // with HTTP 200 + {"success":false,"code":1001,...} (measured live 2026-08-15;
  // the sibling paas routes send an honest 401 for the same condition). `ok`
  // alone cannot gate that — the BODY must be inspected before trusting it.
  | "error_payload"
  // TASK.113: a well-formed {data:[]} is a real, distinct outcome — the endpoint
  // answered and lists zero models (no key on plan, no access). Returning it as
  // a silent "success with nothing" hides the problem; flagging it as a generic
  // error overstates it. It gets its own reason so the copy can say both.
  | "empty_models"
  // TASK.183: the settings file (or a newer-version file this binary refuses to
  // write) is read-only — a manual model addition cannot be persisted.
  | "read_only";

export type FetchModelsOutcome =
  | { ok: true; models: { id: string; reasoning?: boolean; effortLevels?: string[] }[] }
  | { ok: false; reason: FetchModelsFailureReason };

/** Minimal fetch surface this module needs (injectable; defaults to global fetch — mirrors oauth.ts's `FetchLike`). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export interface FetchModelsParams {
  baseUrl: string;
  apiKey?: string;
  /** Auth header shape (Anthropic's API wants `x-api-key`, not `Authorization: Bearer`). Defaults to "openai-compatible". */
  kind?: CustomProviderRecord["kind"];
  /** Complete models-list URL (catalog `modelsUrl`); replaces the derived `<base>/models` URL and switches auth to Bearer per that field's contract. */
  modelsUrl?: string;
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

/**
 * Base URL a CATALOG entry's models list lives under. Custom records declare
 * their baseUrl WITH the `/v1` segment (the S5-2 convention above), but
 * catalog anthropic-family baseUrls are complete prefixes WITHOUT it
 * (`https://api.kimi.com/coding` serves `/coding/v1/models`, verified live
 * 2026-07-17), while OpenAI-family catalog baseUrls already end in `/v1`.
 * Appending `/v1` only when absent lands both families on `<base>/v1/models`.
 */
export function catalogModelsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Runs the guarded models-list GET described in the module doc's threat model. */
export async function fetchCustomProviderModels(params: FetchModelsParams): Promise<FetchModelsOutcome> {
  const effectiveUrl = params.modelsUrl !== undefined
    ? `${params.modelsUrl.replace(/\/+$/, "")}`
    : `${params.baseUrl.replace(/\/+$/, "")}${MODELS_PATH}`;
  if (!isAllowedCustomProviderUrl(effectiveUrl)) {
    return { ok: false, reason: "invalid_url" };
  }
  const fetchImpl = params.fetchImpl ?? defaultFetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(effectiveUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...authHeaders(params.modelsUrl !== undefined ? "openai-compatible" : params.kind, params.apiKey),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    if (err instanceof ProxyMisconfiguredError) {
      // FIXED text only — no URL, no interpolated value (masking cannot be
      // trusted on malformed junk).
      console.warn("[provider-ipc] refusing to bypass a misconfigured proxy for a models fetch");
      return { ok: false, reason: "network_error" };
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
    // 404/405 (TASK.67): the route itself is missing/unsupported, not a
    // rejected request — live curl against Moonshot's Anthropic-compatible
    // proxy confirmed `GET /v1/models` 404s `url.not_found` while
    // `POST /v1/messages` 401s (base path is right, the models-list route
    // just isn't implemented there). Surfacing that as the generic
    // `http_error` reads to the user as "your connection is broken", when
    // the fix is "type the model id by hand". 401/403 stay `http_error` on
    // purpose — those mean the KEY was rejected on a route that exists, a
    // different problem with a different fix.
    if (response.status === 404 || response.status === 405) {
      return { ok: false, reason: "models_not_supported" };
    }
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
  // TASK.113: check the body for an error BEFORE trusting its shape as a models
  // list — a 200 with {"success":false,"code":...} is a refused request wearing
  // a success status, and must not degrade into `invalid_response`'s "wasn't a
  // recognizable models list" (let alone a silent empty success).
  if (looksLikeErrorPayload(parsed)) {
    return { ok: false, reason: "error_payload" };
  }
  const models = extractModelIds(parsed);
  if (models === undefined) {
    return { ok: false, reason: "invalid_response" };
  }
  if (models.length === 0) {
    return { ok: false, reason: "empty_models" };
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

/**
 * Taskana 4118: per-item meta fields we keep from a models-list entry. A plain
 * `z.object` (NOT `.strict()` — bodies carry many legitimate siblings we do
 * not model) that picks only the two known fields; unknown keys are ignored.
 */
// Each field validates on its own (`.catch(undefined)`), so garbage in one
// signal (e.g. `reasoning: null`, `supported_efforts: null`) never discards the
// other — a `supported_parameters: ["reasoning"]` declaration survives a
// malformed `reasoning` block.
const liveCapsSchema = z.object({
  supported_parameters: z.array(z.string()).optional().catch(undefined),
  reasoning: z
    .object({
      supported_efforts: z.array(z.string().max(64)).max(16).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/**
 * Taskana 4118 cross-review F2: `modelCapabilities` is persisted as a
 * `z.record(z.string().max(256), …)` key (settings/schema.ts) whose
 * `.catch(undefined)` is WHOLE-map — one longer, endpoint-controlled id with
 * reasoning meta would make every later `loadSettings` drop the connection's
 * ENTIRE capability map (all legal models included). Capability meta is only
 * ever kept for ids the schema can round-trip; the id itself survives in
 * `models` (display-only, same discipline as garbage meta).
 */
const MODEL_CAPABILITY_ID_MAX = 256;

/**
 * `{data:[{id}...]}` -> `{id, reasoning?, effortLevels?}[]`; undefined for any
 * other shape (fail-closed, never throws). Taskana 4118: per-item meta is kept
 * ONLY when the endpoint declares reasoning — `supported_parameters` contains
 * `"reasoning"` OR `reasoning.supported_efforts` is a non-empty array (either
 * signal suffices; OpenRouter sends both) — and then `effortLevels` carries the
 * RAW foreign strings exactly as spelled (mapping into the closed enum is
 * core's job, at resolution). Garbage meta on an item (wrong types, over-long
 * entries) drops ONLY that item's meta via safeParse failure; the id survives.
 * An OpenAI-style `{id, object, created, owned_by}` body parses to plain ids.
 */
function extractModelIds(value: unknown): { id: string; reasoning?: boolean; effortLevels?: string[] }[] | undefined {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return undefined;
  }
  const data = (value as { data: unknown }).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const models: { id: string; reasoning?: boolean; effortLevels?: string[] }[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const maybe = item as { id?: unknown };
    if (typeof maybe.id !== "string") {
      continue;
    }
    // D-Trust: read only the two known fields; a safeParse failure (garbage
    // meta) degrades this item to its bare id — never to a fetch failure.
    const meta = liveCapsSchema.safeParse(item);
    if (!meta.success) {
      models.push({ id: maybe.id });
      continue;
    }
    const declared = meta.data.reasoning?.supported_efforts;
    const reasoning = meta.data.supported_parameters?.includes("reasoning") === true
      || (Array.isArray(declared) && declared.length > 0);
    // Cross-review F2: ids the settings schema cannot accept as capability
    // keys degrade to the bare id — keeping their meta would poison the whole
    // stored map on the next read (`.catch` is whole-map, not per-key).
    if (!reasoning || maybe.id.length > MODEL_CAPABILITY_ID_MAX) {
      models.push({ id: maybe.id });
      continue;
    }
    models.push({
      id: maybe.id,
      reasoning: true,
      ...(declared !== undefined && declared.length > 0 ? { effortLevels: [...declared] } : {}),
    });
  }
  return models;
}

/**
 * TASK.113: does this parsed 200-body carry an error instead of a models list?
 * Fail-closed, never throws. Two signals, either suffices:
 *  - `success === false` (strict boolean — Z.AI's anthropic-compat /v1/models
 *    auth failure: 200 + {"code":1001,"msg":"...","success":false});
 *  - an own `code` property (number|string) with NO `data` array alongside —
 *    the common error-envelope shape that carries no models at all.
 * A body WITH a valid `data` array is never an error, even if it also carries a
 * `code` field (some providers stamp a benign code on success envelopes) — the
 * models win.
 */
export function looksLikeErrorPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const hasDataArray = "data" in value && Array.isArray((value as { data: unknown }).data);
  if (hasDataArray) {
    return false;
  }
  if ((value as { success?: unknown }).success === false) {
    return true;
  }
  const code = (value as { code?: unknown }).code;
  return code !== undefined && (typeof code === "number" || typeof code === "string");
}

// ── custom-provider CRUD ──

/** The vault surface this module depends on (structural — `main/vault.ts`'s `Vault` satisfies it). */
export interface ProviderVaultLike {
  setSecret(key: SecretKey, value: string, opts: { allowWeak: boolean }): Promise<SecretSetResult>;
  clearSecret(key: SecretKey): Promise<void>;
  getSecretValue(key: SecretKey): Promise<string | undefined>;
}

/**
 * Structural view of the ONE catalog fact the connection-scoped fetch needs
 * (mirrors settings-ipc.ts's `CatalogEntryShape` discipline — no core
 * value-import in this lane file; main/index.ts wires it from
 * `@anycode/core/catalog`'s `findCatalogEntry`).
 */
export interface CatalogFetchEntryShape {
  id: string;
  baseUrl: string;
  defaultTransport?: string;
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
  /** TASK.133: per-connection fetch (proxy routing); supplied by main/index.ts. */
  connectionFetch?: (connectionId: string) => FetchLike;
  /**
   * Catalog lookup for the connection-scoped fetch (`{connectionId}` request
   * shape). Absent = that shape is refused `invalid_request` (fail-closed) —
   * custom-record CRUD/fetch never needs it.
   */
  catalogEntryById?: (id: string) => CatalogFetchEntryShape | undefined;
  /**
   * Fired after every successful mutation with the fresh settings object —
   * main re-derives catalogIds/catalog projection/readiness off it, mirroring
   * settings-ipc.ts's `onMutation`. Optional so unit tests can omit it.
   */
  onMutation?: (settings: AnycodeSettings) => void | Promise<void>;
  /**
   * Fired after a successful custom-record key write, BEFORE onMutation
   * (TASK.202) — same contract as settings-ipc.ts's `onSecretWritten` (see
   * that dep's doc there).
   */
  onSecretWritten?: (key: SecretKey, settings: AnycodeSettings) => void;
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
// than silently ignored. TASK.58: `apiKey` is OPTIONAL — a keyless local
// endpoint (LM Studio/ollama) is declared via `authOptional: true` instead.
const createSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().min(1),
    kind: kindSchema,
    apiKey: z.string().optional(),
    authOptional: z.boolean().optional(),
    models: z.array(z.string()).optional(),
  })
  .strict();

/**
 * custom-provider-create: mint a new `CustomProviderRecord` + (for a keyed
 * endpoint) store its key. The key is written to the vault BEFORE settings.json
 * (opposite of connection-delete's secrets-LAST ordering — a keyed record is
 * worthless without a stored key, so a `weak_storage_needs_consent` refusal
 * must leave ZERO trace, not a keyless record the user has to notice and
 * re-key).
 *
 * KEYLESS (TASK.58): a record is EITHER keyed (a non-empty `apiKey`) OR
 * explicitly keyless (`authOptional: true` with no key) — an endpoint that is
 * neither is refused `invalid`. A non-empty key is AUTHORITATIVE: if one is
 * present the record is keyed regardless of the flag (the client disables the
 * key field when the box is checked, so the two only ever collide via a
 * malformed direct call). The vault write is skipped entirely for a keyless
 * record.
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
  const hasKey = req.apiKey !== undefined && req.apiKey !== "";
  const keyless = !hasKey && req.authOptional === true;
  if (!hasKey && !keyless) {
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
      ...(keyless ? { authOptional: true } : {}),
    };
    const custom = [...(loaded.settings.provider.custom ?? []), record];
    const merged: AnycodeSettings = { ...loaded.settings, provider: { ...loaded.settings.provider, custom } };
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false, reason: "invalid" };
    }
    if (hasKey) {
      const secretResult = await deps.vault.setSecret(customProviderSecretKey(id), req.apiKey as string, {
        allowWeak: loaded.settings.security.allowWeakSecretStorage,
      });
      if (!secretResult.ok) {
        return { ok: false, reason: secretResult.reason };
      }
      // TASK.202: keyed create — a vault write landed; fired BEFORE onMutation
      // (settings-ipc.ts's `onSecretWritten` ordering discipline).
      deps.onSecretWritten?.(customProviderSecretKey(id), merged);
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
    // TASK.58: `true` declares the record keyless, `false` clears the flag —
    // same only-truthy-on-disk discipline as ConnectionUpdateRequest.
    authOptional: z.boolean().optional(),
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
    const hasFreshKey = req.apiKey !== undefined && req.apiKey !== "";
    const existingKeyless = existing.authOptional === true;
    // Resulting keyless state: a fresh key always makes the record keyed
    // (authoritative, mirrors create); otherwise an explicit `authOptional`
    // flag wins; otherwise the record keeps its current state (a metadata- or
    // models-only update never silently flips keylessness).
    const willBeKeyless = hasFreshKey ? false : req.authOptional !== undefined ? req.authOptional : existingKeyless;
    // Origin-rebind custody guard (see the handler doc). Both URLs are
    // already policy-validated (request: the isAllowedCustomProviderUrl gate
    // above; existing: settings/schema.ts on load), so `new URL` cannot throw.
    // TASK.58: a KEYLESS record that STAYS keyless has no stored key to decrypt
    // and re-POST to a new origin, so it may rebind without a fresh key — the
    // same "nothing can leak" rationale as the loopback→loopback waiver. Only a
    // keyed record (or one becoming keyed) still needs the fresh key.
    if (req.baseUrl !== undefined && !hasFreshKey) {
      const originChanged = new URL(req.baseUrl).origin !== new URL(existing.baseUrl).origin;
      const bothLoopback = isLoopbackUrl(existing.baseUrl) && isLoopbackUrl(req.baseUrl);
      if (originChanged && !bothLoopback && !(existingKeyless && willBeKeyless)) {
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
    // Reflect the resulting keyless state — `true` persists, `false` clears the
    // flag entirely (only-truthy-on-disk).
    if (willBeKeyless) {
      updatedRecord.authOptional = true;
    } else {
      delete updatedRecord.authOptional;
    }
    const custom = (loaded.settings.provider.custom ?? []).map((p) => (p.id === req.id ? updatedRecord : p));
    const merged: AnycodeSettings = { ...loaded.settings, provider: { ...loaded.settings.provider, custom } };
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false, reason: "invalid" };
    }
    if (hasFreshKey) {
      const secretResult = await deps.vault.setSecret(customProviderSecretKey(req.id), req.apiKey as string, {
        allowWeak: loaded.settings.security.allowWeakSecretStorage,
      });
      if (!secretResult.ok) {
        return { ok: false, reason: secretResult.reason };
      }
      // TASK.202: a key rotation through update — fired BEFORE onMutation (the
      // keyed→keyless `clearSecret` branch below needs nothing: that update
      // also rewrites `merged`, and the record's baseUrl is in the fingerprint).
      deps.onSecretWritten?.(customProviderSecretKey(req.id), merged);
    } else if (willBeKeyless && !existingKeyless) {
      // Keyed → keyless transition: drop the now-orphaned vault key so a
      // "keyless" record can never still boot a fork with a stale stored key
      // (buildHostEnv reads the custom key whenever one is present).
      await deps.vault.clearSecret(customProviderSecretKey(req.id));
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
  // TASK.183: manual addition of connection-scoped model ids. Listed BEFORE the
  // plain `{connectionId}` member so a request carrying `addModels` is
  // dispatched to `handleConnectionAddModels`, never to the network fetch.
  z.object({ connectionId: z.string().min(1), addModels: z.array(z.string()).min(1) }).strict(),
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ connectionId: z.string().min(1) }).strict(),
  z.object({ baseUrl: z.string().min(1), apiKey: z.string().optional(), kind: kindSchema.optional() }).strict(),
]);

/**
 * Connection-scoped MANUAL model addition (TASK.183, the `{connectionId,
 * addModels}` request shape): appends user-entered model ids to the target
 * connection's own `models[]`, so a manually typed id becomes a durable list
 * entry rather than a single `connection.model` value that the next picker
 * rebuild loses.
 *
 * Unlike the network fetch this needs no catalog entry, base URL or vault key
 * — a manual id is valid for EVERY existing connection kind (catalog,
 * openrouter, vllm, literal custom, `custom:<slug>`). There is deliberately NO
 * catalog-membership check: membership is never validation.
 *
 * Every requested id is normalized through the shared `normalizeModelId`
 * BEFORE any write; one invalid id rejects the whole request (all-or-nothing).
 * The write is a single locked load→modify→save critical section that preserves
 * every sibling field (model, activeConnectionId, modelsFetchedAt, sibling
 * connections, provider.custom records). When the resulting list is identical
 * to what was already stored, the call succeeds WITHOUT saving or firing
 * `onMutation`.
 */
async function handleConnectionAddModels(
  deps: ProviderIpcDeps,
  connectionId: string,
  requestedIds: readonly string[],
): Promise<FetchModelsOutcome> {
  const normalizedIds: string[] = [];
  for (const raw of requestedIds) {
    const id = normalizeModelId(raw);
    if (id === null) {
      return { ok: false, reason: "invalid_request" };
    }
    normalizedIds.push(id);
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const target = loaded.settings.provider.connections.find((c) => c.id === connectionId);
    if (target === undefined) {
      return { ok: false, reason: "invalid_request" };
    }
    const storedModels = target.models ?? [];
    const mergedModels = mergeModelIds(storedModels, normalizedIds);
    if (mergedModels.length === storedModels.length && mergedModels.every((id, i) => id === storedModels[i])) {
      // Identical list: succeed without a write or a mutation callback.
      return { ok: true, models: mergedModels.map((id) => ({ id })) };
    }
    const updatedConnection: ProviderConnection = { ...target, models: mergedModels };
    const updatedSettings: AnycodeSettings = {
      ...loaded.settings,
      provider: {
        ...loaded.settings.provider,
        connections: loaded.settings.provider.connections.map((c) => (c.id === connectionId ? updatedConnection : c)),
      },
    };
    if (!settingsSchema.safeParse(updatedSettings).success) {
      return { ok: false, reason: "invalid_request" };
    }
    await saveSettings(deps.settingsPath, updatedSettings);
    await deps.onMutation?.(updatedSettings);
    return { ok: true, models: mergedModels.map((id) => ({ id })) };
  });
}

/** The vault key one catalog connection's API-key credential lives under (mirrors the renderer's `connectionSecretKey`). */
export function connectionApiKeySecretKey(connectionId: string): SecretKey {
  return `provider.connection.${connectionId}.apiKey`;
}

/**
 * Connection-scoped models fetch (`{connectionId}`): the SAME guarded GET,
 * for a CATALOG connection — main resolves everything itself (the renderer
 * holds neither the entry's baseUrl nor the key). Resolution runs under the
 * settings lock (same W4-R1-L1 rationale as the `{id}` branch: a concurrent
 * baseUrl/key mutation must never hand this read a mixed pair); the network
 * call runs outside it. CUSTODY: the decrypted connection key travels only to
 * the origin the connection itself already sends every session turn to
 * (`connection.baseUrl ?? entry.baseUrl`) — no new exfil surface. On success
 * the fetched ids are persisted onto the connection (`models` +
 * `modelsFetchedAt`, advisory display data) so pickers survive a restart
 * without refetching; an empty list is returned but never persisted (the
 * pickers' static-hints fallback stays intact).
 */
async function handleConnectionFetchModels(
  deps: ProviderIpcDeps,
  connectionId: string,
  fetchModels: (params: FetchModelsParams) => Promise<FetchModelsOutcome>,
): Promise<FetchModelsOutcome> {
  const entryById = deps.catalogEntryById;
  if (entryById === undefined) {
    return { ok: false, reason: "invalid_request" };
  }
  const resolved = await withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    const connection = loaded.settings.provider.connections.find((c) => c.id === connectionId);
    if (connection === undefined) {
      return undefined;
    }
    // Only catalog templates resolve here: a `custom:<slug>` providerId has no
    // catalog entry (its fetch is the `{id}` branch), and the literal `custom`
    // sentinel is refused too — its credential is the bare legacy key, not
    // this connection-scoped one, so resolving it here would pair the wrong
    // key with a user-typed origin.
    const entry = entryById(connection.providerId);
    if (entry === undefined || entry.id === "custom") {
      return undefined;
    }
    const baseUrl = connection.baseUrl?.trim() ? connection.baseUrl.trim() : entry.baseUrl;
    const transport = connection.transport ?? entry.defaultTransport;
    const apiKey = await deps.vault.getSecretValue(connectionApiKeySecretKey(connectionId));
    // A user-overridden baseUrl (gateway/proxy) opts out of the catalog's
    // models URL: the list must come from the origin the user pointed at.
    const modelsUrl = connection.baseUrl?.trim() ? undefined : findCatalogEntry(connection.providerId)?.modelsUrl;
    return {
      baseUrl,
      apiKey,
      kind: (transport === "anthropic-messages" ? "anthropic" : "openai-compatible") as CustomProviderRecord["kind"],
      ...(modelsUrl !== undefined ? { modelsUrl } : {}),
    };
  });
  if (resolved === undefined) {
    return { ok: false, reason: "invalid_request" };
  }
  if (resolved.baseUrl === "") {
    return { ok: false, reason: "invalid_url" };
  }
  const outcome = await fetchModels({
    baseUrl: catalogModelsBaseUrl(resolved.baseUrl),
    apiKey: resolved.apiKey,
    kind: resolved.kind,
    ...(resolved.modelsUrl !== undefined ? { modelsUrl: resolved.modelsUrl } : {}),
    ...(deps.connectionFetch !== undefined ? { fetchImpl: deps.connectionFetch(connectionId) } : {}),
  });
  if (!outcome.ok || outcome.models.length === 0) {
    return outcome;
  }
  await withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return;
    }
    const target = loaded.settings.provider.connections.find((c) => c.id === connectionId);
    if (target === undefined) {
      // Deleted mid-fetch: the transient result still reaches the caller, but
      // nothing is resurrected on disk.
      return;
    }
    const fetchedIds = outcome.models.map((m) => m.id);
    // Taskana 4118: live per-model capabilities the endpoint declared, keyed by
    // model id. Fail-closed like `models` above: an outcome with zero capable
    // models leaves the stored map untouched (never deleted on empty).
    const caps: Record<string, { reasoning?: boolean; effortLevels?: string[] }> = {};
    for (const m of outcome.models) {
      // Cross-review F2 (defense-in-depth): `fetchModels` is injectable, so
      // this seam can see meta the extractor never produced — the same
      // schema-legal key bound applies here too.
      if (m.id.length > MODEL_CAPABILITY_ID_MAX) {
        continue;
      }
      if (m.reasoning === true || m.effortLevels !== undefined) {
        caps[m.id] = {
          ...(m.reasoning === true ? { reasoning: true } : {}),
          ...(m.effortLevels !== undefined ? { effortLevels: m.effortLevels } : {}),
        };
      }
    }
    const mergedCaps = Object.keys(caps).length > 0
      ? { ...(target.modelCapabilities ?? {}), ...caps }
      : target.modelCapabilities;
    const updated: ProviderConnection = {
      ...target,
      // TASK.183: fetched ids first, then the connection's previously stored
      // ids (manual additions and earlier fetches), deduped case-sensitively —
      // so the merge can never replace a manual addition.
      models: mergeModelIds(fetchedIds, target.models ?? []),
      modelsFetchedAt: (deps.now ?? defaultNowIso)(),
      ...(mergedCaps !== undefined ? { modelCapabilities: mergedCaps } : {}),
    };
    const merged: AnycodeSettings = {
      ...loaded.settings,
      provider: {
        ...loaded.settings.provider,
        connections: loaded.settings.provider.connections.map((c) => (c.id === connectionId ? updated : c)),
      },
    };
    if (!settingsSchema.safeParse(merged).success) {
      return;
    }
    await saveSettings(deps.settingsPath, merged);
    await deps.onMutation?.(merged);
  });
  return outcome;
}

/**
 * custom-provider-fetch-models: the guarded models-list GET (module doc's
 * threat model), for an ALREADY-SAVED custom record (`{id}` — main resolves
 * `baseUrl`/`kind`/the decrypted key itself), a CATALOG connection
 * (`{connectionId}` — same resolution off the connection + its catalog entry,
 * see `handleConnectionFetchModels`), or a NOT-YET-SAVED endpoint the
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
  if ("addModels" in parsed.data) {
    return handleConnectionAddModels(deps, parsed.data.connectionId, parsed.data.addModels);
  }
  if ("connectionId" in parsed.data) {
    return handleConnectionFetchModels(deps, parsed.data.connectionId, fetchModels);
  }
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

// ── external settings-file watcher (TASK.183) ──

/** Debounce window (ms) coalescing a burst of directory events into one read. */
export const SETTINGS_WATCH_DEBOUNCE_MS = 150;

/**
 * Does a directory event's `filename` concern our settings file? A `null`
 * filename (some platforms omit it on a rescan) is treated CONSERVATIVELY as a
 * match — the caller then re-reads and skips identical bytes, so a spurious
 * rescan costs one read and never a false mutation. A Buffer filename is
 * decoded rather than compared by reference.
 */
export function settingsWatchEventMatchesTarget(filename: string | Buffer | null, targetName: string): boolean {
  if (filename === null) {
    return true;
  }
  const name = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
  return name === targetName;
}

/**
 * Watches the settings DIRECTORY (never the file's own inode — `atomicWrite`
 * replaces the target by `rename`, so a file watch would be attached to a
 * stale inode) for EXTERNAL edits — a hand-edit of `settings.json` while the
 * host is running — and reports each schema-valid change through
 * `onExternalChange`. This is TASK.183 work item 4's minimum permitted route:
 * an in-boundary notification, NOT a new public CLI API, and no preload/main
 * index change.
 *
 * Discipline:
 *  - the directory watch is installed BEFORE the synchronous baseline read so
 *    an edit racing startup still leaves a queued event;
 *  - the baseline text is remembered WITHOUT dispatching (the unchanged
 *    startup file is not a change); a missing initial file is permitted;
 *  - events are debounced ~150 ms and the ENTIRE read/parse/dispatch operation
 *    is serialized on one promise chain, so a slow read can never reorder
 *    changes;
 *  - only `JSON.parse` + `settingsSchema.safeParse`-valid content is dispatched
 *    (`normalizeActiveConnection` repairs the active<->non-empty invariant the
 *    normal loader repairs); invalid JSON/schema is logged and ignored, never
 *    defaulted or written back;
 *  - a temporary ENOENT (delete/recreate) is skipped — recreation fires its own
 *    directory event;
 *  - identical bytes are skipped, which bounds the redundant refresh an own
 *    save causes without ever forming a mutation loop (`onMutation` reloads
 *    settings, it does not write);
 *  - read/watch/callback failures go to `logger.warn` and leave later changes
 *    operable; credentials/content are never logged.
 *
 * Returns a `close()` that flags closed, clears any pending timer, closes the
 * watch, and prevents queued-but-not-started callbacks. Unrefs the watcher and
 * debounce timer.
 */
export function startSettingsFileWatcher(
  settingsPath: string,
  logger: FileIoLogger | undefined,
  onExternalChange: (settings: AnycodeSettings) => void | Promise<void>,
): () => void {
  const directory = dirname(settingsPath);
  const targetName = basename(settingsPath);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let queue: Promise<void> = Promise.resolve();
  let lastText: string | null = null;

  async function run(): Promise<void> {
    if (closed) {
      return;
    }
    let text: string;
    try {
      text = await readFile(settingsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        logger?.warn(`settings watcher: read failed for ${settingsPath}`, err);
      }
      return;
    }
    if (text === lastText) {
      return;
    }
    lastText = text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      logger?.warn(`settings watcher: corrupt JSON at ${settingsPath}; ignoring`, err);
      return;
    }
    const parsed = settingsSchema.safeParse(json);
    if (!parsed.success) {
      logger?.warn(`settings watcher: schema-invalid at ${settingsPath}; ignoring`);
      return;
    }
    try {
      await onExternalChange(normalizeActiveConnection(parsed.data));
    } catch (err) {
      logger?.warn(`settings watcher: change handler failed for ${settingsPath}`, err);
    }
  }

  function schedule(): void {
    if (closed) {
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      queue = queue.then(run, run);
    }, SETTINGS_WATCH_DEBOUNCE_MS);
    timer.unref?.();
  }

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
      if (closed) {
        return;
      }
      if (!settingsWatchEventMatchesTarget(filename, targetName)) {
        return;
      }
      schedule();
    });
    watcher.unref?.();
  } catch (err) {
    logger?.warn(`settings watcher: cannot watch ${directory}`, err);
    return () => {};
  }

  try {
    lastText = readFileSync(settingsPath, "utf8");
  } catch {
    lastText = null;
  }
  // The OS watch stream can take a moment to arm (FSEvents on macOS drops an
  // edit landing in that window), so one deferred rescan after startup re-reads
  // the file and dispatches only if it differs from the baseline just taken.
  schedule();

  return () => {
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      watcher?.close();
    } catch {
      // already closed
    }
  };
}

// ── ipcMain wiring (called by main/index.ts — see the module doc's WIRING note) ──

export const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
export const CUSTOM_PROVIDER_UPDATE_CHANNEL = "anycode:custom-provider-update";
export const CUSTOM_PROVIDER_DELETE_CHANNEL = "anycode:custom-provider-delete";
export const CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL = "anycode:custom-provider-fetch-models";

/** Handle returned by `registerProviderIpc` so a caller can tear the file watcher down. */
export interface ProviderIpcHandle {
  dispose(): void;
}

export function registerProviderIpc(deps: ProviderIpcDeps): ProviderIpcHandle {
  ipcMain.handle(CUSTOM_PROVIDER_CREATE_CHANNEL, (_event, raw: unknown) => handleCustomProviderCreate(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_UPDATE_CHANNEL, (_event, raw: unknown) => handleCustomProviderUpdate(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_DELETE_CHANNEL, (_event, raw: unknown) => handleCustomProviderDelete(deps, raw));
  ipcMain.handle(CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL, (_event, raw: unknown) =>
    handleCustomProviderFetchModels(deps, raw),
  );
  // TASK.183: notify the running host of schema-valid EXTERNAL settings edits
  // through the existing `onMutation` hook. Only wired when a hook exists —
  // without one there is nothing to notify. A failed startup degrades to a
  // no-op close (see `startSettingsFileWatcher`) rather than crashing IPC.
  const closeWatcher =
    deps.onMutation === undefined
      ? (): void => {}
      : startSettingsFileWatcher(deps.settingsPath, deps.logger, deps.onMutation);
  return { dispose: closeWatcher };
}

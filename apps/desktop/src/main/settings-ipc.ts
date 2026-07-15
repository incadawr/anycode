/**
 * Settings + secret-vault control-plane IPC (design slice-2.2-cut.md §3, ruling
 * §4). Registers `ipcMain.handle` for the five frozen channels from
 * shared/settings.ts and answers every one with a SettingsSnapshot — a mutating
 * channel returns `{ok:true, snapshot}` or a typed refusal reason. Main is the

 * zod-validated here before it reaches the vault or the settings file, exactly
 * like main/tab-ipc.ts.
 *

 * A value only ever travels IN via `secret-set`; every response's `secrets` are
 * `SecretStatus` (set/source/tier). The handler logic is split into exported
 * pure async functions (handle*) that take a deps bag so they are unit-testable
 * off a fake vault + scratch paths without an Electron ipcMain.
 *
 * zod is a direct dep (not routed through the @anycode/core barrel, which would
 * bundle core's ai-SDK runtime into the thin main process — same rule as
 * tab-ipc.ts).
 */

import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { z } from "zod";
import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, saveSettings } from "../settings/files.js";
import { keybindingsSchema, mergeSettings, settingsSchema } from "../settings/schema.js";
import {
  CONNECTION_CHECK_CHANNEL,
  CONNECTION_CREATE_CHANNEL,
  CONNECTION_DELETE_CHANNEL,
  CONNECTION_SET_ACTIVE_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  OAUTH_CANCEL_CHANNEL,
  OAUTH_START_CHANNEL,
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
  activeConnection,
  activeProviderView,
} from "../shared/settings.js";
import type {
  AnycodeSettings,
  CatalogAuthKind,
  CatalogSummary,
  CatalogSummaryEntry,
  LegacyProviderPatch,
  OAuthCancelRequest,
  OAuthStartRequest,
  OAuthStartResult,
  PermissionRuleAddRequest,
  ProviderConnection,
  ProviderHealthStatus,
  ProviderSettingsV2,
  ProviderTransportId,
  SecretKey,
  SecretStatus,
  SettingsMutationResult,
  SettingsPatch,
  SettingsSnapshot,
} from "../shared/settings.js";
import {
  computeProviderReady,
  connectionSecretKey,
  envOverrides,
  isKnownSecretKey,
  resolveEffectiveTransport,
} from "./host-env.js";
import type { OAuthOutcome, OAuthProviderConfig } from "./oauth.js";
import type { SecretSetResult, Vault } from "./vault.js";

/** The vault surface settings-ipc depends on (structural, so tests inject a fake). */
export interface VaultLike {
  setSecret(key: SecretKey, value: string, opts: { allowWeak: boolean }): Promise<SecretSetResult>;
  clearSecret(key: SecretKey): Promise<void>;
  getSecretValue(key: SecretKey): Promise<string | undefined>;
  statuses(bootEnv: NodeJS.ProcessEnv, catalogIds?: readonly string[]): Promise<SettingsSnapshot["secrets"]>;
}

/** OAuth engine surface settings-ipc drives (structural; the real OAuthEngine satisfies it). */
export interface OAuthRunnerLike {
  startFlow(config: OAuthProviderConfig, connectionId: string, opts: { allowWeak: boolean }): Promise<OAuthOutcome>;
  cancel(providerId: string): void;
  /**
   * Tombstones `connectionId` for the compensating clear (TASK.45 W11-FIX2
   * #2) — REQUIRED (not optional): an optional custody hook is a hook that
   * gets forgotten to wire up. Returns a revert closure the caller MUST
   * invoke on every exit where the connection's metadata is NOT actually
   * removed (see `handleConnectionDelete`).
   */
  markConnectionDeleting(connectionId: string): () => void;
}

export interface SettingsIpcDeps {
  vault: VaultLike;
  /* */
  bootEnv: NodeJS.ProcessEnv;
  settingsPath: string;
  logger?: FileIoLogger;
  /**
   * Fired after every SUCCESSFUL mutation (settings-set / secret-set /
   * secret-clear / rule-add / oauth-start) with the fresh snapshot — index.ts
   * re-evaluates readiness + rebuilds the host env + fires the deferred auto-tab

   */
  onMutation?: (snapshot: SettingsSnapshot) => void | Promise<void>;
  // ── slice 2.5 (catalog + oauth); all optional so legacy tests stay green ──
  /** Catalog provider ids: allow-list for the widened `SecretKey` / `provider.id` refine. */
  catalogIds?: readonly string[];
  /** Value-only catalog projection surfaced in the snapshot (main projects it from core). */
  catalog?: CatalogSummary;
  /** Auth kind of a catalog id (main supplies it from core); undefined = unknown id. */
  authKindFor?: (providerId: string) => CatalogAuthKind | undefined;
  /* */
  isCustom?: (providerId: string) => boolean;
  /** OAuth flow engine; absent -> oauth-start refuses `unsupported`. */
  oauth?: OAuthRunnerLike;
  /** Per-provider oauth config; undefined -> the provider is not oauth (`unsupported`). */
  oauthConfigFor?: (providerId: string) => OAuthProviderConfig | undefined;
  /** Mints an opaque connection id (`conn-<uuid>`). Injected for determinism in tests. */
  genConnectionId?: () => string;
  /**
   * True when a connection is pinned to a LIVE session (TASK.45 W10 delete-guard).
   * Main injects `(id) => manager.pinnedConnectionIds().has(id)`. Absent = no live
   * sessions to protect (unit fixtures) so delete behaves as before.
   */
  connectionInUse?: (connectionId: string) => boolean;
  /**
   * TASK.45 W11: an optional free provider-specific probe for `connection-check`.
   * `handleConnectionCheck` calls this AT MOST once per invocation and NEVER
   * falls back to a billable generation request. Absent = the W9 scaffold
   * behaviour — `connection-check` validates the id and returns the current
   * snapshot untouched (byte-compatible; no network call, no health write).
   */
  probeConnection?: (connection: ProviderConnection, credential: string) => Promise<ConnectionProbeOutcome>;
  /** Injectable ISO-timestamp clock for `lastHealth.at` (tests only; defaults to `new Date().toISOString()`). */
  now?: () => string;
}

/** Outcome of an explicit `connection-check` probe (TASK.45 W11). */
export type ConnectionProbeOutcome = { ok: true } | { ok: false; code: string };

/** A fresh opaque connection id for a connection minted by main (`conn-<uuid>`). */
function defaultConnectionId(): string {
  return `conn-${randomUUID()}`;
}

/**
 * Per-settings-file mutation lock (§2.2). Every mutating handler's
 * load→modify→save→snapshot critical section runs through this promise-chain so
 * two interleaved `ipcMain.handle` handlers can never both load the same base and
 * clobber each other on save (main is the sole writer). Keyed on `settingsPath`
 * so unit tests with distinct scratch paths never serialize against each other.
 * The interactive OAuth flow stays OUTSIDE the lock — only its metadata section
 * is serialized (a minutes-long browser login must not freeze all settings IPC).
 */
const settingsLocks = new Map<string, Promise<unknown>>();
function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = settingsLocks.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  settingsLocks.set(
    path,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Whether two providerIds share the credential bucket. `custom` ≡ bare-legacy
 * (`providerId ∈ {"", "custom"}`) — the R6 equivalence: the catalog `custom`
 * entry and a no-catalog-pick connection both use the bare legacy key — so their
 * connections collapse to one bucket; every other id matches exactly.
 */
function inSameProviderBucket(a: string, b: string): boolean {
  const isBare = (p: string): boolean => p === "" || p === "custom";
  return isBare(a) ? isBare(b) : a === b;
}

/**
 * The bucket's target connection (§1.3): the ACTIVE connection when it belongs to
 * the requested provider bucket, else the first matching connection. A legacy
 * write must land on the connection the runtime actually reads (readiness/env
 * resolve strictly by `activeConnectionId`), so with multiple connections of the
 * same provider the active one — not array order — wins.
 */
function bucketConnection(provider: ProviderSettingsV2, providerId: string): ProviderConnection | undefined {
  const active =
    provider.activeConnectionId === undefined
      ? undefined
      : provider.connections.find((c) => c.id === provider.activeConnectionId);
  if (active !== undefined && inSameProviderBucket(active.providerId, providerId)) {
    return active;
  }
  return provider.connections.find((c) => inSameProviderBucket(c.providerId, providerId));
}

/**
 * Finds the connection that holds a provider's credential, or creates one.
 * Shared by the v1-patch metadata shim, the pre-W12 secret-write translation
 * (§4.1) and oauth-start (§4.3). `activate: "always"` makes the target the
 * default for new sessions (an explicit provider pick); `"if-none"` only
 * activates a freshly-created connection when nothing is active yet. Returns the
 * (possibly-updated) provider block, the target connection id, and whether a new
 * connection was minted (so the caller can persist metadata-first).
 */
function findOrCreateConnectionByProvider(
  provider: ProviderSettingsV2,
  providerId: string,
  genId: () => string,
  activate: "always" | "if-none",
): { provider: ProviderSettingsV2; connectionId: string; created: boolean } {
  const existing = bucketConnection(provider, providerId);
  if (existing !== undefined) {
    if (activate === "always" && provider.activeConnectionId !== existing.id) {
      return { provider: { ...provider, activeConnectionId: existing.id }, connectionId: existing.id, created: false };
    }
    return { provider, connectionId: existing.id, created: false };
  }
  const id = genId();
  const connection: ProviderConnection = { id, providerId };
  const shouldActivate = activate === "always" || provider.activeConnectionId === undefined;
  return {
    provider: {
      ...provider,
      connections: [...provider.connections, connection],
      ...(shouldActivate ? { activeConnectionId: id } : {}),
    },
    connectionId: id,
    created: true,
  };
}

/** The legacy vault-key alias the pre-W12 renderer reads/writes a credential under (mirror of SettingsScreen `providerSecretKey`). */
function legacyAliasKey(providerId: string, authKind: "api_key" | "oauth"): SecretKey {
  if (providerId === "" || providerId === "custom") {
    return "provider.apiKey";
  }
  return authKind === "oauth" ? `provider.${providerId}.oauth` : `provider.${providerId}.apiKey`;
}

/**
 * Translates a secret-set/clear key into the vault key it should ACTUALLY touch
 * (pre-W12 write seam, §4.1). A key already in connection form
 * (`provider.connection.<id>.*`) passes through unchanged. A legacy-shaped key
 * (bare `provider.apiKey`, or `provider.<pid>.{apiKey,oauth}`) is routed to the
 * connection of that provider bucket — found, or (for a write) created + possibly
 * activated. The legacy form is NEVER written to the vault again; the connection
 * key is the only source of truth. Returns the possibly-updated settings + the
 * resolved target key (`undefined` = a clear of a bucket with no connection: a
 * safe no-op).
 */
function translateSecretKey(
  key: SecretKey,
  settings: AnycodeSettings,
  genId: () => string,
  opts: { create: boolean },
): { settings: AnycodeSettings; targetKey: SecretKey | undefined } {
  if (/^provider\.connection\.[^.]+\.(apiKey|oauth)$/.test(key)) {
    return { settings, targetKey: key }; // already connection-scoped
  }
  let providerId: string;
  let authKind: "api_key" | "oauth";
  if (key === "provider.apiKey") {
    providerId = "";
    authKind = "api_key";
  } else {
    const match = /^provider\.([^.]+)\.(apiKey|oauth)$/.exec(key);
    if (match === null || match[1] === undefined) {
      return { settings, targetKey: undefined };
    }
    providerId = match[1];
    authKind = match[2] === "oauth" ? "oauth" : "api_key";
  }
  const existing = bucketConnection(settings.provider, providerId);
  if (existing !== undefined) {
    return { settings, targetKey: connectionSecretKey(existing.id, authKind) };
  }
  if (!opts.create) {
    return { settings, targetKey: undefined }; // clear of an absent connection: nothing to do
  }
  const { provider, connectionId } = findOrCreateConnectionByProvider(settings.provider, providerId, genId, "if-none");
  return { settings: { ...settings, provider }, targetKey: connectionSecretKey(connectionId, authKind) };
}



/**
 * Secret-set/clear key: a bare `string` here (the catalog-membership refine is
 * done in the handler via `isKnownSecretKey(key, catalogIds)`, which is the
 * runtime narrowing to `SecretKey` — a zod literal cannot express the widened
 * template-literal `SecretKey` per catalog).
 */
const secretSetSchema = z.object({ key: z.string(), value: z.string() });
const secretClearSchema = z.object({ key: z.string() });

const oauthStartSchema: z.ZodType<OAuthStartRequest> = z.object({ providerId: z.string().min(1) });
const oauthCancelSchema: z.ZodType<OAuthCancelRequest> = z.object({ providerId: z.string().min(1) });

const ruleAddSchema: z.ZodType<PermissionRuleAddRequest> = z.object({
  toolName: z.string().min(1),
  pattern: z.string().optional(),
});

// ── connection CRUD payload schemas (TASK.45 W9) ──
const transportEnum = z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
const reasoningEffortEnum = z.enum(["off", "low", "medium", "high", "max"]);
// `.strict()` (custody, §6.5): a CRUD payload carrying a credential field
// (`apiKey`/`token`/…) is rejected `invalid` — plaintext NEVER crosses IPC on a
// metadata channel; secrets travel only via `secret-set`.
const connectionCreateSchema = z
  .object({
    providerId: z.string().min(1),
    label: z.string().optional(),
    model: z.string().optional(),
    transport: transportEnum.optional(),
    baseUrl: z.string().optional(),
    reasoningEffort: reasoningEffortEnum.optional(),
    setActive: z.boolean().optional(),
  })
  .strict();
const connectionUpdateSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    model: z.string().optional(),
    transport: transportEnum.optional(),
    baseUrl: z.string().optional(),
    reasoningEffort: reasoningEffortEnum.optional(),
  })
  .strict();
const connectionIdSchema = z.object({ id: z.string().min(1) }).strict();

/** Structural view of ONE catalog entry the projection needs (avoids a core value-import). */
export interface CatalogEntryShape {
  id: string;
  name: string;
  auth: { kind: string };
  baseUrl: string;
  models: { id: string; name?: string }[];
  /** True for the literal `custom` sentinel (TASK.43 W5-FIX); main supplies it from core's `isCustomProvider`. */
  isCustom?: boolean;
  /** Wire transport fields (TASK.43 W5); `string`-typed to keep this module core-import-free. */
  defaultTransport?: string;
  supportedTransports?: readonly string[];
  authOptional?: boolean;
}

/**
 * Projects the built-in catalog to the renderer-facing `CatalogSummary` (value
 * only — no baseUrl secret, no key). `needsBaseUrl` is set for an entry with an
 * empty baseUrl (e.g. the `custom`/`vllm` endpoints, whose baseUrl lives in
 * settings). `isCustom` (TASK.43 W5-FIX) / `defaultTransport` /
 * `supportedTransports` / `authOptional` (TASK.43 W5) are projected only when
 * the source entry declares them, so a legacy caller's plain
 * `{id,name,auth,baseUrl,models}` fixtures keep producing the exact same output
 * as before this wave.
 */
export function projectCatalogSummary(providers: readonly CatalogEntryShape[]): CatalogSummary {
  return providers.map((entry) => ({
    id: entry.id,
    name: entry.name,
    authKind: entry.auth.kind === "oauth" ? "oauth" : "api_key",
    models: entry.models.map((m) => (m.name !== undefined ? { id: m.id, name: m.name } : { id: m.id })),
    ...(entry.baseUrl === "" ? { needsBaseUrl: true } : {}),
    ...(entry.isCustom === true ? { isCustom: true } : {}),
    ...(entry.defaultTransport !== undefined ? { defaultTransport: entry.defaultTransport as ProviderTransportId } : {}),
    ...(entry.supportedTransports !== undefined
      ? { supportedTransports: entry.supportedTransports as ProviderTransportId[] }
      : {}),
    ...(entry.authOptional === true ? { authOptional: true } : {}),
  }));
}

/**
 * The credential key that gates readiness for the ACTIVE connection (TASK.45 v2):
 * its own connection key (`provider.connection.<id>.{apiKey,oauth}`), plus the
 * legacy alias key the pre-W12 renderer reads that key's status under (§4.2).
 * `{}` when there is no active connection — `computeProviderReady` then uses its
 * legacy `provider.apiKey` default (unset on a fresh install).
 */
function activeCredential(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
): { credentialKey?: SecretKey; aliasKey?: SecretKey } {
  const connection = activeConnection(settings);
  if (connection === undefined) {
    return {};
  }
  const providerId = connection.providerId;
  // custom/bare-legacy and every catalog entry are api_key today; an oauth
  // provider (dormant in v1 catalog) uses the connection's oauth key.
  const kind = providerId === "" ? "api_key" : deps.authKindFor?.(providerId) ?? "api_key";
  const authKind: "api_key" | "oauth" = kind === "oauth" ? "oauth" : "api_key";
  return {
    credentialKey: connectionSecretKey(connection.id, authKind),
    aliasKey: legacyAliasKey(providerId, authKind),
  };
}

/**
 * Mirrors the ACTIVE connection's credential status under the legacy alias the
 * pre-W12 renderer looks it up by (§4.2). Presentation-only and value-less
 * (`SecretStatus` carries no plaintext — custody intact): the projected entry
 * copies `set/source/tier` from the connection key's status (or, when that key
 * has no on-disk entry, reports `set:false` with an env-or-none source). Replaces
 * an existing same-key entry in place (so `provider.apiKey` keeps its position),
 * else appends.
 */
function projectAliasStatus(
  secrets: SecretStatus[],
  connectionKey: SecretKey,
  aliasKey: SecretKey,
  bootEnv: NodeJS.ProcessEnv,
): SecretStatus[] {
  const connStatus = secrets.find((s) => s.key === connectionKey);
  const envValue = bootEnv.ANYCODE_API_KEY;
  const envSet = envValue !== undefined && envValue.trim() !== "";
  const aliasStatus: SecretStatus = {
    key: aliasKey,
    set: connStatus?.set ?? false,
    source: connStatus?.source ?? (envSet ? "env" : "none"),
    tier: connStatus?.tier ?? secrets[0]?.tier ?? "unavailable",
  };
  return secrets.some((s) => s.key === aliasKey)
    ? secrets.map((s) => (s.key === aliasKey ? aliasStatus : s))
    : [...secrets, aliasStatus];
}

/**
 * Auth-policy + transport-guard inputs for `computeProviderReady` (TASK.43 W5,
 * cut Risk #3). Looks the selected id up in the already-projected
 * `deps.catalog` (this module stays core-free — no second catalog lookup
 * path). `authOptional` is true either statically (a catalog entry marked
 * `authOptional`, e.g. vLLM) or dynamically for `custom` once its resolved
 * transport is an OpenAI-family one (mirrors core's `loadEnvConfig`: a key is
 * only ever mandatory on `anthropic-messages`).
 */
function selectedTransportInfo(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
): { authOptional: boolean; resolvedTransport?: string; supportedTransports?: readonly string[] } {
  const view = activeProviderView(settings);
  const id = view.id;
  // Legacy / no-catalog branches: still apply the env rung over the active
  // connection's transport, but there is no catalog entry to validate against.
  const resolveLegacy = (): string | undefined =>
    resolveEffectiveTransport({ bootEnv: deps.bootEnv, settingsTransport: view.transport }).value;
  if (id === undefined || id.trim() === "") {
    return { authOptional: false, resolvedTransport: resolveLegacy() };
  }
  const entry: CatalogSummaryEntry | undefined = deps.catalog?.find((e) => e.id === id);
  if (entry === undefined) {
    return { authOptional: false, resolvedTransport: resolveLegacy() };
  }
  // Env-inclusive ladder (env > active-connection transport > catalog default)
  // so the readiness guard + the custom auth-waiver see the SAME transport the
  // fork runs.
  const resolvedTransport = resolveEffectiveTransport({
    bootEnv: deps.bootEnv,
    settingsTransport: view.transport,
    defaultTransport: entry.defaultTransport,
  }).value;
  const isCustomEntry = deps.isCustom?.(id) === true;
  const authOptional =
    entry.authOptional === true ||
    (isCustomEntry && resolvedTransport !== undefined && resolvedTransport !== "anthropic-messages");
  return { authOptional, resolvedTransport, supportedTransports: entry.supportedTransports };
}

/**
 * Deep-partial patch SHAPE guard: rejects only a non-object payload (a malformed
 * bridge message is a safe no-op). This is a shape gate, not a value gate — the
 * legacy `provider` sub-patch is type-validated by `legacyProviderPatchSchema`
 * and the fully-merged settings object is validated against `settingsSchema`
 * before it is written (§5.2). A bad enum/type is therefore refused `invalid`
 * and NEVER persisted; an unvalidated write would quarantine the WHOLE
 * settings.json on the next load (it is not "clamped to the schema").
 */
const patchSchema = z.record(z.string(), z.unknown());

/**
 * Type-validates the whitelisted legacy `provider` sub-patch (§5.2 layer 1):
 * known fields must be well-typed (a bad `transport` / `reasoningEffort` enum is
 * `invalid`), while `.passthrough()` lets an unknown field pass exactly as
 * `applyFieldEdits` already ignores it. Enums are reused from the CRUD schemas.
 */
const legacyProviderPatchSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    transport: transportEnum.optional(),
    defaults: z
      .record(
        z.string(),
        z.object({ model: z.string().optional(), reasoningEffort: reasoningEffortEnum.optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

// ── snapshot projection ──

/**
 * Builds the SettingsSnapshot the renderer renders Settings/Welcome from without
 * a second round-trip. Loads settings fresh (main is the sole writer, atomic),
 * projects vault statuses (NEVER a value), and computes providerReady +
 * envOverrides from the boot snapshot.
 */
export async function buildSettingsSnapshot(deps: SettingsIpcDeps): Promise<SettingsSnapshot> {
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return snapshotFrom(deps, loaded.settings, loaded.readOnly);
}

async function snapshotFrom(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
  readOnly: boolean,
): Promise<SettingsSnapshot> {
  const transportInfo = selectedTransportInfo(deps, settings);
  const credential = activeCredential(deps, settings);
  const [rawSecrets, providerReady] = await Promise.all([
    deps.vault.statuses(deps.bootEnv, deps.catalogIds ?? []),
    computeProviderReady({
      bootEnv: deps.bootEnv,
      settings,
      getSecret: (key) => deps.vault.getSecretValue(key),
      credentialKey: credential.credentialKey,
      authOptional: transportInfo.authOptional,
      resolvedTransport: transportInfo.resolvedTransport,
      supportedTransports: transportInfo.supportedTransports,
    }),
  ]);
  // Legacy alias projection (§4.2): mirror the active connection's key status
  // under the alias the pre-W12 renderer reads, so a key entered via the old
  // generic channel shows as set. Value-less; dies with the shim in W12.
  const secrets =
    credential.credentialKey !== undefined && credential.aliasKey !== undefined
      ? projectAliasStatus(rawSecrets, credential.credentialKey, credential.aliasKey, deps.bootEnv)
      : rawSecrets;
  return {
    settings,
    secrets,
    providerReady,
    envOverrides: envOverrides(deps.bootEnv),
    readOnly,
    ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
  };
}

/** Fires onMutation with the fresh snapshot after a successful mutation. */
async function emitMutation(deps: SettingsIpcDeps, snapshot: SettingsSnapshot): Promise<void> {
  await deps.onMutation?.(snapshot);
}

// ── handlers (exported for unit tests) ──

/** settings-get: the full snapshot. */
export async function handleGet(deps: SettingsIpcDeps): Promise<SettingsSnapshot> {
  return buildSettingsSnapshot(deps);
}

/**
 * The v1-patch compat shim (TASK.45 W9 §4.3): translates a whitelisted legacy
 * `provider` sub-patch into an operation on the ACTIVE connection so the pre-W12
 * renderer's generic write path keeps behaving as it did pre-W9. `id` switches
 * the active connection (find-or-create the connection for that provider bucket,
 * then make it active); `model/baseUrl/transport` and a folded `defaults[activePid]`
 * update the active connection. It never accepts a wholesale `connections[]` /
 * `activeConnectionId` (rejected upstream in `handleSet`). `genId` mints an
 * opaque `conn-<uuid>` for a created connection (injected for deterministic
 * tests). Lives until W12 moves the renderer onto the `connection-*` IPC.
 */
export function applyLegacyProviderPatch(
  settings: AnycodeSettings,
  patch: LegacyProviderPatch,
  genId: () => string = defaultConnectionId,
): AnycodeSettings {
  let provider: ProviderSettingsV2 = settings.provider;
  let targetId = provider.activeConnectionId;

  // (1) provider selection change -> find-or-create the connection for that
  // provider bucket, make it active, and reflect the explicit catalog pick on it
  // (custom<->bare share one bucket).
  if (patch.id !== undefined) {
    const pickedId = patch.id;
    const result = findOrCreateConnectionByProvider(provider, pickedId, genId, "always");
    provider = {
      ...result.provider,
      connections: result.provider.connections.map((connection) =>
        connection.id === result.connectionId ? { ...connection, providerId: pickedId } : connection,
      ),
    };
    targetId = result.connectionId;
  } else if (targetId === undefined && hasLegacyFieldEdit(patch)) {
    // A model/baseUrl/transport edit with no active connection (fresh install,
    // no provider picked): materialise a bare-legacy connection to hold it.
    const connectionId = genId();
    provider = {
      ...provider,
      connections: [...provider.connections, { id: connectionId, providerId: "" }],
      activeConnectionId: connectionId,
    };
    targetId = connectionId;
  }

  // (2) apply model/baseUrl/transport + the folded defaults entry to the target.
  if (targetId !== undefined) {
    const currentId = targetId;
    provider = {
      ...provider,
      connections: provider.connections.map((connection) =>
        connection.id === currentId ? applyFieldEdits(connection, patch) : connection,
      ),
    };
  }

  return { ...settings, provider };
}

/** True when the patch carries any per-connection field edit (model/baseUrl/transport/defaults). */
function hasLegacyFieldEdit(patch: LegacyProviderPatch): boolean {
  return (
    patch.model !== undefined ||
    patch.baseUrl !== undefined ||
    patch.transport !== undefined ||
    patch.defaults !== undefined
  );
}

/** Applies a legacy patch's field edits to one connection (defaults[activePid] wins over the top-level model, matching v1). */
function applyFieldEdits(connection: ProviderConnection, patch: LegacyProviderPatch): ProviderConnection {
  const activePid = connection.providerId === "" ? "custom" : connection.providerId;
  const folded = patch.defaults?.[activePid];
  return {
    ...connection,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
    ...(folded?.model !== undefined ? { model: folded.model } : {}),
    ...(folded?.reasoningEffort !== undefined ? { reasoningEffort: folded.reasoningEffort } : {}),
  };
}

/**
 * settings-set: deep-partial merge into settings.json. The legacy `provider`
 * sub-patch routes through the v1-patch compat shim; a wholesale connections
 * graph refine-rejects. Refuses `read_only` (a newer-than-CURRENT file) and an
 * unparseable patch (`invalid`); `version` is never changed by a patch.
 */
export async function handleSet(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const rawPatch = parsed.data as Record<string, unknown>;
  const providerPatch = rawPatch.provider;
  if (providerPatch !== undefined) {
    if (typeof providerPatch !== "object" || providerPatch === null || Array.isArray(providerPatch)) {
      return { ok: false, reason: "invalid" };
    }
    const pp = providerPatch as Record<string, unknown>;
    // Refine-reject a wholesale connections graph through the generic path: the
    // renderer must use the main-authoritative connection-* CRUD (cut invariant).
    if ("connections" in pp || "activeConnectionId" in pp) {
      return { ok: false, reason: "invalid" };
    }
    // A `provider.id` in the shim patch must name a catalog entry (trust boundary,
    // threat model §9): a compromised renderer cannot point at an arbitrary id.
    if ("id" in pp && pp.id !== undefined && (typeof pp.id !== "string" || !(deps.catalogIds ?? []).includes(pp.id))) {
      return { ok: false, reason: "invalid" };
    }
    // Type-validate the legacy provider sub-patch (§5.2 layer 1): a bad enum is
    // refused here, never folded onto a connection and persisted.
    if (!legacyProviderPatchSchema.safeParse(providerPatch).success) {
      return { ok: false, reason: "invalid" };
    }
  }

  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    // Translate the legacy provider sub-patch into a connection operation first.
    let settings = loaded.settings;
    if (providerPatch !== undefined) {
      settings = applyLegacyProviderPatch(
        settings,
        providerPatch as LegacyProviderPatch,
        deps.genConnectionId ?? defaultConnectionId,
      );
    }
    // Drop version + provider (already handled by the shim); merge the rest.
    const patch: SettingsPatch = { ...(rawPatch as SettingsPatch) };
    delete (patch as Record<string, unknown>).version;
    delete (patch as Record<string, unknown>).provider;
    // Defense in depth (F20 hardening): validate the `keybindings` section against
    // the schema (scoped ONLY to keybindings) so a malformed section is dropped
    // rather than persisted where it could crash a reader.
    if ("keybindings" in patch) {
      const kb = keybindingsSchema.safeParse((patch as Record<string, unknown>).keybindings);
      if (kb.success) {
        (patch as Record<string, unknown>).keybindings = kb.data;
      } else {
        delete (patch as Record<string, unknown>).keybindings;
      }
    }
    const merged = mergeSettings(settings, patch);
    // Safety gate (§5.2 layer 2): validate the WHOLE merged object before it is
    // written. A type/enum violation in ANY section is refused `invalid` rather
    // than persisted — an unvalidated write would fail schema parse on the next
    // load and quarantine-wipe the entire settings.json. Persist the ORIGINAL
    // `merged` (validate-only): `parsed.data` would strip the top-level
    // passthrough keys a future version relies on surviving.
    if (!settingsSchema.safeParse(merged).success) {
      return { ok: false, reason: "invalid" };
    }
    await saveSettings(deps.settingsPath, merged);
    const snapshot = await snapshotFrom(deps, merged, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * secret-set: store a value in the vault (design §1). Pre-W12 the renderer still
 * writes a legacy-shaped key (`provider.apiKey` / `provider.<id>.*`); W9′
 * TRANSLATES it to the connection key of the target provider bucket, minting +
 * activating a connection when none exists yet (§4.1). The connection metadata is
 * persisted FIRST (metadata-first: a crash leaves a visible keyless connection,
 * never an orphan secret). The legacy form is never written to the vault. The
 * consent flag comes from the persisted settings; a weak tier without consent
 * returns `weak_storage_needs_consent` and — after rolling back any connection
 * this call just minted — leaves settings.json and the vault untouched (§3.2).
 * A raw `provider.connection.<id>.*` key is custody-checked against the graph
 * first (§4.2). The whole load→persist→vault→snapshot critical section runs under
 * the settings mutation lock (§2.2). Blocked in read_only.
 */
export async function handleSetSecret(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = secretSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }

  // `SecretKey` is only valid for the legacy `provider.apiKey`, a
  // `provider.<id>.{apiKey,oauth}` whose id is in the catalog, or a
  // `provider.connection.<id>.*` key. Runtime narrowing from `string`.
  const { key } = parsed.data;
  if (!isKnownSecretKey(key, deps.catalogIds ?? [])) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    // Connection-key custody (§4.2, `handleSetSecret` ONLY): a raw
    // `provider.connection.<id>.<kind>` write must name a connection that EXISTS
    // and whose auth kind matches the suffix — a compromised renderer cannot seat
    // a vault entry outside the connection graph. `handleClearSecret` stays
    // permissive (existence not required) so orphans remain removable.
    const connMatch = /^provider\.connection\.([^.]+)\.(apiKey|oauth)$/.exec(key);
    if (connMatch !== null) {
      const conn = loaded.settings.provider.connections.find((c) => c.id === connMatch[1]);
      if (conn === undefined) {
        return { ok: false, reason: "not_found" };
      }
      // Resolve the connection's auth kind exactly as `activeCredential` does.
      const kind = conn.providerId === "" ? "api_key" : deps.authKindFor?.(conn.providerId) ?? "api_key";
      const expectedSuffix = kind === "oauth" ? "oauth" : "apiKey";
      if (connMatch[2] !== expectedSuffix) {
        return { ok: false, reason: "invalid" };
      }
    }
    const { settings: updatedSettings, targetKey } = translateSecretKey(
      key,
      loaded.settings,
      deps.genConnectionId ?? defaultConnectionId,
      { create: true },
    );
    if (targetKey === undefined) {
      return { ok: false, reason: "invalid" }; // defensive: isKnownSecretKey already narrowed
    }
    // Metadata-first: persist a freshly-minted connection BEFORE writing its secret.
    const connectionCreated = updatedSettings !== loaded.settings;
    if (connectionCreated) {
      await saveSettings(deps.settingsPath, updatedSettings);
    }
    const result = await deps.vault.setSecret(targetKey, parsed.data.value, {
      allowWeak: updatedSettings.security.allowWeakSecretStorage,
    });
    if (!result.ok) {
      // Refusal rollback (§3.2): the refused write persisted nothing in the vault,
      // so the connection this call just minted must not linger. Roll the metadata
      // back to the pre-mint state (race-safe under the mutation lock).
      if (connectionCreated) {
        await saveSettings(deps.settingsPath, loaded.settings);
      }
      return { ok: false, reason: result.reason };
    }
    // TASK.45 W11: a stored/replaced credential has not yet been confirmed by a
    // real request or explicit check — reset health to `unchecked` (never leave
    // a stale auth_invalid/etc. from a NOW-superseded key).
    let finalSettings = updatedSettings;
    const targetConnMatch = /^provider\.connection\.([^.]+)\./.exec(targetKey);
    if (targetConnMatch?.[1] !== undefined) {
      const withHealth = withConnectionHealth(updatedSettings, targetConnMatch[1], {
        status: "unchecked",
        at: (deps.now ?? defaultNowIso)(),
      });
      if (withHealth !== undefined) {
        finalSettings = withHealth;
        await saveSettings(deps.settingsPath, finalSettings);
      }
    }
    const snapshot = await snapshotFrom(deps, finalSettings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * secret-clear: remove a value from the vault. A legacy-shaped key is translated
 * to the connection key of its provider bucket (find-only — clearing a bucket
 * with no connection is a safe no-op, §4.1). Blocked in read_only.
 */
export async function handleClearSecret(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = secretClearSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { key } = parsed.data;
  if (!isKnownSecretKey(key, deps.catalogIds ?? [])) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const { targetKey } = translateSecretKey(key, loaded.settings, deps.genConnectionId ?? defaultConnectionId, {
      create: false,
    });
    let finalSettings = loaded.settings;
    if (targetKey !== undefined) {
      await deps.vault.clearSecret(targetKey);
      // TASK.45 W11: a cleared credential resets health to `unchecked` too (cut
      // §W11: "replace/clear key -> unchecked") — never leave a stale
      // auth_invalid/etc. pinned to a now-empty credential slot.
      const targetConnMatch = /^provider\.connection\.([^.]+)\./.exec(targetKey);
      if (targetConnMatch?.[1] !== undefined) {
        const withHealth = withConnectionHealth(loaded.settings, targetConnMatch[1], {
          status: "unchecked",
          at: (deps.now ?? defaultNowIso)(),
        });
        if (withHealth !== undefined) {
          finalSettings = withHealth;
          await saveSettings(deps.settingsPath, finalSettings);
        }
      }
    }
    const snapshot = await snapshotFrom(deps, finalSettings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * permission-rule-add: dedup-append an always-allow rule to
 * settings.permissions.alwaysAllow (design §5). A rule equal by {toolName,
 * pattern} is a no-op (still returns a fresh snapshot). Blocked in read_only.
 */
export async function handleAddRule(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = ruleAddSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const rule = {
      toolName: parsed.data.toolName,
      ...(parsed.data.pattern !== undefined ? { pattern: parsed.data.pattern } : {}),
    };
    const existing = loaded.settings.permissions.alwaysAllow;
    const isDup = existing.some((r) => r.toolName === rule.toolName && r.pattern === rule.pattern);
    let settings = loaded.settings;
    if (!isDup) {
      settings = {
        ...loaded.settings,
        permissions: { ...loaded.settings.permissions, alwaysAllow: [...existing, rule] },
      };
      await saveSettings(deps.settingsPath, settings);
    }
    const snapshot = await snapshotFrom(deps, settings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * oauth-start: run the interactive loopback+PKCE sign-in for a catalog provider
 * (design §3.2/§4.1). Refuses `unsupported` when the provider is not oauth (no
 * config / no engine), `read_only` for a newer settings file, else runs the flow
 * and — on success — returns a fresh snapshot (the provider's SecretStatus now

 * the vault by the engine and only the SecretStatus changes.
 */
export async function handleOAuthStart(deps: SettingsIpcDeps, raw: unknown): Promise<OAuthStartResult> {
  const parsed = oauthStartSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "failed" };
  }
  const config = deps.oauthConfigFor?.(parsed.data.providerId);
  const oauth = deps.oauth;
  if (config === undefined || oauth === undefined) {
    return { ok: false, reason: "unsupported" };
  }
  // Resolve the target connection under the mutation lock (§2.2): the engine
  // persists the token blob by CONNECTION id, so a connection must exist first
  // (metadata-first, created + activated when the provider has none yet). ONLY
  // this metadata section is serialized — the interactive flow (minutes of
  // browser login) runs OUTSIDE the lock so it never freezes settings IPC.
  const prep = await withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { readOnly: true as const };
    }
    const { provider, connectionId, created } = findOrCreateConnectionByProvider(
      loaded.settings.provider,
      parsed.data.providerId,
      deps.genConnectionId ?? defaultConnectionId,
      "if-none",
    );
    const settings: AnycodeSettings = created ? { ...loaded.settings, provider } : loaded.settings;
    if (created) {
      await saveSettings(deps.settingsPath, settings);
    }
    return { readOnly: false as const, connectionId, allowWeak: settings.security.allowWeakSecretStorage };
  });
  if (prep.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  const outcome = await oauth.startFlow(config, prep.connectionId, { allowWeak: prep.allowWeak });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  // Post-flow snapshot from a FRESH load (§2.2): reflects the token the engine
  // just wrote plus any mutation that landed while the flow was in flight.
  const snapshot = await buildSettingsSnapshot(deps);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/** oauth-cancel: abort an in-flight flow for a provider (fire-and-forget, no response). */
export async function handleOAuthCancel(deps: SettingsIpcDeps, raw: unknown): Promise<void> {
  const parsed = oauthCancelSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  deps.oauth?.cancel(parsed.data.providerId);
}

// ── connection health (TASK.45 W11, advisory — never a readiness source) ──

/** `lastHealth.at` clock; overridable via `deps.now` (tests only). */
function defaultNowIso(): string {
  return new Date().toISOString();
}

/**
 * Maps core's `ProviderFailureCode` (provider/failure.ts, relayed verbatim over
 * the host<->main wire as a plain string — see shared/provider-health.ts) onto
 * TASK.45's `ProviderHealthStatus` table. `quota` collapses into `rate_limited`
 * (both a 429-class limit; neither marks the credential itself invalid).
 * `unknown` (an unclassified failure, e.g. a 400 "bad model" request) maps to
 * `misconfigured` — DELIBERATELY never `auth_invalid`: a bad model/schema
 * request must never paint a working credential red. An unrecognised future
 * code (forward-compat with a new core failure bucket) defaults to
 * `unreachable` rather than either "credential is bad" bucket.
 */
/**
 * Null-prototype (W11-FIX2 #1): a plain object literal inherits
 * `Object.prototype`, so both the bracket-index below and the `in` operator in
 * `sanitizeProviderFailureCode` treat `"constructor"`/`"toString"`/
 * `"hasOwnProperty"`/`"__proto__"`/etc as present keys — collapsing this table
 * to a null prototype makes every current AND future accessor own-key-only by
 * construction, closing the whole class of proto-inherited members at once
 * rather than patching each accessor individually.
 */
const FAILURE_CODE_TO_HEALTH: Record<string, ProviderHealthStatus> = Object.assign(Object.create(null), {
  auth: "auth_invalid",
  forbidden: "forbidden",
  rate_limited: "rate_limited",
  quota: "rate_limited",
  connect_timeout: "unreachable",
  network: "unreachable",
  server: "unreachable",
  unknown: "misconfigured",
});

/** Pure classification (TASK.45 W11 gate: 401/429/timeout/bad-model all discriminate). */
export function mapProviderFailureCodeToHealthStatus(code: string): ProviderHealthStatus {
  return FAILURE_CODE_TO_HEALTH[code] ?? "unreachable";
}

/**
 * Sanitizes a host-reported failure code at the untrusted main<->host process
 * boundary (TASK.45 W11-FIX H1): `tabs.ts` casts the parentPort message to
 * `ProviderHealthEvent` with no runtime shape validation, so `code` can be any
 * string a regressed/compromised host writes (e.g. a leaked bearer token) —
 * `FAILURE_CODE_TO_HEALTH`'s keys already mirror core's `ProviderFailureCode`
 * enum, so they double as the whitelist here rather than a third copy of the
 * list. Anything outside that whitelist collapses to `"unknown"` — the same
 * bucket a real unclassified core failure already uses — so `lastHealth.safeCode`
 * can never persist or render an arbitrary string.
 */
export function sanitizeProviderFailureCode(code: unknown): string {
  return typeof code === "string" && code in FAILURE_CODE_TO_HEALTH ? code : "unknown";
}

/**
 * Pure merge of `lastHealth` onto one connection; `undefined` when the
 * connection no longer exists (race-safe no-op — deleted mid-flight). Callers
 * that already hold the settings lock use this directly (no re-entrant lock);
 * `applyConnectionHealthEvent` below is the ONE lock-acquiring entry point for
 * callers outside a handler's own critical section.
 */
function withConnectionHealth(
  settings: AnycodeSettings,
  connectionId: string,
  lastHealth: { status: ProviderHealthStatus; at: string; safeCode?: string },
): AnycodeSettings | undefined {
  if (!settings.provider.connections.some((connection) => connection.id === connectionId)) {
    return undefined;
  }
  return {
    ...settings,
    provider: {
      ...settings.provider,
      connections: settings.provider.connections.map((connection) =>
        connection.id === connectionId ? { ...connection, lastHealth } : connection,
      ),
    },
  };
}

/**
 * Persists an advisory health signal for one connection (TASK.45 W11): a
 * runtime request outcome reported by a pinned core host (main/tabs.ts ->
 * main/index.ts), or a `connection-check` probe result. NEVER fires
 * `onMutation` — health is advisory (task doc §3: "not a runtime-readiness
 * source") and must not trigger the readiness/host-env/auto-tab side effects a
 * real settings mutation does. Read-only settings or a since-deleted connection
 * are silent no-ops (race-safe). Acquires the settings lock itself — callers
 * that already hold it (handleSetSecret/handleClearSecret/handleConnectionUpdate)
 * must use `withConnectionHealth` directly instead, or this would deadlock.
 */
export async function applyConnectionHealthEvent(
  deps: SettingsIpcDeps,
  connectionId: string,
  event: { kind: "success" } | { kind: "failure"; code: string },
): Promise<void> {
  const status: ProviderHealthStatus =
    event.kind === "success" ? "ready" : mapProviderFailureCodeToHealthStatus(event.code);
  const lastHealth = {
    status,
    at: (deps.now ?? defaultNowIso)(),
    ...(event.kind === "failure" ? { safeCode: event.code } : {}),
  };
  await withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return;
    }
    const updated = withConnectionHealth(loaded.settings, connectionId, lastHealth);
    if (updated === undefined) {
      return;
    }
    await saveSettings(deps.settingsPath, updated);
  });
}

// ── connection CRUD handlers (TASK.45 W9, main-authoritative) ──

/** Persists a new provider settings block, then returns a fresh snapshot + fires onMutation. */
async function persistProvider(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
  provider: ProviderSettingsV2,
): Promise<SettingsMutationResult> {
  const updated: AnycodeSettings = { ...settings, provider };
  await saveSettings(deps.settingsPath, updated);
  const snapshot = await snapshotFrom(deps, updated, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/**
 * connection-create: mint a new connection. `providerId` must be a catalog entry
 * (trust boundary). `setActive` — or being the first connection — makes it the
 * default for new sessions. Read-only settings refuse.
 */
export async function handleConnectionCreate(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const req = parsed.data;
  if (!(deps.catalogIds ?? []).includes(req.providerId)) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const id = (deps.genConnectionId ?? defaultConnectionId)();
    const connection: ProviderConnection = {
      id,
      providerId: req.providerId,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.transport !== undefined ? { transport: req.transport } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
    };
    const shouldActivate = req.setActive === true || loaded.settings.provider.activeConnectionId === undefined;
    const activeConnectionId = shouldActivate ? id : loaded.settings.provider.activeConnectionId;
    const provider: ProviderSettingsV2 = {
      connections: [...loaded.settings.provider.connections, connection],
      ...(activeConnectionId !== undefined ? { activeConnectionId } : {}),
    };
    return persistProvider(deps, loaded.settings, provider);
  });
}

/**
 * connection-update: patch a connection's metadata (never its credential).
 * `not_found` for an unknown id. TASK.45 W11: a real edit to model/transport/
 * baseUrl resets `lastHealth` to `unchecked` (a label-only edit or a resend of
 * the SAME value leaves it untouched).
 */
export async function handleConnectionUpdate(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const req = parsed.data;
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = loaded.settings.provider.connections.find((connection) => connection.id === req.id);
    if (existing === undefined) {
      return { ok: false, reason: "not_found" };
    }
    // TASK.45 §3 (Фаза 3): editing a significant ENDPOINT field invalidates the
    // last observed health — a health status confirmed against the OLD
    // model/transport/baseUrl must not linger under the new one. A label-only
    // edit (or a no-op resend of the same value) leaves health untouched.
    const endpointChanged =
      (req.model !== undefined && req.model !== existing.model) ||
      (req.transport !== undefined && req.transport !== existing.transport) ||
      (req.baseUrl !== undefined && req.baseUrl !== existing.baseUrl);
    const updatedConnection: ProviderConnection = {
      ...existing,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.transport !== undefined ? { transport: req.transport } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(endpointChanged
        ? { lastHealth: { status: "unchecked" as const, at: (deps.now ?? defaultNowIso)() } }
        : {}),
    };
    const provider: ProviderSettingsV2 = {
      ...loaded.settings.provider,
      connections: loaded.settings.provider.connections.map((connection) =>
        connection.id === req.id ? updatedConnection : connection,
      ),
    };
    return persistProvider(deps, loaded.settings, provider);
  });
}

/** connection-set-active: make a connection the default for NEW sessions (session-pinning is W10). */
export async function handleConnectionSetActive(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    if (!loaded.settings.provider.connections.some((connection) => connection.id === parsed.data.id)) {
      return { ok: false, reason: "not_found" };
    }
    const provider: ProviderSettingsV2 = { ...loaded.settings.provider, activeConnectionId: parsed.data.id };
    return persistProvider(deps, loaded.settings, provider);
  });
}

/**
 * connection-delete: clear the connection's vault secrets FIRST, then remove its
 * metadata (design order: a crash leaves a visible keyless connection, never an
 * orphan secret). Idempotent: deleting an already-gone connection succeeds. If
 * the deleted connection was active, the active id is cleared.
 *
 * TASK.45 W10:
 *  - delete-guard (EARLY): a connection pinned to a LIVE session refuses
 *    `connection_in_use` and touches nothing (no secret cleared, no metadata
 *    removed). This zero-touch guarantee holds ONLY for the early check.
 *  - W10-FIX F3 delete-guard (LATE re-check): a resume may reserve/register this
 *    pin AFTER the early check passed but WHILE the secret-clears below await. A
 *    second `connectionInUse` check runs before metadata is removed; if it trips,
 *    the delete aborts `connection_in_use` WITHOUT removing metadata — but the
 *    secrets are already cleared, leaving a visible, recoverable keyless
 *    connection (consistent with the "a crash leaves a keyless connection, never
 *    an orphan secret" design posture), never a session pulled out from under.
 *  - residual §6.5: an in-flight oauth flow for the deleted connection's provider
 *    is cancelled BEFORE the secrets are cleared, so the engine cannot persist a
 *    token blob back under the just-deleted connection id.
 */
export async function handleConnectionDelete(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const id = parsed.data.id;
    // Delete-guard: a live session still resolves this connection's credential on
    // every respawn — pulling it out from under an open thread is refused.
    if (deps.connectionInUse?.(id) === true) {
      return { ok: false, reason: "connection_in_use" };
    }
    // Residual §6.5: cancel any in-flight oauth flow for this connection's
    // provider before clearing, so a racing callback cannot re-persist a blob
    // under the deleted id (the flow persists by connectionId, outside this lock).
    const target = loaded.settings.provider.connections.find((connection) => connection.id === id);
    if (target !== undefined && target.providerId !== "") {
      deps.oauth?.cancel(target.providerId);
    }
    // TASK.45 W11-FIX2 #2: tombstone this connectionId BEFORE the vault-clears
    // below, so a same-connection oauth write that settles AFTER this delete's
    // clears (superseded-but-deleted) is still compensated instead of skipped
    // (W11-FIX M6's supersede-skip is for a SURVIVING connection only).
    // Reverted on every exit below where metadata is NOT actually removed, so
    // a connection that survives an aborted delete never carries a stale
    // tombstone into its own future re-sign-in flows.
    const revertTombstone = deps.oauth?.markConnectionDeleting(id);
    let committed = false;
    try {
      // secrets-first (idempotent clears): both credential kinds, before metadata.
      await deps.vault.clearSecret(connectionSecretKey(id, "api_key"));
      await deps.vault.clearSecret(connectionSecretKey(id, "oauth"));
      // W10-FIX F3 (layer b): re-check AFTER the awaits above. A resume that
      // reserved/registered this pin in the window since the early check must not
      // be clobbered — abort before removing metadata. Degradation: the secrets are
      // already gone (keyless, recoverable), but the connection is never yanked out
      // from under a now-live session (the custody defect this closes).
      if (deps.connectionInUse?.(id) === true) {
        return { ok: false, reason: "connection_in_use" };
      }
      const remaining = loaded.settings.provider.connections.filter((connection) => connection.id !== id);
      const activeConnectionId =
        loaded.settings.provider.activeConnectionId === id ? undefined : loaded.settings.provider.activeConnectionId;
      const provider: ProviderSettingsV2 = {
        connections: remaining,
        ...(activeConnectionId !== undefined ? { activeConnectionId } : {}),
      };
      const result = await persistProvider(deps, loaded.settings, provider);
      committed = result.ok;
      return result;
    } finally {
      if (!committed) {
        revertTombstone?.();
      }
    }
  });
}

/**
 * connection-check (TASK.45 W11 wires the probe over the W9 scaffold): runs
 * `deps.probeConnection` AT MOST once, NEVER as a fallback billable request —
 * absent (the default) this behaves byte-identically to the W9 scaffold (id
 * validated, current snapshot returned, no network call at all). A connection
 * with no resolvable credential is left untouched (nothing to probe with —
 * same as "needs_credential", which W11 never writes itself). The probe result
 * is classified through the SAME `mapProviderFailureCodeToHealthStatus` table
 * every runtime event uses (`applyConnectionHealthEvent`), never a bespoke
 * check-only classifier.
 */
export async function handleConnectionCheck(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  const connection = loaded.settings.provider.connections.find((c) => c.id === parsed.data.id);
  if (connection === undefined) {
    return { ok: false, reason: "not_found" };
  }
  // A read-only settings.json (newer-than-this-binary) can never persist a probe
  // result — skip the network call entirely rather than fire it and discard it.
  if (!loaded.readOnly && deps.probeConnection !== undefined) {
    const kind = connection.providerId === "" ? "api_key" : deps.authKindFor?.(connection.providerId) ?? "api_key";
    const credential = await deps.vault.getSecretValue(connectionSecretKey(connection.id, kind));
    if (credential !== undefined && credential !== "") {
      const outcome = await deps.probeConnection(connection, credential);
      await applyConnectionHealthEvent(
        deps,
        connection.id,
        outcome.ok ? { kind: "success" } : { kind: "failure", code: outcome.code },
      );
    }
  }
  const snapshot = await buildSettingsSnapshot(deps);
  return { ok: true, snapshot };
}

/**
 * Wires the frozen channels onto ipcMain. A payload the handler cannot validate
 * is answered with that channel's safe negative (never thrown across the bridge).
 * The Vault concrete type satisfies VaultLike structurally. The two OAuth
 * channels (slice 2.5) are additive.
 */
export function registerSettingsIpc(deps: Omit<SettingsIpcDeps, "vault"> & { vault: Vault }): void {
  ipcMain.handle(SETTINGS_GET_CHANNEL, () => handleGet(deps));
  ipcMain.handle(SETTINGS_SET_CHANNEL, (_event, raw: unknown) => handleSet(deps, raw));
  ipcMain.handle(SECRET_SET_CHANNEL, (_event, raw: unknown) => handleSetSecret(deps, raw));
  ipcMain.handle(SECRET_CLEAR_CHANNEL, (_event, raw: unknown) => handleClearSecret(deps, raw));
  ipcMain.handle(PERMISSION_RULE_ADD_CHANNEL, (_event, raw: unknown) => handleAddRule(deps, raw));
  ipcMain.handle(OAUTH_START_CHANNEL, (_event, raw: unknown) => handleOAuthStart(deps, raw));
  ipcMain.handle(OAUTH_CANCEL_CHANNEL, (_event, raw: unknown) => handleOAuthCancel(deps, raw));
  // Connection CRUD (TASK.45 W9): main-authoritative, additive channels.
  ipcMain.handle(CONNECTION_CREATE_CHANNEL, (_event, raw: unknown) => handleConnectionCreate(deps, raw));
  ipcMain.handle(CONNECTION_UPDATE_CHANNEL, (_event, raw: unknown) => handleConnectionUpdate(deps, raw));
  ipcMain.handle(CONNECTION_SET_ACTIVE_CHANNEL, (_event, raw: unknown) => handleConnectionSetActive(deps, raw));
  ipcMain.handle(CONNECTION_DELETE_CHANNEL, (_event, raw: unknown) => handleConnectionDelete(deps, raw));
  ipcMain.handle(CONNECTION_CHECK_CHANNEL, (_event, raw: unknown) => handleConnectionCheck(deps, raw));
}

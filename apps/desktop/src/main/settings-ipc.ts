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
import { isAbsolute } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { keybindingsSchema, mergeSettings, settingsSchema } from "../settings/schema.js";
import { RECOGNIZER_SET_CHANNEL } from "../shared/recognizer.js";
import type { RecognizerSetRequest } from "../shared/recognizer.js";
import type { ProxyProfile, ProxyProfileDeleteResult } from "../shared/proxy.js";
import {
  findProxyProfile,
  isProxyProfileSecretKey,
  isProxyProfileUrl,
  maskLegacyProxyUrls,
  proxyPathFingerprint,
  proxyProfiles,
  proxyProfileSecretKey,
  PROXY_PROFILE_DELETE_CHANNEL,
  PROXY_PROFILE_SECRET_KEY_RE,
  PROXY_PROFILE_UPSERT_CHANNEL,
  PROXY_REF_DIRECT,
  PROXY_REF_LEGACY,
  PROXY_REF_SET_CHANNEL,
  hostForkProxyChain,
  resolveProxyLadder,
} from "../shared/proxy.js";
import type { LegacyProxyImportDeps, ProxyPasswordProbe } from "./proxy-scopes.js";
import {
  defaultProxyProfileId,
  importLegacyProxy,
  proxyProfileConsumers,
  PROXY_SCOPE_BINDINGS,
} from "./proxy-scopes.js";
import {
  BINARY_TRUST_GRANT_CHANNEL,
  BINARY_TRUST_REVOKE_CHANNEL,
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
  connectionById,
  isProxyUrl,
} from "../shared/settings.js";
import type {
  AnycodeSettings,
  CatalogAuthKind,
  CatalogSummary,
  CatalogSummaryEntry,
  OAuthCancelRequest,
  OAuthStartRequest,
  OAuthStartResult,
  PermissionRuleAddRequest,
  ProviderConnection,
  ProviderHealthStatus,
  ProviderSettingsV2,
  ProviderTransportId,
  SecretKey,
  SettingsMutationResult,
  SettingsPatch,
  SettingsSnapshot,
  TrustedBinaryConsent,
} from "../shared/settings.js";
import {
  computeProviderReady,
  connectionSecretKey,
  customKindDefaultTransport,
  customProviderSecretKey,
  customSupportedTransports,
  envOverrides,
  findCustomProviderRecord,
  isCustomProviderRecordId,
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
  /**
   * Tri-state read (TASK.141, design review B-08): distinguishes "no entry" from
   * "an entry that will not decrypt". Used by the legacy-import dedup, which may
   * not treat the two alike, and by the password-mutation compensation, which
   * has to be able to put the PREVIOUS value back.
   */
  probeSecret(key: SecretKey): Promise<ProxyPasswordProbe>;
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
  /** Mints an opaque proxy-profile id (`proxy-<uuid>`, dot-free — it is a vault-key segment). Injected for determinism in tests. */
  genProxyProfileId?: () => string;
  /**
   * Refreshes main's in-memory plaintext proxy-password cache from the vault
   * (TASK.141 §5, design review H-01). Called after the vault write and BEFORE
   * the mutation event, so the very first spawn that follows a save already
   * carries the new credential: the sync materialisation call sites read that
   * cache, and a mutation event that arrived first would let a spawn race the
   * refresh and go out with the superseded password. Absent in unit fixtures
   * (and until lane B wires the cache) — an absent refresh is a no-op, never an
   * error.
   */
  refreshProxySecrets?: () => void | Promise<void>;
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
  /**
   * TASK.49: returns the running app's version for `SettingsSnapshot.appVersion`.
   * Injected (never `import { app } from "electron"` here) so this module keeps
   * the same DI discipline as automation/handlers.ts's `AppLike` and stays
   * unit-testable with a fake. main/index.ts wires `() => app.getVersion()`;
   * absent in a test deps bag simply omits `appVersion` from the snapshot.
   */
  getAppVersion?: () => string;
  /**
   * TASK.103 seam: realpath+stat of a binary the user asked to trust.
   * Production: realpathSync -> statSync. Injectable so grant tests never
   * depend on live fs layout.
   */
  statBinaryForTrust?: (path: string) =>
    | { ok: true; resolvedPath: string; stat: { isFile: boolean; mode: number; uid: number; gid: number; size: number; mtimeMs: number } }
    | { ok: false; error: string };
  /** TASK.103: platform gate for the grant (win32 refuses — the unchecked path needs no consent). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** TASK.103 fix wave (D-S4-13): the process uid the grant custody check judges file ownership against. Defaults to `process.getuid?.() ?? -1` (the -1 sentinel matches no real owner — fail-closed). */
  uid?: number;
}

/** Outcome of an explicit `connection-check` probe (TASK.45 W11). */
export type ConnectionProbeOutcome = { ok: true } | { ok: false; code: string };

/** A fresh opaque connection id for a connection minted by main (`conn-<uuid>`). */
function defaultConnectionId(): string {
  return `conn-${randomUUID()}`;
}

/**
 * Per-settings-file mutation lock (§2.2): the shared `withSettingsFileLock`
 * from settings/files.ts — ONE lock per settingsPath across this module AND
 * main/provider-ipc.ts (FX3-L1 G-C: two private per-module locks over the
 * same file serialized nothing against each other). Every mutating handler's
 * load→modify→save→snapshot critical section runs through it so two
 * interleaved `ipcMain.handle` handlers can never both load the same base and
 * clobber each other on save (main is the sole writer). The interactive OAuth
 * flow stays OUTSIDE the lock — only its metadata section is serialized (a
 * minutes-long browser login must not freeze all settings IPC).
 */

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

/**
 * Secret-set/clear key: a bare `string` here (the catalog-membership refine is
 * done in the handler via `isKnownSecretKey(key, catalogIds)`, which is the
 * runtime narrowing to `SecretKey` — a zod literal cannot express the widened
 * template-literal `SecretKey` per catalog).
 */
const secretSetSchema = z.object({ key: z.string(), value: z.string() });
const secretClearSchema = z.object({ key: z.string() });

const oauthStartSchema: z.ZodType<OAuthStartRequest> = z.object({
  providerId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
});
const oauthCancelSchema: z.ZodType<OAuthCancelRequest> = z.object({ providerId: z.string().min(1) });

const ruleAddSchema: z.ZodType<PermissionRuleAddRequest> = z.object({
  toolName: z.string().min(1),
  pattern: z.string().optional(),
});

// TASK.103: grant/revoke request payloads — {path} ONLY. The fingerprint is
// NEVER accepted from the caller; main computes it main-side from the live
// filesystem (D-S4-5) via `statBinaryForTrust`.
const binaryTrustGrantSchema = z.object({ path: z.string().min(1) });
const binaryTrustRevokeSchema = z.object({ path: z.string().min(1) });

/** Local structural check (no shared helper exists in this file to reuse — ANCHORS-S4 confirms `isPlainObjectLike` is a hedge, not a real symbol). */
function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── connection CRUD payload schemas (TASK.45 W9) ──
const transportEnum = z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
const reasoningEffortEnum = z.enum(["off", "low", "medium", "high", "max"]);
// `.strict()` (custody, §6.5): a CRUD payload carrying a credential field
// (`apiKey`/`token`/…) is rejected `invalid` — plaintext NEVER crosses IPC on a
// metadata channel; secrets travel only via `secret-set`.

/**
 * Output-token ceiling (TASK.150) at the trust boundary. Bounded on both sides
 * rather than merely `.positive()`: a fat-fingered `10` produces a connection
 * that truncates every single reply, and an absurd `1e12` is a request the
 * provider will 400 on — neither is worth persisting. The persisted schema
 * stays lenient (`.catch(undefined)`) for document-tolerance reasons; strictness
 * belongs here, where exactly one value is being written.
 */
const MAX_OUTPUT_TOKENS_MIN = 1_024;
const MAX_OUTPUT_TOKENS_MAX = 1_000_000;
const maxOutputTokensSchema = z.number().int().min(MAX_OUTPUT_TOKENS_MIN).max(MAX_OUTPUT_TOKENS_MAX);

const connectionCreateSchema = z
  .object({
    providerId: z.string().min(1),
    label: z.string().optional(),
    model: z.string().optional(),
    transport: transportEnum.optional(),
    baseUrl: z.string().optional(),
    // HTTP(S) proxy (TASK.132). The strict `isProxyUrl` gate lives HERE, at the
    // trust boundary — the persisted schema stays lenient so one hand-edited
    // value can never corrupt the whole document (settings/schema.ts).
    proxyUrl: z.string().refine(isProxyUrl).optional(),
    // Proxy-registry reference (TASK.141). Shape only here — `"direct"` or an
    // existing profile id is checked in the handler, which is where the registry
    // is in hand. Carried on CREATE so a new connection's proxy choice is saved
    // atomically with the connection, never as a second call that can be lost.
    proxyRef: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortEnum.optional(),
    maxOutputTokens: maxOutputTokensSchema.optional(),
    authOptional: z.boolean().optional(),
    setActive: z.boolean().optional(),
  })
  .strict();
const connectionUpdateSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    model: z.string().optional(),
    // `""` sentinel (§3): clears an explicit transport back to catalog
    // default. `connectionCreateSchema` deliberately does NOT get this union
    // — at create time an omitted transport already means "use the default".
    transport: z.union([transportEnum, z.literal("")]).optional(),
    baseUrl: z.string().optional(),
    // HTTP(S) proxy (TASK.132) with the same `""` clear-sentinel convention as
    // `transport` above; a non-empty value must pass the strict `isProxyUrl`
    // gate before it can reach disk.
    proxyUrl: z.union([z.string().refine(isProxyUrl), z.literal("")]).optional(),
    // Proxy-registry reference (TASK.141) with the same `""` clear sentinel;
    // `"legacy"` additionally requests the one-shot conversion of this
    // connection's own legacy `proxyUrl` into a real profile.
    proxyRef: z.string().optional(),
    reasoningEffort: reasoningEffortEnum.optional(),
    // Output-token ceiling (TASK.150) with the same `""` clear sentinel as
    // `transport`/`proxyRef` above.
    maxOutputTokens: z.union([maxOutputTokensSchema, z.literal("")]).optional(),
    // `false` clears (removed from disk), `true` sets — see ConnectionUpdateRequest.
    authOptional: z.boolean().optional(),
  })
  .strict();
const connectionIdSchema = z.object({ id: z.string().min(1) }).strict();
// ── proxy-registry payload schemas (TASK.141) ──

/**
 * A profile id, in the ONLY shape main ever mints (design review B-06):
 * `proxy-` plus a dot-free, whitespace-free segment. Dot-free because the id is
 * a segment of the vault key (`proxy.profile.<id>.password`) and a dot there
 * would make `PROXY_PROFILE_SECRET_KEY_RE` read a different id than the one
 * written. Prefixed because an EDIT must not be expressible against an
 * arbitrary string: create mints the id, edit may only name one that already
 * exists, and there is no third way for an id to enter the registry.
 */
const proxyProfileIdSchema = z.string().regex(/^proxy-[A-Za-z0-9_-]+$/);

/**
 * The password half of an upsert (design review H-01). Three explicit actions
 * rather than an optional string, because "field absent" is genuinely ambiguous
 * for a value the editor CANNOT read back: it means "leave it alone" to a form
 * that never touched the field and "erase it" to one that cleared it, and
 * guessing wrong either strands an old credential or silently drops a working
 * one. `set` refuses an empty value — clearing is `clear`, said out loud.
 */
const proxyPasswordActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("set"), value: z.string().min(1) }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
]);

/**
 * A profile as the editor submits it — DISCRIMINATED on `mode` (design review
 * B-06), because the two modes are two different shapes and a single optional
 * `url` accepted both "a manual profile with no path at all" (which persists as
 * a real-looking row that materialises direct) and "a system profile carrying a
 * stale host from a mode switch".
 *
 *  - `manual` REQUIRES a url, held to `isProxyProfileUrl`: http(s), a real host,
 *    no userinfo, no path/query/fragment. Userinfo is the custody half —
 *    credentials belong in `login` + the vault, and a `user:pass@` typed into
 *    the host field would put a password straight back into the 0644
 *    settings.json this slice exists to take it out of;
 *  - `system` accepts a url key and NEVER stores it: the mode decides where the
 *    path comes from, and a leftover host/port from a mode switch in the editor
 *    is stale data, not user intent. (Accepted rather than refused so an editor
 *    that keeps one form state for both modes does not have to delete the field
 *    to switch mode.)
 */
const proxyProfileUpsertSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("manual"),
      id: proxyProfileIdSchema.optional(),
      name: z.string().min(1),
      url: z.string().refine(isProxyProfileUrl),
      noProxy: z.string().optional(),
      login: z.string().optional(),
      password: proxyPasswordActionSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("system"),
      id: proxyProfileIdSchema.optional(),
      name: z.string().min(1),
      url: z.string().optional(),
      noProxy: z.string().optional(),
      login: z.string().optional(),
      password: proxyPasswordActionSchema.optional(),
    })
    .strict(),
]);

const proxyProfileDeleteSchema = z.object({ id: z.string().min(1) }).strict();

/** The serialised scope identity (`ProxyScopeId`) — `.strict()` per variant, so an unknown scope shape is refused rather than half-read. */
const proxyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app") }).strict(),
  z.object({ kind: z.literal("connection"), connectionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("engine"), engine: z.enum(["codex", "claude"]) }).strict(),
]);

/** `ref: null` = remove the scope's ref (and its legacy string) — "inherit the rung below". */
const proxyRefSetSchema = z
  .object({
    scope: proxyScopeSchema,
    ref: z.union([z.string().min(1), z.null()]),
  })
  .strict();

/**
 * recognizer-set payload (TASK.198): `recognizer: null` deletes
 * `settings.recognizer` (the fallback is off); the object variant is the
 * candidate to persist. `modelId`'s `.min(1)` catches a flatly empty string —
 * the whitespace-only case (`"  "`) is caught in the handler, which mirrors
 * host/index.ts's `parseRecognizerEnv` trim-then-check rather than duplicating
 * a stricter regex here. `.strict()` on both variants, same discipline as
 * every other write-payload schema in this file.
 */
const recognizerSetSchema = z
  .object({
    recognizer: z.union([
      z.object({ connectionId: z.string().min(1), modelId: z.string().min(1) }).strict(),
      z.null(),
    ]),
  })
  .strict();

/** Structural view of ONE catalog entry the projection needs (avoids a core value-import). */
export interface CatalogEntryShape {
  id: string;
  name: string;
  auth: { kind: string };
  baseUrl: string;
  /** `reasoning`/`effortLevels` (TASK.131), `maxOutputTokens` (TASK.159) and `imageInput` (TASK.198) ride along for the draft-time effort picker / ceiling display / vision-model suggestions; `string[]`-typed to keep this module core-import-free. */
  models: {
    id: string;
    name?: string;
    reasoning?: boolean;
    effortLevels?: readonly string[];
    maxOutputTokens?: number;
    imageInput?: boolean;
  }[];
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
 * `supportedTransports` / `authOptional` (TASK.43 W5) — and each model's
 * `maxOutputTokens` (TASK.159) — are projected only when the source entry/model
 * declares them, so a legacy caller's plain
 * `{id,name,auth,baseUrl,models}` fixtures keep producing the exact same output
 * as before this wave.
 */
export function projectCatalogSummary(providers: readonly CatalogEntryShape[]): CatalogSummary {
  return providers.map((entry) => ({
    id: entry.id,
    name: entry.name,
    authKind: entry.auth.kind === "oauth" ? "oauth" : "api_key",
    models: entry.models.map((m) => ({
      id: m.id,
      ...(m.name !== undefined ? { name: m.name } : {}),
      // TASK.131: both only when declared, so a fixture's plain `{id,name}`
      // model still projects to exactly `{id,name}`.
      ...(m.reasoning === true ? { reasoning: true } : {}),
      ...(m.effortLevels !== undefined ? { effortLevels: [...m.effortLevels] } : {}),
      // TASK.159: same conditional-spread precedent — only when the catalog
      // declares a ceiling, so legacy fixtures stay byte-identical.
      ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
      // TASK.198: only the models the catalog MARKS as accepting image input,
      // matching core's own reading of the flag (absent = not marked, never
      // "unknown"): the Vision pane suggests these as recognizer models.
      ...(m.imageInput === true ? { imageInput: true } : {}),
    })),
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
 * its own connection key (`provider.connection.<id>.{apiKey,oauth}`).
 * `undefined` when there is no active connection — `computeProviderReady` then
 * uses its legacy `provider.apiKey` default (unset on a fresh install).
 *
 * FX4: a `custom:*` providerId routes at the custom provider's OWN shared
 * vault key (`provider.<custom-id>.apiKey`) instead of the connection key —
 * mirrors index.ts's `activeCredential` and `buildHostEnv`'s custom-provider
 * route, neither of which ever reads the connection key for a custom id.
 * Deliberately NO record look-up: a deleted custom provider still yields its
 * (now-orphaned) secret key, so the vault read naturally comes back unset and
 * the fail-closed default gate does the rest.
 */
function activeCredential(deps: SettingsIpcDeps, settings: AnycodeSettings): SecretKey | undefined {
  const connection = activeConnection(settings);
  if (connection === undefined) {
    return undefined;
  }
  const providerId = connection.providerId;
  if (isCustomProviderRecordId(providerId)) {
    return customProviderSecretKey(providerId);
  }
  // custom/bare-legacy and every catalog entry are api_key today; an oauth
  // provider (dormant in v1 catalog) uses the connection's oauth key.
  const kind = providerId === "" ? "api_key" : deps.authKindFor?.(providerId) ?? "api_key";
  const authKind: "api_key" | "oauth" = kind === "oauth" ? "oauth" : "api_key";
  return connectionSecretKey(connection.id, authKind);
}

/**
 * Auth-policy + transport-guard inputs for `computeProviderReady` (TASK.43 W5,
 * cut Risk #3). Looks the selected id up in the already-projected
 * `deps.catalog` (this module stays core-free — no second catalog lookup
 * path). `authOptional` is true either statically (a catalog entry marked
 * `authOptional`, e.g. vLLM) or dynamically for `custom` once its resolved
 * transport is an OpenAI-family one (mirrors core's `loadEnvConfig`: a key is
 * only ever mandatory on `anthropic-messages`).
 *
 * FX4: a `custom:*` providerId with a live record resolves its OWN kind-implied
 * ladder (`customKindDefaultTransport`/`customSupportedTransports`, mirroring
 * index.ts's `selectedTransportInfo` and `buildHostEnv`'s custom-provider
 * route) BEFORE `deps.catalog` is even consulted — that projection only ever
 * holds builtin entries, so it would otherwise fall through to the generic
 * no-catalog-entry branch below (no supported-transport guard, `authOptional`
 * always false, wrongly blocking a keyless openai-family custom provider). A
 * deleted record falls through unchanged to that same generic fail-closed
 * branch.
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
  const customRecord = isCustomProviderRecordId(id) ? findCustomProviderRecord(settings, id) : undefined;
  if (customRecord !== undefined) {
    // resolvedTransport is always defined here: customKindDefaultTransport
    // always supplies a defaultTransport rung, so resolveEffectiveTransport's
    // ladder never falls through to "unset".
    const resolvedTransport = resolveEffectiveTransport({
      bootEnv: deps.bootEnv,
      settingsTransport: view.transport,
      defaultTransport: customKindDefaultTransport(customRecord.kind),
    }).value;
    return {
      authOptional: resolvedTransport !== "anthropic-messages",
      resolvedTransport,
      supportedTransports: customSupportedTransports(customRecord.kind),
    };
  }
  if (isCustomProviderRecordId(id)) {
    // W4-R3-1: a `custom:*` id with NO live record (deleted while a connection
    // still names it — e.g. removed via the generic settings-patch channel,
    // which skips handleCustomProviderDelete's clear-first, leaving an orphaned
    // vault key). `buildHostEnv` fail-closes here (neither baseUrl nor key), so
    // readiness MUST be false even if that orphaned key or ANYCODE_API_KEY is
    // present. An empty supportedTransports set trips computeProviderReady's
    // transport guard — but only when resolvedTransport is defined, so pin a
    // non-empty sentinel when neither env nor the connection selects one (a bare
    // resolveLegacy() can be undefined, which would SKIP the guard entirely).
    return { authOptional: false, resolvedTransport: resolveLegacy() ?? "custom-provider-deleted", supportedTransports: [] };
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
 * fully-merged settings object is validated against `settingsSchema` before it
 * is written (§5.2). A bad enum/type is therefore refused `invalid` and NEVER
 * persisted; an unvalidated write would quarantine the WHOLE settings.json on
 * the next load (it is not "clamped to the schema"). `provider` is refined out
 * entirely upstream (`handleSet`, TASK.45 W12) before this shape gate even runs.
 */
const patchSchema = z.record(z.string(), z.unknown());

// ── snapshot projection ──

/**
 * TASK.159: pin of packages/core/src/types/config.ts's DEFAULT_MAX_OUTPUT_TOKENS
 * (32_768). This module sits on the IPC boundary beside shared/settings.ts, so
 * it must stay core-import-free — the default crosses to the renderer as this
 * literal (`SettingsSnapshot.defaultMaxOutputTokens`) instead of an import.
 * When core's default moves, move BOTH pins together (this one and the
 * renderer-facing field); the renderer never hardcodes the number.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

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
  const credentialKey = activeCredential(deps, settings);
  const [rawSecrets, providerReady] = await Promise.all([
    deps.vault.statuses(deps.bootEnv, deps.catalogIds ?? []),
    computeProviderReady({
      bootEnv: deps.bootEnv,
      settings,
      getSecret: (key) => deps.vault.getSecretValue(key),
      credentialKey,
      authOptional: transportInfo.authOptional,
      resolvedTransport: transportInfo.resolvedTransport,
      supportedTransports: transportInfo.supportedTransports,
    }),
  ]);
  return {
    // TASK.141 (design review H-02): the ONE place the settings document is
    // handed to the renderer, and therefore the one place a legacy
    // `http://user:pass@proxy:3128` must lose its password. Everything computed
    // above reads the UNMASKED document (readiness, credentials, transport), and
    // main keeps working off the real one — the projection is renderer-facing
    // only. A document with no legacy userinfo comes back unchanged, byte for
    // byte, so this costs nothing on the overwhelmingly common path.
    settings: maskLegacyProxyUrls(settings),
    secrets: rawSecrets,
    providerReady,
    envOverrides: envOverrides(deps.bootEnv),
    readOnly,
    ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
    // TASK.159: the fallback output ceiling a blank "Max output tokens"
    // resolves to for a model no catalog entry knows — projected so the
    // renderer can NAME the effective number without importing core.
    defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    ...(deps.getAppVersion !== undefined ? { appVersion: deps.getAppVersion() } : {}),
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
 * settings-set: deep-partial merge into settings.json. `provider` is refine-
 * rejected outright (TASK.45 W12): the connection graph is CRUD-only
 * (`connection-*` channels) — the pre-W12 v1-patch compat shim that folded a
 * legacy `provider` sub-patch onto the active connection is retired now that
 * the renderer writes connections directly. Refuses `read_only` (a
 * newer-than-CURRENT file) and an unparseable patch (`invalid`); `version` is
 * never changed by a patch.
 */
export async function handleSet(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const rawPatch = parsed.data as Record<string, unknown>;
  // The connection graph is CRUD-only (cut invariant) — ANY `provider` key sent
  // through the generic path is refused, not folded onto a connection.
  if ("provider" in rawPatch) {
    return { ok: false, reason: "invalid" };
  }
  // TASK.103 custody: consent records are written ONLY by the dedicated
  // grant/revoke channels — main computes the fingerprint from the live
  // filesystem. A generic merge carrying them is refused loudly, never
  // silently stripped (a buggy caller must not believe it persisted).
  const securityPatch = rawPatch.security;
  if (isPlainObjectLike(securityPatch) && "trustedBinaries" in securityPatch) {
    return { ok: false, reason: "invalid" };
  }
  // TASK.141 custody (design review B-04): the proxy registry and every scope
  // ref are written ONLY by their dedicated handlers, and a generic patch
  // carrying one is refused loudly rather than silently stripped (a buggy caller
  // must not believe it persisted). Without this the whole slice's invariants
  // are decorative: `{network:{proxyProfiles:[]}}` would delete a profile that
  // three connections reference, skipping the consumer scan that refuses exactly
  // that, orphaning its vault password and re-routing scopes nobody was looking
  // at; `{codex:{proxyRef:"nope"}}` would seat a dangling ref past the
  // membership check. Same shape as the `provider` and `security.trustedBinaries`
  // refusals above.
  if (patchTouchesProxy(rawPatch)) {
    return { ok: false, reason: "invalid" };
  }
  // TASK.198: `settings.recognizer` is written ONLY by its dedicated
  // `recognizer-set` channel — a generic patch carrying it is refused loudly
  // rather than silently stripped (a buggy caller must not believe it
  // persisted). Unlike the two refusals above, this one is not (only) about
  // custody: `mergeSettings`'s `deepMerge` skips every `undefined` patch value,
  // so the generic path is PHYSICALLY unable to delete the key — it can only
  // ADD or REPLACE `recognizer`, never turn the fallback off. Leaving it half
  // of a two-writer field (one that can enable, one that can also disable)
  // would let a caller believe `settings-set` fully owns the field when it can
  // only ever move it one direction.
  if ("recognizer" in rawPatch) {
    return { ok: false, reason: "invalid" };
  }

  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const settings = loaded.settings;
    // Drop version (main is the sole authority); merge the rest.
    const patch: SettingsPatch = { ...(rawPatch as SettingsPatch) };
    delete (patch as Record<string, unknown>).version;
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
 * The proxy-owned keys of a settings block. `proxyUrl` is included together with
 * the two ref fields (design review B-04/H-04): it is the LEGACY expression of
 * the same decision, and letting a generic patch write it would reopen the same
 * hole one field to the left — plus it is the byte-preservation contract the
 * automatic doctor writes rely on, and a caller that can rewrite it can also
 * erase it.
 */
const PROXY_PATCH_KEYS = ["proxyProfiles", "proxyRef", "proxyUrl"] as const;

/** True when a patch's `network`/`codex`/`claude` block carries any proxy-owned key (B-04). */
function patchTouchesProxy(patch: Record<string, unknown>): boolean {
  return ["network", "codex", "claude"].some((block) => {
    const value = patch[block];
    // A NON-proxy patch to the same engine block (binaryPath, lastCheck,
    // profiles, riskAcceptedVersions — everything the doctor writes) stays
    // allowed: the refusal is per FIELD, not per block.
    return isPlainObjectLike(value) && PROXY_PATCH_KEYS.some((key) => key in value);
  });
}

/** Matches a connection-scoped vault key, capturing `[id, kind]`. */
const CONNECTION_SECRET_KEY_RE = /^provider\.connection\.([^.]+)\.(apiKey|oauth)$/;

/**
 * secret-set: store a value in the vault (design §1). TASK.45 W12: the renderer
 * writes a connection-scoped key DIRECTLY (`provider.connection.<id>.*`) —
 * connection metadata is always created first via `connection-create`, so this
 * handler never mints or activates a connection itself; a legacy-shaped key
 * (bare `provider.apiKey` / `provider.<id>.*`) is refused `invalid` (the
 * pre-W12 write-translation shim is retired). The named connection must EXIST
 * and its auth kind must match the key suffix (custody: a compromised renderer
 * cannot seat a vault entry outside the connection graph). The consent flag
 * comes from the persisted settings; a weak tier without consent returns
 * `weak_storage_needs_consent` and leaves settings.json and the vault untouched.
 * The whole load→vault→snapshot critical section runs under the settings
 * mutation lock (§2.2). Blocked in read_only.
 */
export async function handleSetSecret(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = secretSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { key } = parsed.data;
  if (!isKnownSecretKey(key, deps.catalogIds ?? [])) {
    return { ok: false, reason: "invalid" };
  }
  if (isProxyProfileSecretKey(key)) {
    // TASK.141 (design review H-01): a proxy password is NOT settable here. It
    // is one half of a profile's configuration and travels with the other half,
    // through `proxy-profile-upsert`'s `password` action, so that a login+
    // password edit lands as ONE mutation instead of two — and so that setting
    // it invalidates the health of every connection that authenticates through
    // it, which this generic channel has no way to know how to do.
    return { ok: false, reason: "invalid" };
  }
  const connMatch = CONNECTION_SECRET_KEY_RE.exec(key);
  if (connMatch === null) {
    return { ok: false, reason: "invalid" }; // legacy-shaped key: no longer a write target
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
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
    const result = await deps.vault.setSecret(key, parsed.data.value, {
      allowWeak: loaded.settings.security.allowWeakSecretStorage,
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    // TASK.45 W11: a stored/replaced credential has not yet been confirmed by a
    // real request or explicit check — reset health to `unchecked` (never leave
    // a stale auth_invalid/etc. from a NOW-superseded key).
    let finalSettings = loaded.settings;
    const withHealth = withConnectionHealth(loaded.settings, conn.id, {
      status: "unchecked",
      at: (deps.now ?? defaultNowIso)(),
    });
    if (withHealth !== undefined) {
      finalSettings = withHealth;
      await saveSettings(deps.settingsPath, finalSettings);
    }
    const snapshot = await snapshotFrom(deps, finalSettings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * secret-clear: remove a value from the vault. TASK.45 W12: only a
 * connection-scoped key is a valid clear target — a legacy-shaped key is
 * refused `invalid` (nothing ever writes one anymore). Existence of the
 * connection is NOT required (orphans remain removable). Blocked in read_only.
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
  if (isProxyProfileSecretKey(key)) {
    // A proxy password clears with no membership check: an ORPHANED key (its
    // profile already deleted) stays removable, following the connection-key
    // precedent, and that is the only reason this path still exists now that the
    // ordinary clear is `proxy-profile-upsert`'s `{action:"clear"}`.
    //
    // It DOES reset health (design review H-01): clearing a password changes the
    // credential every connection routed through that profile authenticates
    // with, so a `ready` reading taken with the old one is stale. The earlier
    // claim that "the path itself did not move" was measuring the wrong thing —
    // §7 defines staleness over the EFFECTIVE materialised proxy, and the
    // password is part of it.
    return withSettingsFileLock(deps.settingsPath, async () => {
      const loaded = await loadSettings(deps.settingsPath, deps.logger);
      if (loaded.readOnly) {
        return { ok: false, reason: "read_only" };
      }
      await deps.vault.clearSecret(key);
      const profileId = PROXY_PROFILE_SECRET_KEY_RE.exec(key)?.[1] ?? "";
      const draft = structuredClone(loaded.settings);
      const moved = resetHealthForProfileConsumers(draft, profileId, (deps.now ?? defaultNowIso)());
      if (!moved) {
        // Nothing references the profile (the orphan case): leave settings.json
        // untouched rather than rewriting an identical document.
        await deps.refreshProxySecrets?.();
        const snapshot = await snapshotFrom(deps, loaded.settings, false);
        await emitMutation(deps, snapshot);
        return { ok: true, snapshot };
      }
      return persistProxyDraft(deps, draft);
    });
  }
  const connMatch = CONNECTION_SECRET_KEY_RE.exec(key);
  if (connMatch === null) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    await deps.vault.clearSecret(key);
    // TASK.45 W11: a cleared credential resets health to `unchecked` too (cut
    // §W11: "replace/clear key -> unchecked") — never leave a stale
    // auth_invalid/etc. pinned to a now-empty credential slot.
    let finalSettings = loaded.settings;
    const withHealth = withConnectionHealth(loaded.settings, connMatch[1] as string, {
      status: "unchecked",
      at: (deps.now ?? defaultNowIso)(),
    });
    if (withHealth !== undefined) {
      finalSettings = withHealth;
      await saveSettings(deps.settingsPath, finalSettings);
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
  return withSettingsFileLock(deps.settingsPath, async () => {
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
 * binary-trust-grant (TASK.103, D-S4-5): the ONLY writer of
 * `settings.security.trustedBinaries`. The request carries `{path}` ONLY —
 * the fingerprint is computed HERE, main-side, from the live filesystem
 * (`deps.statBinaryForTrust`), never accepted from the renderer. Structural
 * targets (relative path, nonexistent, not a file, not executable, win32)
 * are refused `invalid` before any write — a grant for something that
 * cannot be run would only manufacture a confused state (D-S4-2). Re-
 * granting a path REPLACES its record (upsert, no duplicates) — the exact
 * `handleAddRule` discipline above, applied to a different array.
 */
export async function handleBinaryTrustGrant(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = binaryTrustGrantSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return { ok: false, reason: "invalid" };
  }
  if (!isAbsolute(parsed.data.path)) {
    return { ok: false, reason: "invalid" };
  }
  const statResult = deps.statBinaryForTrust?.(parsed.data.path);
  if (statResult === undefined || !statResult.ok) {
    return { ok: false, reason: "invalid" };
  }
  const { resolvedPath, stat } = statResult;
  // D-S4-14: the grant channel accepts ONLY a canonical path — the record
  // must pin exactly the file the dialog named. A caller handing a symlink
  // (or a path whose resolution moved since the card rendered) is refused;
  // the trustRefusal carrier always names the resolved path, so the UI flow
  // always sends a canonical one.
  if (resolvedPath !== parsed.data.path) {
    return { ok: false, reason: "invalid" };
  }
  if (!stat.isFile || (stat.mode & 0o111) === 0) {
    return { ok: false, reason: "invalid" };
  }
  // D-S4-13 custody layer: never mint a consent for a file owned by a third
  // party — its owner can restore the whole fingerprint (B-2). Root-owned is
  // allowed (outside the threat model, RES-2).
  const selfUid = deps.uid ?? (process.getuid?.() ?? -1);
  if (stat.uid !== selfUid && stat.uid !== 0) {
    return { ok: false, reason: "invalid" };
  }

  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const record: TrustedBinaryConsent = {
      path: resolvedPath,
      fingerprint: { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs },
      grantedAt: deps.now?.() ?? new Date().toISOString(),
    };
    const existing = loaded.settings.security.trustedBinaries ?? [];
    const trustedBinaries = [...existing.filter((c) => c.path !== record.path), record];
    const settings: AnycodeSettings = {
      ...loaded.settings,
      security: { ...loaded.settings.security, trustedBinaries },
    };
    if (!settingsSchema.safeParse(settings).success) {
      return { ok: false, reason: "invalid" };
    }
    await saveSettings(deps.settingsPath, settings);
    const snapshot = await snapshotFrom(deps, settings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/**
 * binary-trust-revoke (TASK.103): removes exactly the named path's consent
 * record. Idempotent — an unknown path is a no-op success with a fresh
 * snapshot (D-S4-7).
 */
export async function handleBinaryTrustRevoke(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = binaryTrustRevokeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = loaded.settings.security.trustedBinaries ?? [];
    const trustedBinaries = existing.filter((c) => c.path !== parsed.data.path);
    const settings: AnycodeSettings = {
      ...loaded.settings,
      security: { ...loaded.settings.security, trustedBinaries },
    };
    await saveSettings(deps.settingsPath, settings);
    const snapshot = await snapshotFrom(deps, settings, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
}

/** Resolution outcome of `handleOAuthStart`'s lock-held prep step (§1, W12-FIX). */
type OAuthStartPrep =
  | { readOnly: true }
  | { readOnly: false; refused: true }
  | { readOnly: false; refused: false; connectionId: string; allowWeak: boolean };

/**
 * oauth-start: run the interactive loopback+PKCE sign-in for a catalog provider
 * (design §3.2/§4.1). Refuses `unsupported` when the provider is not oauth (no
 * config / no engine), `read_only` for a newer settings file, else runs the flow
 * and — on success — returns a fresh snapshot (the provider's SecretStatus now

 * the vault by the engine and only the SecretStatus changes.
 *
 * TASK.45 W12-FIX §1: `connectionId` (additive, optional) scopes the sign-in
 * to ONE connection — a connection-scoped surface (tile, drawer) must persist
 * the token to the EXACT connection the user clicked, never a provider-bucket
 * guess that could silently land on a different same-provider connection's
 * custody. Present: resolved by exact id (not-found or a different provider
 * bucket both refuse `failed`, zero side effects — the engine is never
 * called, nothing minted/activated). Absent: the pre-existing
 * findOrCreateConnectionByProvider/bucket semantics, unchanged.
 *
 * Support-precedence (TASK.45 W12-FIX2 §4): `unsupported` (the provider's
 * catalog auth kind is not oauth) is checked BEFORE `connectionId` is
 * resolved and dominates it — both are fail-closed, so a non-oauth
 * `providerId` refuses `unsupported` even when `connectionId` is bogus too.
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
  const targetConnectionId = parsed.data.connectionId;
  // Resolve the target connection under the mutation lock (§2.2): the engine
  // persists the token blob by CONNECTION id, so a connection must exist first
  // (metadata-first, created + activated when the provider has none yet). ONLY
  // this metadata section is serialized — the interactive flow (minutes of
  // browser login) runs OUTSIDE the lock so it never freezes settings IPC.
  const prep: OAuthStartPrep = await withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { readOnly: true as const };
    }
    if (targetConnectionId !== undefined) {
      const connection = loaded.settings.provider.connections.find((c) => c.id === targetConnectionId);
      if (connection === undefined || !inSameProviderBucket(connection.providerId, parsed.data.providerId)) {
        return { readOnly: false as const, refused: true as const };
      }
      return {
        readOnly: false as const,
        refused: false as const,
        connectionId: connection.id,
        allowWeak: loaded.settings.security.allowWeakSecretStorage,
      };
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
    return {
      readOnly: false as const,
      refused: false as const,
      connectionId,
      allowWeak: settings.security.allowWeakSecretStorage,
    };
  });
  if (prep.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  if (prep.refused) {
    return { ok: false, reason: "failed" };
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
 * are silent no-ops for the CALLER's state, but distinguishable via the return
 * value (`false`) so a caller can gate a push signal on an actual write.
 * Acquires the settings lock itself — callers that already hold it
 * (handleSetSecret/handleClearSecret/handleConnectionUpdate) must use
 * `withConnectionHealth` directly instead, or this would deadlock.
 */
export async function applyConnectionHealthEvent(
  deps: SettingsIpcDeps,
  connectionId: string,
  event: { kind: "success" } | { kind: "failure"; code: string },
): Promise<boolean> {
  const status: ProviderHealthStatus =
    event.kind === "success" ? "ready" : mapProviderFailureCodeToHealthStatus(event.code);
  const lastHealth = {
    status,
    at: (deps.now ?? defaultNowIso)(),
    ...(event.kind === "failure" ? { safeCode: event.code } : {}),
  };
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return false;
    }
    const updated = withConnectionHealth(loaded.settings, connectionId, lastHealth);
    if (updated === undefined) {
      return false;
    }
    await saveSettings(deps.settingsPath, updated);
    return true;
  });
}

// ── connection CRUD handlers (TASK.45 W9, main-authoritative) ──

/**
 * The ONE durable commit point for a provider-settings mutation (W11-FIX3):
 * everything after this resolves is announce-only (snapshot projection +
 * onMutation broadcast), never a condition for whether the write "happened".
 * Callers that hold compensating state keyed on durability (e.g.
 * `handleConnectionDelete`'s oauth tombstone) must treat THIS resolving —
 * not the composite `persistProvider` below — as the commit signal.
 */
async function saveProviderSettings(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
  provider: ProviderSettingsV2,
): Promise<AnycodeSettings> {
  const updated: AnycodeSettings = { ...settings, provider };
  await saveSettings(deps.settingsPath, updated);
  return updated;
}

/** Persists a new provider settings block, then returns a fresh snapshot + fires onMutation. */
async function persistProvider(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
  provider: ProviderSettingsV2,
): Promise<SettingsMutationResult> {
  const updated = await saveProviderSettings(deps, settings, provider);
  const snapshot = await snapshotFrom(deps, updated, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/** Same as `persistProvider`, plus the authoritative minted id (TASK.45 W12-FIX2 §1, connection-create only). */
async function persistProviderWithCreatedId(
  deps: SettingsIpcDeps,
  settings: AnycodeSettings,
  provider: ProviderSettingsV2,
  createdConnectionId: string,
): Promise<SettingsMutationResult> {
  const result = await persistProvider(deps, settings, provider);
  return result.ok ? { ...result, createdConnectionId } : result;
}

/**
 * connection-create: mint a new connection. `providerId` must be a catalog entry
 * (trust boundary). `setActive` — or being the first connection — makes it the
 * default for new sessions. Read-only settings refuse. The success arm carries
 * `createdConnectionId` (TASK.45 W12-FIX2 §1) — the authoritative minted id, so
 * a caller never has to diff the snapshot to guess which entry is new.
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
  // The legacy-import action is REFUSED on create (design review B-05, made
  // explicit rather than left to fall out of the membership check below): a
  // connection being minted has no legacy string to convert, so a caller sending
  // it is confused about what it is asking for, and answering "invalid" is the
  // only honest reply. Checked before the file lock — it is a payload fact.
  if (req.proxyRef === PROXY_REF_LEGACY) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    // Registry membership at the trust boundary (TASK.141): only `direct` or an
    // id that exists in THIS document may be seated on a new connection.
    if (
      req.proxyRef !== undefined &&
      req.proxyRef !== PROXY_REF_DIRECT &&
      findProxyProfile(loaded.settings, req.proxyRef) === undefined
    ) {
      return { ok: false, reason: "invalid" };
    }
    const id = (deps.genConnectionId ?? defaultConnectionId)();
    const connection: ProviderConnection = {
      id,
      providerId: req.providerId,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.transport !== undefined ? { transport: req.transport } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.proxyUrl !== undefined ? { proxyUrl: req.proxyUrl } : {}),
      ...(req.proxyRef !== undefined ? { proxyRef: req.proxyRef } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.authOptional === true ? { authOptional: true } : {}),
    };
    const shouldActivate = req.setActive === true || loaded.settings.provider.activeConnectionId === undefined;
    const activeConnectionId = shouldActivate ? id : loaded.settings.provider.activeConnectionId;
    // Spread the loaded provider block (FX3-L1 G-C): rebuilding it from named
    // fields would silently drop every sibling field (`custom[]`, and anything
    // a future version adds) from the persisted file on every create.
    const provider: ProviderSettingsV2 = {
      ...loaded.settings.provider,
      connections: [...loaded.settings.provider.connections, connection],
      ...(activeConnectionId !== undefined ? { activeConnectionId } : {}),
    };
    return persistProviderWithCreatedId(deps, loaded.settings, provider, id);
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
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = loaded.settings.provider.connections.find((connection) => connection.id === req.id);
    if (existing === undefined) {
      return { ok: false, reason: "not_found" };
    }
    // W12-FIX §3: `""` is the clear-to-default sentinel (mirrors the existing
    // baseUrl/model `""`-convention on this same channel) — normalize BEFORE
    // comparing/persisting so `""` never lands on disk as a value.
    const normalizedTransport = req.transport === "" ? undefined : req.transport;
    // TASK.132: same `""`-sentinel normalization as `transport`, for the same
    // reason — `""` never lands on disk as a value.
    const normalizedProxyUrl = req.proxyUrl === "" ? undefined : req.proxyUrl;
    // TASK.141: the ref request is resolved BEFORE the connection is rebuilt,
    // because a `"legacy"` conversion writes into the REGISTRY section and the
    // resulting id is what the connection then references. `draft` is a shallow
    // copy — `importLegacyProxy` assigns a fresh `network` object onto it, so
    // `loaded.settings` stays the untouched "before" the health diff compares
    // against. `undefined` = the field was not sent; `null` = clear it.
    const draft: AnycodeSettings = { ...loaded.settings };
    let normalizedProxyRef: string | null | undefined;
    let importedPassword: string | undefined;
    if (req.proxyRef !== undefined) {
      if (req.proxyRef === "") {
        normalizedProxyRef = null;
      } else if (req.proxyRef === PROXY_REF_LEGACY) {
        const imported =
          existing.proxyUrl === undefined
            ? undefined
            : await importLegacyProxy(draft, existing.proxyUrl, legacyImportDeps(deps));
        if (imported === undefined) {
          return { ok: false, reason: "invalid" };
        }
        normalizedProxyRef = imported.profileId;
        importedPassword = imported.password;
      } else if (req.proxyRef !== PROXY_REF_DIRECT && findProxyProfile(draft, req.proxyRef) === undefined) {
        return { ok: false, reason: "invalid" };
      } else {
        normalizedProxyRef = req.proxyRef;
      }
    }
    // TASK.45 §3 (Фаза 3): editing a significant ENDPOINT field invalidates the
    // last observed health — a health status confirmed against the OLD
    // model/transport/baseUrl must not linger under the new one. A label-only
    // edit (or a no-op resend of the same value) leaves health untouched.
    // A proxy edit joins that set (TASK.132): it changes the NETWORK PATH the
    // request takes, so health observed through the old path is just as stale
    // as health observed against the old transport.
    const endpointChanged =
      (req.model !== undefined && req.model !== existing.model) ||
      (req.transport !== undefined && normalizedTransport !== existing.transport) ||
      (req.baseUrl !== undefined && req.baseUrl !== existing.baseUrl) ||
      (req.proxyUrl !== undefined && normalizedProxyUrl !== existing.proxyUrl) ||
      // A ref change moves the network path exactly the way a `proxyUrl` change
      // does — including a change to `direct`, which is a path, not an absence.
      (normalizedProxyRef !== undefined && normalizedProxyRef !== (existing.proxyRef ?? null));
    // A baseUrl change re-points the connection at a DIFFERENT endpoint, so a
    // live-fetched model list from the old one must not linger (same staleness
    // rationale as the lastHealth reset, scoped to baseUrl only — a model/
    // transport edit doesn't change which endpoint serves `/models`).
    // Normalized comparison: `""` and absent both mean "catalog default".
    const baseUrlChanged =
      req.baseUrl !== undefined && req.baseUrl.trim() !== (existing.baseUrl ?? "").trim();
    const updatedConnection: ProviderConnection = {
      ...existing,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(endpointChanged
        ? { lastHealth: { status: "unchecked" as const, at: (deps.now ?? defaultNowIso)() } }
        : {}),
    };
    // Transport clear (`""`) must remove the key entirely, not merely spread
    // `undefined` over it — `normalizedTransport === undefined` here can mean
    // EITHER "not sent" (leave `existing.transport` alone, already carried by
    // the spread above) OR "sent as `""`" (must delete it), so this needs an
    // explicit branch rather than a spread.
    if (req.transport !== undefined) {
      if (normalizedTransport === undefined) {
        delete updatedConnection.transport;
      } else {
        updatedConnection.transport = normalizedTransport;
      }
    }
    // Only-truthy-on-disk (mirrors transport's clear branch): `false` deletes
    // the key rather than persisting a literal `false`.
    if (req.authOptional !== undefined) {
      if (req.authOptional) {
        updatedConnection.authOptional = true;
      } else {
        delete updatedConnection.authOptional;
      }
    }
    // Output-token ceiling (TASK.150): identical shape to the transport clear
    // branch — `""` means "back to the catalog hint / core default", and that
    // has to DELETE the key, not spread `undefined` over it. Health is
    // deliberately NOT invalidated: a ceiling is not an endpoint identity, so a
    // `ready` observed a minute ago stays true.
    if (req.maxOutputTokens !== undefined) {
      if (req.maxOutputTokens === "") {
        delete updatedConnection.maxOutputTokens;
      } else {
        updatedConnection.maxOutputTokens = req.maxOutputTokens;
      }
    }
    // Proxy clear (`""`) must remove the key entirely (TASK.132) — identical
    // shape and rationale to the transport branch above: `normalizedProxyUrl
    // === undefined` means EITHER "not sent" or "sent as `""`", so the two
    // cases need an explicit branch, not a spread.
    if (req.proxyUrl !== undefined) {
      if (normalizedProxyUrl === undefined) {
        delete updatedConnection.proxyUrl;
      } else {
        updatedConnection.proxyUrl = normalizedProxyUrl;
      }
    }
    // Proxy REF write (TASK.141). Applied AFTER the `proxyUrl` branch above and
    // deleting that key unconditionally: the ref outranks the legacy string on
    // the same scope, and a dead string left behind would resurrect the old
    // proxy the moment the ref is cleared.
    if (normalizedProxyRef !== undefined) {
      delete updatedConnection.proxyUrl;
      if (normalizedProxyRef === null) {
        delete updatedConnection.proxyRef;
      } else {
        updatedConnection.proxyRef = normalizedProxyRef;
      }
    }
    if (baseUrlChanged) {
      delete updatedConnection.models;
      delete updatedConnection.modelsFetchedAt;
    }
    const provider: ProviderSettingsV2 = {
      ...draft.provider,
      connections: draft.provider.connections.map((connection) =>
        connection.id === req.id ? updatedConnection : connection,
      ),
    };
    // `draft`, not `loaded.settings`: a `"legacy"` conversion put the new profile
    // in `draft.network`, and persisting the pre-import document would save a
    // connection referencing a profile that was never written.
    if (importedPassword === undefined || typeof normalizedProxyRef !== "string") {
      return persistProvider(deps, draft, provider);
    }
    // The two-file ordering of a legacy import (design review B-08), identical
    // to the ref-set handler's:
    //  1. secrets.json FIRST. A weak-storage refusal has to land while nothing
    //     is persisted anywhere — persisting the profile and failing the
    //     password would leave a profile that silently authenticates against
    //     nothing;
    //  2. settings.json second, and if that write fails, the just-written key is
    //     removed again. `created: true` guarantees the id was minted in this
    //     call, so the compensation cannot destroy a credential that existed
    //     before it (a DEDUPED import never carries a password at all — the
    //     match already proved the stored one is identical).
    return persistWithImportedPassword(deps, proxyProfileSecretKey(normalizedProxyRef), importedPassword, {
      allowWeak: loaded.settings.security.allowWeakSecretStorage,
      save: () => saveProviderSettings(deps, draft, provider),
    });
  });
}

/** connection-set-active: make a connection the default for NEW sessions (session-pinning is W10). */
export async function handleConnectionSetActive(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = connectionIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
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
  return withSettingsFileLock(deps.settingsPath, async () => {
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
      // W12-FIX §2: deleting the ACTIVE connection promotes a deterministic
      // successor — the first remaining connection in array order — rather
      // than leaving `activeConnectionId` undefined with connections still
      // present (a state only a Welcome-embed dead-end and a manual
      // settings.json edit could ever recover from). Deleting a non-active
      // connection, or the last connection, is unchanged.
      const activeConnectionId =
        loaded.settings.provider.activeConnectionId === id
          ? remaining[0]?.id
          : loaded.settings.provider.activeConnectionId;
      // Spread the loaded provider block (FX3-L1 G-C): rebuilding it from
      // named fields would silently drop `custom[]` (orphaning its vault
      // secrets) from the persisted file on every delete. When the LAST
      // connection is removed the stale spread-carried activeConnectionId
      // must be deleted explicitly — the conditional spread alone cannot
      // remove a key the base spread already put there.
      const provider: ProviderSettingsV2 = {
        ...loaded.settings.provider,
        connections: remaining,
        ...(activeConnectionId !== undefined ? { activeConnectionId } : {}),
      };
      if (activeConnectionId === undefined) {
        delete provider.activeConnectionId;
      }
      // W11-FIX3: the tombstone's commit signal is the durable save resolving,
      // NOT the composite persistProvider resolving. A post-save throw below
      // (snapshot/emit) must NOT revert the tombstone — the metadata is
      // already gone from disk, so reverting here would strand an OAuth blob
      // in the vault under the just-deleted id (reopens fix #2's own DoD).
      const updated = await saveProviderSettings(deps, loaded.settings, provider);
      committed = true;
      const snapshot = await snapshotFrom(deps, updated, false);
      await emitMutation(deps, snapshot);
      return { ok: true, snapshot };
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

// ── proxy registry (TASK.141) ──

/**
 * The vault-reading half of the legacy import (design review B-08), bound to
 * this deps bag. The import compares the FULL credential — normalised url +
 * login + DECRYPTED password — and only main can read the third part.
 */
function legacyImportDeps(deps: SettingsIpcDeps): LegacyProxyImportDeps {
  return {
    readPassword: (profileId) => deps.vault.probeSecret(proxyProfileSecretKey(profileId)),
    ...(deps.genProxyProfileId !== undefined ? { genId: deps.genProxyProfileId } : {}),
  };
}

/**
 * The two-file commit of a legacy import: secrets.json, then settings.json, with
 * a compensation on the settings write (design review B-08).
 *
 * ORDER: the vault goes first because its refusal is the RECOVERABLE one — a
 * weak-storage-without-consent answer must land while nothing has been written
 * anywhere, so the user sees "grant consent or cancel" rather than a profile
 * that exists and silently authenticates against nothing.
 *
 * COMPENSATION: if the settings write then fails, the just-written key is
 * removed. That is safe precisely because a compensated import always MINTED its
 * profile id in this same call (a deduped import carries no password at all, by
 * construction — the match already proved the stored password is identical), so
 * the clear can only ever remove a secret that had no reader yet.
 *
 * The compensation wraps the DISK WRITE alone, not the snapshot/broadcast that
 * follows: once settings.json holds the profile, the password must stay, and a
 * failure to project or broadcast is an app-level error, not a reason to strip a
 * credential off a persisted profile.
 */
async function persistWithImportedPassword(
  deps: SettingsIpcDeps,
  key: SecretKey,
  password: string,
  opts: { allowWeak: boolean; save: () => Promise<AnycodeSettings> },
): Promise<SettingsMutationResult> {
  const stored = await deps.vault.setSecret(key, password, { allowWeak: opts.allowWeak });
  if (!stored.ok) {
    return { ok: false, reason: stored.reason };
  }
  let saved: AnycodeSettings;
  try {
    saved = await opts.save();
  } catch (error) {
    await deps.vault.clearSecret(key).catch(() => undefined);
    throw error;
  }
  await deps.refreshProxySecrets?.();
  const snapshot = await snapshotFrom(deps, saved, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/**
 * Resets `lastHealth` on every connection whose EFFECTIVE proxy rung IS
 * `profileId` (design review H-01). Returns true when it changed anything.
 *
 * The sibling of `resetHealthForMovedProxyPaths` for the one mutation that
 * moves the network path WITHOUT changing the persisted document: a password
 * set/clear. `proxyPathFingerprint` deliberately excludes the password (it is
 * not in the document at all), so the fingerprint diff cannot see this and the
 * consumer walk has to.
 *
 * "Effectively using" is read through each connection's OWN ladder, so a
 * connection that merely INHERITS the app default is reset too — its traffic
 * goes through that profile just as much as a connection that names it.
 */
function resetHealthForProfileConsumers(draft: AnycodeSettings, profileId: string, at: string): boolean {
  let changed = false;
  for (const connection of draft.provider.connections) {
    if (resolveProxyLadder(draft, hostForkProxyChain(connection.id))?.ref === profileId) {
      connection.lastHealth = { status: "unchecked", at };
      changed = true;
    }
  }
  return changed;
}

/**
 * Resets `lastHealth` to `unchecked` on every connection whose EFFECTIVE proxy
 * path moved between `before` and the draft (TASK.141 §7) — the direct
 * continuation of TASK.132's "the path changed ⇒ the health reading is stale".
 *
 * Fingerprinted per connection over ITS OWN ladder (connection rung, then app),
 * so editing the profile an app default points at also stales every connection
 * that INHERITS that default, while a rename — which changes no path — stales
 * nothing. Engine `lastCheck` is deliberately untouched: it records disk facts
 * (binary found, version, signed-in), and no proxy change can stale those
 * (TASK.139 §4).
 */
function resetHealthForMovedProxyPaths(before: AnycodeSettings, draft: AnycodeSettings, at: string): void {
  for (const connection of draft.provider.connections) {
    const chain = hostForkProxyChain(connection.id);
    if (proxyPathFingerprint(before, chain) !== proxyPathFingerprint(draft, chain)) {
      connection.lastHealth = { status: "unchecked", at };
    }
  }
}

/**
 * Commits a proxy-mutated draft: persist, refresh the password cache, project,
 * broadcast.
 *
 * The refresh sits BETWEEN the disk write and the broadcast (design review
 * H-01): the sync materialisation call sites read that cache, and a mutation
 * event that reached the renderer first would let the next spawn race the
 * refresh and go out on the superseded credential.
 */
async function persistProxyDraft(deps: SettingsIpcDeps, draft: AnycodeSettings): Promise<SettingsMutationResult> {
  await saveSettings(deps.settingsPath, draft);
  await deps.refreshProxySecrets?.();
  const snapshot = await snapshotFrom(deps, draft, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/**
 * proxy-profile-upsert: create a profile (no `id` — main mints one and returns
 * it as `createdProxyProfileId`) or edit/rename an existing one.
 *
 * Names are unique case-insensitively because they are the ONLY thing the
 * pickers show — two profiles called "Corp" make the dropdown a coin flip. The
 * id is never derived from the name, so a rename is a pure display change: the
 * vault key and every scope's ref keep pointing at the same profile, which is
 * exactly why a rename cannot lose the password.
 *
 * `url` is dropped for a `system` profile rather than refused: the mode decides
 * where the path comes from, and a leftover host/port from a mode switch in the
 * editor is stale data, not user intent.
 *
 * The PASSWORD is part of this one mutation (design review H-01), not a separate
 * `secret-set` round trip. Two calls meant a window in which the persisted
 * configuration was a mix of the new login and the old password — a spawn in
 * that window authenticates with a pair that never existed — and it meant the
 * password half invalidated nobody's health. Here, a `set`/`clear` stales every
 * connection that authenticates through this profile, and the plaintext cache is
 * refreshed before the mutation event so the next spawn already has the new
 * value (`persistProxyDraft`).
 *
 * The vault write happens BEFORE the settings write, and is compensated if the
 * settings write fails, for the ordering reasons spelled out in
 * `persistWithImportedPassword`; here the compensation restores the PREVIOUS
 * password rather than clearing, since an edit may be overwriting a credential
 * that other scopes are already using.
 */
export async function handleProxyProfileUpsert(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = proxyProfileUpsertSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const req = parsed.data;
  const name = req.name.trim();
  if (name === "") {
    return { ok: false, reason: "invalid" };
  }
  const password = req.password ?? { action: "keep" as const };
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const existing = req.id === undefined ? undefined : findProxyProfile(loaded.settings, req.id);
    if (req.id !== undefined && existing === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const clash = proxyProfiles(loaded.settings).some(
      (profile) => profile.id !== req.id && profile.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      return { ok: false, reason: "invalid" };
    }
    const id = req.id ?? (deps.genProxyProfileId ?? defaultProxyProfileId)();
    // A `system` profile stores NO url at all (design review B-06); a `manual`
    // one has already been validated against `isProxyProfileUrl` by the schema,
    // and is re-checked after trimming so padding cannot smuggle a value past it.
    const url = req.mode === "manual" ? req.url.trim() : "";
    if (req.mode === "manual" && !isProxyProfileUrl(url)) {
      return { ok: false, reason: "invalid" };
    }
    const noProxy = req.noProxy?.trim() ?? "";
    const login = req.login?.trim() ?? "";
    // Only-truthy-on-disk, the discipline every optional settings field here
    // follows: an emptied editor field removes the key instead of persisting "".
    const profile: ProxyProfile = {
      id,
      name,
      mode: req.mode,
      ...(url !== "" ? { url } : {}),
      ...(noProxy !== "" ? { noProxy } : {}),
      ...(login !== "" ? { login } : {}),
    };
    const draft = structuredClone(loaded.settings);
    const registry = proxyProfiles(draft);
    draft.network = {
      ...draft.network,
      proxyProfiles:
        existing === undefined
          ? [...registry, profile]
          : registry.map((entry) => (entry.id === id ? profile : entry)),
    };
    const at = (deps.now ?? defaultNowIso)();
    resetHealthForMovedProxyPaths(loaded.settings, draft, at);
    if (password.action !== "keep") {
      // The credential this profile's consumers authenticate with is changing,
      // which stales every health reading taken through it — including the
      // connections that only INHERIT this profile from the app default.
      resetHealthForProfileConsumers(draft, id, at);
    }
    const key = proxyProfileSecretKey(id);
    const previous = password.action === "keep" ? undefined : await deps.vault.probeSecret(key);
    if (password.action === "set") {
      const stored = await deps.vault.setSecret(key, password.value, {
        allowWeak: loaded.settings.security.allowWeakSecretStorage,
      });
      if (!stored.ok) {
        return { ok: false, reason: stored.reason };
      }
    } else if (password.action === "clear") {
      await deps.vault.clearSecret(key);
    }
    let result: SettingsMutationResult;
    try {
      result = await persistProxyDraft(deps, draft);
    } catch (error) {
      await restoreProxyPassword(deps, key, previous);
      throw error;
    }
    return result.ok && existing === undefined ? { ...result, createdProxyProfileId: id } : result;
  });
}

/**
 * Puts a profile's password back the way it was, after a settings write failed
 * between the vault mutation and the persisted document (design review H-01).
 *
 * `unreadable` is the one state that cannot be restored — the previous bytes
 * were already undecryptable, so re-encrypting them is impossible and there is
 * nothing to put back that any consumer could have used. It is left as-is
 * (the new value stands) rather than cleared, because clearing would destroy the
 * user's only chance to recover it by re-entering the same key material.
 */
async function restoreProxyPassword(
  deps: SettingsIpcDeps,
  key: SecretKey,
  previous: ProxyPasswordProbe | undefined,
): Promise<void> {
  if (previous === undefined || previous.state === "unreadable") {
    return;
  }
  try {
    if (previous.state === "unset") {
      await deps.vault.clearSecret(key);
    } else {
      await deps.vault.setSecret(key, previous.value, { allowWeak: true });
    }
  } catch {
    // A failed compensation must not mask the original failure being rethrown.
  }
}

/**
 * proxy-profile-delete: remove a profile and its vault password.
 *
 * REFUSED while any scope still references it, with the consumers named. The
 * alternative — silently detaching the refs — would re-route scopes the user is
 * not looking at, and the worst outcome of that is traffic leaving the corporate
 * proxy: a leak class, not an inconvenience. The product already takes this
 * shape elsewhere (a connection pinned to a live session refuses deletion too).
 *
 * A clean delete clears the vault entry FIRST, then the metadata — the
 * connection-delete ordering and for the same reason: a crash between the two
 * leaves a visible profile with no password, never an orphan secret nothing can
 * ever reach again.
 */
export async function handleProxyProfileDelete(deps: SettingsIpcDeps, raw: unknown): Promise<ProxyProfileDeleteResult> {
  const parsed = proxyProfileDeleteSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const id = parsed.data.id;
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    if (findProxyProfile(loaded.settings, id) === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const consumers = proxyProfileConsumers(loaded.settings, id);
    if (consumers.length > 0) {
      return { ok: false, reason: "in_use", consumers };
    }
    await deps.vault.clearSecret(proxyProfileSecretKey(id));
    const draft = structuredClone(loaded.settings);
    const remaining = proxyProfiles(draft).filter((profile) => profile.id !== id);
    draft.network = { ...draft.network, proxyProfiles: remaining };
    if (remaining.length === 0) {
      delete draft.network.proxyProfiles;
    }
    if (Object.keys(draft.network).length === 0) {
      delete draft.network;
    }
    const result = await persistProxyDraft(deps, draft);
    return result.ok ? { ok: true, snapshot: result.snapshot } : { ok: false, reason: "invalid" };
  });
}

/**
 * proxy-ref-set: point the APP or an ENGINE scope at a profile / at `direct` /
 * back at "inherit".
 *
 * A CONNECTION scope is refused here by design: its ref rides
 * `connection-create`/`connection-update`, so a new connection saves its proxy
 * choice atomically with itself instead of through a two-phase "create it, then
 * attach the proxy" dance that can be interrupted halfway.
 *
 * `PROXY_REF_LEGACY` is the conversion request: "keep what this scope's legacy
 * `proxyUrl` says, as a real profile". It runs the ONE shared `importLegacyProxy`
 * (deduped by URL + login), so the same corporate string on three scopes
 * converges on one profile instead of minting three twins.
 */
export async function handleProxyRefSet(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = proxyRefSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { scope, ref } = parsed.data;
  if (scope.kind === "connection") {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    const draft = structuredClone(loaded.settings);
    const binding = PROXY_SCOPE_BINDINGS[scope.kind];
    let effective: string | null = ref;
    let password: string | undefined;
    if (ref === PROXY_REF_LEGACY) {
      const legacyUrl = binding.read(draft, scope).legacyUrl;
      const imported =
        legacyUrl === undefined ? undefined : await importLegacyProxy(draft, legacyUrl, legacyImportDeps(deps));
      if (imported === undefined) {
        return { ok: false, reason: "invalid" };
      }
      effective = imported.profileId;
      password = imported.password;
    } else if (ref !== null && ref !== PROXY_REF_DIRECT && findProxyProfile(draft, ref) === undefined) {
      return { ok: false, reason: "invalid" };
    }
    binding.write(draft, scope, effective);
    resetHealthForMovedProxyPaths(loaded.settings, draft, (deps.now ?? defaultNowIso)());
    if (password === undefined || effective === null) {
      return persistProxyDraft(deps, draft);
    }
    // The two-file ordering + compensation of an import (design review B-08) —
    // one implementation shared with `connection-update`.
    return persistWithImportedPassword(deps, proxyProfileSecretKey(effective), password, {
      allowWeak: draft.security.allowWeakSecretStorage,
      save: async () => {
        await saveSettings(deps.settingsPath, draft);
        return draft;
      },
    });
  });
}

/**
 * recognizer-set (TASK.198): the ONLY writer of `settings.recognizer`, and
 * the ONLY way to turn the vision-fallback recognizer OFF. A separate channel
 * from `settings-set` for the reason `shared/recognizer.ts`'s docstring on
 * `RECOGNIZER_SET_CHANNEL` spells out: `settings/schema.ts`'s `deepMerge`
 * skips every `undefined` patch value (`if (value === undefined) continue;`),
 * so the generic path can only ever ADD or REPLACE `recognizer`, never delete
 * it — `recognizer: null` here is the explicit delete this handler alone
 * accepts.
 *
 * A `{connectionId, modelId}` pair is checked against the LIVE connection
 * graph before it is persisted (same membership discipline as
 * `handleProxyRefSet`'s `findProxyProfile` check): a dangling `connectionId`
 * would resolve as "fallback disabled" at every consumer
 * (`resolveRecognizerConfig`) with no visible signal to the user, so it is
 * refused here instead of saved silently-broken. A blank/whitespace `modelId`
 * is refused for the same reason — host/index.ts's `parseRecognizerEnv`
 * already treats an empty-after-trim model as "fallback disabled"
 * (`if (model === undefined || model.trim() === "") return null;`), so saving
 * one here would let this layer and that layer disagree about what "set"
 * means.
 *
 * Deliberately does NOT re-check the connection's auth kind (oauth): that
 * refusal belongs to `resolveRecognizerConfig` alone (main/host-env.ts), which
 * already fails closed on an oauth connection — a third copy of that rule
 * here would be the first of the three to drift.
 *
 * Saves via the same plain load -> mutate -> save -> snapshot -> emit shape
 * `handleAddRule`/`handleBinaryTrustGrant` use, not `persistProxyDraft`:
 * that helper's only work beyond the save is `deps.refreshProxySecrets?.()`,
 * which refreshes main's in-memory PROXY password cache — meaningless for a
 * recognizer mutation, so reusing it here would be borrowing a side effect
 * that has nothing to do with this field.
 */
export async function handleRecognizerSet(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = recognizerSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { recognizer } = parsed.data;
  if (recognizer !== null && recognizer.modelId.trim() === "") {
    return { ok: false, reason: "invalid" };
  }
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return { ok: false, reason: "read_only" };
    }
    if (recognizer !== null && connectionById(loaded.settings, recognizer.connectionId) === undefined) {
      return { ok: false, reason: "invalid" };
    }
    const draft = structuredClone(loaded.settings);
    if (recognizer === null) {
      delete draft.recognizer;
    } else {
      draft.recognizer = recognizer;
    }
    await saveSettings(deps.settingsPath, draft);
    const snapshot = await snapshotFrom(deps, draft, false);
    await emitMutation(deps, snapshot);
    return { ok: true, snapshot };
  });
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
  ipcMain.handle(BINARY_TRUST_GRANT_CHANNEL, (_event, raw: unknown) => handleBinaryTrustGrant(deps, raw));
  ipcMain.handle(BINARY_TRUST_REVOKE_CHANNEL, (_event, raw: unknown) => handleBinaryTrustRevoke(deps, raw));
  ipcMain.handle(OAUTH_START_CHANNEL, (_event, raw: unknown) => handleOAuthStart(deps, raw));
  ipcMain.handle(OAUTH_CANCEL_CHANNEL, (_event, raw: unknown) => handleOAuthCancel(deps, raw));
  // Connection CRUD (TASK.45 W9): main-authoritative, additive channels.
  ipcMain.handle(CONNECTION_CREATE_CHANNEL, (_event, raw: unknown) => handleConnectionCreate(deps, raw));
  ipcMain.handle(CONNECTION_UPDATE_CHANNEL, (_event, raw: unknown) => handleConnectionUpdate(deps, raw));
  ipcMain.handle(CONNECTION_SET_ACTIVE_CHANNEL, (_event, raw: unknown) => handleConnectionSetActive(deps, raw));
  ipcMain.handle(CONNECTION_DELETE_CHANNEL, (_event, raw: unknown) => handleConnectionDelete(deps, raw));
  ipcMain.handle(CONNECTION_CHECK_CHANNEL, (_event, raw: unknown) => handleConnectionCheck(deps, raw));
  // Engine-level proxy (TASK.139): main-authoritative, additive — the only write
  // path the engine panes' proxy field may use.
  // Proxy registry (TASK.141): the profile CRUD + the scope-ref write. The
  // CHECK channel is not here — it spawns a probe child and lives in
  // main/network-ipc.ts, which has no business inside the settings lock.
  ipcMain.handle(PROXY_PROFILE_UPSERT_CHANNEL, (_event, raw: unknown) => handleProxyProfileUpsert(deps, raw));
  ipcMain.handle(PROXY_PROFILE_DELETE_CHANNEL, (_event, raw: unknown) => handleProxyProfileDelete(deps, raw));
  ipcMain.handle(PROXY_REF_SET_CHANNEL, (_event, raw: unknown) => handleProxyRefSet(deps, raw));
  // TASK.198: the vision-fallback recognizer's dedicated write channel — the
  // only path that can DELETE `settings.recognizer` (see handleRecognizerSet).
  ipcMain.handle(RECOGNIZER_SET_CHANNEL, (_event, raw: unknown) => handleRecognizerSet(deps, raw));
}

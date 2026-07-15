/**
 * Control-plane contract for the settings + secret-vault invoke-API between main
 * and the renderer (design/slice-2.2-cut.md §3, frozen by task 2.2.1 per
 * reviews/slice-2.2-forks-ruling.md §4). The renderer drives settings/secrets via
 * `ipcRenderer.invoke` (exposed through the contextBridge `anycode.settings`
 * object in preload/index.ts); main answers with `ipcMain.handle` (2.2.2).
 *
 * VALUE-ONLY module with ZERO imports, by the exact precedent of shared/tabs.ts

 * (sandboxed CJS), the renderer web bundle, AND main, so it must never drag zod
 * or the @anycode/core barrel into a bundle that cannot afford it. The zod
 * schema that validates the settings shape lives in settings/schema.ts and the
 * request-payload validation in main/settings-ipc.ts (2.2.2), NOT here — the
 * same reasoning that keeps runtime schemas out of shared/protocol.ts's type
 * surface.
 *
 * CUSTODY INVARIANT (design §1): a decrypted secret VALUE is never carried back
 * across this API. `secret-set` is the only channel a plaintext value ever
 * crosses (renderer -> main); every response — including `settings-get` — is a
 * SettingsSnapshot whose `secrets` are `SecretStatus` (set/source/tier only).
 */

// ── invoke channels (5 — frozen; named consistently with shared/tabs.ts) ──

/** invoke channel: read the full SettingsSnapshot. */
export const SETTINGS_GET_CHANNEL = "anycode:settings-get";

/** invoke channel: deep-partial merge into settings.json. */
export const SETTINGS_SET_CHANNEL = "anycode:settings-set";

/** invoke channel: store a secret value in the vault ({key, value}). */
export const SECRET_SET_CHANNEL = "anycode:secret-set";

/** invoke channel: remove a secret from the vault ({key}). */
export const SECRET_CLEAR_CHANNEL = "anycode:secret-clear";

/** invoke channel: dedup-append an always-allow rule ({toolName, pattern?}). */
export const PERMISSION_RULE_ADD_CHANNEL = "anycode:permission-rule-add";

// ── OAuth invoke channels (slice 2.5 §4.1; wired to main's OAuth engine in 2.5.2) ──

/**
 * invoke channel: begin an interactive OAuth sign-in for a catalog provider
 * ({providerId}). Main runs the loopback+PKCE flow (system browser) and, on
 * success, persists the token blob to the vault and resolves with a fresh
 * SettingsSnapshot; every failure mode resolves with a typed reason. A decrypted

 * snapshot changes to `set: true`.
 */
export const OAUTH_START_CHANNEL = "anycode:oauth-start";

/** invoke channel: abort an in-flight OAuth flow for a provider ({providerId}). */
export const OAUTH_CANCEL_CHANNEL = "anycode:oauth-cancel";

// ── connection CRUD invoke channels (TASK.45 W9; main-authoritative, additive —
// the generic settings-set path can NEVER carry a wholesale `connections[]`,
// which refine-rejects) ──

/** invoke channel: create a connection ({providerId, label?, model?, ...}). */
export const CONNECTION_CREATE_CHANNEL = "anycode:connection-create";
/** invoke channel: update a connection's metadata ({id, model?, ...}). */
export const CONNECTION_UPDATE_CHANNEL = "anycode:connection-update";
/** invoke channel: make a connection the default for new sessions ({id}). */
export const CONNECTION_SET_ACTIVE_CHANNEL = "anycode:connection-set-active";
/** invoke channel: delete a connection ({id}) — secrets cleared before metadata. */
export const CONNECTION_DELETE_CHANNEL = "anycode:connection-delete";
/** invoke channel: re-check a connection's health ({id}) — scaffold (W11 wires the probe). */
export const CONNECTION_CHECK_CHANNEL = "anycode:connection-check";

// ── settings schema (design §2; mirrored 1:1 by the zod schema in settings/schema.ts) ──

/**
 * A persisted always-allow rule — structurally identical to core's
 * `PermissionRule` (`{toolName, pattern?}`, picomatch-glob over the subject),
 * redeclared locally so this value-only module keeps its zero-import rule.
 */
export interface AlwaysAllowRule {
  toolName: string;
  pattern?: string;
}

/**
 * A persisted per-action keybinding override (F20, slice-P7.24-cut.md §1). `action`
 * is a renderer `ActionId` (kept a bare `string` here so this value-only module
 * stays zero-import — the keymap owns the ActionId union and validates membership).
 * `bindings` is the FULL replacement set of canonical, platform-neutral chords
 * (`"mod[+shift]+<key>"`); an empty array means the action is intentionally
 * Unassigned. Arrays replace wholesale on merge (the editor sends the full set).
 */
export interface KeybindingOverride {
  action: string;
  bindings: string[];
}

/**
 * Wire protocol a provider selection speaks (TASK.43, mirrors core's
 * `ProviderTransport`). Redeclared here — not imported from `@anycode/core` —
 * so this value-only module keeps its zero-import rule (same precedent as
 * `SecretKey`).
 */
export type ProviderTransportId = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

/** Per-model reasoning-effort tier (mirrors core's `ReasoningEffort`; local literal keeps this module zero-import). */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/**
 * Advisory connection health (TASK.45 §3). NOT a runtime-readiness source — it
 * is a last-known classification of the last real request/probe. W9 only owns
 * the SHAPE (it lives in the persisted connection); W11 classifies + writes it.
 */
export type ProviderHealthStatus =
  | "needs_credential"
  | "unchecked"
  | "ready"
  | "auth_invalid"
  | "forbidden"
  | "rate_limited"
  | "unreachable"
  | "misconfigured";

/**
 * One user-created provider connection (TASK.45 §«Техническая модель»): an
 * instance of a catalog `providerId` with its own label, default
 * model/transport/baseUrl/effort and its OWN vault credential
 * (`provider.connection.<id>.{apiKey,oauth}`). `id` is a stable opaque id minted
 * + validated by main (`conn-<uuid>`). `providerId` is `""` for the bare/custom
 * "legacy" bucket (no catalog pick) so `activeProviderView` reads back an
 * absent `provider.id`, exactly like a v1 singleton with no id.
 */
export interface ProviderConnection {
  id: string;
  providerId: string;
  label?: string;
  model?: string;
  transport?: ProviderTransportId;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  /** Advisory last-known health (TASK.45 §3); W11 writes it, never a runtime-readiness source. */
  lastHealth?: { status: ProviderHealthStatus; at: string; safeCode?: string };
}

/**
 * settings.json v2 `provider` (TASK.45): the replacing shape — the v1 singleton
 * fields (`id/model/baseUrl/transport/defaults`) NO LONGER EXIST here; the user
 * configures one or more named connections instead. `activeConnectionId` is the
 * default for NEW core sessions only (session-pinning is W10).
 */
export interface ProviderSettingsV2 {
  activeConnectionId?: string;
  connections: ProviderConnection[];
}

/**
 * Derived legacy-shaped view of the ACTIVE connection (`shared` helper
 * `activeProviderView`): the read-only projection every pre-W12 read-site
 * consumes in place of the removed v1 singleton, so their behaviour is preserved
 * by construction (the active connection stands in for the former singleton).
 * Never persisted.
 */
export interface ActiveProviderView {
  id?: string;
  model?: string;
  baseUrl?: string;
  transport?: ProviderTransportId;
  reasoningEffort?: ReasoningEffort;
}

/** Non-secret, human-editable settings persisted to ~/.anycode/settings.json (0644). */
export interface AnycodeSettings {
  version: 2;
  /**
   * Provider connections (TASK.45, settings v2 — replacing shape). The active
   * connection is the default for new core sessions; pre-W12 read-sites project
   * it through `activeProviderView`.
   */
  provider: ProviderSettingsV2;
  /** Mirrors of the ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS env (env > settings). */
  tools: { concurrency?: number; stallTimeoutMs?: number; maxTurns?: number };
  /** Persisted always-allow rules seeded into every new host session (§5). */
  permissions: { alwaysAllow: AlwaysAllowRule[] };
  ui: { theme: "system" | "light" | "dark" };
  /** Consent flag for weak secret storage on Linux/headless (§4), default false. */
  security: { allowWeakSecretStorage: boolean };
  /**
   * Per-action keyboard-shortcut overrides (F20, slice-P7.24-cut.md §1,
   * additive-optional; version NOT bumped). Absent = every action uses its
   * built-in chord, so an existing settings.json round-trips byte-identically.
   * Only known EDITABLE actions are honoured at resolve time; unknown/reserved
   * entries are ignored fail-soft.
   */
  keybindings?: { overrides: KeybindingOverride[] };
  /**
   * Codex engine onboarding metadata (TASK.41, cut §3.5, additive-optional;
   * version NOT bumped — same forward-compat reasoning as `provider.defaults`/
   * `keybindings` above: an existing settings.json with no `codex` field
   * round-trips byte-identically). `binaryPath` is the validated absolute path
   * the user picked/confirmed (NEVER the `ANYCODE_CODEX_BIN` dev env-override,
   * which always wins at read time and is never persisted). `lastCheck` is an
   * advisory cache of the last `codex-doctor` run — it NEVER carries a
   * credential or token (those stay in CODEX_HOME, cut §2(g) — AnyCode does
   * not read or store Codex auth state).
   */
  codex?: {
    binaryPath?: string;
    lastCheck?: {
      status: "ready" | "not_installed" | "update_required" | "signed_out" | "error";
      version?: string;
      /** ISO timestamp; advisory-cache only. */
      at: string;
    };
  };
}

// ── secret vault status (renderer NEVER receives a decrypted value, only status) ──

/**
 * Vault key allow-list. Legacy/custom mode uses the bare `provider.apiKey`

 * widens it additively to per-provider credentials:
 *  - `provider.<id>.apiKey`  — API-key auth for a catalog provider
 *  - `provider.<id>.oauth`   — the OAuth token blob for a catalog provider
 * Membership of `<id>` against the catalog is enforced at the main boundary
 * (main/host-env.ts `isKnownSecretKey`, settings-ipc zod-refine); this value-only
 * type stays a structural template so preload/renderer keep zero imports.
 */
export type SecretKey =
  | "provider.apiKey"
  | `provider.${string}.apiKey`
  | `provider.${string}.oauth`
  // ── connection-scoped keys (TASK.45 settings v2) ──
  //   `provider.connection.<connectionId>.apiKey` — a connection's API key
  //   `provider.connection.<connectionId>.oauth`  — a connection's OAuth token blob
  // (structurally a subset of `provider.${string}.{apiKey,oauth}`, declared
  // explicitly for readability; catalog/connection membership is enforced at the
  // main boundary via `isKnownSecretKey`).
  | `provider.connection.${string}.apiKey`
  | `provider.connection.${string}.oauth`;

/** What will actually win when a host is spawned (env-override is visible to the UI). */
export type SecretSource = "env" | "vault" | "plaintext" | "none";

/** Storage tier of the vault backend on this machine (§4). */
export type SecretTier = "os_encrypted" | "obfuscated" | "plaintext" | "unavailable";

export interface SecretStatus {
  key: SecretKey;
  /** true when an entry exists in the vault / secrets file. */
  set: boolean;
  source: SecretSource;
  tier: SecretTier;
}

// ── provider catalog projection (slice 2.5 §4.1; renderer NEVER imports core) ──

/** Auth mechanism a catalog provider uses, projected for the renderer. */
export type CatalogAuthKind = "api_key" | "oauth";

/**
 * Public, non-secret projection of ONE catalog provider for the renderer. Carries
 * only display metadata — never a baseUrl secret, never a key. `models` are the

 * `needsBaseUrl` is true for the `custom` entry (the UI must show a baseUrl field).
 */
export interface CatalogSummaryEntry {
  id: string;
  name: string;
  authKind: CatalogAuthKind;
  models: { id: string; name?: string }[];
  needsBaseUrl?: boolean;
  /**
   * True ONLY for the literal `custom` sentinel entry (TASK.43 W5-FIX). Distinct
   * from `needsBaseUrl`: a non-custom template (vLLM) also needs a base URL but
   * keeps its own per-provider vault key, whereas the custom sentinel shares the
   * bare legacy key. The renderer keys credential-slot + no-selection-fallback
   * choices off this, never off `needsBaseUrl`.
   */
  isCustom?: boolean;
  /** Transport this endpoint uses when neither env nor settings pick one (TASK.43 W5). */
  defaultTransport?: ProviderTransportId;
  /** Every transport this endpoint is known to speak; a UI may only offer these (TASK.43 W5). */
  supportedTransports?: ProviderTransportId[];
  /** True when this endpoint works without a credential (e.g. a local vLLM server) — readiness never blocks on a missing key (TASK.43 W5). */
  authOptional?: boolean;
}

/** The catalog as the renderer sees it (main projects it from @anycode/core/catalog). */
export type CatalogSummary = CatalogSummaryEntry[];

/** Everything the renderer needs to render Settings/Welcome without a second round-trip. */
export interface SettingsSnapshot {
  settings: AnycodeSettings;
  secrets: SecretStatus[];
  /** apiKey(env|vault) && model(env|settings) — the auto-tab gate (§6). */
  providerReady: boolean;
  /** Names of ANYCODE_* env vars overriding vault/settings (UI warning). */
  envOverrides: string[];
  /** true when settings.json is a newer version than this binary understands (§2). */
  readOnly: boolean;
  /**
   * Provider catalog projection (slice 2.5 §4.1). Optional so the field stays
   * additive: 2.5.1 freezes the type, 2.5.2 populates it in the main-side snapshot
   * builder. Renderers treat an absent value as an empty catalog.
   */
  catalog?: CatalogSummary;
}

// ── mutating-channel result shape (all mutators return a fresh snapshot) ──

export type SettingsMutationReason =
  | "invalid"
  | "read_only"
  | "weak_storage_needs_consent"
  | "not_found"
  // A connection-delete blocked because the connection is pinned to a live
  // session (TASK.45 W10 delete-guard). The renderer explains it is in use.
  | "connection_in_use";

/**
 * Response of every mutating channel (settings-set / secret-set / secret-clear /
 * permission-rule-add): a fresh snapshot on success so the UI stays consistent
 * without a second get, or a typed reason on refusal.
 */
export type SettingsMutationResult =
  | { ok: true; snapshot: SettingsSnapshot }
  | { ok: false; reason: SettingsMutationReason };

// ── OAuth channel payloads (companions to OAUTH_START/CANCEL_CHANNEL) ──

export interface OAuthStartRequest {
  providerId: string;
  /**
   * Scopes the sign-in to ONE connection (TASK.45 W12-FIX §1) — additive,
   * companion to `providerId`. Present: the flow persists the token to
   * EXACTLY this connection (not-found or a different provider bucket both
   * refuse `failed`, zero side effects). Absent: the pre-existing
   * provider-scoped findOrCreate semantics (the v1-shim / legacy path),
   * unchanged byte-for-byte.
   */
  connectionId?: string;
}

export interface OAuthCancelRequest {
  providerId: string;
}

/**
 * Refusal reasons of `oauth-start`:
 *  - `unsupported`: the provider's catalog auth kind is not `oauth`.
 *  - `cancelled`:   the user (or a cancel invoke) aborted the flow.
 *  - `timeout`:     the browser round-trip exceeded the flow deadline.
 *  - `failed`:      token exchange / callback validation failed.
 *  - `read_only`:   settings.json is newer than this binary, so no write is allowed.
 */
export type OAuthStartReason = "unsupported" | "cancelled" | "timeout" | "failed" | "read_only";

/**
 * Response of `oauth-start`: a fresh snapshot on success (the provider's
 * SecretStatus now reads `set: true`) or a typed reason. Never carries a token.
 */
export type OAuthStartResult =
  | { ok: true; snapshot: SettingsSnapshot }
  | { ok: false; reason: OAuthStartReason };

// ── request payloads (companions to the 5 channels) ──

/**
 * Deep-partial patch for `settings-set`: nested objects merge key-by-key while
 * arrays (e.g. `permissions.alwaysAllow`) are replaced wholesale — the rule
 * editor sends the full array. `version` is patchable in the type but main
 * ignores/rejects a version change. `provider` is excluded entirely (TASK.45
 * W12): the connection graph is CRUD-only (`connection-*` channels below) —
 * main refine-rejects ANY `provider` key sent through this generic path.
 */
export type SettingsPatch = Omit<DeepPartial<AnycodeSettings>, "provider">;

// ── connection CRUD request payloads (companions to the connection-* channels) ──

export interface ConnectionCreateRequest {
  providerId: string;
  label?: string;
  model?: string;
  transport?: ProviderTransportId;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  /** Make the new connection active (default for new sessions). */
  setActive?: boolean;
}

export interface ConnectionUpdateRequest {
  id: string;
  label?: string;
  model?: string;
  /**
   * `""` is a sentinel (TASK.45 W12-FIX §3, same convention as `baseUrl`/
   * `model` on this channel): absent = keep the current value, an enum value
   * = set it, `""` = clear an explicit choice back to catalog default. `""`
   * is NEVER itself persisted — the handler normalizes it to `undefined`
   * before writing, so a cleared connection carries no `transport` key.
   */
  transport?: ProviderTransportId | "";
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ConnectionSetActiveRequest {
  id: string;
}

export interface ConnectionDeleteRequest {
  id: string;
}

export interface ConnectionCheckRequest {
  id: string;
}

export interface SecretSetRequest {
  key: SecretKey;
  value: string;
}

export interface SecretClearRequest {
  key: SecretKey;
}

export interface PermissionRuleAddRequest {
  toolName: string;
  pattern?: string;
}



/**
 * Secret env keys scrubbed from the live `process.env` of BOTH main and every
 * host process right after their value is captured in memory (ruling §3). Single
 * source of truth for both processes; value-only (the lanes consume it, never
 * edit it). 2.5 extends this list with provider credentials.
 */
export const SECRET_ENV_KEYS = ["ANYCODE_API_KEY"] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

// ── connection view helpers (pure; value-only, no imports — usable in main + renderer) ──

/**
 * The active connection (the default for new core sessions), or `undefined` when
 * none is selected / it was deleted. A fresh install (no connections) yields
 * `undefined`, exactly like a fresh v1 install had no configured provider.
 */
export function activeConnection(settings: AnycodeSettings): ProviderConnection | undefined {
  const { activeConnectionId, connections } = settings.provider;
  if (activeConnectionId === undefined) {
    return undefined;
  }
  return connections.find((connection) => connection.id === activeConnectionId);
}

/**
 * The connection with a given id, or `undefined` when it does not exist (e.g. a
 * session pinned to a since-deleted connection, TASK.45 W10). Pure/value-only so
 * both main (runtime resolution + resume matrix) and the renderer can use it.
 */
export function connectionById(settings: AnycodeSettings, connectionId: string): ProviderConnection | undefined {
  return settings.provider.connections.find((connection) => connection.id === connectionId);
}

/**
 * Legacy-shaped projection of the active connection (TASK.45 W9 §4.1): every
 * pre-W12 read-site consumes this in place of the removed v1
 * `settings.provider.{id,model,baseUrl,transport,reasoningEffort}` singleton, so
 * its behaviour is preserved by construction (the active connection stands in
 * for the former singleton). `id` is the connection's `providerId` normalised so
 * the bare/custom sentinel (`providerId === ""`) reads back as `undefined`,
 * byte-for-byte v1's absent `provider.id`. Never persisted.
 */
export function activeProviderView(settings: AnycodeSettings): ActiveProviderView {
  const connection = activeConnection(settings);
  if (connection === undefined) {
    return {};
  }
  return {
    id: connection.providerId === "" ? undefined : connection.providerId,
    model: connection.model,
    baseUrl: connection.baseUrl,
    transport: connection.transport,
    reasoningEffort: connection.reasoningEffort,
  };
}

// ── internal type helper (not exported; erased at compile time) ──

/** Deep-partial that replaces arrays wholesale and recurses into plain objects. */
type DeepPartial<T> = T extends ReadonlyArray<unknown>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

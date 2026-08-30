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

// TASK.141: the ONLY import in this module, and a TYPE one — `verbatimModuleSyntax`
// erases the statement outright, so the zero-runtime-import rule above is intact
// and no bundle grows by a byte. The single VALUE edge between the two modules
// runs the other way (shared/proxy.ts imports `isProxyUrl` from here), so there
// is no runtime cycle either. Redeclaring `ProxyProfile` structurally here — the
// `AlwaysAllowRule` precedent — was rejected: the registry is written by main and
// read by main, host AND renderer, and two hand-synced copies of a persisted
// shape is exactly the drift that silently drops a field on a round-trip.
import type { ProxyProfile } from "./proxy.js";

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

/** invoke channel: grant per-path binary-trust consent ({path}); TASK.103 — main computes the fingerprint, the request never carries one. */
export const BINARY_TRUST_GRANT_CHANNEL = "anycode:binary-trust-grant";
/** invoke channel: revoke a per-path binary-trust consent ({path}); TASK.103 — idempotent. */
export const BINARY_TRUST_REVOKE_CHANNEL = "anycode:binary-trust-revoke";

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
 * One per-path binary-trust consent (TASK.103), as persisted in
 * `settings.security.trustedBinaries`. Structurally REDECLARED here (not
 * imported) to keep this value-only module's zero-import rule — same
 * precedent as `AlwaysAllowRule` above. This shape MUST match
 * `BinaryTrustConsent` in `shared/codex-binary-trust.ts` field-for-field;
 * the two meet (and are cross-checked) only where a caller crosses the
 * seam (settings-ipc.ts) — see RESIDUALS-S4.md#RES-11.
 */
export interface TrustedBinaryConsent {
  /** The binary's realpath at grant time. */
  path: string;
  /** RAW stat 5-tuple, compared with strict equality by the policy. */
  fingerprint: { mode: number; uid: number; gid: number; size: number; mtimeMs: number };
  /** ISO timestamp of the grant. */
  grantedAt: string;
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
  /**
   * HTTP(S) proxy this connection's traffic is routed through (TASK.132, owner
   * 17.08). Main emits it into the host fork's env as the HTTP(S)_PROXY family
   * plus `NODE_USE_ENV_PROXY=1` (main/host-env.ts `applyConnectionProxy`), so
   * node's global fetch inside the host AND the engine children — which already
   * pass the proxy family through their env allow-lists — all honour it; a
   * shell-provided proxy env always wins over this field.
   *
   * CUSTODY: stored VERBATIM and may carry `user:pass@` userinfo (authenticated
   * proxies are the dominant real-world case), so the credential lives in plain
   * text in the 0644 settings.json and is visible in the env of every child
   * process the host spawns. It NO LONGER rides the renderer snapshot: TASK.141
   * (design review H-02) projects every snapshot through `maskLegacyProxyUrls`,
   * so what crosses to the renderer is `user:***@host:port` while main keeps the
   * real string for the spawn. The remaining exposure is the
   * owner's decision, not an oversight: this is network infrastructure config
   * with parity to a shell-exported `https_proxy`, it has no vault key, and
   * children inheriting it is precisely the feature — it is deliberately NOT
   * scrubbed the way `ANYCODE_API_KEY` is (host/boot.ts `scrubSecretEnv`).
   *
   * Read that last part literally: Bash tool children inherit the host's whole
   * `process.env` (core's node-execution adapter), so a model that runs `env`
   * can read this proxy's password into its own transcript. Scrubbing it there
   * is not obviously right either — it would break `npm`/`git`/`curl` inside
   * the very corporate-proxy setup this field exists for — so the trade sits
   * with the owner as TASK.135 rather than being decided silently here.
   *
   * Only a non-empty value is ever persisted (only-truthy-on-disk, same
   * discipline as `transport`/`authOptional`).
   */
  proxyUrl?: string;
  /**
   * Reference into the named proxy registry (TASK.141) — the REPLACEMENT for
   * the verbatim `proxyUrl` above. Absent = inherit the app rung; `"direct"` =
   * this connection explicitly uses no proxy (the one falsy-MEANING string this
   * field persists, and a value rather than a `false`, so only-truthy-on-disk
   * still holds); a `proxy-<uuid>` id = that profile.
   *
   * Beats `proxyUrl` on the SAME connection when both are present. The legacy
   * string keeps working untouched — there is no migration on READ; the first
   * write through the picker converts it into a real profile
   * (`importLegacyProxy`, deduped by URL) and removes the legacy key.
   *
   * A ref naming a profile that no longer exists resolves to "direct" for this
   * connection, NEVER to a fall-through into the app's proxy: an explicit rung
   * with a broken value must not quietly route this connection's traffic into
   * someone else's proxy.
   */
  proxyRef?: string;
  reasoningEffort?: ReasoningEffort;
  /**
   * Explicit output-token ceiling for this connection (TASK.150), materialised
   * as `ANYCODE_MAX_OUTPUT_TOKENS` on the fork env — so an env value set by the
   * launching shell still wins, exactly like `reasoningEffort`.
   *
   * This is the ONLY user-reachable rung for an on-prem / free-text model: the
   * `vllm`, `custom` and `openrouter` catalog entries carry `models: []`, so
   * core's `resolveMaxOutputTokens` can never find a per-model hint for them and
   * falls back to `DEFAULT_MAX_OUTPUT_TOKENS`. A self-hosted model that really
   * serves 128K of output says so here. Absent = the catalog hint, else the
   * core default.
   *
   * Beats the catalog hint when present (it is an explicit statement about THIS
   * endpoint, which the static hint cannot know), and is beaten by the env var.
   */
  maxOutputTokens?: number;
  /**
   * User declaration that this endpoint authenticates nothing (dogfood 16.07:
   * local servers — LM Studio/ollama/llama.cpp). UI-level truth for the
   * drawer's "no API key" checkbox and the tile's health derivation (a keyless
   * connection must not nag "Needs credential"). Runtime keylessness itself is
   * transport-governed (core accepts a missing key only on OpenAI-family
   * transports), so this flag never overrides `computeProviderReady`.
   */
  authOptional?: boolean;
  /** Advisory last-known health (TASK.45 §3); W11 writes it, never a runtime-readiness source. */
  lastHealth?: { status: ProviderHealthStatus; at: string; safeCode?: string };
  /**
   * Live-fetched model ids for a CATALOG connection (the guarded
   * connection-scoped `/v1/models` fetch, main/provider-ipc.ts). Advisory
   * display data only: pickers show these INSTEAD of the catalog entry's
   * static hints when present (static hints still decorate matching ids with
   * display names/capabilities); absent = static hints, exactly the pre-fetch
   * behavior. Never a runtime-readiness or endpoint-resolution source. A
   * `custom:<slug>` connection never carries this — its live list lives on
   * the custom record's own `models[]`.
   */
  models?: string[];
  /** ISO timestamp of the last successful connection-scoped model-list fetch. */
  modelsFetchedAt?: string;
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
  /**
   * Custom OpenAI-compatible/Anthropic model-provider endpoints for AnyCode's
   * OWN engine (owner-decision #6, cut §9.2) — additive-optional, dedicated
   * array independent of `connections` (TASK.45's connection graph). A
   * malformed entry validates INDEPENDENTLY at the zod boundary (same
   * per-element `.catch` discipline as `codex.profiles`, cut §2.3).
   */
  custom?: CustomProviderRecord[];
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
  /**
   * The active connection's LEGACY HTTP(S) proxy string (TASK.132), projected
   * for display. No longer the fork env's source: TASK.141 resolves the fork's
   * network path through the proxy LADDER (`resolveProxyLadder` over the active
   * connection's rung, then the app's), because a connection can now express
   * "inherit", "direct" or "profile X" — none of which a single string can
   * carry. The per-tab-pin property is unchanged: the ladder keys off
   * `activeConnectionId`, the same handle this projection does.
   */
  proxyUrl?: string;
  reasoningEffort?: ReasoningEffort;
  /** The active connection's explicit output-token ceiling (TASK.150); absent = catalog/default. */
  maxOutputTokens?: number;
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
  /**
   * Mirrors of the ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS env
   * (env > settings). `subagentStallTimeoutMs` (TASK.148 slice 1) mirrors
   * ANYCODE_SUBAGENT_STALL_MS — the subagent silence-detector threshold, NOT
   * `stallTimeoutMs` above (the per-attempt stream watchdog).
   */
  tools: {
    concurrency?: number;
    stallTimeoutMs?: number;
    maxTurns?: number;
    subagentMaxTurns?: number;
    subagentStallTimeoutMs?: number;
  };
  /** Persisted always-allow rules seeded into every new host session (§5). */
  permissions: { alwaysAllow: AlwaysAllowRule[] };
  ui: { theme: "system" | "light" | "dark" };
  /** Consent flag for weak secret storage on Linux/headless (§4), default false. */
  security: {
    allowWeakSecretStorage: boolean;
    /**
     * Per-path binary-trust consents (TASK.103), additive-optional — absent
     * = today's byte-identical round-trip. Written ONLY through the
     * dedicated grant/revoke channels (never through generic `settings-set`,
     * which refine-rejects this field — D-S4-5).
     */
    trustedBinaries?: TrustedBinaryConsent[];
  };
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
    /**
     * Codex account profiles (codex-profiles cut §2.3, amended §A1.1;
     * additive-optional, `version` NOT bumped — absent = exactly today's
     * single-profile behavior, the `system` pseudo-profile). Each element
     * validates INDEPENDENTLY at the zod boundary (settings/schema.ts) — a
     * single malformed profile record is dropped without disturbing its
     * siblings or `binaryPath` (cut §2.3 "zod-гранулярность").
     */
    profiles?: CodexProfileRecord[];
    /** Default profile id for NEW sessions; absent = `system`. */
    activeProfileId?: string;
    /** Codex versions the user explicitly accepted running outside the supported range (cut §7.4), per-version — not a blanket opt-out. */
    riskAcceptedVersions?: string[];
    /**
     * HTTP(S) proxy for everything the Codex CLI does (TASK.139): the tab's
     * app-server child, a Codex subagent spawned from ANY tab, and the
     * doctor/`codex login` probes main spawns itself. ENGINE-level, not
     * per-profile: a profile is an auth home (`CODEX_HOME`), never a network
     * path, and this is machine network infrastructure.
     *
     * Priority ladder for those children — `shell > this field >
     * connection.proxyUrl > none`. Main materialises it into every host fork as
     * the carrier `ANYCODE_CODEX_PROXY_URL` (main/host-env.ts
     * `engineProxyCarriers`) and the child-env builders turn the carrier into
     * the real HTTP(S)_PROXY family (`applyEngineProxyOverride`). The carrier is
     * emitted ONLY when the shell owns no proxy var, which is what makes the
     * builders' unconditional overwrite of the connection-inherited family
     * correct. The host fork's OWN env is untouched, so a Bash/terminal child in
     * a Codex tab keeps the connection-level semantics unchanged.
     *
     * CUSTODY: identical to `ProviderConnection.proxyUrl` above — stored
     * verbatim in the 0644 settings.json, `user:pass@` userinfo deliberately
     * allowed, and visible in the env of every process the engine starts. This
     * field widens the TASK.135 perimeter by exactly two names,
     * `ANYCODE_CODEX_PROXY_URL` and `ANYCODE_CLAUDE_PROXY_URL`.
     *
     * Only a non-empty value is persisted (only-truthy-on-disk).
     */
    proxyUrl?: string;
    /**
     * Reference into the named proxy registry (TASK.141) — the replacement for
     * `proxyUrl` above, with the identical three-state semantics as
     * `ProviderConnection.proxyRef`: absent = inherit the app rung, `"direct"` =
     * this engine's children explicitly use no proxy, a `proxy-<uuid>` id = that
     * profile. Beats `proxyUrl` on this same block; a dangling id resolves to
     * "direct" for this engine, never to a fall-through into the app rung.
     *
     * The `"direct"` case is what the `PROXY_CARRIER_DIRECT` sentinel exists
     * for (shared/engines.ts): the child-env builder has to actively DELETE the
     * proxy family the connection's passthrough put there, and "delete nothing"
     * would silently leave the engine on the connection's proxy.
     */
    proxyRef?: string;
  };
  /**
   * Claude engine onboarding metadata (SLICE-CC A1, cut §1.2, additive-optional;
   * version NOT bumped — same forward-compat reasoning as `codex` above: an
   * existing settings.json with no `claude` field round-trips byte-identically).
   * `binaryPath` is the validated absolute path the user picked/confirmed
   * (NEVER the `ANYCODE_CLAUDE_BIN` dev env-override, which always wins at read
   * time and is never persisted). `lastCheck` is an advisory cache of the last
   * claude-doctor run — it NEVER carries a credential, email, or subscription
   * tier (cut §0.2 invariant 2; `ClaudeDoctorReport` itself excludes them).
   * No `profiles`/`activeProfileId` in CC-A — the engine runs on the user's
   * single ambient `~/.claude` profile by default (owner pivot) until CC-E.
   */
  claude?: {
    binaryPath?: string;
    lastCheck?: {
      status: "ready" | "not_installed" | "update_required" | "signed_out" | "error";
      version?: string;
      /** ISO timestamp; advisory-cache only. */
      at: string;
    };
    /**
     * HTTP(S) proxy for everything the Claude Code CLI does (TASK.139) — the
     * exact mirror of `codex.proxyUrl` above: same ladder (`shell > this field >
     * connection.proxyUrl > none`), same carrier mechanism
     * (`ANYCODE_CLAUDE_PROXY_URL`), same custody (plain text in the 0644 file,
     * userinfo allowed, inherited by every child the CLI starts, TASK.135
     * perimeter). Read that field's doc for the reasoning; it is not repeated.
     *
     * One asymmetry worth naming: the claude LOGIN flow opens a real
     * Terminal.app window rather than spawning a child (main/claude-login.ts),
     * so it runs under the user's shell env and this field cannot reach it —
     * by construction, not by omission.
     *
     * Only a non-empty value is persisted (only-truthy-on-disk).
     */
    proxyUrl?: string;
    /** Reference into the named proxy registry (TASK.141) — the exact mirror of `codex.proxyRef`; read that field's doc. */
    proxyRef?: string;
  };
  /**
   * Named proxy profiles + the APP-level reference (TASK.141, редакция 2;
   * additive-optional, `version` NOT bumped — a settings.json with no `network`
   * key round-trips byte-identically and every child env stays byte-for-byte
   * what it was before this slice).
   *
   * `proxyProfiles` is the ONE registry every scope references. `proxyRef` is
   * the application-wide default rung, the bottom of every ladder. On THIS scope
   * — and only this one — "no proxy" and "inherit" mean the same thing (there is
   * nothing below the app), so the picker's "No proxy" DELETES the key rather
   * than persisting `"direct"`; a `"direct"` that reaches the file by hand is
   * read the same way regardless.
   */
  network?: {
    proxyProfiles?: ProxyProfile[];
    proxyRef?: string;
  };
  /**
   * Browser-preview settings (night-track wave-1 cut §1(e)/§2.7, TASK.96
   * 96-E; additive-optional, version NOT bumped — same forward-compat
   * reasoning as `claude`/`codex`/`keybindings` above: an existing
   * settings.json with no `preview` field round-trips byte-identically).
   * `autoOpen` absent means ON (owner default) — main's `autoOpenEnabled()`
   * reads `settings.preview?.autoOpen ?? true`, never the other way around.
   *
   * `displayMode` (added 96-P0, panel-track CUT.md §2.3): which container a
   * NEW preview opens in. Absent means "panel" (task decision) — main's
   * `displayMode()` dep (96-P1) reads `settings.preview?.displayMode ??
   * "panel"`, same absent-default posture as `autoOpen`.
   */
  preview?: {
    autoOpen?: boolean;
    displayMode?: "panel" | "window";
  };
  /**
   * Vision-fallback recognizer selection (TASK.198 E1): which ALREADY-
   * CONFIGURED connection + model answers `InspectImage` calls when the main
   * session's own model cannot see images (`resolveImageInput` is `false`).
   * Additive-optional, version NOT bumped — same forward-compat reasoning as
   * `preview`/`codex`/`claude` above: an existing settings.json with no
   * `recognizer` key round-trips byte-identically. Absent, a `connectionId`
   * that no longer resolves to a connection, or an OAuth connection
   * (unsupported as a recognizer source in slice 1 — a static env key cannot
   * refresh an OAuth token the way the primary connection's broker does) all
   * read as "fallback disabled" at resolve time — today's `turn_rejected`
   * behaviour on a blind model, never a corrupt-settings state.
   *
   * `apiKey`/`baseUrl`/`transport` are NOT duplicated here — they are read off
   * the referenced `ProviderConnection` at resolve time
   * (main/host-env.ts `resolveRecognizerConfig`), so a credential never gets a
   * second settings home and a connection edit (baseUrl, key rotation) is
   * picked up for free on the next resolve.
   */
  recognizer?: {
    connectionId: string;
    modelId: string;
  };
}

/**
 * One Codex account profile (codex-profiles cut §2.3, amended §A1.1).
 * `authLink` and `linkedHome` are MUTUALLY EXCLUSIVE by construction — a
 * record carrying both is a BAD (broken) record, rejected by the
 * per-element zod refine (settings/schema.ts), never persisted. `id`
 * charset is the strict
 * `[a-z0-9][a-z0-9-]{0,31}` (cut §2.6) — never a filesystem path, `main`
 * derives the actual `CODEX_HOME` from the id via the registry.
 */
export interface CodexProfileRecord {
  id: string;
  label: string;
  /** ISO timestamp. */
  createdAt: string;
  /**
   * Absolute path to an ENTIRE external `CODEX_HOME` this profile points at
   * (cx-parity, cut §2.2 OG-1(b)) — mutually exclusive with `authLink`. When
   * present, AnyCode creates nothing inside it; it only reads/spawns there.
   */
  linkedHome?: string;
  /**
   * Target of the `<our profile home>/auth.json` symlink (amended §A1.1/§A1.2)
   * — mutually exclusive with `linkedHome`. `v1` UI writes exactly
   * `"~/.codex/auth.json"`; `~` is expanded by main via `os.homedir()` before
   * use. Stores INTENT only, never credential content — the lstat-guard
   * (§A1.2) uses this to detect a swapped-out `auth.json`.
   */
  authLink?: string;
  lastCheck?: {
    status: "ready" | "not_installed" | "update_required" | "signed_out" | "error";
    version?: string;
    at: string;
  };
}

/**
 * One custom model-provider endpoint (cut §9.2). `id` is namespaced
 * `custom:<slug>` so it never collides with a builtin catalog id (enforced
 * at the main boundary, `catalogProviderIds() ∪ custom[].id`, same shape as
 * `isKnownSecretKey`). `models` is the user-CURATED subset that actually
 * populates the model selector — main fetches the full list, the user picks
 * which ones to keep.
 */
export interface CustomProviderRecord {
  id: string;
  name: string;
  /** `https://` required; `http://` permitted ONLY for localhost/127.0.0.1 (cut §9.2 threat list). */
  baseUrl: string;
  kind: "openai-compatible" | "anthropic" | "openai";
  models: string[];
  /** ISO timestamp of the last successful model-list fetch. */
  modelsFetchedAt?: string;
  /**
   * User declaration that this endpoint authenticates nothing (TASK.58: local
   * servers — LM Studio/ollama/llama.cpp). Only `true` is persisted (additive,
   * same only-truthy-on-disk discipline as `ProviderConnection.authOptional`);
   * a keyed record omits it. Governs whether create/update may skip the vault
   * key and lets the origin-rebind guard (provider-ipc.ts) waive the
   * fresh-key requirement for a keyless record that stays keyless (no stored
   * key can be leaked to a new origin).
   */
  authOptional?: boolean;
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
  | `provider.connection.${string}.oauth`
  // ── proxy-profile password (TASK.141 §5) ──
  //   `proxy.profile.<profileId>.password` — the authenticated-proxy password of
  // ONE registry profile. Keyed by the profile's immutable `id` (which carries
  // no dots, so it is a `[^.]+` segment exactly like a connectionId), which is
  // what makes a rename lose nothing. Registry membership is enforced at the
  // CRUD boundary, same as connection-graph membership above.
  //
  // Custody, stated plainly and not oversold: the vault takes the password out
  // of the 0644 settings.json (and out of backups and dotfile syncs). It does
  // NOT take it out of the env — the composed `http://user:pass@host:port` still
  // rides `HTTPS_PROXY` into every child, where a model running `env` can read
  // it. That half is TASK.135's open decision, and this slice widens TASK.135's
  // perimeter to cover profiles and vault-sourced passwords.
  | `proxy.profile.${string}.password`;

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
  /**
   * TASK.131: `reasoning`/`effortLevels` join the projection so a picker with
   * no live host — the New Session draft — can tell which models even HAVE a
   * reasoning-effort vocabulary and which levels each one accepts. They are
   * the same two catalog facts core's own `resolveEffortLevels` reads, and
   * they are projected verbatim (not pre-resolved) so the renderer's copy of
   * that rule stays a pure function over them. Both optional/additive: an
   * older main, or a model the catalog says nothing about, projects neither
   * and the renderer then offers no effort level at all.
   *
   * TASK.159: a model's `maxOutputTokens` joins the same way — projected only
   * when the catalog declares it (conditional spread), optional/additive so
   * legacy fixtures stay byte-identical. The drawer uses it to NAME the
   * effective ceiling for an otherwise-blank field instead of guessing.
   *
   * TASK.198: `imageInput` joins by the same conditional-spread rule. Core has
   * carried the flag per model since phase 6.2 (`provider/catalog.ts`), but the
   * projection dropped it, so the renderer could not tell a vision-capable
   * model from a blind one at all — the Vision pane's model suggestions would
   * have been limited to a connection's live-fetched list, with the catalog
   * half contributing nothing.
   */
  models: {
    id: string;
    name?: string;
    reasoning?: boolean;
    effortLevels?: string[];
    maxOutputTokens?: number;
    imageInput?: boolean;
  }[];
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
  /**
   * The settings document, PROJECTED for the renderer (TASK.141, design review
   * H-02): every legacy proxy string's userinfo is masked
   * (`maskLegacyProxyUrls`), because a password must never cross this boundary
   * and a plain snapshot used to carry `user:pass@` in full. Byte-identical to
   * the on-disk document whenever no legacy string carries a credential.
   */
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
  /**
   * TASK.159: core's `DEFAULT_MAX_OUTPUT_TOKENS`, pinned main-side
   * (settings-ipc.ts) and projected here — the renderer cannot import core
   * (this file's own rule, slice 2.5 §4.1), so the fallback a BLANK
   * "Max output tokens" field resolves to must cross the wire like this
   * instead of being hardcoded in renderer code. Always present on every
   * snapshot main builds; optional so older snapshots stay assignable.
   */
  defaultMaxOutputTokens?: number;
  /**
   * The running app's version (TASK.49), sourced from `app.getVersion()` — in
   * dev that resolves to `apps/desktop/package.json`'s `version`, in a packaged
   * build to the bundled app's version. Optional/additive so this stays a pure
   * projection: main only populates it when its `SettingsIpcDeps.getAppVersion`
   * is supplied (settings-ipc.ts), and the About pane renders it as-is — it is
   * NEVER hardcoded in the renderer.
   */
  appVersion?: string;
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
  | {
      ok: true;
      snapshot: SettingsSnapshot;
      /**
       * The connection id `connection-create` just minted (TASK.45 W12-FIX2
       * §1) — additive/optional. Populated ONLY by the connection-create
       * channel; every other mutating channel never sets it. Lets a caller
       * target the connection it just created authoritatively instead of
       * diffing the snapshot to guess which entry is new.
       */
      createdConnectionId?: string;
      /**
       * The profile id `proxy-profile-upsert` just minted (TASK.141) —
       * additive/optional, exact sibling of `createdConnectionId` above and
       * populated ONLY by that channel. Lets "Create profile…" attach the new
       * profile to the scope it was opened from without diffing the registry.
       */
      createdProxyProfileId?: string;
    }
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
  /** HTTP(S) proxy for this connection (see `ProviderConnection.proxyUrl`); validated against `isProxyUrl` at the main boundary, omitted = no proxy. */
  proxyUrl?: string;
  /**
   * Proxy-registry reference for this connection (TASK.141): `"direct"` or an
   * existing profile id, validated at the main boundary; omitted = inherit the
   * app rung. Carried on the CREATE payload (rather than set by a follow-up
   * call) so a new connection's proxy choice lands atomically with the
   * connection — no window in which it exists un-proxied.
   */
  proxyRef?: string;
  reasoningEffort?: ReasoningEffort;
  /** Output-token ceiling (see `ProviderConnection.maxOutputTokens`); omitted = catalog/default. */
  maxOutputTokens?: number;
  /** "No API key" declaration (see `ProviderConnection.authOptional`); only `true` is persisted. */
  authOptional?: boolean;
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
  /**
   * HTTP(S) proxy for this connection (TASK.132), same `""`-sentinel convention
   * as `transport` above: absent = keep the current value, a non-empty value =
   * set it (validated against `isProxyUrl` at the main boundary), `""` = clear
   * the proxy. `""` is NEVER itself persisted — the handler normalizes it to
   * `undefined` and deletes the key, so a cleared connection carries no
   * `proxyUrl`.
   */
  proxyUrl?: string;
  /**
   * Proxy-registry reference (TASK.141), same `""`-sentinel convention as
   * `transport`/`proxyUrl` above: absent = keep the current value, `"direct"`
   * or an existing profile id = set it, `""` = clear the ref back to "inherit
   * the app rung". `""` is never persisted; clearing removes BOTH the ref and
   * the legacy `proxyUrl` key, so a legacy string cannot resurrect from under a
   * ref the user just removed.
   *
   * `"legacy"` is accepted as a one-shot conversion request: it means "keep
   * what this connection's `proxyUrl` already says, but as a real profile" —
   * main runs `importLegacyProxy` (deduped by URL, so three connections sharing
   * a corporate string converge on ONE profile) and persists the minted id.
   */
  proxyRef?: string;
  reasoningEffort?: ReasoningEffort;
  /**
   * Output-token ceiling (TASK.150) with the same `""` clear sentinel as
   * `transport`/`proxyRef` above: absent = keep the current value, a positive
   * integer = set it, `""` = clear back to the catalog hint / core default.
   * `""` is never persisted — the handler deletes the key.
   */
  maxOutputTokens?: number | "";
  /**
   * "No API key" declaration: absent = keep the current value, `true` = set,
   * `false` = clear (the handler removes the key from disk rather than
   * persisting `false` — same only-truthy-on-disk discipline as `transport`).
   */
  authOptional?: boolean;
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
 *
 * TASK.198 срез C durable (TASK.139 precedent): `ANYCODE_RECOGNIZER_API_KEY`
 * is a second, independently-resolved credential (main/host-env.ts's
 * `resolveRecognizerConfig`/`applyRecognizerEnv`) that rides a host fork's
 * env exactly like `ANYCODE_API_KEY` does — without an entry here it would
 * survive `scrubSecretEnv()` and leak into every Bash-tool child a core
 * session spawns (`node-execution.ts` builds a child's env as `{...process.
 * env, ...request.env}`). The engine-child builders
 * (`buildCodexChildEnv`/`buildClaudeChildEnv`) are unaffected either way —
 * they are ALLOW-lists of named vars, not a scrub of `process.env`, so a
 * name absent from those lists never reaches a `codex`/`claude` child
 * regardless of this array.
 */
export const SECRET_ENV_KEYS = ["ANYCODE_API_KEY", "ANYCODE_RECOGNIZER_API_KEY"] as const;

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
 * The ONE proxy-URL predicate (TASK.132) — `http:`/`https:` only, because that
 * is the whole set node's `NODE_USE_ENV_PROXY` (undici's `EnvHttpProxyAgent`)
 * and both engine CLIs speak; `socks5:`/`ftp:`/scheme-less values are rejected
 * rather than persisted into an env var no consumer honours.
 *
 * Embedded `user:pass@` userinfo is deliberately ALLOWED — the exact inversion
 * of `settings/schema.ts`'s `isHttpsOrLocalhostUrl` rule. That rule exists
 * because a provider API credential belongs in the vault and must never
 * round-trip through settings.json; a proxy credential is network
 * infrastructure with no vault home (owner decision), authenticated proxies are
 * the dominant real-world case, and the value is byte-for-byte what a
 * shell-exported `https_proxy` already carries in plain text through every
 * child's env.
 *
 * It lives in this zero-import module rather than beside its sibling predicates
 * in `settings/schema.ts` because all three consumers need it and one of them
 * is the renderer: settings-ipc's create/update payload refine (trust
 * boundary), host-env's fail-soft emission gate, and ConnectionDrawer's
 * pre-flight — which must not pull a zod module into the renderer bundle just
 * to name the rule. One predicate, three call sites, no drifting copy.
 */
export function isProxyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
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
    proxyUrl: connection.proxyUrl,
    reasoningEffort: connection.reasoningEffort,
    maxOutputTokens: connection.maxOutputTokens,
  };
}

/**
 * Resolves an EXPLICIT `Agent(tier:"session", provider:<providerId>)` spawn
 * request's catalog provider id to a live connection (TASK.102 CUT-S2 §10.9.3
 * F4). `main/tabs.ts`'s `resolveProviderConnection` dep needs this pure policy
 * so `main/index.ts`'s composition root can wire it without duplicating the
 * rule inline. Policy (frozen by the cut): `providerId === ""` (the
 * bare/custom sentinel, see `ProviderConnection.providerId` doc above) never
 * resolves — a bare/custom connection has no catalog identity to match
 * against; otherwise the ACTIVE connection wins if its `providerId` matches,
 * else the first connection in `provider.connections` storage order whose
 * `providerId` matches; no match -> `undefined` (the caller fails the spawn
 * closed with `not_ready`, cut §2.7 — never a silent fallback to the parent's
 * own connection). Pure/synchronous — main already holds the connections
 * registry in memory (the same fact `env(connectionId)`/`describeConnection`
 * rely on, `tabs.ts` dep-doc), so this never needs to be async.
 */
export function resolveProviderConnection(
  settings: AnycodeSettings,
  providerId: string,
): ProviderConnection | undefined {
  if (providerId === "") {
    return undefined;
  }
  const active = activeConnection(settings);
  if (active !== undefined && active.providerId === providerId) {
    return active;
  }
  return settings.provider.connections.find((connection) => connection.providerId === providerId);
}

// ── internal type helper (not exported; erased at compile time) ──

/** Deep-partial that replaces arrays wholesale and recurses into plain objects. */
type DeepPartial<T> = T extends ReadonlyArray<unknown>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

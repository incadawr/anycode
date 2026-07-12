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

import { ipcMain } from "electron";
import { z } from "zod";
import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, saveSettings } from "../settings/files.js";
import { keybindingsSchema, mergeSettings } from "../settings/schema.js";
import {
  OAUTH_CANCEL_CHANNEL,
  OAUTH_START_CHANNEL,
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
} from "../shared/settings.js";
import type {
  AnycodeSettings,
  CatalogAuthKind,
  CatalogSummary,
  OAuthCancelRequest,
  OAuthStartRequest,
  OAuthStartResult,
  PermissionRuleAddRequest,
  SecretKey,
  SettingsMutationResult,
  SettingsPatch,
  SettingsSnapshot,
} from "../shared/settings.js";
import { computeProviderReady, envOverrides, isKnownSecretKey } from "./host-env.js";
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
  startFlow(config: OAuthProviderConfig, opts: { allowWeak: boolean }): Promise<OAuthOutcome>;
  cancel(providerId: string): void;
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

/** Structural view of ONE catalog entry the projection needs (avoids a core value-import). */
export interface CatalogEntryShape {
  id: string;
  name: string;
  auth: { kind: string };
  baseUrl: string;
  models: { id: string; name?: string }[];
}

/**
 * Projects the built-in catalog to the renderer-facing `CatalogSummary` (value
 * only — no baseUrl secret, no key). `needsBaseUrl` is set for an entry with an
 * empty baseUrl (the `custom` endpoint, whose baseUrl lives in settings).
 */
export function projectCatalogSummary(providers: readonly CatalogEntryShape[]): CatalogSummary {
  return providers.map((entry) => ({
    id: entry.id,
    name: entry.name,
    authKind: entry.auth.kind === "oauth" ? "oauth" : "api_key",
    models: entry.models.map((m) => (m.name !== undefined ? { id: m.id, name: m.name } : { id: m.id })),
    ...(entry.baseUrl === "" ? { needsBaseUrl: true } : {}),
  }));
}

/**
 * The vault key whose presence gates readiness for the SELECTED provider (slice
 * 2.5 §2.3): `provider.<id>.oauth` for an oauth provider, `provider.<id>.apiKey`
 * for api_key, or `undefined` for legacy (`provider.apiKey`) — an unset/unknown
 * id, so `computeProviderReady` uses its legacy default.
 */
function credentialKeyFor(deps: SettingsIpcDeps, settings: AnycodeSettings): SecretKey | undefined {
  const id = settings.provider.id;
  if (id === undefined || id.trim() === "") {
    return undefined;
  }
  const kind = deps.authKindFor?.(id);
  if (kind === undefined) {
    return undefined;
  }

  // renderer: a needsBaseUrl/custom entry gates readiness on the bare legacy key.
  if (deps.isCustom?.(id) === true) {
    return undefined;
  }
  return kind === "oauth" ? `provider.${id}.oauth` : `provider.${id}.apiKey`;
}

/** Reads `patch.provider.id` presence + raw value (before the catalog refine). */
function providerIdPatch(patch: unknown): { has: boolean; value: unknown } {
  if (typeof patch !== "object" || patch === null) {
    return { has: false, value: undefined };
  }
  const provider = (patch as { provider?: unknown }).provider;
  if (typeof provider !== "object" || provider === null || !("id" in provider)) {
    return { has: false, value: undefined };
  }
  return { has: true, value: (provider as { id?: unknown }).id };
}

/**
 * Deep-partial patch validator: permissive by design (mergeSettings ignores
 * unknown/undefined fields and clamps to the schema on the next read). Rejects
 * only a non-object payload so a malformed bridge message is a safe no-op.
 */
const patchSchema = z.record(z.string(), z.unknown());

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
  const [secrets, providerReady] = await Promise.all([
    deps.vault.statuses(deps.bootEnv, deps.catalogIds ?? []),
    computeProviderReady({
      bootEnv: deps.bootEnv,
      settings,
      getSecret: (key) => deps.vault.getSecretValue(key),
      credentialKey: credentialKeyFor(deps, settings),
    }),
  ]);
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
 * settings-set: deep-partial merge into settings.json. Refuses `read_only` (a
 * newer-than-CURRENT file) and an unparseable patch (`invalid`); `version` is
 * never changed by a patch.
 */
export async function handleSet(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  // Slice 2.5 refine: a `provider.id` in the patch must name a catalog entry
  // (main is the trust boundary). undefined/absent = legacy (allowed); a
  // non-string or an id outside the catalog is refused (a compromised renderer
  // cannot point the provider at an arbitrary id — threat model §9).
  const pid = providerIdPatch(parsed.data);
  if (pid.has && pid.value !== undefined) {
    if (typeof pid.value !== "string" || !(deps.catalogIds ?? []).includes(pid.value)) {
      return { ok: false, reason: "invalid" };
    }
  }
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  if (loaded.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  // Drop a version change: main owns the schema version (design §2).
  const patch: SettingsPatch = { ...(parsed.data as SettingsPatch) };
  delete (patch as Record<string, unknown>).version;
  // Defense in depth (F20 hardening): the `keybindings` section is the one patch
  // field the renderer previously stored opaquely. Validate it against the schema
  // (scoped ONLY to keybindings — every other section keeps its permissive
  // deep-partial merge + the top-level passthrough for unknown keys), so a
  // malformed section (`bindings: null`, non-array overrides, wrong-typed chords)
  // is dropped rather than persisted to disk where it could crash a reader.
  if ("keybindings" in patch) {
    const kb = keybindingsSchema.safeParse((patch as Record<string, unknown>).keybindings);
    if (kb.success) {
      (patch as Record<string, unknown>).keybindings = kb.data;
    } else {
      delete (patch as Record<string, unknown>).keybindings;
    }
  }
  const merged = mergeSettings(loaded.settings, patch);
  await saveSettings(deps.settingsPath, merged);
  const snapshot = await snapshotFrom(deps, merged, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/**
 * secret-set: store a value in the vault (design §1). The consent flag comes from
 * the persisted settings; a weak tier without consent returns
 * `weak_storage_needs_consent` and writes nothing. Blocked in read_only.
 */
export async function handleSetSecret(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = secretSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }

  // `SecretKey` is only valid for the legacy `provider.apiKey` or a
  // `provider.<id>.{apiKey,oauth}` whose id is in the catalog. This is the
  // runtime narrowing from `string` to `SecretKey`.
  const { key } = parsed.data;
  if (!isKnownSecretKey(key, deps.catalogIds ?? [])) {
    return { ok: false, reason: "invalid" };
  }
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  if (loaded.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  const result = await deps.vault.setSecret(key, parsed.data.value, {
    allowWeak: loaded.settings.security.allowWeakSecretStorage,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  const snapshot = await snapshotFrom(deps, loaded.settings, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
}

/** secret-clear: remove a value from the vault. Blocked in read_only. */
export async function handleClearSecret(deps: SettingsIpcDeps, raw: unknown): Promise<SettingsMutationResult> {
  const parsed = secretClearSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { key } = parsed.data;
  if (!isKnownSecretKey(key, deps.catalogIds ?? [])) {
    return { ok: false, reason: "invalid" };
  }
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  if (loaded.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  await deps.vault.clearSecret(key);
  const snapshot = await snapshotFrom(deps, loaded.settings, false);
  await emitMutation(deps, snapshot);
  return { ok: true, snapshot };
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
  if (config === undefined || deps.oauth === undefined) {
    return { ok: false, reason: "unsupported" };
  }
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  if (loaded.readOnly) {
    return { ok: false, reason: "read_only" };
  }
  const outcome = await deps.oauth.startFlow(config, {
    allowWeak: loaded.settings.security.allowWeakSecretStorage,
  });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  const snapshot = await snapshotFrom(deps, loaded.settings, false);
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
}

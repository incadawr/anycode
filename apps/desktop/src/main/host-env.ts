/**
 * Host-env composition + the env-scrub primitives (design slice-2.2-cut.md §6/§1

 * gate, and the boot-env snapshot/scrub discipline are all unit-testable off
 * plain objects.
 *

 * immutable `bootEnv` snapshot main captured BEFORE it scrubbed the live
 * `process.env` (ruling §3.3) — never live `process.env`. That is what lets a
 * secret key be scrubbed from main's live env (so main's Bash children cannot
 * inherit it) while the host fork still receives it and env-override semantics
 * stay byte-identical: the snapshot is read-only and long-lived.
 */

import { ENV_AUTH_MODE } from "../shared/credentials.js";
import type { AnycodeSettings, SecretEnvKey, SecretKey } from "../shared/settings.js";
import { SECRET_ENV_KEYS } from "../shared/settings.js";

// ── env var names (mirror core/provider/env.ts by contract; local literals so
// main never value-imports the core runtime, same reasoning as main/index.ts) ──

export const ENV_API_KEY = "ANYCODE_API_KEY";
export const ENV_MODEL = "ANYCODE_MODEL";
export const ENV_BASE_URL = "ANYCODE_BASE_URL";
export const ENV_TOOL_CONCURRENCY = "ANYCODE_TOOL_CONCURRENCY";
export const ENV_STALL_TIMEOUT_MS = "ANYCODE_STALL_TIMEOUT_MS";
export const ENV_MAX_TURNS = "ANYCODE_MAX_TURNS";
/**
 * Reasoning-effort inheritance rung (F14, slice-P7.15-cut.md §2.4). Literal
 * mirrors core's `provider/env.ts:11` (host already reads this into
 * `envConfig.reasoningEffort` on every fork boot — zero host/core delta here).
 */
export const ENV_REASONING_EFFORT = "ANYCODE_REASONING_EFFORT";

/** The vault key allow-list (2.2 = one key; 2.5.2 generalises via isKnownSecretKey). */
export const SECRET_KEYS: readonly SecretKey[] = ["provider.apiKey"];



/**
 * The env var a vault secret is materialised under in a host fork. `SECRET_ENV_KEYS`
 * holds exactly one entry (`ANYCODE_API_KEY`) and a fork runs ONE selected provider
 * at a time, so every provider credential — the legacy `provider.apiKey`, a
 * per-provider `provider.<id>.apiKey`, or a resolved `provider.<id>.oauth` token —

 * Replaces the `SECRET_KEY_ENV` Record, which does not survive the widened
 * `SecretKey`: indexing a `Record<SecretKey, _>` with a union key that includes
 * template-literal members yields `_ | undefined` under `noUncheckedIndexedAccess`
 * (can no longer index `bootEnv`). Legacy `provider.apiKey` -> `ANYCODE_API_KEY`,
 * byte-for-byte 2.2.
 */
export function secretEnvFor(_key: SecretKey): SecretEnvKey {
  return "ANYCODE_API_KEY";
}

/**
 * Allow-list predicate over the widened `SecretKey` (supersedes the fixed
 * `SECRET_KEYS` array). A key is known when it is the legacy/custom
 * `provider.apiKey`, or a `provider.<id>.apiKey` / `provider.<id>.oauth` whose
 * `<id>` is a member of the supplied catalog id set. Narrows a `string` to
 * `SecretKey` (the runtime catalog check is stricter than the structural type).
 * `catalogIds` is passed in so this module keeps zero core imports (main supplies
 * ids from `@anycode/core/catalog`).
 */
export function isKnownSecretKey(key: string, catalogIds: readonly string[]): key is SecretKey {
  if (key === "provider.apiKey") {
    return true;
  }
  const match = /^provider\.(.+)\.(apiKey|oauth)$/.exec(key);
  if (match === null) {
    return false;
  }
  const providerId = match[1];
  return providerId !== undefined && providerId.length > 0 && catalogIds.includes(providerId);
}

/**
 * Provider-relevant ANYCODE_* env vars whose presence in the boot snapshot

 * warning; the secret key is first so it lines up with SECRET_ENV_KEYS.
 */
const PROVIDER_ENV_KEYS: readonly string[] = [
  ENV_API_KEY,
  ENV_MODEL,
  ENV_BASE_URL,
  ENV_TOOL_CONCURRENCY,
  ENV_STALL_TIMEOUT_MS,
  ENV_MAX_TURNS,
  ENV_REASONING_EFFORT,
];

/** True when an env var is present AND non-blank (mirrors loadEnvConfig's own test). */
function envPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}



/**
 * Immutable snapshot of the live env, captured at boot BEFORE any host spawn and
 * BEFORE the scrub. All later provider-env reads in main (host fork env,
 * envOverrides, readiness) go through this snapshot, so scrubbing the live
 * `process.env` afterwards is invisible to them.
 */
export function snapshotBootEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env };
}

/**
 * Deletes every SECRET_ENV_KEY from the live `process.env` (ruling §3.3): Bash
 * children spawned by main later cannot inherit the key, closing the
 * prompt-injection "print env" exfil vector. Non-secret ANYCODE_* (MODEL /
 * BASE_URL / DB_PATH / WORKSPACE / RESUME / AUTOMATION) are untouched — the
 * automation gate reads them from the live env. Idempotent.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of SECRET_ENV_KEYS) {
    delete env[key];
  }
}

/**
 * Injects (or clears) the dev/automation-only `ANYCODE_SUBAGENTS_HOME`
 * override into a host fork's env (design/slice-P7.21-cut.md, dispatch-parity
 * fix). `override === null` deletes the var — the byte-for-byte packaged
 * production path, since `resolveSubagentsHome` (main/index.ts) always yields
 * null there. A non-null override sets the var so the host-side gate
 * (`resolveExtensionsHomeOverride`, host/dev-home.ts) can see it. Electron-free:
 * main resolves the value and injects it here.
 */
export function applySubagentsHomeOverride(env: NodeJS.ProcessEnv, override: string | null): void {
  if (override === null) {
    delete env.ANYCODE_SUBAGENTS_HOME;
  } else {
    env.ANYCODE_SUBAGENTS_HOME = override;
  }
}



/** Reads a secret value from the vault (decrypt); undefined = unset/undecryptable. */
export type SecretReader = (key: SecretKey) => Promise<string | undefined>;

/**
 * The catalog-resolved selection main hands buildHostEnv for the currently
 * configured provider (slice 2.5 §1/§3.3). host-env stays core-free: main
 * computes this from `@anycode/core/catalog` + the vault/TokenBroker and injects
 * it via `resolveSelection`. `apiKey` is the resolved credential — a per-provider
 * API key, or an OAuth access token freshly minted by the broker at fork time.
 */
export interface ResolvedProviderSelection {
  /** Endpoint base for ANYCODE_BASE_URL (catalog baseUrl, or custom settings.baseUrl). */
  baseUrl?: string;
  /** Model id for ANYCODE_MODEL (free-text or a catalog hint). */
  model?: string;
  /** Resolved credential for ANYCODE_API_KEY (api key or oauth access token). */
  apiKey?: string;
  /** "oauth" -> also set ANYCODE_AUTH_MODE so the host brokers per-attempt tokens. */
  authKind: "api_key" | "oauth";
}

export interface HostEnvParams {
  /* */
  bootEnv: NodeJS.ProcessEnv;
  settings: AnycodeSettings;
  /** Vault decrypt accessor (fail-soft: undefined when unset/undecryptable). */
  getSecret: SecretReader;
  /**
   * Slice 2.5 catalog resolution (host-env is core-free — main injects this from
   * `@anycode/core/catalog` + the vault/TokenBroker). Returns the selected catalog
   * provider's baseUrl/model/credential/authKind. `undefined` (dep absent OR an
   * unset/unknown `settings.provider.id`) selects the LEGACY 2.2 path
   * (`provider.apiKey` + settings baseUrl/model), byte-for-byte.
   */
  resolveSelection?: () => Promise<ResolvedProviderSelection | undefined>;
}

/**

 * settings) by only filling variables the boot snapshot left empty:
 *  - ANYCODE_API_KEY  <- bootEnv, else vault(provider.apiKey)
 *  - ANYCODE_MODEL    <- bootEnv, else settings.provider.model
 *  - ANYCODE_BASE_URL <- bootEnv, else settings.provider.baseUrl
 *  - ANYCODE_TOOL_CONCURRENCY / ANYCODE_STALL_TIMEOUT_MS <- bootEnv, else settings.tools.*
 *
 * The result starts from the whole boot snapshot (so PATH etc. survive) and only
 * ADDS provider defaults where env was blank — an env value always wins by

 * the vault is picked up by the next respawn.
 */
export async function buildHostEnv(params: HostEnvParams): Promise<NodeJS.ProcessEnv> {
  const { bootEnv, settings, getSecret, resolveSelection } = params;
  const env: NodeJS.ProcessEnv = { ...bootEnv };
  const selection = resolveSelection !== undefined ? await resolveSelection() : undefined;
  // Per-provider persisted default (F14 §2.4): keyed by catalog id, "custom" for
  // legacy/unset provider.id. Resolved once here so BOTH the legacy/custom model
  // fill below and the effort rung at the end of the ladder share one lookup;
  // the catalog-path model is resolved by token-broker's resolveProviderSelection
  // (same defaults[pid]?.model precedence), not here.
  const pid = settings.provider.id ?? "custom";
  const providerDefaults = settings.provider.defaults?.[pid];

  if (selection === undefined) {
    // LEGACY 2.2 path (byte-for-byte): the single `provider.apiKey` vault key +
    // settings baseUrl/model. ANYCODE_AUTH_MODE is never set.
    if (!envPresent(env, ENV_API_KEY)) {
      const fromVault = await getSecret("provider.apiKey");
      if (fromVault !== undefined && fromVault !== "") {
        env[ENV_API_KEY] = fromVault;
      }
    }
    fillFromSettings(env, ENV_MODEL, providerDefaults?.model ?? settings.provider.model);
    fillFromSettings(env, ENV_BASE_URL, settings.provider.baseUrl);
  } else {
    // CATALOG path (slice 2.5): main already resolved the selected provider's
    // credential (an api key, or an OAuth access token via the TokenBroker) and

    if (!envPresent(env, ENV_API_KEY) && selection.apiKey !== undefined && selection.apiKey !== "") {
      env[ENV_API_KEY] = selection.apiKey;
    }
    fillFromSettings(env, ENV_MODEL, selection.model);
    fillFromSettings(env, ENV_BASE_URL, selection.baseUrl);
    // ANYCODE_AUTH_MODE="oauth" ONLY for oauth providers: the host then brokers a
    // fresh token per attempt (§3.3). api_key providers keep the static-key path
    // and never receive the flag (zero behavioural delta from 2.2).
    if (selection.authKind === "oauth") {
      env[ENV_AUTH_MODE] = "oauth";
    }
  }

  fillFromSettings(env, ENV_TOOL_CONCURRENCY, numToStr(settings.tools.concurrency));
  fillFromSettings(env, ENV_STALL_TIMEOUT_MS, numToStr(settings.tools.stallTimeoutMs));
  fillFromSettings(env, ENV_MAX_TURNS, numToStr(settings.tools.maxTurns));
  // Reasoning-effort inheritance rung (F14 §2.4): a new host boot inherits the
  // last chosen effort for this provider instead of hardcoded `off`. Applies to
  // BOTH the legacy/custom and catalog paths (effort is provider-keyed, not
  // catalog-selection-keyed). Env still wins by construction (fillFromSettings).
  fillFromSettings(env, ENV_REASONING_EFFORT, providerDefaults?.reasoningEffort);

  return env;
}

function fillFromSettings(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (envPresent(env, name)) {
    return;
  }
  if (value !== undefined && value !== "") {
    env[name] = value;
  }
}

function numToStr(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

// ── env-override projection (UI warning) ──

/**
 * Names of the provider-relevant ANYCODE_* env vars present in the boot snapshot

 * SettingsSnapshot so the UI can warn "this value is overridden by an env var".
 */
export function envOverrides(bootEnv: NodeJS.ProcessEnv): string[] {
  return PROVIDER_ENV_KEYS.filter((name) => envPresent(bootEnv, name));
}



export interface ReadinessParams {
  bootEnv: NodeJS.ProcessEnv;
  settings: AnycodeSettings;
  getSecret: SecretReader;
  /**
   * Slice 2.5: the vault key whose decryptable presence means "credential set"
   * for the SELECTED catalog provider — `provider.<id>.apiKey` (api_key auth) or
   * `provider.<id>.oauth` (oauth: an entry present = signed in; an expired access
   * token is refreshed by the broker, so mere presence gates readiness). Main
   * derives it from the catalog. `undefined` = legacy `provider.apiKey`
   * (byte-for-byte 2.2).
   */
  credentialKey?: SecretKey;
}

/**
 * providerReady = apiKey(env|vault) && model(env|settings) — the auto-tab gate
 * (§6). apiKey is ready when the boot snapshot carries a non-blank
 * ANYCODE_API_KEY OR the vault yields a decryptable value for the selected
 * provider's `credentialKey` (a present-but-undecryptable entry counts as unset,
 * ruling §1: user re-enters). model is ready from env or the settings default.
 */
export async function computeProviderReady(params: ReadinessParams): Promise<boolean> {
  const { bootEnv, settings, getSecret } = params;
  const credentialKey = params.credentialKey ?? "provider.apiKey";
  const apiKeyReady =
    envPresent(bootEnv, ENV_API_KEY) || hasValue(await getSecret(credentialKey));
  const modelReady = envPresent(bootEnv, ENV_MODEL) || hasValue(settings.provider.model);
  return apiKeyReady && modelReady;
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** True when the boot snapshot carries a non-blank value for this env var. */
export function bootEnvHas(bootEnv: NodeJS.ProcessEnv, name: string): boolean {
  return envPresent(bootEnv, name);
}

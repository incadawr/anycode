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
import { activeProviderView, SECRET_ENV_KEYS } from "../shared/settings.js";

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
/**
 * Wire transport override (TASK.43 W5). Literal mirrors core's
 * `provider/env.ts` `ENV_PROVIDER_TRANSPORT` — same local-literal convention
 * as every other var above (host-env stays core-free).
 */
export const ENV_PROVIDER_TRANSPORT = "ANYCODE_PROVIDER_TRANSPORT";

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
  // Connection-scoped keys (TASK.45): provider.connection.<connectionId>.{apiKey,oauth}.
  // The connectionId carries no dots (opaque `conn-<uuid>` ids), so it is a
  // `[^.]+` segment; connection-graph membership is enforced at the CRUD boundary.
  const connMatch = /^provider\.connection\.([^.]+)\.(apiKey|oauth)$/.exec(key);
  if (connMatch !== null) {
    return connMatch[1] !== undefined && connMatch[1].length > 0;
  }
  const match = /^provider\.(.+)\.(apiKey|oauth)$/.exec(key);
  if (match === null) {
    return false;
  }
  const providerId = match[1];
  return providerId !== undefined && providerId.length > 0 && catalogIds.includes(providerId);
}

/** The vault key a connection's credential lives under (TASK.45): connection-scoped. */
export function connectionSecretKey(connectionId: string, authKind: "api_key" | "oauth"): SecretKey {
  return authKind === "oauth"
    ? `provider.connection.${connectionId}.oauth`
    : `provider.connection.${connectionId}.apiKey`;
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
  ENV_PROVIDER_TRANSPORT,
];

/** True when an env var is present AND non-blank (mirrors loadEnvConfig's own test). */
function envPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

/** Where the effective transport came from (drives both readiness and fork-env emission). */
export type EffectiveTransportSource = "env" | "settings" | "catalog-default" | "unset";

export interface EffectiveTransport {
  /** The resolved transport id, or undefined when nothing selects one ("unset"). */
  value?: string;
  source: EffectiveTransportSource;
}

/**
 * The ONE normative transport ladder (TASK.43 W5-FIX, cut Risk #3): the single
 * authority every readiness guard and every fork-env emission consumes, so they
 * can never disagree about which transport a fork actually runs. Rungs:
 *
 *   nonblank bootEnv[ANYCODE_PROVIDER_TRANSPORT]  ->  source "env"
 *   nonblank settingsTransport                    ->  source "settings"
 *   defined defaultTransport (catalog default)    ->  source "catalog-default"
 *   otherwise                                     ->  source "unset"
 *
 * A blank/whitespace-only env value is treated as absent, exactly like
 * `envPresent` elsewhere in this module. `source` lets `buildHostEnv` apply the
 * emission rule (an implicit anthropic-family default emits nothing) without
 * re-deriving the ladder.
 */
export function resolveEffectiveTransport(input: {
  bootEnv: NodeJS.ProcessEnv;
  settingsTransport?: string;
  defaultTransport?: string;
}): EffectiveTransport {
  if (envPresent(input.bootEnv, ENV_PROVIDER_TRANSPORT)) {
    return { value: input.bootEnv[ENV_PROVIDER_TRANSPORT], source: "env" };
  }
  if (input.settingsTransport !== undefined && input.settingsTransport.trim() !== "") {
    return { value: input.settingsTransport, source: "settings" };
  }
  if (input.defaultTransport !== undefined) {
    return { value: input.defaultTransport, source: "catalog-default" };
  }
  return { source: "unset" };
}

/**
 * The value `buildHostEnv` writes into ANYCODE_PROVIDER_TRANSPORT for the fork,
 * per the emission rule (TASK.43 W5-FIX): only an explicit user selection
 * (source "settings") or a NON-anthropic catalog default is emitted. An env
 * value is already carried in `{...bootEnv}` and is never re-emitted; an
 * implicit anthropic-family catalog default emits NOTHING, so the anthropic /
 * z-ai(GLM) / deepseek / moonshot / custom fork env stays byte-identical to
 * pre-W5. Returns undefined for the "no emission" cases.
 */
function transportToEmit(resolved: EffectiveTransport): string | undefined {
  if (resolved.source === "settings") {
    return resolved.value;
  }
  if (resolved.source === "catalog-default" && resolved.value !== "anthropic-messages") {
    return resolved.value;
  }
  return undefined;
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
  /**
   * The selected catalog entry's RAW `defaultTransport` (TASK.43 W5-FIX). The
   * effective transport ladder (env > settings.provider.transport > this
   * default) is applied by `buildHostEnv` via the single
   * `resolveEffectiveTransport` authority — this projection deliberately does
   * NOT pre-resolve it, so the catalog fork-env path and the readiness guards
   * can never disagree. Undefined = no catalog entry (legacy path).
   */
  defaultTransport?: string;
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
  /**
   * TASK.45 v2: resolves the ACTIVE connection's credential (its connection key)
   * for the legacy/custom/no-active branch — main computes it because host-env is
   * core-free (it cannot derive the auth kind / connection key itself). Absent ->
   * the byte-for-byte 2.2 read of the bare `provider.apiKey` (used by pre-v2 unit
   * fixtures only).
   */
  resolveActiveCredential?: () => Promise<string | undefined>;
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
  const { bootEnv, settings, getSecret, resolveSelection, resolveActiveCredential } = params;
  const env: NodeJS.ProcessEnv = { ...bootEnv };
  const selection = resolveSelection !== undefined ? await resolveSelection() : undefined;
  // Active-connection legacy-shaped view (TASK.45 v2): model/baseUrl/transport/
  // effort come from the ACTIVE connection, not the removed v1 singleton. Post
  // migration the active connection ≡ the former singleton, so the ladder OUTPUT
  // stays byte-equivalent (DoD #5).
  const view = activeProviderView(settings);

  if (selection === undefined) {
    // LEGACY/custom/no-active branch: the credential is the active connection's
    // connection key, resolved by main because host-env is core-free.
    // `provider.apiKey` bare-read is the pre-v2 fixture fallback only.
    // ANYCODE_AUTH_MODE is never set.
    if (!envPresent(env, ENV_API_KEY)) {
      const cred =
        resolveActiveCredential !== undefined ? await resolveActiveCredential() : await getSecret("provider.apiKey");
      if (cred !== undefined && cred !== "") {
        env[ENV_API_KEY] = cred;
      }
    }
    fillFromSettings(env, ENV_MODEL, view.model);
    fillFromSettings(env, ENV_BASE_URL, view.baseUrl);
  } else {
    // CATALOG path (slice 2.5): main already resolved the active connection's
    // credential (an api key, or an OAuth access token via the TokenBroker).
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

  // Wire transport (TASK.43 W5-FIX, cut Risk #3): ONE ladder authority for BOTH
  // branches. `defaultTransport` is the selected catalog entry's raw default
  // (undefined on the legacy/no-catalog path). The emission rule suppresses an
  // implicit anthropic-family default so the anthropic/GLM/deepseek/moonshot/
  // custom fork env stays byte-identical to pre-W5; an env value already rides
  // in `{...bootEnv}` and `fillFromSettings` never overwrites it.
  const effectiveTransport = resolveEffectiveTransport({
    bootEnv,
    settingsTransport: view.transport,
    defaultTransport: selection?.defaultTransport,
  });
  fillFromSettings(env, ENV_PROVIDER_TRANSPORT, transportToEmit(effectiveTransport));

  fillFromSettings(env, ENV_TOOL_CONCURRENCY, numToStr(settings.tools.concurrency));
  fillFromSettings(env, ENV_STALL_TIMEOUT_MS, numToStr(settings.tools.stallTimeoutMs));
  fillFromSettings(env, ENV_MAX_TURNS, numToStr(settings.tools.maxTurns));
  // Reasoning-effort inheritance rung (F14 §2.4): a new host boot inherits the
  // active connection's last chosen effort instead of hardcoded `off`. Env still
  // wins by construction (fillFromSettings).
  fillFromSettings(env, ENV_REASONING_EFFORT, view.reasoningEffort);

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
  /**
   * Auth-policy override (TASK.43 W5, cut Risk #3): true waives the apiKeyReady
   * requirement entirely. Set by the caller for a catalog entry marked
   * `authOptional` (vLLM), or for `custom` on a resolved openai-family
   * transport (mirrors core's `loadEnvConfig` — a key is only ever mandatory
   * on `anthropic-messages`). Undefined/false keeps the byte-compat
   * fail-closed default: anthropic and every other `api_key` provider still
   * require a key regardless of transport.
   */
  authOptional?: boolean;
  /**
   * The transport actually in effect for the selected provider (env >
   * settings.provider.transport > catalog default ladder), paired with
   * `supportedTransports` below to block readiness on an unsupported
   * combination instead of silently falling back (cut Risk #3). Undefined
   * skips the guard (legacy path — no catalog entry to validate against).
   */
  resolvedTransport?: string;
  /** supportedTransports of the selected catalog entry; undefined skips the unsupported-transport guard. */
  supportedTransports?: readonly string[];
}

/**
 * providerReady = apiKey(env|vault) && model(env|settings) — the auto-tab gate
 * (§6). apiKey is ready when the boot snapshot carries a non-blank
 * ANYCODE_API_KEY OR the vault yields a decryptable value for the selected
 * provider's `credentialKey` (a present-but-undecryptable entry counts as unset,
 * ruling §1: user re-enters) OR `authOptional` waives the requirement (TASK.43
 * W5). model is ready from env or the settings default. Readiness is blocked
 * outright when the resolved transport is not one the selected catalog entry
 * supports (TASK.43 W5 cut Risk #3) — never a silent anthropic fallback.
 */
export async function computeProviderReady(params: ReadinessParams): Promise<boolean> {
  const { bootEnv, settings, getSecret } = params;
  if (
    params.resolvedTransport !== undefined &&
    params.supportedTransports !== undefined &&
    !params.supportedTransports.includes(params.resolvedTransport)
  ) {
    return false;
  }
  const credentialKey = params.credentialKey ?? "provider.apiKey";
  const credential = await getSecret(credentialKey);
  const apiKeyReady = params.authOptional === true || envPresent(bootEnv, ENV_API_KEY) || hasValue(credential);
  const modelReady = envPresent(bootEnv, ENV_MODEL) || hasValue(activeProviderView(settings).model);
  return apiKeyReady && modelReady;
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** True when the boot snapshot carries a non-blank value for this env var. */
export function bootEnvHas(bootEnv: NodeJS.ProcessEnv, name: string): boolean {
  return envPresent(bootEnv, name);
}

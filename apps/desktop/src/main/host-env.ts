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
import type { EngineProxyCarrier } from "../shared/engines.js";
import {
  encodeEngineProxyCarrier,
  ENV_CLAUDE_PROXY_URL,
  ENV_CODEX_PROXY_URL,
  LOOPBACK_NO_PROXY,
  stripEngineProxyCarriers,
} from "../shared/engines.js";
import type {
  MaterializedProxy,
  ProxyMaterializationDeps,
  ProxyRung,
  ProxyScopeId,
} from "../shared/proxy.js";
import {
  composeProxyUrl,
  engineProxyChain,
  hostForkProxyChain,
  isProxyProfileSecretKey,
  isProxyProfileUrl,
  PROXY_PROFILE_SECRET_KEY_RE,
  resolveProxyLadder,
} from "../shared/proxy.js";
import type { AnycodeSettings, CustomProviderRecord, SecretEnvKey, SecretKey } from "../shared/settings.js";
import { activeProviderView, isProxyUrl, SECRET_ENV_KEYS } from "../shared/settings.js";

// ── env var names (mirror core/provider/env.ts by contract; local literals so
// main never value-imports the core runtime, same reasoning as main/index.ts) ──

export const ENV_API_KEY = "ANYCODE_API_KEY";
export const ENV_MODEL = "ANYCODE_MODEL";
export const ENV_BASE_URL = "ANYCODE_BASE_URL";
export const ENV_TOOL_CONCURRENCY = "ANYCODE_TOOL_CONCURRENCY";
export const ENV_STALL_TIMEOUT_MS = "ANYCODE_STALL_TIMEOUT_MS";
export const ENV_MAX_TURNS = "ANYCODE_MAX_TURNS";
/** Subagent turn budget; literal mirror of core's `provider/env.ts` ENV_SUBAGENT_MAX_TURNS. */
export const ENV_SUBAGENT_MAX_TURNS = "ANYCODE_SUBAGENT_MAX_TURNS";
/**
 * Reasoning-effort inheritance rung (F14, slice-P7.15-cut.md §2.4). Literal
 * mirrors core's `provider/env.ts:11` (host already reads this into
 * `envConfig.reasoningEffort` on every fork boot — zero host/core delta here).
 */
export const ENV_REASONING_EFFORT = "ANYCODE_REASONING_EFFORT";
/**
 * Explicit output-token ceiling (TASK.150). Literal mirror of core's
 * `provider/env.ts:12` ENV_MAX_OUTPUT_TOKENS — same local-literal convention
 * as every other var above (host-env stays core-free, never value-imports the
 * core runtime).
 */
export const ENV_MAX_OUTPUT_TOKENS = "ANYCODE_MAX_OUTPUT_TOKENS";
/**
 * Wire transport override (TASK.43 W5). Literal mirrors core's
 * `provider/env.ts` `ENV_PROVIDER_TRANSPORT` — same local-literal convention
 * as every other var above (host-env stays core-free, never value-imports the
 * core runtime).
 */
export const ENV_PROVIDER_TRANSPORT = "ANYCODE_PROVIDER_TRANSPORT";
/**
 * Usage-streaming override (TASK.158): `1/true/on` or `0/false/off`; an
 * explicit value wins over resolveIncludeUsage's transport-conditional default
 * (default-on for openai-chat-completions, the escape hatch for strict
 * servers). Literal mirror of core's `provider/env.ts`
 * `ENV_INCLUDE_USAGE` — same local-literal convention (host-env stays
 * core-free). Registered in PROVIDER_ENV_KEYS so the settings UI shows the
 * env-override warning; there is deliberately NO settings field or
 * `fillFromSettings` step: ambient/shell env is the desktop user's opt-out.
 */
export const ENV_INCLUDE_USAGE = "ANYCODE_INCLUDE_USAGE";
/**
 * The provider connection pinned to a tab's session (TASK.45 W10). Informational
 * for the host: it is NOT a secret and NOT a credential — the resolved
 * credential rides ANYCODE_API_KEY as before. The host only reads this to persist
 * the pin into its session metadata (host/index.ts), so a resume resolves the
 * same connection. Stamped per-fork by the TabHostManager from `TabHost.connectionId`,
 * never baked into the shared boot env, so a legacy (unpinned) tab carries none.
 */
export const ENV_CONNECTION_ID = "ANYCODE_CONNECTION_ID";

/**
 * The four proxy env vars a connection's `proxyUrl` materialises as (TASK.132),
 * treated as ONE atomic family — see `applyConnectionProxy`. Both cases of both
 * names are emitted because the consumers disagree: node/undici reads the
 * uppercase pair, while curl-convention tools (and several CLI runtimes) prefer
 * the lowercase one. `ALL_PROXY` is deliberately absent — undici ignores it and
 * overriding it would change terminal-launch semantics for the engine children.
 */
const PROXY_FAMILY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

/**
 * The exemption list, its own atomic pair for the same reason as the family
 * above — and a sharper one: undici resolves `no_proxy` BEFORE `NO_PROXY`, so
 * writing only the lowercase key would SHADOW a shell-exported uppercase
 * exemption and quietly route the very hosts the user excluded through the
 * proxy. Measured on Electron 43: shell `NO_PROXY=target.invalid` + our
 * `no_proxy=localhost,…` → the proxy received CONNECT for target.invalid;
 * with the lowercase key absent the same request went direct.
 */
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

// The loopback exemption (`LOOPBACK_NO_PROXY`) moved to ../shared/engines.ts in
// TASK.139: the engine-proxy override writes the identical value from a module
// the host side can import, and two copies of a measured constant is exactly the
// kind of drift that silently un-exempts an IPv6 loopback endpoint.

/**
 * Node's opt-in switch for env-driven proxying of the GLOBAL fetch (undici's
 * `EnvHttpProxyAgent`). Measured on Electron 43 / node 24: without it the proxy
 * vars are inert for `globalThis.fetch`, which is how the host talks to a
 * provider.
 */
const ENV_NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";

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
 *
 * TASK.141 fail-closed belt (the `customProviderSecretKey` precedent): a
 * proxy-profile password is NOT a provider credential and has no fork-env
 * materialisation at all — it is composed into a proxy URL in main and rides the
 * HTTP(S)_PROXY family, never `ANYCODE_API_KEY`. Answering "ANYCODE_API_KEY" for
 * such a key would be a category error whose visible symptom is a host fork
 * booting on a proxy password as its provider credential, so the key is refused
 * loudly instead. Every legitimate caller either holds a provider key already or
 * filters with `isProxyProfileSecretKey` (main/vault.ts's status projection), so
 * this never trips in normal flow.
 */
export function secretEnvFor(key: SecretKey): SecretEnvKey {
  if (isProxyProfileSecretKey(key)) {
    throw new Error(
      `secretEnvFor refuses a proxy-profile key (${key}) — a proxy password has no host-env materialisation (TASK.141 §5)`,
    );
  }
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
  // Proxy-profile password (TASK.141 §5): `proxy.profile.<id>.password`. Same
  // `[^.]+`-segment shape and same division of labour as the connection keys —
  // the id's membership in the registry is enforced at the CRUD boundary
  // (main/settings-ipc.ts), this predicate only says the key is well-formed and
  // belongs to a namespace this app owns. Being recognised here is also what
  // surfaces the key in `Vault.statuses`, which is the ONLY way the renderer
  // learns `passwordSet` — the value itself never crosses back.
  const proxyMatch = PROXY_PROFILE_SECRET_KEY_RE.exec(key);
  if (proxyMatch !== null) {
    return proxyMatch[1] !== undefined && proxyMatch[1].length > 0;
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
 * Every custom-provider id currently in settings (owner-decision #6, cut
 * §9.2, TASK.54). A custom provider's vault key (`provider.<id>.apiKey`) is
 * only ever recognized by `isKnownSecretKey`/`Vault.statuses` when its id is
 * present in the `catalogIds` array those callers are given — main is
 * expected to union this with `catalogProviderIds()` (mirrors the existing
 * `catalogProviderIds() ∪ custom[].id` seam described in TASK.54) before
 * passing `catalogIds` down, the same way it already includes every builtin
 * catalog id.
 */
export function customProviderIds(settings: AnycodeSettings): string[] {
  return (settings.provider.custom ?? []).map((entry) => entry.id);
}

// ── custom-provider host-env route (F-G-B, cut §9.2) ──

/** Namespace prefix of user-created custom-provider ids (`custom:<slug>`, cut §9.2). */
const CUSTOM_PROVIDER_PREFIX = "custom:";

/**
 * True when a providerId names a user-created custom-provider RECORD
 * (`custom:<slug>`). Deliberately distinct from the builtin catalog `custom`
 * SENTINEL (the bare literal, no colon), which keeps its pre-existing
 * legacy-branch behaviour in `buildHostEnv`.
 */
export function isCustomProviderRecordId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/**
 * The vault key a custom provider's ONE shared credential lives under —
 * `provider.<custom-id>.apiKey`, one key per PROVIDER covering all of its
 * connections (design §9.2 "key into the existing vault"). Mirrors
 * provider-ipc.ts's own `customProviderSecretKey` by contract — that module
 * keeps its own copy rather than importing this one (host-env stays
 * electron/zod-free of the IPC module), the same convention as the core
 * env-var mirrors at the top of this file. Exported (FX4) so index.ts's and
 * settings-ipc.ts's readiness-gate `activeCredential` can route a
 * `custom:*` providerId at its real vault key instead of the connection key.
 */
export function customProviderSecretKey(id: string): SecretKey {
  // W4-R1-M1 belt (defense-in-depth): a custom-provider vault key derives ONLY
  // from the `custom:` namespace. The renderer-reachable exfil path is closed
  // one layer up (settings/schema.ts drops any custom record whose id is not
  // `custom:*`); this fail-closed refusal is the second layer for the
  // readiness-gate callers in index.ts / settings-ipc.ts, so a cross-namespace
  // id can never mint `provider.connection.<victim>.apiKey` /
  // `provider.<catalog-id>.apiKey` and read a foreign namespace's secret. Every
  // legitimate caller already gates on `isCustomProviderRecordId`, so this never
  // trips in normal flow. (provider-ipc.ts keeps its own byte-mirror copy — its
  // fetch-models path is guarded by the schema drop, not this belt.)
  if (!isCustomProviderRecordId(id)) {
    throw new Error(`customProviderSecretKey refuses a non-custom:* namespace id (${id}) — cross-namespace vault access is fail-closed (W4-R1-M1)`);
  }
  return `provider.${id}.apiKey`;
}

/**
 * The record a `custom:*` providerId points at; undefined = deleted while a
 * connection still references it. Exported (FX4) so the readiness-gate
 * `selectedTransportInfo` in index.ts/settings-ipc.ts can look up a custom
 * record's `kind` the same way `buildHostEnv` already does.
 */
export function findCustomProviderRecord(settings: AnycodeSettings, id: string): CustomProviderRecord | undefined {
  return (settings.provider.custom ?? []).find((entry) => entry.id === id);
}

/**
 * The default transport a custom record's `kind` implies, mirroring the
 * builtin catalog entry of the same kind (anthropic -> the anthropic entry's
 * "anthropic-messages", openai -> the openai entry's "openai-responses",
 * openai-compatible -> the openrouter/vllm family's "openai-chat-completions").
 * Fed into the SAME `resolveEffectiveTransport` ladder + emission rule a
 * catalog default rides, so an anthropic-kind default emits NOTHING (byte
 * parity with the builtin anthropic-family entries) while an explicit
 * env/settings transport still wins by construction. Exported (FX4) — same
 * readiness-gate seam as the two exports above.
 */
export function customKindDefaultTransport(kind: CustomProviderRecord["kind"]): string {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
      return "openai-chat-completions";
  }
}

/**
 * The transports a custom record's `kind` supports — mirrors the builtin
 * catalog family of the same kind (anthropic entries only ever support
 * `anthropic-messages`; the openai/openai-compatible families support both
 * openai-shaped transports, mirroring the openai/openrouter/vllm catalog
 * entries). Fed into `computeProviderReady`'s `supportedTransports` guard
 * (FX4) — without this, a `custom:*` record had NO supported-transport guard
 * at all in the readiness gate, silently accepting an unsupported transport
 * combination that `buildHostEnv` would actually run.
 */
export function customSupportedTransports(kind: CustomProviderRecord["kind"]): readonly string[] {
  switch (kind) {
    case "anthropic":
      return ["anthropic-messages"];
    case "openai":
      return ["openai-responses", "openai-chat-completions"];
    case "openai-compatible":
      return ["openai-chat-completions", "openai-responses"];
  }
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
  ENV_SUBAGENT_MAX_TURNS,
  ENV_REASONING_EFFORT,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_PROVIDER_TRANSPORT,
  ENV_INCLUDE_USAGE,
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
 *
 * The one thing the snapshot does NOT preserve is the engine-proxy carrier
 * namespace (TASK.139 F1): those two names are main's private main→child
 * transport, so an ambient value is dropped at the origin and every consumer of
 * this snapshot — the fork env, the doctor/login source env, the discovery
 * ladder — is carrier-clean by construction. `engineProxyCarriers` is the only
 * writer. See `stripEngineProxyCarriers` for why these names are stripped while
 * every other ambient `ANYCODE_*` is honoured.
 */
export function snapshotBootEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const snapshot: NodeJS.ProcessEnv = { ...env };
  stripEngineProxyCarriers(snapshot);
  return snapshot;
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

/**
 * Injects (or clears) the dev/automation-only `ANYCODE_CODEX_PROFILES_HOME`
 * override into a host fork's env (codex-profiles W4-F0b, Fable ruling
 * iter-10). Sibling of `applySubagentsHomeOverride` above — duplicated on
 * purpose, NOT generalized. The delete branch is the structural guarantee the
 * host's trust rests on: `buildHostEnv` starts from a spread of the bootEnv
 * snapshot, so a raw ambient value from the owner's shell would otherwise
 * ride into the host fork ungated. `override === null` (gate refused / var
 * absent) deletes it — the byte-for-byte packaged-production path; a non-null
 * override sets main's already-vetted value so the host-side defense-in-depth
 * reader (`resolveCodexProfilesHomeOverride`, host/engines/codex/codex-home.ts)
 * can see it.
 */
export function applyCodexProfilesHomeOverride(env: NodeJS.ProcessEnv, override: string | null): void {
  if (override === null) {
    delete env.ANYCODE_CODEX_PROFILES_HOME;
  } else {
    env.ANYCODE_CODEX_PROFILES_HOME = override;
  }
}

/**
 * True when the BOOT env declares any member of the proxy family — the one
 * shell-wins gate of this whole slice (design review B-01).
 *
 * "Declares" means the name EXISTS, empty string included, and that is the
 * owner's rule read literally: the shell wins BY FAMILY. `export HTTPS_PROXY=`
 * is a statement — "this shell wants no proxy for https" — and a settings value
 * that filled the family behind it would override an explicit shell decision
 * with a stored one. Everywhere else in this module presence means "present AND
 * non-blank" (`envPresent`, mirroring loadEnvConfig); the proxy family is the
 * deliberate exception, and the difference is why it has its own predicate.
 *
 * ONE gate for both consumers below (the fork family and the engine carriers),
 * so a scope cannot be silenced down one path and heard down the other.
 * `ALL_PROXY` is deliberately NOT a member — see `ALL_PROXY_KEYS` in
 * shared/engines.ts for the measurement that decision is waiting on.
 */
function shellOwnsProxyFamily(bootEnv: NodeJS.ProcessEnv): boolean {
  return PROXY_FAMILY_KEYS.some((name) => bootEnv[name] !== undefined);
}

/**
 * Materialises the fork's resolved proxy (TASK.132's connection field,
 * generalised to the TASK.141 ladder) into a host fork's env as the
 * HTTP(S)_PROXY family + the loopback `NO_PROXY` exemption +
 * `NODE_USE_ENV_PROXY=1`. The host's own global fetch honours it through
 * undici's env-proxy agent; the claude/codex children inherit the family
 * through their existing env allow-lists and proxy themselves natively.
 *
 * SHELL-WINS IS AN EARLY RETURN, before ANY write (design review B-01). The gate
 * is family-atomic rather than the per-var `fillFromSettings` used everywhere
 * else in this module, and it now covers the whole emission rather than just the
 * four proxy names:
 *  - filling only the vars the shell left blank (shell `HTTPS_PROXY=X` + our
 *    `https_proxy=Y`) would let the settings value beat the shell's under the
 *    lowercase-first precedence curl and undici follow;
 *  - and emitting `NO_PROXY` / `NODE_USE_ENV_PROXY` "anyway" — which is what
 *    this function used to do — is not a smaller version of the same intent. It
 *    rewrites the shell's exemption list and switches the host's own fetch onto
 *    the shell's proxy, both of which the shell did not ask for. "The shell owns
 *    the family, settings emit NOTHING" is the whole rule, so nothing is what
 *    gets emitted.
 *
 * The cost of the stricter reading is named rather than hidden: with a
 * shell-exported proxy AND a configured profile, the host's own `fetch` no
 * longer has `NODE_USE_ENV_PROXY` switched on for it, so it goes direct exactly
 * as it did before TASK.132 existed. A shell that wants the host's fetch
 * proxied can export `NODE_USE_ENV_PROXY=1` itself, which is a variable it
 * already owns.
 *
 * With no (or an unparseable) proxy this emits NOTHING either, so a fork's env
 * stays byte-identical to pre-TASK.132 in every case. A value that fails
 * `isProxyUrl` is fail-soft for the same reason a hand-edited settings.json must
 * not break every request: it degrades to "no proxy", never to a broken env.
 */
export function applyConnectionProxy(
  env: NodeJS.ProcessEnv,
  bootEnv: NodeJS.ProcessEnv,
  proxy: MaterializedProxy | undefined,
): void {
  if (shellOwnsProxyFamily(bootEnv)) {
    return;
  }
  if (proxy === undefined || proxy.url.trim() === "" || !isProxyUrl(proxy.url)) {
    return;
  }
  for (const name of PROXY_FAMILY_KEYS) {
    env[name] = proxy.url;
  }
  // Atomic for the shadowing reason in NO_PROXY_KEYS — a shell that named its
  // own exemptions keeps both keys untouched (that check stays `envPresent`:
  // an empty `NO_PROXY=""` names no exemptions, so there is nothing of the
  // shell's to preserve).
  //
  // TASK.141: a profile's own exemptions are APPENDED to the loopback default,
  // never substituted for it — a list that replaced it would send a local
  // Ollama/vLLM endpoint (and every loopback MCP server) through the proxy. Both
  // cases get the identical composed string, atomically, for the shadowing
  // reason above.
  if (!NO_PROXY_KEYS.some((name) => envPresent(bootEnv, name))) {
    for (const name of NO_PROXY_KEYS) {
      env[name] = composeNoProxy(proxy.noProxy);
    }
  }
  fillFromSettings(env, ENV_NODE_USE_ENV_PROXY, "1");
}

/** The loopback default with a profile's own exemptions appended (never replacing it). */
function composeNoProxy(extra: string | undefined): string {
  const trimmed = extra?.trim() ?? "";
  return trimmed === "" ? LOOPBACK_NO_PROXY : `${LOOPBACK_NO_PROXY},${trimmed}`;
}

// ── proxy-registry materialisation (TASK.141) ──

/**
 * Re-exported so the existing main-side import sites keep one import path; the
 * contract itself lives in shared/proxy.ts, next to `SystemProxyResolver`, since
 * lane B's resolver and lane C's editor both need it and neither may import from
 * main.
 */
export type { ProxyMaterializationDeps };

/**
 * The system-proxy answer for THIS materialisation's target, flattened to the
 * proxy url an env can carry (design review B-10).
 *
 * Both "no resolver" and "no target" yield DIRECT rather than borrowing another
 * target's answer: one global system-proxy value cannot serve a PAC that routes
 * two hosts differently, and a wrong proxy is a worse failure than no proxy.
 */
function systemProxyBase(deps: ProxyMaterializationDeps): string | undefined {
  if (deps.systemProxy === undefined || deps.targetUrl === undefined) {
    return undefined;
  }
  const outcome = deps.systemProxy.cached(deps.targetUrl);
  return outcome.kind === "proxy" ? outcome.url : undefined;
}

/**
 * Turns the rung a ladder picked into what an env needs, or `undefined` for
 * "direct" (TASK.141 §2). Every failure mode collapses to DIRECT rather than to
 * the rung below — a dangling ref, a profile whose `url` was hand-edited into
 * garbage, a `system` profile with nothing resolved: an explicit rung with a
 * broken value must not silently route this scope's traffic into another rung's
 * proxy, which is the same law TASK.132 applied to a malformed `proxyUrl`.
 *
 * The one rung that is NOT registry-shaped — a legacy `proxyUrl` string — is
 * materialised verbatim, byte-for-byte its TASK.132/139 semantics, because that
 * is the whole promise "legacy strings keep working with no user action" makes.
 */
export function materializeProxyRung(
  rung: ProxyRung | undefined,
  deps: ProxyMaterializationDeps = {},
): MaterializedProxy | undefined {
  if (rung === undefined) {
    return undefined;
  }
  if (rung.legacyUrl !== undefined) {
    return isProxyUrl(rung.legacyUrl) ? { url: rung.legacyUrl } : undefined;
  }
  const profile = rung.profile;
  if (profile === undefined) {
    return undefined; // `direct`, or a dangling ref — same outcome by law.
  }
  const base = profile.mode === "system" ? systemProxyBase(deps) : profile.url;
  if (base === undefined || base.trim() === "") {
    return undefined;
  }
  // A hand-edited profile URL is held to the SAME rule the editor enforces
  // (`isProxyProfileUrl`): userinfo in the host field would put a password back
  // into the plaintext settings.json this slice just moved it out of, so such a
  // value is not honoured — it degrades to direct like any other broken value.
  // A `system` answer comes from Chromium and never carries userinfo.
  if (!isProxyProfileUrl(base)) {
    return undefined;
  }
  const url = composeProxyUrl(base, profile.login, deps.proxyPassword?.(profile.id));
  if (url === undefined) {
    return undefined;
  }
  return profile.noProxy !== undefined && profile.noProxy.trim() !== ""
    ? { url, noProxy: profile.noProxy }
    : { url };
}

/**
 * The materialised proxy for ONE chain, or undefined for "direct"/"nothing
 * said" — the single call every consumer makes instead of re-deriving the
 * ladder plus the materialisation separately.
 */
export function resolveProxyFor(
  settings: AnycodeSettings,
  chain: readonly ProxyScopeId[],
  deps: ProxyMaterializationDeps = {},
): MaterializedProxy | undefined {
  return materializeProxyRung(resolveProxyLadder(settings, chain), deps);
}

/**
 * The ASYNC half of the same resolution (design review B-10): the fork path, and
 * the only place a FRESH `session.resolveProxy` is awaited.
 *
 * The split is not a convenience wrapper. Sync consumers (the engine carriers,
 * the doctor stubs) cannot await anything and must read the cache for their own
 * target; the fork path can, and it is composing the env a real spawn will use,
 * so it takes a fresh answer for the target THAT fork is pinned to. Two pinned
 * connections therefore each resolve their own endpoint instead of racing over
 * one shared slot.
 *
 * The freshly-taken outcome is used directly rather than re-read through
 * `cached` after the await: between the two, a resolve for a DIFFERENT target
 * may have landed, and re-reading would reintroduce exactly the cross-target
 * mix-up this keying exists to remove.
 */
export async function resolveProxyForAsync(
  settings: AnycodeSettings,
  chain: readonly ProxyScopeId[],
  deps: ProxyMaterializationDeps = {},
): Promise<MaterializedProxy | undefined> {
  const rung = resolveProxyLadder(settings, chain);
  const resolver = deps.systemProxy;
  const targetUrl = deps.targetUrl;
  if (rung?.profile?.mode !== "system" || resolver === undefined || targetUrl === undefined) {
    return materializeProxyRung(rung, deps);
  }
  const fresh = await resolver.resolve(targetUrl);
  return materializeProxyRung(rung, {
    ...deps,
    // A resolver pinned to the answer just taken for this exact target.
    systemProxy: { cached: () => fresh, resolve: (url) => resolver.resolve(url) },
  });
}

/**
 * The engine-level proxy carriers (TASK.139) main stamps into EVERY host fork's
 * engine overlay, and the single authority the doctor/login spawn sites read
 * through as well. Returns only the keys that should exist — an absent key is
 * how "no engine proxy" is expressed, so the result spreads into an env literal
 * without changing a byte when it is empty.
 *
 * The shell-wins gate is ONE family-atomic check covering BOTH engines: if the
 * shell exported any of the four proxy vars it owns the network path for
 * everything this app spawns, and no setting emits anything anywhere. That gate
 * living here — and only here — is what licenses `applyEngineProxyOverride` to
 * clobber the proxy family unconditionally on the other side; see its doc.
 *
 * A malformed value is fail-soft (key omitted), not fatal: `settings.codex` /
 * `settings.claude` carry a LENIENT persisted schema, so a hand-edited or
 * generic-`settings-set`-written value can be anything, and the worst it may
 * ever mean is "this engine gets no proxy".
 *
 * `NODE_USE_ENV_PROXY` is deliberately not part of this: the carriers configure
 * ENGINE CHILDREN (a Rust binary and a CLI that read the proxy env natively),
 * never the host's own `fetch`, whose proxying stays connection-governed.
 */
export function engineProxyCarriers(
  settings: AnycodeSettings,
  bootEnv: NodeJS.ProcessEnv,
  deps: ProxyMaterializationDeps = {},
): NodeJS.ProcessEnv {
  const carriers: NodeJS.ProcessEnv = {};
  const codex = engineProxyCarrierValue(settings, bootEnv, "codex", false, deps);
  if (codex !== undefined) {
    carriers[ENV_CODEX_PROXY_URL] = codex;
  }
  const claude = engineProxyCarrierValue(settings, bootEnv, "claude", false, deps);
  if (claude !== undefined) {
    carriers[ENV_CLAUDE_PROXY_URL] = claude;
  }
  return carriers;
}

/**
 * The value ONE engine's carrier should hold: a materialised proxy URL, the
 * `PROXY_CARRIER_DIRECT` sentinel, or undefined for "emit nothing" (TASK.141
 * §8). The shell-wins gate lives here, so every consumer — the per-fork overlay
 * above and main's doctor/login stubs — inherits it from one place.
 *
 * `includeApp` selects the traffic class, and the difference is not cosmetic:
 *  - a TAB/subagent child (`false`) gets the engine rung ALONE, because its
 *    connection and app rungs are already materialised into the host fork's env
 *    and reach it through the builders' passthrough lists. Adding the app rung
 *    here would make the ENGINE carrier clobber a connection proxy that ranks
 *    ABOVE the app rung — inverting the ladder;
 *  - a DOCTOR/`codex login` child (`true`) has no connection rung by
 *    construction (it is connection-less) and no host fork to inherit from, so
 *    the app rung has to arrive through the carrier or not at all.
 *
 * The engine's effective `noProxy` DOES ride the carrier (design review B-02),
 * together with the licence to rewrite the exemption pair. The licence is
 * decided here because only here is the boot snapshot still visible: main knows
 * whether the shell owns `NO_PROXY`, the child builder cannot tell a
 * shell-exported value from one `applyConnectionProxy` wrote. Without it, the
 * connection rung's exemptions silently applied to an engine that had selected a
 * different proxy — traffic to an exempt host left the engine's proxy entirely —
 * and an engine-scoped profile's own exemptions reached nothing.
 */
export function engineProxyCarrierValue(
  settings: AnycodeSettings,
  bootEnv: NodeJS.ProcessEnv,
  engine: "codex" | "claude",
  includeApp: boolean,
  deps: ProxyMaterializationDeps = {},
): string | undefined {
  return encodeEngineProxyCarrier(engineProxyOutcome(settings, bootEnv, engine, includeApp, deps));
}

/**
 * What ONE engine's rung resolves to, as a DISCRIMINATED outcome (design review
 * B-03). The distinction the previous `ref === "direct"` test could not make is
 * the whole point: `absent` (no rung spoke) and `direct` (an explicit rung
 * resolved to no proxy) are opposite instructions to the child builder, and the
 * ways of REACHING direct are many — `proxyRef:"direct"`, a dangling id, a
 * hand-broken url, a `system` profile the OS answered DIRECT for. Every one of
 * them has to emit the sentinel, because the connection's proxy is already in
 * the child env via the passthrough list and staying silent would leave the
 * engine on it — routing traffic through someone else's proxy after the user
 * explicitly said "none".
 */
export function engineProxyOutcome(
  settings: AnycodeSettings,
  bootEnv: NodeJS.ProcessEnv,
  engine: "codex" | "claude",
  includeApp: boolean,
  deps: ProxyMaterializationDeps = {},
): EngineProxyCarrier {
  if (shellOwnsProxyFamily(bootEnv)) {
    return { kind: "absent" };
  }
  const rung = resolveProxyLadder(settings, engineProxyChain(engine, includeApp));
  if (rung === undefined) {
    return { kind: "absent" }; // no rung spoke — the child keeps whatever it inherited.
  }
  const materialized = materializeProxyRung(rung, deps);
  if (materialized === undefined) {
    return { kind: "direct" };
  }
  // The exemption pair is the shell's whenever the shell named it; only then is
  // the licence withheld, and the child builder leaves both spellings alone.
  return NO_PROXY_KEYS.some((name) => envPresent(bootEnv, name))
    ? { kind: "proxy", url: materialized.url }
    : { kind: "proxy", url: materialized.url, noProxy: composeNoProxy(materialized.noProxy) };
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
  /**
   * TASK.141: the system-resolve / password caches the proxy registry
   * materialises through. Absent (unit fixtures, and lane A's shipped default)
   * means a `system` profile resolves DIRECT and no profile carries a password —
   * both are honest answers, never an error.
   */
  proxy?: ProxyMaterializationDeps;
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
  // TASK.139 F1: the engine-proxy carriers are main-authored, and this spread is
  // the structural hole they would otherwise ride through — same reasoning as
  // `applyCodexProfilesHomeOverride`'s delete branch above. Repeated here rather
  // than relied upon from `snapshotBootEnv` because this function accepts ANY
  // env object, and the guarantee must not depend on where the caller got it.
  // `engineEnv` (main/index.ts) puts the authoritative carriers back, spread
  // over this env at spawn time.
  stripEngineProxyCarriers(env);
  // Active-connection legacy-shaped view (TASK.45 v2): model/baseUrl/transport/
  // effort come from the ACTIVE connection, not the removed v1 singleton. Post
  // migration the active connection ≡ the former singleton, so the ladder OUTPUT
  // stays byte-equivalent (DoD #5).
  const view = activeProviderView(settings);
  // Custom-provider route (F-G-B): a `custom:<slug>` providerId resolves from
  // `settings.provider.custom[]` — the record's baseUrl verbatim plus the
  // provider's ONE shared vault key — NEVER from the catalog selection
  // (findCatalogEntry only knows builtin ids, so it would misroute to the
  // legacy branch) and NEVER from the legacy/connection-key credential ladder
  // (a DIFFERENT vault namespace; reading it would run the fork on another
  // account's credential). Decided up front, before resolveSelection is even
  // consulted, so the route cannot depend on what the selection path happens
  // to return for a custom id.
  const customId = view.id !== undefined && isCustomProviderRecordId(view.id) ? view.id : undefined;
  const customRecord = customId !== undefined ? findCustomProviderRecord(settings, customId) : undefined;
  const selection = customId === undefined && resolveSelection !== undefined ? await resolveSelection() : undefined;

  if (customId !== undefined) {
    // CUSTOM branch (F-G-B): auth is always api_key — ANYCODE_AUTH_MODE is
    // never set. A missing record (provider deleted while a connection still
    // references it) is FAIL-CLOSED: no other credential source is consulted
    // — neither the bare legacy `provider.apiKey` nor the connection key —
    // the fork boots keyless/baseUrl-less rather than on a different
    // account's secret.
    if (customRecord !== undefined) {
      if (!envPresent(env, ENV_API_KEY)) {
        const cred = await getSecret(customProviderSecretKey(customRecord.id));
        if (cred !== undefined && cred !== "") {
          env[ENV_API_KEY] = cred;
        }
      }
      fillFromSettings(env, ENV_BASE_URL, customRecord.baseUrl);
    }
    fillFromSettings(env, ENV_MODEL, view.model);
  } else if (selection === undefined) {
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

  // Wire transport (TASK.43 W5-FIX, cut Risk #3): ONE ladder authority for ALL
  // branches. `defaultTransport` is the selected catalog entry's raw default
  // (undefined on the legacy/no-catalog path), or the kind-implied default of
  // the resolved custom record (F-G-B — a deleted record contributes none, so
  // only the env/settings rungs remain). The emission rule suppresses an
  // implicit anthropic-family default so the anthropic/GLM/deepseek/moonshot/
  // custom fork env stays byte-identical to pre-W5; an env value already rides
  // in `{...bootEnv}` and `fillFromSettings` never overwrites it.
  const effectiveTransport = resolveEffectiveTransport({
    bootEnv,
    settingsTransport: view.transport,
    defaultTransport:
      customRecord !== undefined ? customKindDefaultTransport(customRecord.kind) : selection?.defaultTransport,
  });
  fillFromSettings(env, ENV_PROVIDER_TRANSPORT, transportToEmit(effectiveTransport));

  fillFromSettings(env, ENV_TOOL_CONCURRENCY, numToStr(settings.tools.concurrency));
  fillFromSettings(env, ENV_STALL_TIMEOUT_MS, numToStr(settings.tools.stallTimeoutMs));
  fillFromSettings(env, ENV_MAX_TURNS, numToStr(settings.tools.maxTurns));
  fillFromSettings(env, ENV_SUBAGENT_MAX_TURNS, numToStr(settings.tools.subagentMaxTurns));
  // Reasoning-effort inheritance rung (F14 §2.4): a new host boot inherits the
  // active connection's last chosen effort instead of hardcoded `off`. Env still
  // wins by construction (fillFromSettings).
  fillFromSettings(env, ENV_REASONING_EFFORT, view.reasoningEffort);
  // Output-token ceiling (TASK.150): the same F14 §2.4 inheritance rung as
  // ENV_REASONING_EFFORT above. `fillFromSettings` only fills a slot the boot
  // snapshot left blank, so a launching shell's own ANYCODE_MAX_OUTPUT_TOKENS
  // ALWAYS wins over the persisted connection value — this is the load-bearing
  // property of the whole ladder (env > settings), not incidental to how
  // fillFromSettings happens to be implemented.
  fillFromSettings(env, ENV_MAX_OUTPUT_TOKENS, numToStr(view.maxOutputTokens));
  // The host fork's own network path (TASK.132, generalised by TASK.141 §2
  // ladder (a)/(b)): the ACTIVE connection's rung, then the app's. Keyed off
  // `activeConnectionId` — the same handle `activeProviderView` reads — so a
  // per-tab pin (`buildHostEnvFor(settingsPinnedTo(...))`, main/index.ts) picks
  // up ITS connection's rung with no extra plumbing, exactly as before.
  // TASK.141 §4 / design review B-10: the target this fork's traffic is for is
  // the endpoint it was just configured with (`ANYCODE_BASE_URL`, after the
  // whole env > connection > catalog ladder above has run) — the honest answer
  // to "which host does a `system` profile resolve against for THIS fork". A
  // caller may override it; nobody does today. This is the async path, so it is
  // also the one place a FRESH system resolve is awaited.
  const proxyDeps: ProxyMaterializationDeps = { ...(params.proxy ?? {}) };
  if (proxyDeps.targetUrl === undefined && envPresent(env, ENV_BASE_URL)) {
    proxyDeps.targetUrl = env[ENV_BASE_URL];
  }
  applyConnectionProxy(
    env,
    bootEnv,
    await resolveProxyForAsync(settings, hostForkProxyChain(settings.provider.activeConnectionId), proxyDeps),
  );

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

/**
 * True when a live core host's provider-health event must NOT be bound to any
 * saved connection plaquette (TASK.45 W11, cut §W11 env-override rule): a
 * non-blank `ANYCODE_API_KEY` boot-snapshot override means the request that
 * just succeeded/failed actually ran on a DIFFERENT, ephemeral credential — the
 * env-override "connection" has no persisted tile to paint, so its outcome
 * would otherwise wrongly color the stored connection's plaquette.
 */
export function shouldSkipConnectionHealthBinding(bootEnv: NodeJS.ProcessEnv): boolean {
  return bootEnvHas(bootEnv, ENV_API_KEY);
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

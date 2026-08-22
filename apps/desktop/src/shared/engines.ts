/**
 * Value-free engine identity shared by main, host, and future renderer wiring.
 * This is deliberately not a dynamic plugin manifest: only reviewed engines
 * compiled into the desktop application can appear here.
 *
 * TASK.139 adds the engine-proxy carrier contract here rather than in
 * main/host-env.ts because BOTH sides need it and a host module may never
 * import from main (architectural rule, stated in the engine client headers
 * under host/engines).
 * `shared/settings.js` is the only import this module takes, and that module is
 * itself import-free, so the zero-runtime-weight property survives.
 */

import { isProxyUrl } from "./settings.js";

export const ENGINE_IDS = ["core", "codex", "claude"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export function isEngineId(value: string | undefined): value is EngineId {
  return value !== undefined && (ENGINE_IDS as readonly string[]).includes(value);
}

export const ENV_ENGINE = "ANYCODE_ENGINE";
/** Absolute main-validated Codex CLI path passed only to the host process. */
export const ENV_CODEX_BIN = "ANYCODE_CODEX_BIN";
/** Absolute main-validated Claude Code CLI path (SLICE-CC A1) — mirrors ENV_CODEX_BIN; wired to the host process starting CC-C. */
export const ENV_CLAUDE_BIN = "ANYCODE_CLAUDE_BIN";
/** Main-owned utility-process generation; never trusted from renderer input. */
export const ENV_HOST_GENERATION = "ANYCODE_HOST_GENERATION";

// ── engine-level proxy carriers (TASK.139) ──
//
// A host fork's env is composed per-CONNECTION, before and independently of the
// engine (`buildHostEnvFor`), so the engine's own proxy cannot be written into
// the fork's HTTP(S)_PROXY family — by the time the engine is known, the fork
// env already exists. Instead main stamps the SETTING into every fork under a
// private carrier name, and the child-env builders (which run at spawn time,
// when the engine IS known) translate the carrier into the real proxy family.
// Both carriers ride EVERY fork regardless of `ENV_ENGINE`, for the same reason
// ENV_CODEX_BIN/ENV_CLAUDE_BIN do: a subagent of the OTHER engine can be
// spawned from any tab (host/engine-children.ts).

/** Carrier for `settings.codex.proxyUrl`; consumed by the codex child-env builders, never forwarded to the child. */
export const ENV_CODEX_PROXY_URL = "ANYCODE_CODEX_PROXY_URL";
/** Carrier for `settings.claude.proxyUrl`; consumed by the claude child-env builders, never forwarded to the child. */
export const ENV_CLAUDE_PROXY_URL = "ANYCODE_CLAUDE_PROXY_URL";

/** The carrier namespace as one unit — see `stripEngineProxyCarriers`. */
export const ENGINE_PROXY_CARRIER_NAMES = [ENV_CODEX_PROXY_URL, ENV_CLAUDE_PROXY_URL] as const;

/**
 * Carrier VALUE meaning "this engine explicitly uses no proxy" (TASK.141): the
 * engine scope's `proxyRef` is `direct`, or it names a profile whose path
 * resolves to direct (a `system` profile the OS answers `DIRECT` for, a manual
 * profile with a broken URL, a dangling id).
 *
 * A sentinel is needed because the child-env builder has to do something ACTIVE
 * here: the connection's proxy family is already in the child env via the
 * builder's passthrough list, so "emit no carrier" would leave the engine on the
 * connection's proxy — the opposite of what the user selected. The clobber-to-
 * NOTHING this licenses is licensed by the same invariant as the clobber-to-a-
 * value: main emits no carrier at all while the shell owns the family.
 *
 * Its string is deliberately the same word as `PROXY_REF_DIRECT` (shared/proxy.ts)
 * but the two are different namespaces — one is a settings REF, one is an env
 * carrier value — and neither imports the other. An ambient
 * `ANYCODE_*_PROXY_URL=direct` exported by a user's shell dies in
 * `stripEngineProxyCarriers` with every other ambient carrier value.
 */
export const PROXY_CARRIER_DIRECT = "direct";

/**
 * Deletes every carrier name from `env` in place (TASK.139 F1). Called wherever
 * main composes an env from the boot snapshot — the host fork env, the doctor/
 * login source env — BEFORE `engineProxyCarriers` writes the authoritative
 * value back, so main is the SOLE author of this namespace and an ambient
 * `ANYCODE_*_PROXY_URL` from the user's shell can never reach a child.
 *
 * The contrast with the rest of the `ANYCODE_*` surface is deliberate, not an
 * oversight: `ANYCODE_MODEL`, `ANYCODE_BASE_URL`, `ANYCODE_API_KEY` and friends
 * are honoured as ambient OVERRIDES (main/host-env.ts's `fillFromSettings`
 * never overwrites a value the shell exported). These two are not overrides —
 * they are a private main→child transport, and honouring an ambient one would
 * invert two guarantees at once:
 *  - the shell would lose to itself. `applyEngineProxyOverride` clobbers the
 *    proxy family UNCONDITIONALLY, licensed solely by main's shell-wins gate in
 *    `engineProxyCarriers`; an ambient carrier bypasses that gate, so an
 *    exported `ANYCODE_CODEX_PROXY_URL` would beat an exported `HTTPS_PROXY`;
 *  - "no engine proxy configured ⇒ byte-identical child env" would stop
 *    holding on any machine that happens to export one of these names.
 *
 * Idempotent, and a no-op on the overwhelmingly common env that carries neither
 * name (`delete` of an absent key leaves the object byte-identical).
 */
export function stripEngineProxyCarriers(env: NodeJS.ProcessEnv): void {
  for (const name of ENGINE_PROXY_CARRIER_NAMES) {
    delete env[name];
  }
}

/**
 * The HTTP(S) proxy family, treated as ONE atomic unit — byte-mirror of
 * main/host-env.ts's `PROXY_FAMILY_KEYS`, redeclared here because a host module
 * may not import from main. Both cases of both names are written because the
 * consumers disagree: node/undici reads the uppercase pair, curl-convention
 * tools prefer the lowercase one. `ALL_PROXY` is deliberately absent.
 */
const PROXY_FAMILY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

/**
 * The exemption pair, atomic for a sharper reason than the family above: undici
 * resolves `no_proxy` BEFORE `NO_PROXY`, so writing only the uppercase key would
 * SHADOW a lowercase exemption the user (or `applyConnectionProxy`) already set
 * and route the very hosts they excluded through the proxy. Both or neither.
 */
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

/**
 * Loopback exemption written alongside an engine proxy — same value and same
 * measured reasoning as main/host-env.ts (TASK.132): without it a local endpoint
 * or a loopback MCP server would be dialled THROUGH the proxy. Both IPv6
 * spellings are listed because undici splits each entry on `host:port`, so a
 * bare `::1` parses as host `:` + port `1` and matches nothing, while
 * curl-convention consumers compare against the unbracketed form.
 *
 * Single definition for both call sites: host-env.ts imports it from here.
 */
export const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1],::1";

/**
 * Applies an engine-level proxy carrier onto an ALREADY-BUILT child env
 * (TASK.139). `env` is what the engine's own child-env builder assembled;
 * `source` is the env the builder read from (the host fork's env for a session
 * child, main's `bootEnv` overlay for a doctor/login probe).
 *
 * The family overwrite is UNCONDITIONAL, and that is only correct because of an
 * invariant held on the other side: main's `engineProxyCarriers` emits no
 * carrier at all when the shell owns any proxy var. So the only value this can
 * ever clobber is the connection-level proxy that arrived through the builder's
 * passthrough list — which is exactly the declared priority `shell > engine >
 * connection`. The check cannot be moved here: at this point the host's env no
 * longer distinguishes a shell-exported proxy from a connection-derived one.
 *
 * A carrier that is absent, blank, or fails `isProxyUrl` leaves `env`
 * byte-identical. The predicate re-check is defense in depth (main only ever
 * emits validated values) and keeps a hand-edited settings.json degrading to
 * "no engine proxy" rather than to a broken child env.
 *
 * `PROXY_CARRIER_DIRECT` (TASK.141) is the one carrier value that is not a URL:
 * it DELETES the whole family instead of overwriting it, which is what "this
 * engine explicitly uses no proxy" has to mean when the connection's proxy is
 * already sitting in `env` from the passthrough list. The exemption pair is left
 * alone in that branch — the shell may have named exemptions that have nothing
 * to do with our proxy decision, and `NO_PROXY` without a proxy is inert anyway.
 *
 * The carrier name itself is never copied into `env` — the builders' allowlists
 * do not know it, and the child has no use for it.
 */
export function applyEngineProxyOverride(
  env: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  carrierName: string,
): void {
  const carrier = source[carrierName];
  if (carrier === undefined || carrier.trim() === "") {
    return;
  }
  if (carrier === PROXY_CARRIER_DIRECT) {
    for (const name of PROXY_FAMILY_KEYS) {
      delete env[name];
    }
    return;
  }
  if (!isProxyUrl(carrier)) {
    return;
  }
  for (const name of PROXY_FAMILY_KEYS) {
    env[name] = carrier;
  }
  // Read off `env`, not `source`: an exemption that reached the child at all —
  // whether exported by the shell or written by `applyConnectionProxy` and
  // carried in through the passthrough list — is already here, and the user's
  // named exemptions must survive the engine override untouched. Atomic for the
  // shadowing reason in NO_PROXY_KEYS.
  if (!NO_PROXY_KEYS.some((name) => (env[name] ?? "").trim() !== "")) {
    for (const name of NO_PROXY_KEYS) {
      env[name] = LOOPBACK_NO_PROXY;
    }
  }
}

export const ENGINE_PROCESS_REGISTRATION_TYPE = "anycode:engine-process";

/** Exact process ownership facts reported from a host to main. */
export interface EngineProcessRegistration {
  hostPid: number;
  generation: number;
  enginePid: number;
  pgid: number;
}

export type EngineProcessRegistrationMessage =
  & { type: typeof ENGINE_PROCESS_REGISTRATION_TYPE }
  & EngineProcessRegistration;

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

/** Carrier for the codex engine's proxy DECISION; consumed by the codex child-env builders, never forwarded to the child. */
export const ENV_CODEX_PROXY_URL = "ANYCODE_CODEX_PROXY_URL";
/** Carrier for the claude engine's proxy DECISION; consumed by the claude child-env builders, never forwarded to the child. */
export const ENV_CLAUDE_PROXY_URL = "ANYCODE_CLAUDE_PROXY_URL";

/**
 * The carrier namespace as one unit — see `stripEngineProxyCarriers`.
 *
 * TASK.141 (design review B-02) widened what a carrier SAYS without adding a
 * name: the exemption list and the overwrite licence travel as FIELDS inside the
 * one value (see `EngineProxyCarrier`), not as sibling variables. That is not
 * cosmetic — the carrier passes through main/codex-ipc.ts, main/claude-ipc.ts
 * and both host clients, none of which belong to this slice, and every one of
 * them copies the value opaquely. Keeping the namespace at two names means F1's
 * strip (`stripEngineProxyCarriers`) covers every new field by construction,
 * with no third place to remember.
 */
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
 * What ONE engine's carrier says (TASK.141, design review B-02/B-03). A
 * DISCRIMINATED outcome rather than "a url string, or the absence of one",
 * because `absent` and `direct` are opposite instructions to the child builder
 * and only the discriminant tells them apart:
 *  - `absent` — this engine has no rung of its own; the child keeps whatever the
 *    connection/app rung already put in its env. Expressed by emitting NO
 *    carrier at all, so an engine with no proxy settings leaves the child env
 *    byte-identical to a build that never heard of this feature;
 *  - `direct` — an EXPLICIT rung resolved to "no proxy": `proxyRef:"direct"`, a
 *    dangling id, a hand-broken url, or a `system` profile the OS answered
 *    DIRECT for. All of them must CLEAR the family the passthrough list carried
 *    in, which is why the sentinel exists at all;
 *  - `proxy` — use this url. `noProxy` present means main has also decided the
 *    exemption pair may be rewritten, and to exactly this value.
 *
 * `noProxy` carries the LICENCE and the VALUE in one field on purpose. The child
 * builder cannot tell a shell-exported `NO_PROXY` from one the connection rung
 * wrote — by the time it runs, both are just entries in the env it was handed —
 * so the decision has to be made where the boot snapshot is still visible, i.e.
 * in main. Absent `noProxy` therefore means "the shell owns the exemption pair,
 * do not touch it"; present means "the shell does not, replace the pair with
 * this".
 */
export type EngineProxyCarrier =
  | { kind: "absent" }
  | { kind: "direct" }
  | { kind: "proxy"; url: string; noProxy?: string };

/**
 * Encodes a carrier outcome into the ONE env value, or undefined for `absent`
 * (which is expressed by emitting no variable).
 *
 * Two forms, and the reader below accepts nothing else:
 *  - the bare word `direct`;
 *  - a JSON object `{"url":…,"noProxy":…?}`.
 *
 * JSON rather than a delimiter because a proxy url may legally contain almost
 * any punctuation once its userinfo is percent-encoded, and a delimiter that
 * "cannot appear" is a bug waiting for the first password with that character in
 * it. The value is main's private transport read by exactly one function
 * (`applyEngineProxyOverride`), so its shape costs nothing elsewhere.
 */
export function encodeEngineProxyCarrier(carrier: EngineProxyCarrier): string | undefined {
  switch (carrier.kind) {
    case "absent":
      return undefined;
    case "direct":
      return PROXY_CARRIER_DIRECT;
    case "proxy":
      return JSON.stringify(
        carrier.noProxy === undefined ? { url: carrier.url } : { url: carrier.url, noProxy: carrier.noProxy },
      );
  }
}

/**
 * Reads a carrier value back. Anything unrecognised — absent, blank, a leftover
 * bare url from another build, malformed JSON, a url that fails `isProxyUrl` —
 * decodes to `absent`, i.e. "leave the child env alone".
 *
 * That fail-soft direction is the same one every proxy value in this slice
 * takes, and it is load-bearing here: the settings blocks feeding this are
 * LENIENTLY parsed, so a hand-edited file must be able to mean "no engine proxy"
 * and must never be able to mean "a broken child env".
 */
export function decodeEngineProxyCarrier(raw: string | undefined): EngineProxyCarrier {
  if (raw === undefined || raw.trim() === "") {
    return { kind: "absent" };
  }
  if (raw === PROXY_CARRIER_DIRECT) {
    return { kind: "direct" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "absent" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "absent" };
  }
  const { url, noProxy } = parsed as { url?: unknown; noProxy?: unknown };
  if (typeof url !== "string" || !isProxyUrl(url)) {
    return { kind: "absent" };
  }
  return typeof noProxy === "string" && noProxy.trim() !== ""
    ? { kind: "proxy", url, noProxy }
    : { kind: "proxy", url };
}

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
 * The two names an EXPLICIT direct also clears from a child env (design review
 * M-02), on top of the four above.
 *
 * Both child-env builders pass `ALL_PROXY`/`all_proxy` through, and neither is
 * part of the four-variable shell gate — so before this, an engine set to
 * "explicitly no proxy" deleted four names and left a fifth pointing at a proxy.
 * Clearing them is the SAFE half of the finding and needs no measurement: an
 * engine the user told to use no proxy must not be handed a proxy variable of
 * any spelling, and the worst case of removing one is a child that goes direct,
 * which is exactly what was asked for.
 *
 * MEASUREMENT STILL OWED: whether the Codex Rust binary and the Claude Code CLI
 * actually honour `ALL_PROXY` is unmeasured. That measurement decides the OTHER
 * half — whether an ambient `ALL_PROXY` alone should count as "the shell owns
 * the proxy family" and silence the settings. Until it is taken the shell gate
 * stays at four variables, deliberately unchanged, because widening it would
 * make settings STOP working on machines that export `ALL_PROXY` for unrelated
 * tools, and that failure direction is not fail-soft.
 */
const ALL_PROXY_KEYS = ["ALL_PROXY", "all_proxy"] as const;

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
 * A carrier that is absent, blank, or undecodable leaves `env` byte-identical
 * (see `decodeEngineProxyCarrier`). The re-validation there is defense in depth
 * — main only ever emits validated values — and keeps a hand-edited
 * settings.json degrading to "no engine proxy" rather than to a broken child env.
 *
 * `direct` is the outcome that is not a URL: it DELETES the proxy variables
 * instead of overwriting them, which is what "this engine explicitly uses no
 * proxy" has to mean when the connection's proxy is already sitting in `env`
 * from the passthrough list. It clears `ALL_PROXY`/`all_proxy` too (design
 * review M-02): those ride the same passthrough lists and were surviving an
 * explicit direct. The exemption pair is left alone in that branch — with no
 * proxy variable left `NO_PROXY` is inert, and the shell may have named
 * exemptions that have nothing to do with our decision.
 *
 * `proxy` carrying a `noProxy` field REPLACES the exemption pair atomically
 * (design review B-02). Without that, a connection rung's exemptions leaked
 * upward into an engine that never granted them — connection
 * `NO_PROXY=…,corp.internal` plus a Codex-scoped proxy meant Codex reached
 * `corp.internal` directly, past the proxy the engine rung had explicitly
 * selected — while an ENGINE profile's OWN exemptions reached no child at all.
 * Main sets the field ONLY when the boot env does not own the pair, so a
 * shell-exported `NO_PROXY` still survives untouched; see `EngineProxyCarrier`
 * for why the licence cannot be decided here. Atomic across both spellings for
 * the shadowing reason in `NO_PROXY_KEYS`.
 *
 * The carrier name itself is never copied into `env` — the builders' allowlists
 * do not know it, and the child has no use for it.
 */
export function applyEngineProxyOverride(
  env: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  carrierName: string,
): void {
  const carrier = decodeEngineProxyCarrier(source[carrierName]);
  if (carrier.kind === "absent") {
    return;
  }
  if (carrier.kind === "direct") {
    for (const name of [...PROXY_FAMILY_KEYS, ...ALL_PROXY_KEYS]) {
      delete env[name];
    }
    return;
  }
  for (const name of PROXY_FAMILY_KEYS) {
    env[name] = carrier.url;
  }
  if (carrier.noProxy !== undefined) {
    for (const name of NO_PROXY_KEYS) {
      env[name] = carrier.noProxy;
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

/**
 * Proxy-profile registry contract (TASK.141, редакция 2): the named profiles a
 * user configures ONCE, plus the one-string reference every scope holds instead
 * of its own copy of the configuration.
 *
 * The whole slice rests on one inversion of TASK.132/139: a scope (the app, a
 * connection, an engine) no longer carries proxy CONFIGURATION — it carries a
 * `proxyRef`, and every knob (mode, host/port, exemptions, credentials) lives on
 * the profile that ref names. Three states of a scope are therefore three values
 * of one optional string: absent = inherit the rung below, `PROXY_REF_DIRECT` =
 * explicitly no proxy, `proxy-<uuid>` = that profile.
 *
 * `./settings.js` is the ONLY import this module takes (`isProxyUrl` + the
 * settings types), and that module is itself value-import-free, so this stays as
 * cheap to pull into the preload/renderer bundles as shared/settings.ts is.
 * shared/settings.ts imports `ProxyProfile` back from here with `import type`,
 * which `verbatimModuleSyntax` erases outright — there is no runtime edge in
 * that direction and therefore no cycle.
 */

import type { AnycodeSettings, ProviderConnection, SecretKey, SettingsSnapshot } from "./settings.js";
import { isProxyUrl } from "./settings.js";

// ── invoke channels ──

/**
 * invoke channel: create or edit ONE profile (`ProxyProfileUpsertRequest`).
 * Without `id` main mints a fresh `proxy-<uuid>`; with `id` it edits (renaming
 * included) the profile that id names. Its own channel rather than a
 * `settings-set` patch for the same reason the connection CRUD channels are:
 * the persisted schema for the registry is deliberately lenient, so a generic
 * patch would put an unrefined profile on disk.
 */
export const PROXY_PROFILE_UPSERT_CHANNEL = "anycode:proxy-profile-upsert";

/**
 * invoke channel: delete ONE profile (`{id}`). Refuses while ANY scope still
 * references it and names the consumers in the refusal — silently detaching
 * references would re-route scopes the user is not looking at, and the worst
 * outcome of that is traffic leaving the corporate proxy.
 */
export const PROXY_PROFILE_DELETE_CHANNEL = "anycode:proxy-profile-delete";

/**
 * invoke channel: point ONE scope at a profile (or at `direct`, or back to
 * "inherit"). Serves the app and the two engine scopes; a CONNECTION's ref
 * rides the existing connection CRUD payloads instead, so a brand-new
 * connection saves its proxy choice atomically with itself.
 */
export const PROXY_REF_SET_CHANNEL = "anycode:proxy-ref-set";

/**
 * invoke channel: probe ONE profile (`{profileId}`) by SPAWNING a child with the
 * profile's materialised env. Handled by main/network-ipc.ts (TASK.141 lane B).
 * A probe done with main's own `fetch` would lie — main's global fetch reads
 * `NODE_USE_ENV_PROXY` once at bootstrap and ignores the proxy env afterwards
 * (measured, TASK.132).
 */
export const PROXY_CHECK_CHANNEL = "anycode:proxy-check";

// ── the registry ──

/**
 * One named proxy profile, as persisted in `settings.network.proxyProfiles`.
 *
 * There is no `off`/`none` mode: "no proxy" is a property of a SCOPE
 * (`PROXY_REF_DIRECT`), never of a profile — a profile always describes a real
 * network path.
 */
export interface ProxyProfile {
  /**
   * Stable id, minted by main as `proxy-<uuid>`. Never changes, never carries a
   * dot — it is a segment of the vault key (`proxyProfileSecretKey`), and the
   * `[^.]+` shape is what lets `isKnownSecretKey` recognise that key the same
   * way it recognises a connection key. Renaming a profile is an upsert under
   * the SAME id, which is precisely why a rename cannot lose the password.
   */
  id: string;
  /** Display name for the pickers. Case-insensitive uniqueness is enforced at the IPC boundary, not here. */
  name: string;
  /**
   * `system` = ask Chromium (`session.resolveProxy`) what the OS/PAC would do
   * and materialise ITS answer into the child env; `manual` = use `url` below.
   * Children cannot execute a PAC in any form, so only main can resolve one.
   */
  mode: "system" | "manual";
  /**
   * `manual` only: `http(s)://host:port`. Userinfo is REFUSED here at the IPC
   * boundary (`isProxyProfileUrl`) — credentials belong in `login` + the vault,
   * not in a string that round-trips through the 0644 settings.json.
   */
  url?: string;
  /**
   * Hosts that bypass this proxy, in honest `NO_PROXY` syntax (suffixes, not
   * JetBrains globs — `192.168.*` matches nothing in undici/curl). APPENDED to
   * `LOOPBACK_NO_PROXY`, never a replacement for it: a list that replaced the
   * loopback default would send a local Ollama/vLLM endpoint through the proxy.
   */
  noProxy?: string;
  /**
   * Proxy-authentication username. Not a secret (it is not the password), so it
   * lives in settings.json like every other display-level field; the password
   * lives in the vault under `proxyProfileSecretKey(id)` and NEVER travels back
   * to the renderer — the editor sees only a `passwordSet` boolean, derived
   * from the snapshot's `SecretStatus` list.
   */
  login?: string;
}

/**
 * The reserved ref meaning "this scope explicitly uses NO proxy". Cannot collide
 * with a profile id (`proxy-<uuid>`).
 *
 * On a non-app scope this value IS persisted — the single "falsy-meaning" string
 * on disk, and deliberately not an exception to the only-truthy-on-disk rule
 * (it is a VALUE, not a `false`). On the app scope "no proxy" and "inherit"
 * coincide, so there the picker's "No proxy" deletes the key instead.
 */
export const PROXY_REF_DIRECT = "direct";

/**
 * WIRE-ONLY ref: "keep whatever legacy `proxyUrl` string this scope already
 * has". Never persisted — a write carrying it makes main run `importLegacyProxy`
 * and store the minted profile id instead. It is also the `ref` a legacy rung
 * reports out of `resolveProxyLadder`, so "which rung won" reads the same on
 * both sides.
 *
 * Reading a legacy string changes nothing on disk; migration happens ONLY on a
 * write, which is what keeps an untouched settings.json byte-identical.
 */
export const PROXY_REF_LEGACY = "legacy";

/** True for a ref the registry can never mint — the two reserved words above. */
export function isReservedProxyRef(ref: string): boolean {
  return ref === PROXY_REF_DIRECT || ref === PROXY_REF_LEGACY;
}

// ── scopes ──

/**
 * Serialisable identity of a proxy scope (it crosses IPC). Adding a scope to the
 * product means: a variant here, a `proxyRef?` field in its settings block, a
 * binding in main/proxy-scopes.ts, one `<ProxyRefPicker scope={…}>`, and its own
 * chain at the point where its traffic class is materialised. No new editor, no
 * new credential surface, no new check button — those already live on profiles.
 */
export type ProxyScopeId =
  | { kind: "app" }
  | { kind: "connection"; connectionId: string }
  | { kind: "engine"; engine: "codex" | "claude" };

/** The rung of a ladder that won: which scope spoke, and with what. */
export interface ProxyRung {
  source: ProxyScopeId;
  /**
   * The scope's ref: `PROXY_REF_DIRECT`, a profile id, or `PROXY_REF_LEGACY`
   * for an implicit rung expressed by a legacy `proxyUrl` string.
   */
  ref: string;
  /** The named profile, when the ref resolves to one. Absent for `direct`, for a legacy rung, and for a DANGLING ref. */
  profile?: ProxyProfile;
  /** The scope's legacy `proxyUrl` string, for a legacy rung only. */
  legacyUrl?: string;
}

/** Every profile in the registry, in storage order; `[]` when the section is absent. */
export function proxyProfiles(settings: AnycodeSettings): readonly ProxyProfile[] {
  return settings.network?.proxyProfiles ?? [];
}

/** The profile a ref names, or undefined for a dangling/reserved ref. */
export function findProxyProfile(settings: AnycodeSettings, profileId: string): ProxyProfile | undefined {
  return proxyProfiles(settings).find((profile) => profile.id === profileId);
}

/**
 * The two proxy-bearing fields of ONE scope, read straight off the settings
 * document. The single authority for the scope→field mapping: main's binding
 * registry (main/proxy-scopes.ts) reads through this rather than keeping a
 * second copy, so the ladder and the consumer walk can never disagree about
 * where a scope's ref lives.
 *
 * A connection scope naming a connection that does not exist reads as empty —
 * the same fail-soft posture a since-deleted pin gets everywhere else.
 */
export function readProxyScope(
  settings: AnycodeSettings,
  scope: ProxyScopeId,
): { ref?: string; legacyUrl?: string } {
  switch (scope.kind) {
    case "app":
      return pick(settings.network?.proxyRef, undefined);
    case "engine": {
      const block = scope.engine === "codex" ? settings.codex : settings.claude;
      return pick(block?.proxyRef, block?.proxyUrl);
    }
    case "connection": {
      const connection = settings.provider.connections.find(
        (candidate: ProviderConnection) => candidate.id === scope.connectionId,
      );
      return pick(connection?.proxyRef, connection?.proxyUrl);
    }
  }
}

/** Normalises "" / whitespace to absent — a blank string is not a choice. */
function pick(ref: string | undefined, legacyUrl: string | undefined): { ref?: string; legacyUrl?: string } {
  const out: { ref?: string; legacyUrl?: string } = {};
  if (ref !== undefined && ref.trim() !== "") {
    out.ref = ref;
  }
  if (legacyUrl !== undefined && legacyUrl.trim() !== "") {
    out.legacyUrl = legacyUrl;
  }
  return out;
}

/**
 * The FIRST scope in `chain` that says anything at all (TASK.141 §2). Below the
 * shell — which still wins the whole proxy family atomically, one rung above
 * every ladder here (TASK.132's law, gated in main/host-env.ts) — the first
 * EXPLICIT rung wins, and its outcome is allowed to be "direct".
 *
 * A rung is explicit when the scope carries a `proxyRef` OR a legacy `proxyUrl`
 * string; `proxyRef` beats the legacy string of the SAME scope. `undefined`
 * means no scope in the chain said anything: no proxy, byte-identically to a
 * settings.json that has never heard of this feature.
 *
 * A DANGLING ref (a profile id that no longer exists — reachable only by hand-
 * editing the file, since the delete handler refuses while consumers exist)
 * still returns a rung, with no `profile`. That is deliberate and is the whole
 * point of the "explicit rung, broken value ⇒ direct" law: falling through to
 * the rung below would route this scope's traffic into SOMEONE ELSE's proxy
 * because of a typo.
 *
 * A MALFORMED legacy string is the deliberate exception: it is not a rung at
 * all, and the ladder keeps descending. That is not an inconsistency with the
 * law above — it is TASK.132's fail-soft semantics for that field preserved
 * byte-for-byte, which is what "legacy strings keep working with no user action"
 * requires. The two rules cannot collide in a document written before this
 * slice: nothing below a legacy string existed there to fall through to.
 */
export function resolveProxyLadder(
  settings: AnycodeSettings,
  chain: readonly ProxyScopeId[],
): ProxyRung | undefined {
  for (const source of chain) {
    const { ref, legacyUrl } = readProxyScope(settings, source);
    if (ref !== undefined) {
      if (ref === PROXY_REF_DIRECT) {
        return { source, ref };
      }
      const profile = findProxyProfile(settings, ref);
      return profile === undefined ? { source, ref } : { source, ref, profile };
    }
    if (legacyUrl !== undefined && isProxyUrl(legacyUrl)) {
      return { source, ref: PROXY_REF_LEGACY, legacyUrl };
    }
  }
  return undefined;
}

/**
 * Ladder (a)/(b) — the host fork's own `fetch` and every Bash/terminal/LSP child
 * that inherits its env: the ACTIVE connection, then the app. Exported so the
 * probe (lane B) can materialise a profile down the exact path a real spawn
 * takes, rather than a look-alike that can drift from it.
 */
export function hostForkProxyChain(activeConnectionId: string | undefined): ProxyScopeId[] {
  return activeConnectionId === undefined
    ? [{ kind: "app" }]
    : [{ kind: "connection", connectionId: activeConnectionId }, { kind: "app" }];
}

/**
 * Ladder (f) — the doctor/`codex login` children main spawns itself: the engine,
 * then the app. There is no connection rung by construction (a doctor is
 * connection-less). The tab/subagent children use the engine rung ALONE, because
 * their connection and app rungs are already materialised into the host fork's
 * env and reach the child through the builders' passthrough lists.
 */
export function engineProxyChain(engine: "codex" | "claude", includeApp: boolean): ProxyScopeId[] {
  return includeApp ? [{ kind: "engine", engine }, { kind: "app" }] : [{ kind: "engine", engine }];
}

// ── materialisation inputs ──

/** A rung turned into what an env actually needs. `undefined` everywhere else means "direct". */
export interface MaterializedProxy {
  /** The full proxy URL, userinfo already composed and percent-encoded. */
  url: string;
  /** The profile's extra exemptions, to be APPENDED to `LOOPBACK_NO_PROXY`. */
  noProxy?: string;
}

/**
 * True for a `manual` profile URL: `isProxyUrl` PLUS "no userinfo". The extra
 * half is the boundary rule the profile editor enforces — credentials belong in
 * `login` + the vault, and a `user:pass@` typed into the host field would put a
 * password back into the 0644 settings.json this slice just took it out of.
 * Exported so the renderer pre-flights with the same predicate main refuses on.
 */
export function isProxyProfileUrl(value: string): boolean {
  if (!isProxyUrl(value)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.username === "" && url.password === "";
}

/**
 * Composes `login`/`password` into a proxy URL's userinfo, percent-encoding
 * both. Without the encoding a password containing `@`, `:`, `/` or `%` — all
 * legal in a proxy password and common in generated ones — silently reparses
 * into a different host, and the request goes somewhere the user never named.
 *
 * A blank login yields the base URL untouched (a password with no login is not
 * expressible in a URL and is dropped, not guessed at). Returns undefined for
 * anything that is not a real http(s) proxy URL — the caller's "broken value ⇒
 * direct" branch. The `isProxyUrl` gate is doing real work here rather than
 * repeating the caller: `new URL("proxy.corp:3128")` PARSES, as scheme
 * `proxy.corp:` with an opaque path, and then silently swallows the userinfo
 * assignment below — so a "did it throw?" check would hand back a credential-
 * free string that looks fine and authenticates against nothing.
 */
export function composeProxyUrl(baseUrl: string, login?: string, password?: string): string | undefined {
  if (!isProxyUrl(baseUrl)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const user = login ?? "";
  if (user.trim() === "") {
    return url.toString();
  }
  // Assigned through the URL API, which percent-encodes the userinfo components
  // itself with exactly the set a proxy client expects.
  url.username = encodeURIComponent(user);
  url.password = password === undefined || password === "" ? "" : encodeURIComponent(password);
  return url.toString();
}

/**
 * Masks the credential half of a proxy URL for display (`user:***@host:port`).
 * Every text that can reach the renderer — a Legacy picker item, a Check
 * verdict, an error string — goes through this: the password is the one thing
 * that must never come back out of main.
 */
export function maskProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username === "" && url.password === "") {
    return url.toString();
  }
  const user = url.username;
  url.username = "";
  url.password = "";
  return url.toString().replace("//", `//${user === "" ? "" : `${user}:`}***@`);
}

/**
 * The vault key a profile's password lives under. Keyed by the IMMUTABLE `id`,
 * never by `name`, so a rename cannot orphan the password — that is the whole
 * reason the id exists separately from the display name.
 */
export function proxyProfileSecretKey(profileId: string): SecretKey {
  return `proxy.profile.${profileId}.password`;
}

/** Matches a proxy-profile vault key, capturing the profile id (`[^.]+`, like the connection keys). */
export const PROXY_PROFILE_SECRET_KEY_RE = /^proxy\.profile\.([^.]+)\.password$/;

/** True when a vault key names a proxy-profile password (never a provider credential). */
export function isProxyProfileSecretKey(key: string): boolean {
  return PROXY_PROFILE_SECRET_KEY_RE.test(key);
}

/**
 * A stable fingerprint of the network path a chain resolves to — the thing a
 * connection's `lastHealth` was measured THROUGH (TASK.141 §7). Two settings
 * documents that fingerprint the same for a chain route that chain's traffic
 * identically, so a mutation only needs to reset the health of the connections
 * whose fingerprint actually moved.
 *
 * Deliberately computed from the persisted facts, not from a fully materialised
 * URL: the vault password and the cached system-proxy resolve are not available
 * on the IPC thread synchronously, and neither of them changes on THIS channel
 * (a password moves through `secret-set`, which does its own reset).
 */
export function proxyPathFingerprint(settings: AnycodeSettings, chain: readonly ProxyScopeId[]): string {
  const rung = resolveProxyLadder(settings, chain);
  if (rung === undefined) {
    return "none";
  }
  if (rung.legacyUrl !== undefined) {
    return `legacy:${rung.legacyUrl}`;
  }
  if (rung.profile === undefined) {
    // `direct` and a dangling ref land on the same outcome (direct) by law, and
    // must therefore fingerprint the same: switching a scope from a deleted
    // profile id to `direct` changes nothing about where its traffic goes.
    return "direct";
  }
  const { mode, url, noProxy, login } = rung.profile;
  return `profile:${mode}|${url ?? ""}|${noProxy ?? ""}|${login ?? ""}`;
}

// ── channel payloads ──

/**
 * `proxy-profile-upsert` payload. No `id` = create (main mints `proxy-<uuid>`
 * and returns it as `createdProxyProfileId`); with `id` = edit that profile,
 * rename included. The password is NOT here — it travels the existing
 * `secret-set` channel under `proxyProfileSecretKey(id)`, the one path a
 * plaintext value is allowed to cross.
 */
export interface ProxyProfileUpsertRequest {
  id?: string;
  name: string;
  mode: "system" | "manual";
  /** `manual` only; refused unless it passes `isProxyProfileUrl`. Ignored for `system`. */
  url?: string;
  noProxy?: string;
  login?: string;
}

export interface ProxyProfileDeleteRequest {
  id: string;
}

/**
 * Result of `proxy-profile-delete`. The `in_use` arm carries the human-readable
 * consumer list (`connection «Anthropic work»`, `Codex engine`, `Application
 * default`) so the UI can say WHICH scopes block the delete instead of just
 * refusing.
 */
export type ProxyProfileDeleteResult =
  | { ok: true; snapshot: SettingsSnapshot }
  | { ok: false; reason: "invalid" | "read_only" | "not_found" }
  | { ok: false; reason: "in_use"; consumers: string[] };

/**
 * `proxy-ref-set` payload. `ref === null` removes the scope's ref (and its legacy
 * `proxyUrl`), i.e. "inherit the rung below" — which on the app scope is the
 * same thing as "no proxy". A CONNECTION scope is refused here: its ref rides
 * `connection-create`/`connection-update` so it is saved atomically with the
 * connection itself.
 */
export interface ProxyRefSetRequest {
  scope: ProxyScopeId;
  ref: string | null;
}

/** Verdict classes of the spawn-probe (TASK.141 §6). `ok` = the TARGET answered at all — a 401 from Anthropic proves the proxy works. */
export type ProxyCheckVerdict = "ok" | "proxy_unreachable" | "proxy_auth" | "tls" | "target_unreachable";

export interface ProxyCheckRequest {
  profileId: string;
}

/**
 * Result of `proxy-check`. `detail` is display text with the userinfo already
 * masked. `shellOverride` is the named caveat: when the boot env owns the proxy
 * family, a profile can probe green while real traffic still leaves through the
 * shell's proxy, and the verdict has to say so.
 */
export type ProxyCheckResult =
  | { ok: true; verdict: ProxyCheckVerdict; detail?: string; shellOverride?: boolean }
  | { ok: false; reason: "invalid" | "not_found" };

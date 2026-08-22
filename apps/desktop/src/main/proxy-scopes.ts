/**
 * The main-side registry of proxy SCOPES (TASK.141 §3): one binding per scope
 * kind, so every operation that has to walk "all the places a proxy can be
 * referenced" — the ladder, the consumer list that blocks a profile delete, the
 * ref write — walks the same list, and adding a scope means adding one entry
 * here rather than editing three handlers.
 *
 * The scope→field mapping itself is NOT duplicated here: `read` delegates to
 * `readProxyScope` (shared/proxy.ts), which is also what `resolveProxyLadder`
 * reads through. One authority, so a scope cannot resolve down one path and be
 * invisible down the other.
 *
 * electron-free and zod-free on purpose (the settings-ipc discipline): every
 * function here is pure over a settings document, so the handlers' behaviour is
 * unit-testable off plain objects.
 */

import { randomUUID } from "node:crypto";
import type { AnycodeSettings, ProviderConnection } from "../shared/settings.js";
import { isProxyUrl } from "../shared/settings.js";
import type { ProxyProfile, ProxyScopeId } from "../shared/proxy.js";
import { isProxyProfileUrl, proxyProfiles, readProxyScope } from "../shared/proxy.js";

/**
 * Everything main needs to know about ONE scope kind. `read` answers the ladder
 * and the consumer walk; `write` is the only path a ref reaches disk; `describe`
 * is what a delete refusal shows the user.
 */
export interface ProxyScopeBinding {
  /** True when the scope actually exists in this document (a connection id may name nothing). */
  exists(settings: AnycodeSettings, scope: ProxyScopeId): boolean;
  /** The scope's ref + its legacy `proxyUrl` string, raw (an unparseable legacy value is still reported — the importer and the picker need to see it). */
  read(settings: AnycodeSettings, scope: ProxyScopeId): { ref?: string; legacyUrl?: string };
  /**
   * Sets (or, with `null`, removes) the scope's ref IN PLACE on a draft the
   * caller owns. `null` also removes the legacy `proxyUrl` key — leaving it
   * would resurrect the legacy rung the moment the ref above it went away, so
   * "clear the proxy" would silently mean "go back to the old proxy".
   *
   * A non-null ref removes the legacy key too: the ref outranks it anyway, and
   * keeping a dead string on disk only invites a later reader to believe it.
   */
  write(settings: AnycodeSettings, scope: ProxyScopeId, ref: string | null): void;
  /** Human-readable name for the delete refusal's consumer list. */
  describe(settings: AnycodeSettings, scope: ProxyScopeId): string;
}

function connectionOf(settings: AnycodeSettings, scope: ProxyScopeId): ProviderConnection | undefined {
  return scope.kind === "connection"
    ? settings.provider.connections.find((candidate) => candidate.id === scope.connectionId)
    : undefined;
}

/**
 * Drops a block that a ref/legacy removal emptied — the only-truthy-on-disk
 * hygiene every settings writer here applies: a user who merely visited the
 * picker must not permanently acquire a `"codex": {}` (or `"network": {}`) husk
 * in settings.json.
 */
function pruneEmptyBlock<K extends "codex" | "claude" | "network">(settings: AnycodeSettings, key: K): void {
  const block = settings[key];
  if (block !== undefined && Object.keys(block).length === 0) {
    delete settings[key];
  }
}

export const PROXY_SCOPE_BINDINGS: Record<ProxyScopeId["kind"], ProxyScopeBinding> = {
  app: {
    exists: () => true,
    read: (settings, scope) => readProxyScope(settings, scope),
    write: (settings, _scope, ref) => {
      if (ref === null) {
        if (settings.network !== undefined) {
          delete settings.network.proxyRef;
          pruneEmptyBlock(settings, "network");
        }
        return;
      }
      settings.network = { ...settings.network, proxyRef: ref };
    },
    describe: () => "Application default",
  },
  engine: {
    exists: () => true,
    read: (settings, scope) => readProxyScope(settings, scope),
    write: (settings, scope, ref) => {
      if (scope.kind !== "engine") {
        return;
      }
      // Two concrete branches rather than one union-keyed write: the two
      // blocks are different types and a keyed write would need a cast that
      // discards exactly the checking this is here for.
      if (scope.engine === "codex") {
        const block = { ...settings.codex };
        delete block.proxyUrl;
        if (ref === null) {
          delete block.proxyRef;
        } else {
          block.proxyRef = ref;
        }
        settings.codex = block;
        pruneEmptyBlock(settings, "codex");
      } else {
        const block = { ...settings.claude };
        delete block.proxyUrl;
        if (ref === null) {
          delete block.proxyRef;
        } else {
          block.proxyRef = ref;
        }
        settings.claude = block;
        pruneEmptyBlock(settings, "claude");
      }
    },
    describe: (_settings, scope) => (scope.kind === "engine" && scope.engine === "codex" ? "Codex engine" : "Claude engine"),
  },
  connection: {
    exists: (settings, scope) => connectionOf(settings, scope) !== undefined,
    read: (settings, scope) => readProxyScope(settings, scope),
    write: (settings, scope, ref) => {
      const connection = connectionOf(settings, scope);
      if (connection === undefined) {
        return;
      }
      delete connection.proxyUrl;
      if (ref === null) {
        delete connection.proxyRef;
      } else {
        connection.proxyRef = ref;
      }
    },
    describe: (settings, scope) => {
      const connection = connectionOf(settings, scope);
      const name = connection?.label ?? (connection?.providerId !== "" ? connection?.providerId : undefined);
      return `connection «${name ?? (scope.kind === "connection" ? scope.connectionId : "")}»`;
    },
  },
};

/**
 * Every scope this document currently has, in a stable order (app, both engines,
 * then connections in storage order). The consumer walk and the health-reset
 * diff both iterate this, so a scope kind added to the bindings above is picked
 * up by both without either being edited.
 */
export function allProxyScopes(settings: AnycodeSettings): ProxyScopeId[] {
  return [
    { kind: "app" },
    { kind: "engine", engine: "codex" },
    { kind: "engine", engine: "claude" },
    ...settings.provider.connections.map((connection): ProxyScopeId => ({
      kind: "connection",
      connectionId: connection.id,
    })),
  ];
}

/**
 * The human-readable names of every scope that currently references
 * `profileId` (TASK.141 §7). A delete is refused while this is non-empty and
 * the list is shown verbatim: silently detaching the references would change the
 * network path of scopes the user is not looking at, and the worst outcome of
 * that is traffic leaving the corporate proxy — a leak class, not an
 * inconvenience. (The product already has this policy shape: a connection pinned
 * to a live session refuses deletion too.)
 */
export function proxyProfileConsumers(settings: AnycodeSettings, profileId: string): string[] {
  const out: string[] = [];
  for (const scope of allProxyScopes(settings)) {
    const binding = PROXY_SCOPE_BINDINGS[scope.kind];
    if (binding.read(settings, scope).ref === profileId) {
      out.push(binding.describe(settings, scope));
    }
  }
  return out;
}

// ── legacy import (TASK.141 §1) ──

/** A fresh profile id. Opaque and dot-free — it is a vault-key segment. */
export function defaultProxyProfileId(): string {
  return `proxy-${randomUUID()}`;
}

/**
 * Dedup key of a proxy: scheme + host + port + the login (userinfo in `url` is
 * ignored — `URL.host` never carries it). This is the CHEAP half of the
 * comparison; the password half is done separately against the vault, because it
 * is the only half that is neither in this document nor readable synchronously.
 *
 * One derivation for both sides of the comparison, so an incoming legacy string
 * and an already-imported profile can never be judged by different rules.
 */
function proxyDedupKey(url: string, login: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}|${login}`;
  } catch {
    return undefined;
  }
}

/** The dedup key of an already-registered profile, or undefined when it cannot have come from a legacy string. */
function profileDedupKey(profile: ProxyProfile): string | undefined {
  return profile.mode === "manual" && profile.url !== undefined
    ? proxyDedupKey(profile.url, profile.login ?? "")
    : undefined;
}

/** A name no existing profile holds (case-insensitive), suffixing ` (2)`, ` (3)`, … */
export function uniqueProxyProfileName(settings: AnycodeSettings, desired: string): string {
  const taken = new Set(proxyProfiles(settings).map((profile) => profile.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) {
    return desired;
  }
  for (let n = 2; ; n++) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/**
 * What the vault knows about ONE profile's password (design review B-08). The
 * third arm is the reason this is not `string | undefined`: an entry that EXISTS
 * but cannot be decrypted (a keychain identity change, a copied secrets.json) is
 * not the same fact as "there is no password", and treating the two alike is
 * precisely how a dedup would merge two different credentials.
 */
export type ProxyPasswordProbe =
  | { state: "unset" }
  | { state: "value"; value: string }
  | { state: "unreadable" };

/** Everything the (now vault-aware) legacy import needs from outside the settings document. */
export interface LegacyProxyImportDeps {
  /**
   * The decrypted password of an EXISTING registry profile. Required, not
   * optional: without it the dedup below can only compare half a credential, and
   * a half-comparison is what makes it unsafe.
   */
  readPassword: (profileId: string) => Promise<ProxyPasswordProbe>;
  /** Mints a fresh profile id; injected for determinism in tests. */
  genId?: () => string;
}

/** Outcome of a legacy import: which profile the scope should now reference, and the password that has to reach the vault. */
export interface LegacyProxyImport {
  profileId: string;
  /**
   * The password embedded in the legacy string's userinfo, decoded — present
   * ONLY together with `created: true`. A deduped import never carries one: a
   * match now REQUIRES the passwords to be equal already, so there is nothing to
   * write, and writing anyway is exactly the defect that made this async (it
   * silently re-authenticated every other consumer of the matched profile).
   */
  password?: string;
  /** False when an existing profile matched (deduped) — the caller then leaves the registry and the vault alone. */
  created: boolean;
}

/**
 * Converts ONE legacy `proxyUrl` string into a registry profile, IN PLACE on a
 * draft the caller owns, and returns the id the scope should now reference.
 *
 * The single implementation for all three scopes (§1 "импорт-на-записи — в
 * одном месте"): three copies would dedupe against three different notions of
 * "same proxy", and three connections sharing one corporate string would end up
 * as three twin profiles.
 *
 * Runs ONLY on the explicit `PROXY_REF_LEGACY` wire action (design review
 * H-04) — never on a read, and never on the automatic doctor/`lastCheck`/
 * binary-path writes those same blocks receive in the background. That is what
 * keeps an untouched settings.json byte-identical and lets a user who never
 * opens the picker keep working exactly as before.
 *
 * An inline `user:pass@` is split apart here: `user` becomes the profile's
 * `login` (settings.json, not a secret) and `pass` comes back for the vault, so
 * the import is also the moment the password stops living in a 0644 file.
 *
 * ASYNC and vault-aware since design review B-08: the dedup compares the FULL
 * credential (normalised url + login + decrypted password), and the password
 * half lives only in the vault. See `sameCredential` for what an unreadable
 * password means.
 */
export async function importLegacyProxy(
  settings: AnycodeSettings,
  legacyUrl: string,
  deps: LegacyProxyImportDeps,
): Promise<LegacyProxyImport | undefined> {
  if (!isProxyUrl(legacyUrl)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(legacyUrl);
  } catch {
    return undefined;
  }
  const login = decodeURIComponent(url.username);
  const password = url.password === "" ? undefined : decodeURIComponent(url.password);
  // Stored without userinfo — the credential halves live in `login` + the vault
  // from here on, which is the at-rest half of the custody fix.
  const bare = new URL(legacyUrl);
  bare.username = "";
  bare.password = "";
  const bareUrl = bare.toString();
  // The registry's custody rule is stricter than TASK.132's legacy predicate
  // (design review B-06): a profile url must be a bare proxy endpoint, with no
  // path/query/fragment. A legacy string that carries one — a PAC url pasted
  // into the proxy field, most likely — is REFUSED conversion rather than
  // silently rewritten into a different endpoint. It keeps working as the legacy
  // string it already is; only the "make it a profile" action fails, loudly.
  if (!isProxyProfileUrl(bareUrl)) {
    return undefined;
  }
  const key = proxyDedupKey(legacyUrl, login);
  // `undefined` here is unreachable after the parse above; comparing it against
  // an unparseable profile's equally-undefined key would dedupe two broken rows
  // into one, so the branch is closed explicitly rather than relied upon.
  const candidates =
    key === undefined ? [] : proxyProfiles(settings).filter((profile) => profileDedupKey(profile) === key);
  for (const candidate of candidates) {
    if (await sameCredential(candidate, password, deps)) {
      return { profileId: candidate.id, created: false };
    }
  }
  const profile: ProxyProfile = {
    id: (deps.genId ?? defaultProxyProfileId)(),
    name: uniqueProxyProfileName(settings, url.host),
    mode: "manual",
    url: bareUrl,
    ...(login !== "" ? { login } : {}),
  };
  settings.network = {
    ...settings.network,
    proxyProfiles: [...proxyProfiles(settings), profile],
  };
  return { profileId: profile.id, ...(password !== undefined ? { password } : {}), created: true };
}

/**
 * True when an existing profile carries exactly the credential the incoming
 * legacy string does — the half of the dedup that needs the vault (design review
 * B-08).
 *
 * Two strings that agree on scheme/host/port/login but disagree on the password
 * are two different accounts on one proxy, not one account typed twice. Merging
 * them would silently REPLACE the password every other consumer of that profile
 * authenticates with, and the first symptom would be a 407 storm on connections
 * the user never touched.
 *
 * An UNREADABLE password answers "not the same": we cannot prove equality, and
 * the safe direction under uncertainty is to mint a separate profile (a
 * duplicate row the user can merge by hand) rather than to alias two credentials
 * we never compared.
 */
async function sameCredential(
  candidate: ProxyProfile,
  password: string | undefined,
  deps: LegacyProxyImportDeps,
): Promise<boolean> {
  const probe = await deps.readPassword(candidate.id);
  if (probe.state === "unreadable") {
    return false;
  }
  return password === undefined ? probe.state === "unset" : probe.state === "value" && probe.value === password;
}

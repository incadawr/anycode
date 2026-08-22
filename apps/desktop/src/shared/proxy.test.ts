/**
 * Unit tests for the proxy-profile contract (TASK.141): the ladder, the pure
 * URL algebra, and the vault-key derivation every other lane builds on.
 *
 * The ladder tests are written as "which rung wins and with what", never as
 * "which env var appeared" — the env half is host-env.test.ts's job, and keeping
 * the two apart is what makes a fall-through bug legible instead of showing up
 * as a missing variable four layers away.
 */

import { describe, expect, it } from "vitest";
import {
  composeProxyUrl,
  engineProxyChain,
  findProxyProfile,
  hostForkProxyChain,
  isProxyProfileSecretKey,
  isProxyProfileUrl,
  isReservedProxyRef,
  maskProxyUrl,
  proxyPathFingerprint,
  proxyProfileSecretKey,
  proxyProfiles,
  PROXY_REF_DIRECT,
  PROXY_REF_LEGACY,
  readProxyScope,
  resolveProxyLadder,
  type ProxyProfile,
  type ProxyScopeId,
} from "./proxy.js";
import type { AnycodeSettings, ProviderConnection } from "./settings.js";

const CORP: ProxyProfile = { id: "proxy-corp", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" };
const SYS: ProxyProfile = { id: "proxy-sys", name: "System", mode: "system" };

function settings(over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...over,
  };
}

function withConnection(connection: ProviderConnection, over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return settings({ provider: { activeConnectionId: connection.id, connections: [connection] }, ...over });
}

const CONNECTION_SCOPE: ProxyScopeId = { kind: "connection", connectionId: "conn-1" };
const APP_SCOPE: ProxyScopeId = { kind: "app" };
const CHAIN: ProxyScopeId[] = [CONNECTION_SCOPE, APP_SCOPE];

describe("resolveProxyLadder — which rung wins", () => {
  it("returns undefined when no scope in the chain says anything", () => {
    expect(resolveProxyLadder(withConnection({ id: "conn-1", providerId: "" }), CHAIN)).toBeUndefined();
  });

  it("descends to the app rung when the connection is silent", () => {
    const current = withConnection(
      { id: "conn-1", providerId: "" },
      { network: { proxyProfiles: [CORP], proxyRef: CORP.id } },
    );
    expect(resolveProxyLadder(current, CHAIN)).toEqual({ source: APP_SCOPE, ref: CORP.id, profile: CORP });
  });

  // The legacy field keeps working with no user action and no migration on read:
  // it is an unnamed implicit manual rung, byte-for-byte its TASK.132 semantics.
  it("reads a legacy proxyUrl string as an implicit rung", () => {
    const current = withConnection({ id: "conn-1", providerId: "", proxyUrl: "http://legacy:8080" });
    expect(resolveProxyLadder(current, CHAIN)).toEqual({
      source: CONNECTION_SCOPE,
      ref: PROXY_REF_LEGACY,
      legacyUrl: "http://legacy:8080",
    });
  });

  it("lets a proxyRef beat the legacy string of the SAME scope", () => {
    const current = withConnection(
      { id: "conn-1", providerId: "", proxyUrl: "http://legacy:8080", proxyRef: CORP.id },
      { network: { proxyProfiles: [CORP] } },
    );
    expect(resolveProxyLadder(current, CHAIN)).toEqual({ source: CONNECTION_SCOPE, ref: CORP.id, profile: CORP });
  });

  // "direct" is an OUTCOME, not an absence: the ladder stops here and the scope
  // below is never consulted.
  it("stops the ladder at an explicit `direct`, never descending to the app rung", () => {
    const current = withConnection(
      { id: "conn-1", providerId: "", proxyRef: PROXY_REF_DIRECT },
      { network: { proxyProfiles: [CORP], proxyRef: CORP.id } },
    );
    expect(resolveProxyLadder(current, CHAIN)).toEqual({ source: CONNECTION_SCOPE, ref: PROXY_REF_DIRECT });
  });

  // The law that makes hand-edited garbage safe: a broken EXPLICIT rung means
  // "direct for this scope", never "use whatever the next scope has". Falling
  // through would route this connection's traffic into someone else's proxy
  // because of a typo — the leak class this rule exists to close.
  it("returns a profile-less rung for a DANGLING ref instead of falling through", () => {
    const current = withConnection(
      { id: "conn-1", providerId: "", proxyRef: "proxy-deleted" },
      { network: { proxyProfiles: [CORP], proxyRef: CORP.id } },
    );
    const rung = resolveProxyLadder(current, CHAIN);
    expect(rung).toEqual({ source: CONNECTION_SCOPE, ref: "proxy-deleted" });
    expect(rung?.profile).toBeUndefined();
  });

  // The deliberate exception to the rule above: a MALFORMED legacy string is not
  // a rung at all, preserving TASK.132's fail-soft reading of that field. The
  // two rules cannot collide on a pre-slice document — nothing existed below a
  // legacy string there to fall through to.
  it("does not treat a malformed legacy string as a rung", () => {
    const current = withConnection(
      { id: "conn-1", providerId: "", proxyUrl: "proxy.corp:3128" },
      { network: { proxyProfiles: [CORP], proxyRef: CORP.id } },
    );
    expect(resolveProxyLadder(current, CHAIN)).toEqual({ source: APP_SCOPE, ref: CORP.id, profile: CORP });
  });

  it("resolves a system-mode profile to a rung carrying that profile", () => {
    const current = settings({ network: { proxyProfiles: [SYS], proxyRef: SYS.id } });
    expect(resolveProxyLadder(current, [APP_SCOPE])).toEqual({ source: APP_SCOPE, ref: SYS.id, profile: SYS });
  });

  it("reads the engine scopes from their own blocks and never from each other's", () => {
    const current = settings({
      codex: { proxyRef: CORP.id },
      claude: { proxyRef: PROXY_REF_DIRECT },
      network: { proxyProfiles: [CORP] },
    });
    expect(resolveProxyLadder(current, engineProxyChain("codex", false))).toEqual({
      source: { kind: "engine", engine: "codex" },
      ref: CORP.id,
      profile: CORP,
    });
    expect(resolveProxyLadder(current, engineProxyChain("claude", false))).toEqual({
      source: { kind: "engine", engine: "claude" },
      ref: PROXY_REF_DIRECT,
    });
  });

  // A blank string is not a choice — it reads as absent everywhere else in the
  // settings surface and must not become an explicit rung here.
  it("treats a blank ref and a blank legacy string as absent", () => {
    const current = withConnection({ id: "conn-1", providerId: "", proxyRef: "  ", proxyUrl: "" });
    expect(resolveProxyLadder(current, CHAIN)).toBeUndefined();
  });
});

describe("chain builders", () => {
  it("puts the connection above the app for the host fork, and omits it when nothing is active", () => {
    expect(hostForkProxyChain("conn-1")).toEqual([CONNECTION_SCOPE, APP_SCOPE]);
    expect(hostForkProxyChain(undefined)).toEqual([APP_SCOPE]);
  });

  // A tab/subagent child's connection + app rungs already ride the host fork's
  // env; adding the app rung to the CARRIER would let the engine value clobber a
  // connection proxy that outranks it — the ladder inverted.
  it("gives a tab child the engine rung alone and a doctor the engine + app rungs", () => {
    expect(engineProxyChain("codex", false)).toEqual([{ kind: "engine", engine: "codex" }]);
    expect(engineProxyChain("claude", true)).toEqual([{ kind: "engine", engine: "claude" }, APP_SCOPE]);
  });
});

describe("readProxyScope — the single scope→field authority", () => {
  it("reports the raw legacy string even when it is unparseable (the importer and the picker need to see it)", () => {
    const current = withConnection({ id: "conn-1", providerId: "", proxyUrl: "nonsense" });
    expect(readProxyScope(current, CONNECTION_SCOPE)).toEqual({ legacyUrl: "nonsense" });
  });

  it("reads a connection scope naming nothing as empty", () => {
    expect(readProxyScope(settings(), { kind: "connection", connectionId: "conn-gone" })).toEqual({});
  });
});

describe("registry lookups", () => {
  it("returns an empty registry for a settings document with no network section", () => {
    expect(proxyProfiles(settings())).toEqual([]);
    expect(findProxyProfile(settings(), CORP.id)).toBeUndefined();
  });

  it("reserves exactly the two ref words the registry can never mint", () => {
    expect(isReservedProxyRef(PROXY_REF_DIRECT)).toBe(true);
    expect(isReservedProxyRef(PROXY_REF_LEGACY)).toBe(true);
    expect(isReservedProxyRef("proxy-abc")).toBe(false);
  });
});

describe("isProxyProfileUrl — the editor's boundary rule", () => {
  it("accepts http/https host:port", () => {
    expect(isProxyProfileUrl("http://proxy.corp:3128")).toBe(true);
    expect(isProxyProfileUrl("https://proxy.corp:8443")).toBe(true);
  });

  // The credential belongs in `login` + the vault. Accepting userinfo in the host
  // field would put a password straight back into the 0644 settings.json this
  // slice exists to take it out of.
  it("REFUSES embedded userinfo, unlike isProxyUrl", () => {
    expect(isProxyProfileUrl("http://user:pass@proxy.corp:3128")).toBe(false);
    expect(isProxyProfileUrl("http://user@proxy.corp:3128")).toBe(false);
  });

  it("refuses a scheme no env-proxy consumer honours, and a scheme-less string", () => {
    expect(isProxyProfileUrl("socks5://proxy.corp:1080")).toBe(false);
    expect(isProxyProfileUrl("proxy.corp:3128")).toBe(false);
  });
});

describe("composeProxyUrl — percent-encoded userinfo", () => {
  it("returns the base URL untouched when there is no login", () => {
    expect(composeProxyUrl("http://proxy.corp:3128")).toBe("http://proxy.corp:3128/");
    expect(composeProxyUrl("http://proxy.corp:3128", "   ")).toBe("http://proxy.corp:3128/");
  });

  // Without encoding, a password containing `@` reparses into a DIFFERENT host
  // and the request silently goes somewhere the user never named. All four of
  // these characters are legal in a proxy password and common in generated ones.
  it("encodes every character that would otherwise reparse the URL", () => {
    const composed = composeProxyUrl("http://proxy.corp:3128", "user@corp", "p@ss:w/rd%1");
    expect(composed).toBe("http://user%40corp:p%40ss%3Aw%2Frd%251@proxy.corp:3128/");
    const parsed = new URL(composed ?? "");
    expect(parsed.hostname).toBe("proxy.corp");
    expect(decodeURIComponent(parsed.username)).toBe("user@corp");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/rd%1");
  });

  it("emits a login with no password when the vault holds none", () => {
    expect(composeProxyUrl("http://proxy.corp:3128", "user")).toBe("http://user@proxy.corp:3128/");
  });

  it("returns undefined for a base URL that does not parse", () => {
    expect(composeProxyUrl("proxy.corp:3128", "user", "pass")).toBeUndefined();
  });
});

describe("maskProxyUrl — the password never comes back out of main", () => {
  it("masks the password and keeps the login legible", () => {
    expect(maskProxyUrl("http://user:pass@proxy.corp:3128")).toBe("http://user:***@proxy.corp:3128/");
  });

  it("leaves a credential-free URL alone", () => {
    expect(maskProxyUrl("http://proxy.corp:3128")).toBe("http://proxy.corp:3128/");
  });

  it("returns an unparseable value verbatim rather than throwing", () => {
    expect(maskProxyUrl("nonsense")).toBe("nonsense");
  });

  it("never leaks the secret substring", () => {
    expect(maskProxyUrl("http://u:s3cr3t@proxy.corp:3128")).not.toContain("s3cr3t");
  });
});

describe("proxyProfileSecretKey — keyed by the immutable id", () => {
  it("derives the vault key from the id", () => {
    expect(proxyProfileSecretKey("proxy-abc")).toBe("proxy.profile.proxy-abc.password");
  });

  it("recognises its own keys and nothing else", () => {
    expect(isProxyProfileSecretKey("proxy.profile.proxy-abc.password")).toBe(true);
    expect(isProxyProfileSecretKey("provider.connection.conn-1.apiKey")).toBe(false);
    expect(isProxyProfileSecretKey("provider.apiKey")).toBe(false);
    // A dotted id would break the `[^.]+` segment the key parser relies on.
    expect(isProxyProfileSecretKey("proxy.profile.a.b.password")).toBe(false);
  });
});

describe("proxyPathFingerprint — what a health reading was measured through", () => {
  const registry = (profile: ProxyProfile, ref: string): AnycodeSettings =>
    withConnection({ id: "conn-1", providerId: "" }, { network: { proxyProfiles: [profile], proxyRef: ref } });

  it("is stable across a RENAME (the name is display-only, the path did not move)", () => {
    const before = registry(CORP, CORP.id);
    const after = registry({ ...CORP, name: "Corporate" }, CORP.id);
    expect(proxyPathFingerprint(after, CHAIN)).toBe(proxyPathFingerprint(before, CHAIN));
  });

  it("moves when the profile's URL changes", () => {
    const before = registry(CORP, CORP.id);
    const after = registry({ ...CORP, url: "http://proxy.corp:9999" }, CORP.id);
    expect(proxyPathFingerprint(after, CHAIN)).not.toBe(proxyPathFingerprint(before, CHAIN));
  });

  it("moves when exemptions or the login change", () => {
    const base = registry(CORP, CORP.id);
    expect(proxyPathFingerprint(registry({ ...CORP, noProxy: "a.corp" }, CORP.id), CHAIN)).not.toBe(
      proxyPathFingerprint(base, CHAIN),
    );
    expect(proxyPathFingerprint(registry({ ...CORP, login: "u" }, CORP.id), CHAIN)).not.toBe(
      proxyPathFingerprint(base, CHAIN),
    );
  });

  // A dangling ref and `direct` land on the same outcome by law, so they must
  // fingerprint the same — switching a scope from a deleted id to `direct`
  // changes nothing about where its traffic goes and must stale no health.
  it("fingerprints a dangling ref and `direct` identically", () => {
    const dangling = withConnection({ id: "conn-1", providerId: "", proxyRef: "proxy-gone" });
    const direct = withConnection({ id: "conn-1", providerId: "", proxyRef: PROXY_REF_DIRECT });
    expect(proxyPathFingerprint(dangling, CHAIN)).toBe(proxyPathFingerprint(direct, CHAIN));
  });

  it("distinguishes `no rung at all` from `direct`", () => {
    const silent = withConnection({ id: "conn-1", providerId: "" });
    const direct = withConnection({ id: "conn-1", providerId: "", proxyRef: PROXY_REF_DIRECT });
    expect(proxyPathFingerprint(silent, CHAIN)).not.toBe(proxyPathFingerprint(direct, CHAIN));
  });
});

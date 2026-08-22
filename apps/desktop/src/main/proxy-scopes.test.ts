/**
 * Unit tests for the scope-binding registry and the legacy importer (TASK.141
 * §3/§1). These are the two pieces every proxy handler stands on: the bindings
 * decide where a ref lives, and the importer decides whether three scopes
 * sharing one corporate proxy string end up as one profile or three twins.
 */

import { describe, expect, it } from "vitest";
import { PROXY_REF_DIRECT, proxyProfiles, readProxyScope, type ProxyProfile, type ProxyScopeId } from "../shared/proxy.js";
import type { AnycodeSettings, ProviderConnection } from "../shared/settings.js";
import type { LegacyProxyImportDeps, ProxyPasswordProbe } from "./proxy-scopes.js";
import {
  allProxyScopes,
  importLegacyProxy,
  proxyProfileConsumers,
  PROXY_SCOPE_BINDINGS,
  uniqueProxyProfileName,
} from "./proxy-scopes.js";

const CORP: ProxyProfile = { id: "proxy-corp", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" };

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

function withConnections(connections: ProviderConnection[], over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return settings({ provider: { activeConnectionId: connections[0]?.id, connections }, ...over });
}

/** Deterministic id minter so a created profile is assertable. */
function ids(...values: string[]): () => string {
  let i = 0;
  return () => values[i++] ?? `proxy-overflow-${i}`;
}

/**
 * Import deps with a deterministic id minter and an explicit view of what the
 * vault holds per profile (B-08: the dedup compares the DECRYPTED password, so
 * the vault is part of the input, not an afterthought). Unlisted profiles read
 * as "no password stored".
 */
function importDeps(
  genId: () => string,
  passwords: Record<string, ProxyPasswordProbe> = {},
): LegacyProxyImportDeps {
  return { genId, readPassword: async (profileId) => passwords[profileId] ?? { state: "unset" } };
}

const APP: ProxyScopeId = { kind: "app" };
const CODEX: ProxyScopeId = { kind: "engine", engine: "codex" };
const CLAUDE: ProxyScopeId = { kind: "engine", engine: "claude" };
const CONN: ProxyScopeId = { kind: "connection", connectionId: "conn-1" };

describe("PROXY_SCOPE_BINDINGS — write", () => {
  it("app: sets and removes the ref, and never leaves an empty `network` husk behind", () => {
    const draft = settings();
    PROXY_SCOPE_BINDINGS.app.write(draft, APP, CORP.id);
    expect(draft.network).toEqual({ proxyRef: CORP.id });
    PROXY_SCOPE_BINDINGS.app.write(draft, APP, null);
    expect("network" in draft).toBe(false);
  });

  it("app: keeps the registry when the ref is removed", () => {
    const draft = settings({ network: { proxyProfiles: [CORP], proxyRef: CORP.id } });
    PROXY_SCOPE_BINDINGS.app.write(draft, APP, null);
    expect(proxyProfiles(draft)).toEqual([CORP]);
    expect(draft.network?.proxyRef).toBeUndefined();
  });

  it("engine: writes into its OWN block and drops the block when nothing else is in it", () => {
    const draft = settings();
    PROXY_SCOPE_BINDINGS.engine.write(draft, CODEX, PROXY_REF_DIRECT);
    expect(draft.codex).toEqual({ proxyRef: PROXY_REF_DIRECT });
    expect(draft.claude).toBeUndefined();
    PROXY_SCOPE_BINDINGS.engine.write(draft, CODEX, null);
    expect("codex" in draft).toBe(false);
  });

  it("engine: a block with siblings survives a ref removal", () => {
    const draft = settings({ claude: { binaryPath: "/usr/local/bin/claude", proxyRef: CORP.id } });
    PROXY_SCOPE_BINDINGS.engine.write(draft, CLAUDE, null);
    expect(draft.claude).toEqual({ binaryPath: "/usr/local/bin/claude" });
  });

  // The grabli case: leaving the legacy string behind would resurrect the OLD
  // proxy the moment the ref above it is cleared, so "clear the proxy" would
  // silently mean "go back to the previous proxy".
  it("clears the legacy proxyUrl together with the ref, on every scope", () => {
    const draft = settings({
      codex: { proxyUrl: "http://legacy:8080", proxyRef: CORP.id },
      provider: { activeConnectionId: "conn-1", connections: [{ id: "conn-1", providerId: "", proxyUrl: "http://legacy:8080" }] },
    });
    PROXY_SCOPE_BINDINGS.engine.write(draft, CODEX, null);
    PROXY_SCOPE_BINDINGS.connection.write(draft, CONN, null);
    expect(readProxyScope(draft, CODEX)).toEqual({});
    expect(readProxyScope(draft, CONN)).toEqual({});
  });

  it("connection: writes the ref and drops the legacy key; an unknown connection is a no-op", () => {
    const draft = withConnections([{ id: "conn-1", providerId: "", proxyUrl: "http://legacy:8080" }]);
    PROXY_SCOPE_BINDINGS.connection.write(draft, CONN, CORP.id);
    expect(draft.provider.connections[0]).toEqual({ id: "conn-1", providerId: "", proxyRef: CORP.id });
    const before = structuredClone(draft);
    PROXY_SCOPE_BINDINGS.connection.write(draft, { kind: "connection", connectionId: "conn-gone" }, CORP.id);
    expect(draft).toEqual(before);
  });
});

describe("PROXY_SCOPE_BINDINGS — describe + exists", () => {
  it("names each scope the way the delete refusal shows it", () => {
    const current = withConnections([{ id: "conn-1", providerId: "anthropic", label: "Anthropic work" }]);
    expect(PROXY_SCOPE_BINDINGS.app.describe(current, APP)).toBe("Application default");
    expect(PROXY_SCOPE_BINDINGS.engine.describe(current, CODEX)).toBe("Codex engine");
    expect(PROXY_SCOPE_BINDINGS.engine.describe(current, CLAUDE)).toBe("Claude engine");
    expect(PROXY_SCOPE_BINDINGS.connection.describe(current, CONN)).toBe("connection «Anthropic work»");
  });

  it("falls back to the providerId, then the id, for an unlabelled connection", () => {
    const byProvider = withConnections([{ id: "conn-1", providerId: "z-ai" }]);
    expect(PROXY_SCOPE_BINDINGS.connection.describe(byProvider, CONN)).toBe("connection «z-ai»");
    const bare = withConnections([{ id: "conn-1", providerId: "" }]);
    expect(PROXY_SCOPE_BINDINGS.connection.describe(bare, CONN)).toBe("connection «conn-1»");
  });

  it("reports existence only for a connection that is actually in the graph", () => {
    const current = withConnections([{ id: "conn-1", providerId: "" }]);
    expect(PROXY_SCOPE_BINDINGS.connection.exists(current, CONN)).toBe(true);
    expect(PROXY_SCOPE_BINDINGS.connection.exists(current, { kind: "connection", connectionId: "conn-x" })).toBe(false);
    expect(PROXY_SCOPE_BINDINGS.app.exists(current, APP)).toBe(true);
  });
});

describe("proxyProfileConsumers — what blocks a delete", () => {
  it("names every referencing scope and ignores the rest", () => {
    const current = withConnections([{ id: "conn-1", providerId: "", label: "Work", proxyRef: CORP.id }], {
      codex: { proxyRef: CORP.id },
      claude: { proxyRef: PROXY_REF_DIRECT },
      network: { proxyProfiles: [CORP], proxyRef: CORP.id },
    });
    expect(proxyProfileConsumers(current, CORP.id)).toEqual([
      "Application default",
      "Codex engine",
      "connection «Work»",
    ]);
  });

  it("is empty when nothing references the profile", () => {
    const current = settings({ network: { proxyProfiles: [CORP] } });
    expect(proxyProfileConsumers(current, CORP.id)).toEqual([]);
  });

  it("walks app, both engines and every connection", () => {
    const current = withConnections([
      { id: "conn-1", providerId: "" },
      { id: "conn-2", providerId: "" },
    ]);
    expect(allProxyScopes(current)).toEqual([
      APP,
      CODEX,
      CLAUDE,
      { kind: "connection", connectionId: "conn-1" },
      { kind: "connection", connectionId: "conn-2" },
    ]);
  });
});

describe("importLegacyProxy — one profile per proxy, not per scope", () => {
  it("mints a manual profile named host:port and strips the userinfo out of the stored URL", async () => {
    const draft = settings();
    const imported = await importLegacyProxy(draft, "http://user:pass@proxy.corp:3128", importDeps(ids("proxy-1")));
    expect(imported).toEqual({ profileId: "proxy-1", password: "pass", created: true });
    expect(proxyProfiles(draft)).toEqual([
      { id: "proxy-1", name: "proxy.corp:3128", mode: "manual", url: "http://proxy.corp:3128/", login: "user" },
    ]);
  });

  // The registry's whole point: three connections carrying the same corporate
  // string converge on ONE profile, editable in one place. B-08 sharpened the
  // rule — convergence now requires the PASSWORD to match too, so the vault view
  // has to reflect what the first import stored.
  it("dedupes by URL + login + password instead of minting a twin", async () => {
    const draft = settings();
    const first = await importLegacyProxy(draft, "http://user:pass@proxy.corp:3128", importDeps(ids("proxy-1")));
    const second = await importLegacyProxy(
      draft,
      "http://user:pass@proxy.corp:3128",
      importDeps(ids("proxy-2"), { "proxy-1": { state: "value", value: "pass" } }),
    );
    expect(second?.profileId).toBe(first?.profileId);
    expect(second?.created).toBe(false);
    // A deduped import carries NO password: the match proved the stored one is
    // already identical, so there is nothing for the caller to write.
    expect(second?.password).toBeUndefined();
    expect(proxyProfiles(draft)).toHaveLength(1);
  });

  it("treats a different login on the same host as a DIFFERENT proxy account", async () => {
    const draft = settings();
    await importLegacyProxy(draft, "http://alice:pw@proxy.corp:3128", importDeps(ids("proxy-1")));
    await importLegacyProxy(
      draft,
      "http://bob:pw@proxy.corp:3128",
      importDeps(ids("proxy-2"), { "proxy-1": { state: "value", value: "pw" } }),
    );
    expect(proxyProfiles(draft)).toHaveLength(2);
  });

  // B-08: the dedup used to compare url+login ONLY, so two accounts that share a
  // host and a username but differ in password merged — and the merge silently
  // re-pointed the password every EXISTING consumer of that profile
  // authenticates with.
  it("B-08: a different password on the same host+login mints a separate profile, never overwrites", async () => {
    const draft = settings();
    await importLegacyProxy(draft, "http://user:secret-A@proxy.corp:3128", importDeps(ids("proxy-1")));
    const second = await importLegacyProxy(
      draft,
      "http://user:secret-B@proxy.corp:3128",
      importDeps(ids("proxy-2"), { "proxy-1": { state: "value", value: "secret-A" } }),
    );
    expect(second).toEqual({ profileId: "proxy-2", password: "secret-B", created: true });
    expect(proxyProfiles(draft)).toHaveLength(2);
  });

  // B-08: "cannot read the stored password" is not "the passwords are equal".
  // Under uncertainty the safe move is a separate profile the user can merge by
  // hand, never an alias between two credentials nobody compared.
  it("B-08: an UNREADABLE stored password blocks the dedup", async () => {
    const draft = settings();
    await importLegacyProxy(draft, "http://user:pass@proxy.corp:3128", importDeps(ids("proxy-1")));
    const second = await importLegacyProxy(
      draft,
      "http://user:pass@proxy.corp:3128",
      importDeps(ids("proxy-2"), { "proxy-1": { state: "unreadable" } }),
    );
    expect(second?.created).toBe(true);
    expect(second?.profileId).toBe("proxy-2");
  });

  // The credential-free case is symmetric: a password-less legacy string matches
  // only a profile the vault holds NOTHING for.
  it("B-08: a password-less string does not dedupe onto a profile that has a password", async () => {
    const draft = settings();
    await importLegacyProxy(draft, "http://user:pass@proxy.corp:3128", importDeps(ids("proxy-1")));
    const second = await importLegacyProxy(
      draft,
      "http://user@proxy.corp:3128",
      importDeps(ids("proxy-2"), { "proxy-1": { state: "value", value: "pass" } }),
    );
    expect(second?.created).toBe(true);
  });

  it("suffixes a colliding name rather than shadowing the existing profile", async () => {
    const draft = settings({
      network: { proxyProfiles: [{ id: "proxy-0", name: "proxy.corp:3128", mode: "system" }] },
    });
    const imported = await importLegacyProxy(draft, "http://proxy.corp:3128", importDeps(ids("proxy-1")));
    expect(imported?.created).toBe(true);
    expect(proxyProfiles(draft)[1]?.name).toBe("proxy.corp:3128 (2)");
  });

  it("carries no login/password keys for a credential-free legacy string", async () => {
    const draft = settings();
    const imported = await importLegacyProxy(draft, "http://proxy.corp:3128", importDeps(ids("proxy-1")));
    expect(imported).toEqual({ profileId: "proxy-1", created: true });
    expect(proxyProfiles(draft)[0]).toEqual({
      id: "proxy-1",
      name: "proxy.corp:3128",
      mode: "manual",
      url: "http://proxy.corp:3128/",
    });
  });

  it("decodes percent-encoded userinfo back to the real credential", async () => {
    const draft = settings();
    const imported = await importLegacyProxy(
      draft,
      "http://user%40corp:p%40ss@proxy.corp:3128",
      importDeps(ids("proxy-1")),
    );
    expect(imported?.password).toBe("p@ss");
    expect(proxyProfiles(draft)[0]?.login).toBe("user@corp");
  });

  it("refuses a string that is not an http(s) proxy URL and leaves the registry untouched", async () => {
    const draft = settings();
    expect(await importLegacyProxy(draft, "proxy.corp:3128", importDeps(ids("proxy-1")))).toBeUndefined();
    expect(await importLegacyProxy(draft, "socks5://proxy.corp:1080", importDeps(ids("proxy-1")))).toBeUndefined();
    expect("network" in draft).toBe(false);
  });

  // B-06: the registry's custody rule is stricter than TASK.132's legacy
  // predicate. A legacy string carrying a path (a PAC url in the proxy field,
  // most likely) keeps working AS a legacy string, but converting it would have
  // to silently rewrite the endpoint — so the conversion is refused instead.
  it("B-06: refuses to convert a legacy string with a path/query/fragment", async () => {
    const draft = settings();
    expect(await importLegacyProxy(draft, "http://proxy.corp:3128/pac", importDeps(ids("proxy-1")))).toBeUndefined();
    expect(await importLegacyProxy(draft, "http://proxy.corp:3128/?a=1", importDeps(ids("proxy-1")))).toBeUndefined();
    expect("network" in draft).toBe(false);
  });

  it("never dedupes against a system-mode profile (it has no URL to match)", async () => {
    const draft = settings({ network: { proxyProfiles: [{ id: "proxy-sys", name: "System", mode: "system" }] } });
    const imported = await importLegacyProxy(draft, "http://proxy.corp:3128", importDeps(ids("proxy-1")));
    expect(imported?.created).toBe(true);
  });
});

describe("uniqueProxyProfileName", () => {
  it("returns the desired name when free, and counts up past every case-insensitive collision", () => {
    const current = settings({
      network: {
        proxyProfiles: [
          { id: "a", name: "Corp", mode: "system" },
          { id: "b", name: "corp (2)", mode: "system" },
        ],
      },
    });
    expect(uniqueProxyProfileName(current, "Other")).toBe("Other");
    expect(uniqueProxyProfileName(current, "Corp")).toBe("Corp (3)");
  });
});

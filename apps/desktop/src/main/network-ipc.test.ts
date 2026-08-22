/**
 * Unit tests for the `proxy-check` handler (TASK.141 §6, design review B-11).
 *
 * Every dependency is faked, so the whole decision tree runs with no Electron,
 * no vault, no network and no child process. The assertions that matter most are
 * the NEGATIVE ones: the four situations in which the handler must NOT spawn,
 * and must report `proxyUsed: false` — a green probe that never touched the
 * proxy is exactly the lie the extended verdict enum exists to prevent.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROXY_CHECK_TARGET,
  SHELL_OVERRIDE_NOTE,
  bootEnvOwnsProxyFamily,
  effectiveNoProxy,
  handleProxyCheck,
  noProxyMatchesTarget,
  parseProxyCheckRequest,
  resolveProbeTarget,
  type NetworkIpcDeps,
} from "./network-ipc.js";
import { PROXY_PROBE_MARKER, type ProxyProbeSpawnRequest, type ProxyProbeSpawner } from "./proxy-probe.js";
import { connectionFixture, providerV2Multi } from "../shared/provider-v2-fixture.js";
import type { MaterializedProxy, ProxyProfile, SystemProxyOutcome, SystemProxyResolver } from "../shared/proxy.js";
import type { AnycodeSettings } from "../shared/settings.js";

const MANUAL: ProxyProfile = { id: "proxy-1", name: "Corp", mode: "manual", url: "http://proxy.corp:3128" };
const SYSTEM: ProxyProfile = { id: "proxy-sys", name: "System", mode: "system" };

function settingsWith(profiles: ProxyProfile[], connections = [], activeId?: string): AnycodeSettings {
  return {
    version: 2,
    provider: providerV2Multi(activeId, connections),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    network: { proxyProfiles: profiles },
  } as unknown as AnycodeSettings;
}

interface Harness {
  deps: NetworkIpcDeps;
  spawns: ProxyProbeSpawnRequest[];
  envs: Array<MaterializedProxy | undefined>;
}

function harness(over: Partial<NetworkIpcDeps> & { systemOutcome?: SystemProxyOutcome; payload?: unknown } = {}): Harness {
  const spawns: ProxyProbeSpawnRequest[] = [];
  const envs: Array<MaterializedProxy | undefined> = [];
  const payload = over.payload ?? { ok: true, status: 401 };
  const spawn: ProxyProbeSpawner = vi.fn(async (request) => {
    spawns.push(request);
    return { exitCode: 0, stdout: `${PROXY_PROBE_MARKER}${JSON.stringify(payload)}\n`, stderr: "" };
  });
  const systemProxy: SystemProxyResolver = {
    cached: () => over.systemOutcome ?? { kind: "unresolved" },
    resolve: async () => over.systemOutcome ?? { kind: "unresolved" },
  };
  const deps: NetworkIpcDeps = {
    readSettings: () => settingsWith([MANUAL, SYSTEM]),
    bootEnv: {},
    execPath: "/electron",
    systemProxy,
    readPassword: async () => undefined,
    composeProbeEnv: (proxy) => {
      envs.push(proxy);
      return proxy === undefined ? { PATH: "/usr/bin" } : { PATH: "/usr/bin", HTTPS_PROXY: proxy.url };
    },
    spawn,
    ...over,
  };
  return { deps, spawns, envs };
}

describe("parseProxyCheckRequest", () => {
  it("accepts a bare profile id", () => {
    expect(parseProxyCheckRequest({ profileId: "proxy-1" })).toEqual({ profileId: "proxy-1" });
  });

  it("accepts both explicit target forms", () => {
    expect(parseProxyCheckRequest({ profileId: "p", target: { kind: "url", url: "https://h/" } })).toEqual({
      profileId: "p",
      target: { kind: "url", url: "https://h/" },
    });
    expect(parseProxyCheckRequest({ profileId: "p", target: { kind: "connection", connectionId: "c" } })).toEqual({
      profileId: "p",
      target: { kind: "connection", connectionId: "c" },
    });
  });

  it("refuses anything else at the trust boundary", () => {
    expect(parseProxyCheckRequest(undefined)).toBeUndefined();
    expect(parseProxyCheckRequest("proxy-1")).toBeUndefined();
    expect(parseProxyCheckRequest({})).toBeUndefined();
    expect(parseProxyCheckRequest({ profileId: "  " })).toBeUndefined();
    expect(parseProxyCheckRequest({ profileId: "p", target: { kind: "scope" } })).toBeUndefined();
    expect(parseProxyCheckRequest({ profileId: "p", target: { kind: "url" } })).toBeUndefined();
  });
});

describe("noProxyMatchesTarget", () => {
  it("matches a host and its subdomains, with or without a leading dot", () => {
    expect(noProxyMatchesTarget("corp.internal", "https://corp.internal/x")).toBe(true);
    expect(noProxyMatchesTarget("corp.internal", "https://api.corp.internal/x")).toBe(true);
    expect(noProxyMatchesTarget(".corp.internal", "https://api.corp.internal/x")).toBe(true);
    expect(noProxyMatchesTarget("corp.internal", "https://notcorp.internal/x")).toBe(false);
  });

  it("matches case-insensitively and across comma or whitespace separators", () => {
    expect(noProxyMatchesTarget("A.EXAMPLE, b.example  c.example", "https://B.Example/")).toBe(true);
  });

  it("honours a pinned port against the scheme default", () => {
    expect(noProxyMatchesTarget("h:443", "https://h/")).toBe(true);
    expect(noProxyMatchesTarget("h:8080", "https://h/")).toBe(false);
    expect(noProxyMatchesTarget("h:8080", "https://h:8080/")).toBe(true);
  });

  it("exempts everything for `*`", () => {
    expect(noProxyMatchesTarget("*", "https://anything/")).toBe(true);
  });

  it("matches an IPv6 loopback whether the list brackets it or not", () => {
    expect(noProxyMatchesTarget("[::1]", "http://[::1]:8080/")).toBe(true);
    expect(noProxyMatchesTarget("::1", "http://[::1]:8080/")).toBe(true);
  });

  it("does not pretend a JetBrains glob works", () => {
    expect(noProxyMatchesTarget("192.168.*", "http://192.168.1.5/")).toBe(false);
  });
});

describe("effectiveNoProxy", () => {
  it("keeps the loopback default when a profile lists nothing", () => {
    expect(effectiveNoProxy(undefined)).toContain("127.0.0.1");
    expect(effectiveNoProxy("   ")).toBe(effectiveNoProxy(undefined));
  });

  it("appends the profile's entries rather than replacing the loopback default", () => {
    const list = effectiveNoProxy("corp.internal");
    expect(list).toContain("127.0.0.1");
    expect(list.endsWith(",corp.internal")).toBe(true);
  });
});

describe("bootEnvOwnsProxyFamily", () => {
  it("is true for any of the four variables and false for a blank one", () => {
    expect(bootEnvOwnsProxyFamily({})).toBe(false);
    expect(bootEnvOwnsProxyFamily({ https_proxy: "http://s:1" })).toBe(true);
    expect(bootEnvOwnsProxyFamily({ HTTP_PROXY: "  " })).toBe(false);
  });
});

describe("resolveProbeTarget", () => {
  const connections = [
    connectionFixture({ connectionId: "c1", id: "anthropic", baseUrl: "https://one.example/v1" }),
    connectionFixture({ connectionId: "c2", id: "openai" }),
  ];
  const settings = settingsWith([MANUAL], connections as never, "c1");

  it("prefers an explicit url", () => {
    expect(resolveProbeTarget(settings, { profileId: "p", target: { kind: "url", url: "https://x/" } })).toEqual({
      ok: true,
      targetUrl: "https://x/",
    });
  });

  it("refuses an explicit target that is not an http(s) url", () => {
    expect(resolveProbeTarget(settings, { profileId: "p", target: { kind: "url", url: "ftp://x/" } })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("uses the named connection's baseUrl", () => {
    expect(
      resolveProbeTarget(settings, { profileId: "p", target: { kind: "connection", connectionId: "c1" } }),
    ).toEqual({ ok: true, targetUrl: "https://one.example/v1" });
  });

  it("reports a connection that does not exist", () => {
    expect(
      resolveProbeTarget(settings, { profileId: "p", target: { kind: "connection", connectionId: "gone" } }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("falls back to the default endpoint for a connection with no baseUrl of its own", () => {
    expect(
      resolveProbeTarget(settings, { profileId: "p", target: { kind: "connection", connectionId: "c2" } }),
    ).toEqual({ ok: true, targetUrl: DEFAULT_PROXY_CHECK_TARGET });
  });

  it("uses the active connection when the request names no target", () => {
    expect(resolveProbeTarget(settings, { profileId: "p" })).toEqual({ ok: true, targetUrl: "https://one.example/v1" });
  });

  it("falls back to the default endpoint when there is no active connection", () => {
    expect(resolveProbeTarget(settingsWith([MANUAL]), { profileId: "p" })).toEqual({
      ok: true,
      targetUrl: DEFAULT_PROXY_CHECK_TARGET,
    });
  });
});

describe("handleProxyCheck — refusals", () => {
  it("refuses a malformed payload", async () => {
    const { deps } = harness();
    expect(await handleProxyCheck(deps, { nope: 1 })).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports not_found before boot loaded the registry", async () => {
    const { deps } = harness({ readSettings: () => null });
    expect(await handleProxyCheck(deps, { profileId: "proxy-1" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports not_found for an unknown profile", async () => {
    const { deps } = harness();
    expect(await handleProxyCheck(deps, { profileId: "proxy-gone" })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("handleProxyCheck — the verdicts that must not spawn", () => {
  it("reports socks_unsupported without probing anything", async () => {
    const { deps, spawns } = harness({ systemOutcome: { kind: "socks_unsupported" } });
    const result = await handleProxyCheck(deps, { profileId: "proxy-sys" });
    expect(result).toMatchObject({ ok: true, verdict: "socks_unsupported", proxyUsed: false, shellOverride: false });
    expect(spawns).toHaveLength(0);
  });

  it("reports direct for a system profile the OS answered DIRECT for", async () => {
    const { deps, spawns } = harness({ systemOutcome: { kind: "direct" } });
    const result = await handleProxyCheck(deps, { profileId: "proxy-sys" });
    expect(result).toMatchObject({ ok: true, verdict: "direct", proxyUsed: false });
    expect(spawns).toHaveLength(0);
  });

  it("reports direct — not an error — when nothing has been resolved yet", async () => {
    const { deps } = harness({ systemOutcome: { kind: "unresolved" } });
    const result = await handleProxyCheck(deps, { profileId: "proxy-sys" });
    expect(result).toMatchObject({ ok: true, verdict: "direct", proxyUsed: false });
  });

  it("reports direct for a manual profile whose URL is missing or broken", async () => {
    for (const url of [undefined, "proxy.corp:3128", "http://user:pw@proxy:3128"]) {
      const broken: ProxyProfile = { id: "proxy-1", name: "Corp", mode: "manual", ...(url === undefined ? {} : { url }) };
      const { deps, spawns } = harness({ readSettings: () => settingsWith([broken]) });
      const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
      expect(result).toMatchObject({ ok: true, verdict: "direct", proxyUsed: false });
      expect(spawns).toHaveLength(0);
    }
  });

  it("reports bypassed_by_no_proxy when the target matches the profile's exemptions", async () => {
    const exempt: ProxyProfile = { ...MANUAL, noProxy: "anthropic.com" };
    const { deps, spawns } = harness({ readSettings: () => settingsWith([exempt]) });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ ok: true, verdict: "bypassed_by_no_proxy", proxyUsed: false });
    expect(spawns).toHaveLength(0);
  });

  it("reports bypassed_by_no_proxy for a loopback target even with no profile exemptions", async () => {
    const { deps, spawns } = harness();
    const result = await handleProxyCheck(deps, {
      profileId: "proxy-1",
      target: { kind: "url", url: "http://127.0.0.1:11434/" },
    });
    expect(result).toMatchObject({ ok: true, verdict: "bypassed_by_no_proxy", proxyUsed: false });
    expect(spawns).toHaveLength(0);
  });
});

describe("handleProxyCheck — the spawn path", () => {
  it("probes through the materialised proxy and reports ok on any target answer", async () => {
    const { deps, spawns, envs } = harness();
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toEqual({
      ok: true,
      verdict: "ok",
      targetUrl: DEFAULT_PROXY_CHECK_TARGET,
      proxyUsed: true,
      shellOverride: false,
      detail: "via http://proxy.corp:3128/: target answered HTTP 401",
    });
    expect(envs).toEqual([{ url: "http://proxy.corp:3128/" }]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.env.HTTPS_PROXY).toBe("http://proxy.corp:3128/");
  });

  it("materialises a system profile from the FRESH resolve, not the cache", async () => {
    const resolve = vi.fn(async (): Promise<SystemProxyOutcome> => ({ kind: "proxy", url: "http://sys:8080" }));
    const { deps, envs } = harness({
      systemProxy: { cached: () => ({ kind: "unresolved" }), resolve },
    });
    const result = await handleProxyCheck(deps, { profileId: "proxy-sys" });
    expect(resolve).toHaveBeenCalledWith(DEFAULT_PROXY_CHECK_TARGET);
    expect(result).toMatchObject({ verdict: "ok", proxyUsed: true });
    expect(envs).toEqual([{ url: "http://sys:8080/" }]);
  });

  it("carries the profile's exemptions into the materialised proxy", async () => {
    const exempt: ProxyProfile = { ...MANUAL, noProxy: "corp.internal" };
    const { deps, envs } = harness({ readSettings: () => settingsWith([exempt]) });
    await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(envs).toEqual([{ url: "http://proxy.corp:3128/", noProxy: "corp.internal" }]);
  });

  it("composes the vault password into the proxy userinfo and masks it back out of the verdict", async () => {
    const withLogin: ProxyProfile = { ...MANUAL, login: "bob" };
    const { deps, envs } = harness({
      readSettings: () => settingsWith([withLogin]),
      readPassword: async () => "s3cr3t/@",
    });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(envs[0]?.url).toContain("bob:");
    expect(envs[0]?.url).not.toContain("s3cr3t/@");
    expect(result).toMatchObject({ verdict: "ok", proxyUsed: true });
    const detail = result.ok ? (result.detail ?? "") : "";
    expect(detail).toContain("bob:***@proxy.corp:3128");
    expect(detail).not.toContain("s3cr3t");
  });

  it("blames the proxy for a refused connection when the proxy was in play", async () => {
    const { deps } = harness({
      payload: { ok: false, chain: [{ name: "Error", message: "connect ECONNREFUSED 10.0.0.1:3128", code: "ECONNREFUSED" }] },
    });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ verdict: "proxy_unreachable", proxyUsed: true });
  });

  it("reports proxy_auth for a 407 tunnel refusal", async () => {
    const { deps } = harness({
      payload: {
        ok: false,
        chain: [
          { name: "TypeError", message: "fetch failed" },
          { name: "AbortError", message: "Proxy response (407) !== 200 when HTTP Tunneling", code: "UND_ERR_ABORTED" },
        ],
      },
    });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ verdict: "proxy_auth", proxyUsed: true });
  });

  it("reports tls for an intercepted handshake", async () => {
    const { deps } = harness({
      payload: {
        ok: false,
        chain: [{ name: "Error", message: "self signed certificate in certificate chain", code: "SELF_SIGNED_CERT_IN_CHAIN" }],
      },
    });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ verdict: "tls" });
  });

  it("probes the target the request names, not the default", async () => {
    const { deps, spawns } = harness();
    const result = await handleProxyCheck(deps, {
      profileId: "proxy-1",
      target: { kind: "url", url: "https://corp.example/health" },
    });
    expect(result).toMatchObject({ targetUrl: "https://corp.example/health" });
    expect(spawns[0]?.args).toContain("https://corp.example/health");
  });
});

describe("handleProxyCheck — the shell override", () => {
  it("refuses to claim the profile was exercised when the shell owns the family", async () => {
    const { deps, spawns } = harness({ bootEnv: { HTTPS_PROXY: "http://shell:8080" } });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ ok: true, verdict: "ok", proxyUsed: false, shellOverride: true });
    const detail = result.ok ? (result.detail ?? "") : "";
    expect(detail).toContain(SHELL_OVERRIDE_NOTE);
    expect(detail).toContain("was not exercised");
    // Still probes: the request tells the user whether the target answers at
    // all, it just cannot be read as a statement about the profile.
    expect(spawns).toHaveLength(1);
  });

  it("names the caveat on a no-spawn verdict too", async () => {
    const { deps } = harness({ bootEnv: { http_proxy: "http://shell:8080" }, systemOutcome: { kind: "direct" } });
    const result = await handleProxyCheck(deps, { profileId: "proxy-sys" });
    const detail = result.ok ? (result.detail ?? "") : "";
    expect(result).toMatchObject({ verdict: "direct", shellOverride: true, proxyUsed: false });
    expect(detail).toContain(SHELL_OVERRIDE_NOTE);
  });

  it("takes the injected gate over the built-in four-variable check", async () => {
    const { deps } = harness({ bootEnv: { HTTPS_PROXY: "http://shell:8080" }, shellOwnsProxyFamily: () => false });
    const result = await handleProxyCheck(deps, { profileId: "proxy-1" });
    expect(result).toMatchObject({ proxyUsed: true, shellOverride: false });
  });
});

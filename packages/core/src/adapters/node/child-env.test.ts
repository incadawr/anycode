/**
 * TASK.135 / Taskana 4074 unit suite for the non-engine child-env scrub.
 * Every edge is its own `it`, exactly as the brief (§2.1) enumerates them.
 */

import { describe, expect, it } from "vitest";
import {
  buildChildEnv,
  isEngineProxyCarrierName,
  isProxyVarName,
  proxyValueHasUserinfo,
  isCredentialFreeRelayUrl,
  proxyValueCarriesCredential,
  sanitizeChildEnv,
} from "./child-env.js";

describe("sanitizeChildEnv (TASK.135)", () => {
  it("drops HTTPS_PROXY/HTTP_PROXY with user:pass userinfo", () => {
    const out = sanitizeChildEnv({
      HTTPS_PROXY: "http://user:pass@proxy:3128",
      HTTP_PROXY: "http://user:pass@proxy:3128",
    });
    expect(out).toEqual({});
  });

  it("drops lowercase https_proxy/http_proxy and mixed-case Https_Proxy when credentialed", () => {
    const out = sanitizeChildEnv({
      https_proxy: "http://u:p@proxy:3128",
      http_proxy: "http://u:p@proxy:3128",
      Https_Proxy: "http://u:p@proxy:3128",
    });
    expect(out).toEqual({});
  });

  it("drops user-only and empty-password userinfo", () => {
    const out = sanitizeChildEnv({
      HTTPS_PROXY: "http://user@proxy:3128",
      HTTP_PROXY: "http://user:@proxy",
    });
    expect(out).toEqual({});
  });

  it("drops percent-encoded userinfo and leaks none of it into the result", () => {
    const out = sanitizeChildEnv({
      HTTPS_PROXY: "http://us%40er:p%3Ass%2Fw@proxy:3128",
    });
    expect(out).toEqual({});
    expect(JSON.stringify(out)).not.toContain("p%3Ass");
  });

  it("drops credentialed ALL_PROXY/all_proxy but keeps credential-less socks5h", () => {
    const out = sanitizeChildEnv({
      ALL_PROXY: "socks5://u:p@127.0.0.1:1080",
      all_proxy: "socks5://u:p@127.0.0.1:1080",
      HTTPS_PROXY: "socks5h://proxy:1080",
    });
    expect(out).toEqual({ HTTPS_PROXY: "socks5h://proxy:1080" });
  });

  it("drops a scheme-less user:pass@proxy:3128 value", () => {
    const out = sanitizeChildEnv({ HTTPS_PROXY: "user:pass@proxy:3128" });
    expect(out).toEqual({});
  });

  it("malformed values: spaces-with-@ dropped; '@'-free junk kept verbatim; single-slash http:/u:p@h dropped", () => {
    const out = sanitizeChildEnv({
      HTTPS_PROXY: "http://us er:p w@host",
      HTTP_PROXY: "not a url",
      ALL_PROXY: "http:/u:p@h",
    });
    expect(out).toEqual({ HTTP_PROXY: "not a url" });
  });

  it("keeps an empty HTTPS_PROXY as an empty string", () => {
    const out = sanitizeChildEnv({ HTTPS_PROXY: "" });
    expect(out).toEqual({ HTTPS_PROXY: "" });
  });

  it("keeps NO_PROXY/no_proxy verbatim, including a pathological a@b value", () => {
    const out = sanitizeChildEnv({
      NO_PROXY: "localhost,127.0.0.1,[::1],::1",
      no_proxy: "localhost,127.0.0.1,[::1],::1",
    });
    expect(out).toEqual({
      NO_PROXY: "localhost,127.0.0.1,[::1],::1",
      no_proxy: "localhost,127.0.0.1,[::1],::1",
    });
    expect(sanitizeChildEnv({ NO_PROXY: "a@b" })).toEqual({ NO_PROXY: "a@b" });
  });

  it("keeps credential-less proxies byte-identical, IPv6 literal included", () => {
    const out = sanitizeChildEnv({
      HTTPS_PROXY: "http://proxy.corp:3128",
      HTTP_PROXY: "http://[::1]:3128",
    });
    expect(out).toEqual({ HTTPS_PROXY: "http://proxy.corp:3128", HTTP_PROXY: "http://[::1]:3128" });
  });

  it("drops engine proxy carriers whatever their value", () => {
    const out = sanitizeChildEnv({
      ANYCODE_CODEX_PROXY_URL: '{"url":"http://u:p@h:1"}',
      ANYCODE_CLAUDE_PROXY_URL: "direct",
      FOO: JSON.stringify({ v: '{"url":"http://h:1"}' }),
    });
    expect(out.ANYCODE_CODEX_PROXY_URL).toBeUndefined();
    expect(out.ANYCODE_CLAUDE_PROXY_URL).toBeUndefined();
    // The sibling with a credential-less url (still a carrier) is dropped too.
    expect(sanitizeChildEnv({ ANYCODE_CLAUDE_PROXY_URL: '{"url":"http://h:1"}' })).toEqual({});
  });

  it("keeps non-proxy @-values (EMAIL, git identity) and drops npm_config credentialed proxies but not NPM_CONFIG_NOPROXY", () => {
    const out = sanitizeChildEnv({
      EMAIL: "a@b.c",
      GIT_AUTHOR_EMAIL: "a@b.c",
      npm_config_https_proxy: "http://u:p@h",
      NPM_CONFIG_NOPROXY: "localhost",
    });
    expect(out).toEqual({ EMAIL: "a@b.c", GIT_AUTHOR_EMAIL: "a@b.c", NPM_CONFIG_NOPROXY: "localhost" });
  });

  it("never mutates its input and always returns a new object; buildChildEnv leaves both inputs untouched", () => {
    const base = { PATH: "/bin", HTTPS_PROXY: "http://u:p@h:1", NO_PROXY: "localhost" };
    const baseSnapshot = { ...base };
    const overlay = { GIT_DIR: "/x", ALL_PROXY: "http://u:p@h:2" };
    const overlaySnapshot = { ...overlay };

    const out = sanitizeChildEnv(base);
    expect(out).not.toBe(base);
    expect(base).toEqual(baseSnapshot);
    expect(out).toEqual({ PATH: "/bin", NO_PROXY: "localhost" });

    const merged = buildChildEnv(base, overlay);
    expect(base).toEqual(baseSnapshot);
    expect(overlay).toEqual(overlaySnapshot);
    expect(merged).toEqual({ PATH: "/bin", NO_PROXY: "localhost", GIT_DIR: "/x" });
  });

  it("overlay: credentialed HTTPS_PROXY over a clean base is dropped; credential-less over a credentialed base wins; undefined-valued keys survive", () => {
    expect(buildChildEnv({ HTTPS_PROXY: "http://h:1" }, { HTTPS_PROXY: "http://u:p@h:2" })).toEqual({});
    expect(buildChildEnv({ HTTPS_PROXY: "http://u:p@h:2" }, { HTTPS_PROXY: "http://h:1" })).toEqual({
      HTTPS_PROXY: "http://h:1",
    });
    const withUndefined = buildChildEnv({ GIT_DIR: "/old" }, { GIT_DIR: undefined });
    expect("GIT_DIR" in withUndefined).toBe(true);
    expect(withUndefined.GIT_DIR).toBeUndefined();
  });

  it("drops a value with two @ signs (http://a@b@host)", () => {
    expect(sanitizeChildEnv({ HTTPS_PROXY: "http://a@b@host" })).toEqual({});
  });
});

describe("relayUrl rewrite (TASK.135 follow-up / Taskana 4074)", () => {
  const RELAY = "http://127.0.0.1:47557";

  it("replaces the dropped credentialed vars with the relay URL (all four cases), keeping NO_PROXY as-is", () => {
    const out = sanitizeChildEnv(
      {
        HTTPS_PROXY: "http://user:pass@proxy:3128",
        https_proxy: "http://user:pass@proxy:3128",
        HTTP_PROXY: "http://user:pass@proxy:3128",
        http_proxy: "http://user:pass@proxy:3128",
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
      },
      RELAY,
    );
    expect(out.HTTPS_PROXY).toBe(RELAY);
    expect(out.https_proxy).toBe(RELAY);
    expect(out.HTTP_PROXY).toBe(RELAY);
    expect(out.http_proxy).toBe(RELAY);
    expect(out.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(out.no_proxy).toBe("localhost,127.0.0.1");
    // The card's DoD: no `@` anywhere in the built env (the relay URL is
    // credential-free, and nothing else crept in).
    expect(JSON.stringify(out)).not.toContain("@");
  });

  it("the ANYCODE_*_PROXY_URL carriers are still removed even with a relay", () => {
    const out = sanitizeChildEnv({ ANYCODE_CLAUDE_PROXY_URL: "direct", HTTPS_PROXY: "http://u:p@h:1" }, RELAY);
    expect(out.ANYCODE_CLAUDE_PROXY_URL).toBeUndefined();
    expect(out.HTTPS_PROXY).toBe(RELAY);
  });

  it("Taskana 4685: a tokened relay URL (path segment) replaces the family verbatim", () => {
    const RELAY_TOKENED = "http://127.0.0.1:47557/AbCdEf1234567890_-XyZ";
    const out = sanitizeChildEnv(
      {
        HTTPS_PROXY: "http://user:pass@proxy:3128",
        https_proxy: "http://user:pass@proxy:3128",
        HTTP_PROXY: "http://user:pass@proxy:3128",
        http_proxy: "http://user:pass@proxy:3128",
      },
      RELAY_TOKENED,
    );
    expect(out.HTTPS_PROXY).toBe(RELAY_TOKENED);
    expect(out.https_proxy).toBe(RELAY_TOKENED);
    expect(out.HTTP_PROXY).toBe(RELAY_TOKENED);
    expect(out.http_proxy).toBe(RELAY_TOKENED);
    // The token rides the URL verbatim (no percent-mangling, no stripping).
    expect(JSON.stringify(out)).toContain("AbCdEf1234567890_-XyZ");
    expect(JSON.stringify(out)).not.toContain("@");
  });

  it("a relay with nothing dropped changes nothing (credential-less proxies pass verbatim)", () => {
    expect(sanitizeChildEnv({ HTTPS_PROXY: "http://proxy.corp:3128" }, RELAY)).toEqual({
      HTTPS_PROXY: "http://proxy.corp:3128",
    });
  });

  // F3 repro: a CLEAN member of the proxy family the user deliberately
  // configured must survive the relay rewrite VERBATIM — the old family-
  // atomic write clobbered it with the relay of a DIFFERENT upstream,
  // silently re-routing that traffic through the credentialed proxy.
  it("F3 repro: a clean sibling proxy survives the relay rewrite verbatim (never re-routed through the relay)", () => {
    const out = sanitizeChildEnv(
      {
        HTTPS_PROXY: "http://user:secret@corp:3128",
        HTTP_PROXY: "http://local-mitm:8080", // clean and deliberately DIFFERENT
      },
      RELAY,
    );
    expect(out.HTTPS_PROXY).toBe(RELAY);
    expect(out.HTTP_PROXY).toBe("http://local-mitm:8080");
    // ...and the ABSENT lowercase spelling is NOT relay-filled: curl reads
    // only `http_proxy`, Python lets lowercase win — a relay there would
    // re-route HTTP through the credentialed upstream (review of F3 fix).
    expect(out.http_proxy).toBeUndefined();
    expect(out.https_proxy).toBe(RELAY);
    expect(JSON.stringify(out)).not.toContain("secret");

    // Inverse family: credentialed ALL_PROXY + clean HTTPS_PROXY — the clean
    // HTTPS proxy survives too (the dropped ALL_PROXY is not one of the four
    // HTTP(S)_PROXY names, so nothing is written there; see F4 for the relay
    // side of that gap).
    const inverse = sanitizeChildEnv(
      {
        ALL_PROXY: "http://user:secret@corp:3128",
        HTTPS_PROXY: "http://clean-https:3129",
      },
      RELAY,
    );
    expect(inverse.ALL_PROXY).toBeUndefined();
    expect(inverse.HTTPS_PROXY).toBe("http://clean-https:3129");
    expect(inverse.https_proxy).toBeUndefined(); // clean sibling: absent spelling not relay-filled
    expect(inverse.HTTP_PROXY).toBe(RELAY); // untouched pair still gets the remedy
    expect(inverse.http_proxy).toBe(RELAY);
  });

  // F4 companion: when the only credentialed member is OUTSIDE the four-name
  // set (ALL_PROXY, npm_config_proxy), the drop still gets its relay remedy —
  // the four HTTP(S)_PROXY names are absent, so they are written. Losing this
  // would keep the F4 breakage alive at the child-env layer.
  it("F4 companion: a dropped non-four-name credentialed proxy still yields the relay URL in the four names", () => {
    const out = sanitizeChildEnv({ ALL_PROXY: "http://user:secret@corp:3128" }, RELAY);
    expect(out.ALL_PROXY).toBeUndefined();
    expect(out.HTTPS_PROXY).toBe(RELAY);
    expect(out.https_proxy).toBe(RELAY);
    expect(out.HTTP_PROXY).toBe(RELAY);
    expect(out.http_proxy).toBe(RELAY);
  });

  it("buildChildEnv threads relayUrl through the merge; a credential-less overlay still wins over the relay", () => {
    const out = buildChildEnv({ HTTPS_PROXY: "http://u:p@h:1" }, { EXTRA: "1" }, RELAY);
    expect(out.HTTPS_PROXY).toBe(RELAY);
    expect(out.EXTRA).toBe("1");

    const overridden = buildChildEnv({ HTTPS_PROXY: "http://u:p@h:1" }, { HTTPS_PROXY: "http://clean:2" }, RELAY);
    expect(overridden.HTTPS_PROXY).toBe("http://clean:2");
  });

  it("a relay URL never leaks the credential it stands in for", () => {
    const out = buildChildEnv({ HTTPS_PROXY: "http://user:s3cret@proxy:3128" }, undefined, RELAY);
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(JSON.stringify(out)).not.toContain("user:");
  });
});

// ── Taskana 4685 rework: the relay URL's own userinfo and the per-value swap ──

describe("relay-URL userinfo exemption + per-value swap (Taskana 4685 rework)", () => {
  const RELAY_A = "http://anycode:tok-a@127.0.0.1:47557";
  const RELAY_B = "http://anycode:tok-b@127.0.0.1:47558";

  it("isCredentialFreeRelayUrl: ONLY our exact loopback relay shape is exempt", () => {
    expect(isCredentialFreeRelayUrl(RELAY_A)).toBe(true);
    expect(isCredentialFreeRelayUrl("http://anycode:tok@127.0.0.1:1/path")) .toBe(true);
    // A different user, host, scheme — or a relay user with an EMPTY password — is NOT a relay URL.
    expect(isCredentialFreeRelayUrl("http://anycode:@127.0.0.1:1")).toBe(false);
    expect(isCredentialFreeRelayUrl("http://other:tok@127.0.0.1:1")).toBe(false);
    expect(isCredentialFreeRelayUrl("http://anycode:tok@10.0.0.5:1")).toBe(false);
    expect(isCredentialFreeRelayUrl("https://anycode:tok@127.0.0.1:1")).toBe(false);
    expect(isCredentialFreeRelayUrl("http://u:p@corp:3128")).toBe(false);
    expect(isCredentialFreeRelayUrl("not a url")).toBe(false);
  });

  it("proxyValueCarriesCredential: an @ is a credential EXCEPT the relay URL's own token userinfo", () => {
    expect(proxyValueCarriesCredential("http://u:p@corp:3128")).toBe(true);
    expect(proxyValueCarriesCredential(RELAY_A)).toBe(false);
    // The raw @-detector still sees both (back-compat: proxyValueHasUserinfo is the TASK.135 shape).
    expect(proxyValueHasUserinfo(RELAY_A)).toBe(true);
  });

  it("B2 (lookup form): each dropped value swaps for the relay of THAT value — distinct HTTP vs HTTPS upstreams keep their own relays", () => {
    const relayFor = (upstreamUrl: string): string | undefined =>
      upstreamUrl === "http://u:p@https-up:3128" ? RELAY_A : upstreamUrl === "http://u:p@http-up:8080" ? RELAY_B : undefined;
    const out = sanitizeChildEnv(
      {
        HTTPS_PROXY: "http://u:p@https-up:3128",
        HTTP_PROXY: "http://u:p@http-up:8080",
      },
      relayFor,
    );
    expect(out.HTTPS_PROXY).toBe(RELAY_A);
    expect(out.HTTP_PROXY).toBe(RELAY_B);
  });

  it("B2 (lookup form): a value with no relay of its own is dropped, never swapped for a foreign relay", () => {
    const relayFor = (upstreamUrl: string): string | undefined =>
      upstreamUrl === "http://u:p@known:3128" ? RELAY_A : undefined;
    const out = sanitizeChildEnv(
      {
        HTTPS_PROXY: "http://u:p@known:3128",
        HTTP_PROXY: "http://u:p@unknown:8080",
      },
      relayFor,
    );
    expect(out.HTTPS_PROXY).toBe(RELAY_A);
    expect(out.HTTP_PROXY).toBeUndefined();
    expect(out.http_proxy).toBeUndefined(); // absent spelling not filled from a foreign relay
  });

  it("a minted relay URL in the env passes the scrub verbatim (the exemption in action)", () => {
    const out = sanitizeChildEnv({ HTTPS_PROXY: RELAY_A, NO_PROXY: "127.0.0.1" });
    expect(out).toEqual({ HTTPS_PROXY: RELAY_A, NO_PROXY: "127.0.0.1" });
  });

  it("buildChildEnv accepts the lookup as its third argument (string callers unchanged)", () => {
    const out = buildChildEnv({ HTTPS_PROXY: "http://u:p@h:1" }, undefined, () => RELAY_A);
    expect(out.HTTPS_PROXY).toBe(RELAY_A);
  });
});

describe("name predicates (TASK.135)", () => {
  it("isProxyVarName matches the family in any case and excludes no_proxy", () => {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "FTP_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "Https_Proxy",
      "npm_config_proxy",
      "npm_config_https_proxy",
    ]) {
      expect(isProxyVarName(name)).toBe(true);
    }
    expect(isProxyVarName("NO_PROXY")).toBe(false);
    expect(isProxyVarName("no_proxy")).toBe(false);
    expect(isProxyVarName("EMAIL")).toBe(false);
    expect(isProxyVarName("PROXY_USER")).toBe(false);
  });

  it("proxyValueHasUserinfo is exactly a literal-@ check", () => {
    expect(proxyValueHasUserinfo("http://u:p@h")).toBe(true);
    expect(proxyValueHasUserinfo("user@host")).toBe(true);
    expect(proxyValueHasUserinfo("http://us%40er:p@h")).toBe(true);
    expect(proxyValueHasUserinfo("http://host:3128")).toBe(false);
    expect(proxyValueHasUserinfo("")).toBe(false);
  });

  it("isEngineProxyCarrierName matches the carrier namespace and nothing else", () => {
    expect(isEngineProxyCarrierName("ANYCODE_CLAUDE_PROXY_URL")).toBe(true);
    expect(isEngineProxyCarrierName("ANYCODE_CODEX_PROXY_URL")).toBe(true);
    expect(isEngineProxyCarrierName("ANYCODE_API_KEY")).toBe(false);
    expect(isEngineProxyCarrierName("anycode_claude_proxy_url")).toBe(false);
    expect(isEngineProxyCarrierName("ANYCODE_CLAUDE_PROXY_URL_X")).toBe(false);
  });
});

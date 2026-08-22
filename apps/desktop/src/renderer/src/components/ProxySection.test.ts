/**
 * Pure-logic tests for the ONE proxy-profile editor plaque (TASK.141 lane C).
 * Deliberately `.test.ts` (not `.test.tsx`) — this package's vitest runs in
 * `environment: "node"` with no jsdom and its include glob collects `.test.ts`
 * only, so a `.tsx` test would not even run. The rendered plaque is proven
 * live; everything that could be WRONG lives in the exported helpers below and
 * is called directly here.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection, SecretStatus } from "../../../shared/settings.js";
import type { ProxyProfile } from "../../../shared/proxy.js";
import {
  PROXY_NO_PROXY_PLACEHOLDER,
  PROXY_SHELL_OVERRIDE_NOTE,
  proxyCheckPayload,
  proxyCheckTargetLabel,
  proxyCheckVerdictText,
  proxyComposeUrl,
  proxyDecomposeUrl,
  proxyHostBlocked,
  proxyHostPortBlocked,
  proxyPasswordActionFor,
  proxyPasswordSet,
  proxyPortBlocked,
  proxyProfileDraftFrom,
  proxyProfileDraftToUpsert,
  proxyProfileNameBlocked,
  maskProxyText,
  type ProxyProfileDraft,
} from "./ProxySection.js";

function draft(over: Partial<ProxyProfileDraft> = {}): ProxyProfileDraft {
  return {
    name: "Corporate",
    mode: "manual",
    host: "proxy.example.com",
    port: "3128",
    https: false,
    noProxy: "",
    login: "",
    password: "",
    passwordCleared: false,
    passwordSet: false,
    ...over,
  };
}

function profile(over: Partial<ProxyProfile> = {}): ProxyProfile {
  return { id: "proxy-1", name: "Corporate", mode: "manual", url: "http://proxy.example.com:3128", ...over };
}

describe("proxyDecomposeUrl (TASK.141: a stored URL reopens as the three controls)", () => {
  it("splits scheme, host and port", () => {
    expect(proxyDecomposeUrl("http://proxy.example.com:3128")).toEqual({
      host: "proxy.example.com",
      port: "3128",
      https: false,
      login: "",
    });
  });

  it("reads the https scheme back onto the checkbox", () => {
    expect(proxyDecomposeUrl("https://proxy.example.com:8443").https).toBe(true);
  });

  it("a URL without an explicit port decomposes to a blank port field", () => {
    expect(proxyDecomposeUrl("http://proxy.example.com").port).toBe("");
  });

  // The legacy-import case: a pre-registry string is ALLOWED to embed
  // `user:pass@`, and the login half has to land in its own field (the password
  // half never reaches the renderer — main decomposes that one).
  it("lifts a legacy userinfo login out into its own field, percent-decoded", () => {
    expect(proxyDecomposeUrl("http://user%40corp:secret@proxy.example.com:3128").login).toBe("user@corp");
  });

  it("total on garbage: unparseable, blank, and non-http schemes all decompose to blanks", () => {
    const blank = { host: "", port: "", https: false, login: "" };
    expect(proxyDecomposeUrl("nonsense")).toEqual(blank);
    expect(proxyDecomposeUrl("")).toEqual(blank);
    expect(proxyDecomposeUrl("   ")).toEqual(blank);
    // SOCKS was cut by the owner outright — it must not decompose into a
    // profile that then re-composes as http.
    expect(proxyDecomposeUrl("socks5://proxy.example.com:1080")).toEqual(blank);
  });
});

describe("proxyComposeUrl (TASK.141: the checkbox owns the scheme, not the user)", () => {
  it("composes host + port under the http scheme by default", () => {
    expect(proxyComposeUrl("proxy.example.com", "3128", false)).toBe("http://proxy.example.com:3128");
  });

  it("the HTTPS checkbox is the ONLY thing that picks https", () => {
    expect(proxyComposeUrl("proxy.example.com", "3128", true)).toBe("https://proxy.example.com:3128");
  });

  it("omits the port entirely when the port field is blank", () => {
    expect(proxyComposeUrl("proxy.example.com", "", false)).toBe("http://proxy.example.com");
    expect(proxyComposeUrl("proxy.example.com", "   ", false)).toBe("http://proxy.example.com");
  });

  it("trims both fields", () => {
    expect(proxyComposeUrl("  proxy.example.com  ", " 3128 ", false)).toBe("http://proxy.example.com:3128");
  });

  it('a blank host composes to "" — never a bare scheme', () => {
    expect(proxyComposeUrl("", "3128", false)).toBe("");
    expect(proxyComposeUrl("   ", "3128", true)).toBe("");
  });

  // Round-trip: this is the property that makes the decomposition safe to show
  // in an editor whose Save re-composes what it displays.
  it("round-trips with proxyDecomposeUrl", () => {
    const parts = proxyDecomposeUrl("https://proxy.example.com:8443");
    expect(proxyComposeUrl(parts.host, parts.port, parts.https)).toBe("https://proxy.example.com:8443");
  });
});

describe("proxyHostBlocked (TASK.141: the scheme-less-host:port typo class, inverted)", () => {
  it("accepts a bare host name and an IPv4 literal", () => {
    expect(proxyHostBlocked("proxy.example.com")).toBe(false);
    expect(proxyHostBlocked("10.0.0.7")).toBe(false);
    expect(proxyHostBlocked("  proxy.example.com  ")).toBe(false);
  });

  it("accepts a bracketed IPv6 literal — the one legal use of ':' in this field", () => {
    expect(proxyHostBlocked("[::1]")).toBe(false);
    expect(proxyHostBlocked("[2001:db8::1]")).toBe(false);
  });

  // The exact paste that `isProxyProfileUrl` alone cannot catch:
  // `new URL("http://http://proxy.corp:3128")` parses as host "http" with the
  // rest as a path, so without this rule the profile would silently point at a
  // host called "http".
  it("blocks a pasted scheme, an embedded port, userinfo, and a path", () => {
    expect(proxyHostBlocked("http://proxy.example.com")).toBe(true);
    expect(proxyHostBlocked("proxy.example.com:3128")).toBe(true);
    expect(proxyHostBlocked("user@proxy.example.com")).toBe(true);
    expect(proxyHostBlocked("proxy.example.com/path")).toBe(true);
    expect(proxyHostBlocked("proxy example.com")).toBe(true);
  });

  it("blocks a blank host", () => {
    expect(proxyHostBlocked("")).toBe(true);
    expect(proxyHostBlocked("   ")).toBe(true);
  });
});

describe("proxyPortBlocked (TASK.141)", () => {
  it("a blank port is fine — it means the scheme's default", () => {
    expect(proxyPortBlocked("")).toBe(false);
    expect(proxyPortBlocked("  ")).toBe(false);
  });

  it("accepts a port in range", () => {
    expect(proxyPortBlocked("80")).toBe(false);
    expect(proxyPortBlocked("3128")).toBe(false);
    expect(proxyPortBlocked("65535")).toBe(false);
  });

  it("blocks non-numeric and out-of-range values", () => {
    expect(proxyPortBlocked("31a8")).toBe(true);
    expect(proxyPortBlocked("0")).toBe(true);
    expect(proxyPortBlocked("65536")).toBe(true);
    expect(proxyPortBlocked("-1")).toBe(true);
  });
});

describe("proxyHostPortBlocked (TASK.141 / review B-06: manual REQUIRES a userinfo-free URL)", () => {
  it("passes a well-formed manual address", () => {
    expect(proxyHostPortBlocked(draft())).toBe(false);
    expect(proxyHostPortBlocked(draft({ https: true, port: "" }))).toBe(false);
  });

  // "No proxy" is not a mode and `system` carries no address at all — a system
  // profile with an empty host field must still save.
  it("never blocks a system profile, whatever the address fields hold", () => {
    expect(proxyHostPortBlocked(draft({ mode: "system", host: "", port: "" }))).toBe(false);
    expect(proxyHostPortBlocked(draft({ mode: "system", host: "http://oops" }))).toBe(false);
  });

  it("blocks a manual profile with no address — main refuses one as well (B-06)", () => {
    expect(proxyHostPortBlocked(draft({ host: "" }))).toBe(true);
  });

  it("blocks a pasted scheme and a bad port", () => {
    expect(proxyHostPortBlocked(draft({ host: "http://proxy.example.com" }))).toBe(true);
    expect(proxyHostPortBlocked(draft({ port: "not-a-port" }))).toBe(true);
  });
});

describe("proxyProfileNameBlocked (TASK.141: case-insensitive uniqueness, matching main)", () => {
  const registry = [profile({ id: "proxy-1", name: "Corporate" }), profile({ id: "proxy-2", name: "Lab" })];

  it("refuses a blank name", () => {
    expect(proxyProfileNameBlocked("", registry, undefined)).toBeDefined();
    expect(proxyProfileNameBlocked("   ", registry, undefined)).toBeDefined();
  });

  it("refuses a name that differs only by case", () => {
    expect(proxyProfileNameBlocked("corporate", registry, undefined)).toBeDefined();
    expect(proxyProfileNameBlocked("  CORPORATE ", registry, undefined)).toBeDefined();
  });

  // A rename is an upsert under the SAME id — re-saving a profile without
  // touching its name must never collide with itself.
  it("excludes the profile being edited from the comparison", () => {
    expect(proxyProfileNameBlocked("Corporate", registry, "proxy-1")).toBeUndefined();
  });

  it("accepts a fresh name", () => {
    expect(proxyProfileNameBlocked("Home", registry, undefined)).toBeUndefined();
  });
});

describe("proxyProfileDraftFrom (TASK.141)", () => {
  it("seeds a create draft with no id and manual mode", () => {
    const created = proxyProfileDraftFrom(undefined, false);
    expect(created.id).toBeUndefined();
    expect(created.mode).toBe("manual");
    expect(created).toMatchObject({ name: "", host: "", port: "", https: false, noProxy: "", login: "" });
  });

  it("decomposes an existing profile's URL back into the three controls", () => {
    const seeded = proxyProfileDraftFrom(
      profile({ url: "https://proxy.example.com:8443", noProxy: "internal.corp", login: "bob" }),
      false,
    );
    expect(seeded).toMatchObject({
      id: "proxy-1",
      name: "Corporate",
      mode: "manual",
      host: "proxy.example.com",
      port: "8443",
      https: true,
      noProxy: "internal.corp",
      login: "bob",
    });
  });

  // CUSTODY: main does not return a password, so there is nothing to seed the
  // field from — this is the invariant, not an implementation detail.
  it("never seeds the password field, even for a profile that has one stored", () => {
    const seeded = proxyProfileDraftFrom(profile(), true);
    expect(seeded.password).toBe("");
    expect(seeded.passwordCleared).toBe(false);
    expect(seeded.passwordSet).toBe(true);
  });
});

describe("proxyPasswordActionFor (TASK.141 / review H-01: one atomic mutation)", () => {
  it('nothing typed and nothing cleared = "keep"', () => {
    expect(proxyPasswordActionFor(draft())).toEqual({ action: "keep" });
    expect(proxyPasswordActionFor(draft({ passwordSet: true }))).toEqual({ action: "keep" });
  });

  it('a typed value = "set", verbatim', () => {
    expect(proxyPasswordActionFor(draft({ password: "s3cr3t" }))).toEqual({ action: "set", value: "s3cr3t" });
  });

  // A proxy password may legally start or end with whitespace; trimming it
  // would authenticate against a different string than the one on screen.
  it("does NOT trim the password", () => {
    expect(proxyPasswordActionFor(draft({ password: "  pad  " }))).toEqual({ action: "set", value: "  pad  " });
  });

  it('the Clear button = "clear"', () => {
    expect(proxyPasswordActionFor(draft({ passwordSet: true, passwordCleared: true }))).toEqual({ action: "clear" });
  });

  it("a typed value wins over a pending clear — nothing the user entered is discarded", () => {
    expect(proxyPasswordActionFor(draft({ password: "new", passwordCleared: true }))).toEqual({
      action: "set",
      value: "new",
    });
  });
});

describe("proxyProfileDraftToUpsert (TASK.141)", () => {
  it("omits the id when creating, carries it when editing", () => {
    expect("id" in proxyProfileDraftToUpsert(draft())).toBe(false);
    expect(proxyProfileDraftToUpsert(draft({ id: "proxy-1" })).id).toBe("proxy-1");
  });

  it("composes the URL out of host/port/checkbox and trims the name", () => {
    expect(proxyProfileDraftToUpsert(draft({ name: "  Corporate  ", https: true }))).toMatchObject({
      name: "Corporate",
      mode: "manual",
      url: "https://proxy.example.com:3128",
    });
  });

  // Only-truthy-on-disk: an untouched exemption list or login must not persist
  // as an empty string key.
  it("omits blank optional fields entirely", () => {
    const payload = proxyProfileDraftToUpsert(draft({ noProxy: "  ", login: "  " }));
    expect("noProxy" in payload).toBe(false);
    expect("login" in payload).toBe(false);
  });

  it("sends trimmed exemptions and login when they are set", () => {
    expect(proxyProfileDraftToUpsert(draft({ noProxy: " internal.corp, .example.com ", login: " bob " })))
      .toMatchObject({ noProxy: "internal.corp, .example.com", login: "bob" });
  });

  // A `system` profile that carried a stale URL would read as "a real path" to
  // anyone inspecting settings.json while materialising as something else.
  it("never sends a url for a system profile, even with host/port still filled in", () => {
    expect("url" in proxyProfileDraftToUpsert(draft({ mode: "system" }))).toBe(false);
  });

  it("carries the password action in the SAME payload (H-01)", () => {
    expect(proxyProfileDraftToUpsert(draft({ password: "s3cr3t" })).password).toEqual({
      action: "set",
      value: "s3cr3t",
    });
    expect(proxyProfileDraftToUpsert(draft()).password).toEqual({ action: "keep" });
  });
});

describe("proxyPasswordSet (TASK.141: a boolean, never a value)", () => {
  const secrets: SecretStatus[] = [
    { key: "proxy.profile.proxy-1.password", set: true, source: "vault", tier: "os_encrypted" },
    { key: "proxy.profile.proxy-2.password", set: false, source: "none", tier: "os_encrypted" },
  ];

  it("true only for a profile whose key is present AND set", () => {
    expect(proxyPasswordSet(secrets, "proxy-1")).toBe(true);
    expect(proxyPasswordSet(secrets, "proxy-2")).toBe(false);
    expect(proxyPasswordSet(secrets, "proxy-3")).toBe(false);
  });

  it("false while creating (there is no id yet)", () => {
    expect(proxyPasswordSet(secrets, undefined)).toBe(false);
  });
});

describe("proxyCheckPayload (TASK.141 / review B-11: the probe checks ONE named target)", () => {
  it("omits the target entirely when the default is chosen", () => {
    const payload = proxyCheckPayload("proxy-1", "");
    expect(payload).toEqual({ profileId: "proxy-1" });
    expect("target" in payload).toBe(false);
  });

  it("names the chosen connection as the target", () => {
    expect(proxyCheckPayload("proxy-1", "conn-9")).toEqual({
      profileId: "proxy-1",
      target: { kind: "connection", connectionId: "conn-9" },
    });
  });

  it("whitespace-only is the default, not a connection called '   '", () => {
    expect("target" in proxyCheckPayload("proxy-1", "   ")).toBe(false);
  });
});

describe("proxyCheckTargetLabel (TASK.141)", () => {
  const conn = (over: Partial<ProviderConnection>): ProviderConnection => ({ id: "c1", providerId: "z-ai", ...over });

  it("prefers the connection's label", () => {
    expect(proxyCheckTargetLabel(conn({ label: "Work" }))).toBe("Work");
  });

  it("falls back to the provider id when the label is blank", () => {
    expect(proxyCheckTargetLabel(conn({ label: "  " }))).toBe("z-ai");
    expect(proxyCheckTargetLabel(conn({}))).toBe("z-ai");
  });
});

describe("proxyCheckVerdictText (TASK.141 §6 / review B-11)", () => {
  it("has honest text for every verdict class, and they all differ", () => {
    const verdicts = [
      "ok",
      "direct",
      "bypassed_by_no_proxy",
      "socks_unsupported",
      "proxy_unreachable",
      "proxy_auth",
      "tls",
      "target_unreachable",
    ] as const;
    const texts = verdicts.map((verdict) => proxyCheckVerdictText({ verdict }));
    expect(new Set(texts).size).toBe(verdicts.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  // B-11's whole point: a green verdict obtained WITHOUT touching the proxy is
  // not "the proxy works", and the three verdicts below have to say so in words
  // a user can act on.
  it("never claims the proxy worked for a request that skipped it", () => {
    expect(proxyCheckVerdictText({ verdict: "direct" })).not.toContain("through the proxy");
    expect(proxyCheckVerdictText({ verdict: "bypassed_by_no_proxy" })).toContain("skipped the proxy");
    expect(proxyCheckVerdictText({ verdict: "socks_unsupported" })).toContain("SOCKS");
  });

  it("names the target it actually probed", () => {
    expect(proxyCheckVerdictText({ verdict: "ok", targetUrl: "https://api.example.com/" })).toContain(
      "https://api.example.com/",
    );
  });

  // A password must never appear in a verdict string — whether main put it
  // there or a legacy `user:pass@` string carried it in (review H-02). The
  // detail arm is the one that caught a real hole: `maskProxyUrl` only masks a
  // string that IS a URL, so a URL EMBEDDED in a sentence sailed through it
  // with the password intact.
  it("masks userinfo in the target and in the detail", () => {
    const text = proxyCheckVerdictText({
      verdict: "proxy_auth",
      targetUrl: "http://bob:hunter2@proxy.example.com:3128",
      detail: "http://bob:hunter2@proxy.example.com:3128 answered 407",
    });
    expect(text).not.toContain("hunter2");
    expect(text).toContain("bob:***@");
  });

  it("carries the shell-override caveat when the boot env owns the proxy family", () => {
    expect(proxyCheckVerdictText({ verdict: "ok", shellOverride: true })).toContain(PROXY_SHELL_OVERRIDE_NOTE);
    expect(proxyCheckVerdictText({ verdict: "ok", shellOverride: false })).not.toContain(PROXY_SHELL_OVERRIDE_NOTE);
  });

  it("surfaces a self-contradicting reply rather than letting the reassuring sentence stand alone", () => {
    expect(proxyCheckVerdictText({ verdict: "ok", proxyUsed: false })).toContain("The proxy was not used");
    expect(proxyCheckVerdictText({ verdict: "ok", proxyUsed: true })).not.toContain("The proxy was not used");
  });
});

// The exemption syntax has to be OURS, not JetBrains'. `192.168.*` matches
// nothing in undici or curl, so an example in that shape would teach a syntax
// that silently sends the traffic it claims to exempt through the proxy.
describe("PROXY_NO_PROXY_PLACEHOLDER (TASK.141: honest NO_PROXY syntax)", () => {
  it("shows host suffixes, never a glob", () => {
    expect(PROXY_NO_PROXY_PLACEHOLDER).toBe("internal.corp, .example.com");
    expect(PROXY_NO_PROXY_PLACEHOLDER).not.toContain("*");
  });
});

describe("maskProxyText (TASK.141: the renderer's own last-resort password net)", () => {
  // `maskProxyUrl` returns a non-URL string untouched, so a URL embedded in a
  // sentence keeps its password. Main masking its own `detail` is the contract;
  // this is the guarantee, and it must hold for a detail that names several.
  it("masks userinfo wherever it appears inside a longer string", () => {
    expect(maskProxyText("tried http://bob:hunter2@a:3128 then https://eve:pw@b:8443, both failed")).toBe(
      "tried http://bob:***@a:3128 then https://eve:***@b:8443, both failed",
    );
  });

  it("masks a password-only userinfo too", () => {
    expect(maskProxyText("http://:hunter2@a:3128")).toBe("http://***@a:3128");
  });

  it("leaves text with no credentials alone", () => {
    expect(maskProxyText("http://proxy.example.com:3128 answered")).toBe("http://proxy.example.com:3128 answered");
    expect(maskProxyText("nothing to mask")).toBe("nothing to mask");
  });
});

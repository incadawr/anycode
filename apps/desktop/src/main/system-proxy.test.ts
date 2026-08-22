/**
 * Unit tests for the system-proxy resolver (TASK.141 §4, design review B-10 and
 * M-01). Two halves, both without Electron: the PURE candidate parser, over the
 * list shapes Chromium and hand-written PAC scripts actually emit, and the
 * target-keyed cache, over an injected fake `resolveProxy`.
 *
 * The cache assertions are about TIMING as much as values — an empty cache
 * answering `unresolved`, a stale answer surviving a failed refresh, and one
 * target's answer never being served for another — because those are the three
 * ways a proxy cache silently sends traffic somewhere the user did not choose.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSystemProxyResolver,
  parseProxyCandidates,
  systemProxyCacheKey,
  systemProxyOutcomeFor,
} from "./system-proxy.js";

const TARGET = "https://api.anthropic.com/v1/models";
const OTHER = "https://b.example/v1";

describe("parseProxyCandidates", () => {
  it("splits a proxy-then-direct list into ordered candidates", () => {
    expect(parseProxyCandidates("PROXY a:1; DIRECT")).toEqual([
      { kind: "proxy", host: "a", port: 1, raw: "PROXY a:1" },
      { kind: "direct", raw: "DIRECT" },
    ]);
  });

  it("reads an HTTPS candidate", () => {
    expect(parseProxyCandidates("HTTPS a:1")).toEqual([{ kind: "https", host: "a", port: 1, raw: "HTTPS a:1" }]);
  });

  it("reads every SOCKS spelling as one kind", () => {
    expect(parseProxyCandidates("SOCKS h:1; SOCKS4 h:2; SOCKS5 h:3").map((candidate) => candidate.kind)).toEqual([
      "socks",
      "socks",
      "socks",
    ]);
  });

  it("returns nothing for an empty or whitespace list", () => {
    expect(parseProxyCandidates("")).toEqual([]);
    expect(parseProxyCandidates("   ;  ; ")).toEqual([]);
  });

  it("marks malformed entries unknown instead of dropping them", () => {
    expect(parseProxyCandidates("GARBAGE; PROXY; PROXY a:notaport; PROXY a:99999")).toEqual([
      { kind: "unknown", raw: "GARBAGE" },
      { kind: "unknown", raw: "PROXY" },
      { kind: "unknown", raw: "PROXY a:notaport" },
      { kind: "unknown", raw: "PROXY a:99999" },
    ]);
  });

  it("keeps an IPv6 literal whole by splitting at the last colon", () => {
    expect(parseProxyCandidates("PROXY [::1]:3128")).toEqual([
      { kind: "proxy", host: "[::1]", port: 3128, raw: "PROXY [::1]:3128" },
    ]);
  });

  it("defaults the port when a PAC entry omits one", () => {
    expect(parseProxyCandidates("PROXY a; HTTPS b").map((candidate) => candidate.port)).toEqual([80, 443]);
  });

  it("accepts lower-case keywords a hand-written PAC may emit", () => {
    expect(parseProxyCandidates("proxy a:1")).toEqual([{ kind: "proxy", host: "a", port: 1, raw: "proxy a:1" }]);
  });
});

describe("systemProxyOutcomeFor", () => {
  it("materialises the first PROXY candidate as an http URL", () => {
    expect(systemProxyOutcomeFor("PROXY a:1; DIRECT")).toEqual({ kind: "proxy", url: "http://a:1" });
  });

  it("materialises an HTTPS candidate as an https URL", () => {
    expect(systemProxyOutcomeFor("HTTPS a:1")).toEqual({ kind: "proxy", url: "https://a:1" });
  });

  it("drops the fallback chain and keeps only the first candidate (named limitation M-01)", () => {
    expect(systemProxyOutcomeFor("PROXY p1:3128; PROXY p2:3128; DIRECT")).toEqual({
      kind: "proxy",
      url: "http://p1:3128",
    });
  });

  it("honours a leading DIRECT over a proxy the system would only fall back to", () => {
    expect(systemProxyOutcomeFor("DIRECT; PROXY a:1")).toEqual({ kind: "direct" });
  });

  it("answers direct for an all-DIRECT list", () => {
    expect(systemProxyOutcomeFor("DIRECT")).toEqual({ kind: "direct" });
  });

  it("refuses a SOCKS-only answer out loud instead of silently going direct", () => {
    expect(systemProxyOutcomeFor("SOCKS5 h:1080")).toEqual({ kind: "socks_unsupported" });
    expect(systemProxyOutcomeFor("SOCKS4 h:1; SOCKS5 h:2")).toEqual({ kind: "socks_unsupported" });
  });

  it("takes the OS's own DIRECT fallback when SOCKS is followed by one", () => {
    expect(systemProxyOutcomeFor("SOCKS5 h:1; DIRECT")).toEqual({ kind: "direct" });
  });

  it("skips SOCKS candidates in favour of a usable one", () => {
    expect(systemProxyOutcomeFor("SOCKS5 h:1; PROXY a:1")).toEqual({ kind: "proxy", url: "http://a:1" });
  });

  it("answers unresolved for an empty or wholly unparseable list", () => {
    expect(systemProxyOutcomeFor("")).toEqual({ kind: "unresolved" });
    expect(systemProxyOutcomeFor("   ")).toEqual({ kind: "unresolved" });
    expect(systemProxyOutcomeFor("NONSENSE ENTRY; ALSO BAD")).toEqual({ kind: "unresolved" });
  });
});

describe("systemProxyCacheKey", () => {
  it("collapses paths onto the origin", () => {
    expect(systemProxyCacheKey(TARGET)).toBe("https://api.anthropic.com");
    expect(systemProxyCacheKey("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
  });

  it("keeps an explicit port distinct", () => {
    expect(systemProxyCacheKey("http://h:8080/x")).toBe("http://h:8080");
  });

  it("rejects a non-http target and a non-URL", () => {
    expect(systemProxyCacheKey("ftp://h/x")).toBeUndefined();
    expect(systemProxyCacheKey("not a url")).toBeUndefined();
  });
});

describe("createSystemProxyResolver", () => {
  it("answers unresolved before anything was resolved, and tracks the target for the next refresh", async () => {
    const resolveProxy = vi.fn(async () => "PROXY a:1");
    const cache = createSystemProxyResolver({ resolveProxy });
    expect(cache.cached(TARGET)).toEqual({ kind: "unresolved" });
    expect(resolveProxy).not.toHaveBeenCalled();
    expect(cache.targets()).toEqual(["https://api.anthropic.com"]);
    await cache.refreshAll();
    expect(cache.cached(TARGET)).toEqual({ kind: "proxy", url: "http://a:1" });
  });

  it("asks Chromium about the origin, and serves the answer for any path of it", async () => {
    const resolveProxy = vi.fn(async () => "PROXY a:1");
    const cache = createSystemProxyResolver({ resolveProxy });
    await cache.resolve(TARGET);
    expect(resolveProxy).toHaveBeenCalledWith("https://api.anthropic.com");
    expect(cache.cached("https://api.anthropic.com/other/path")).toEqual({ kind: "proxy", url: "http://a:1" });
  });

  it("keys answers per target so one PAC branch never serves another", async () => {
    const cache = createSystemProxyResolver({
      resolveProxy: async (url) => (url.includes("anthropic") ? "PROXY a:1" : "PROXY b:2"),
    });
    await cache.resolve(TARGET);
    await cache.resolve(OTHER);
    expect(cache.cached(TARGET)).toEqual({ kind: "proxy", url: "http://a:1" });
    expect(cache.cached(OTHER)).toEqual({ kind: "proxy", url: "http://b:2" });
  });

  it("replaces a stale answer when the network changes", async () => {
    let answer = "PROXY a:1";
    const cache = createSystemProxyResolver({ resolveProxy: async () => answer });
    await cache.resolve(TARGET);
    answer = "DIRECT";
    await cache.refreshAll();
    expect(cache.cached(TARGET)).toEqual({ kind: "direct" });
  });

  it("keeps the last good answer when a resolve rejects — ignorance is not a DIRECT answer", async () => {
    let fail = false;
    const onError = vi.fn();
    const cache = createSystemProxyResolver({
      resolveProxy: async () => {
        if (fail) {
          throw new Error("session gone");
        }
        return "PROXY a:1";
      },
      onError,
    });
    await cache.resolve(TARGET);
    fail = true;
    expect(await cache.resolve(TARGET)).toEqual({ kind: "proxy", url: "http://a:1" });
    expect(cache.cached(TARGET)).toEqual({ kind: "proxy", url: "http://a:1" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("answers unresolved when the very first resolve rejects", async () => {
    const cache = createSystemProxyResolver({
      resolveProxy: async () => {
        throw new Error("not ready");
      },
    });
    expect(await cache.resolve(TARGET)).toEqual({ kind: "unresolved" });
  });

  it("shares one round trip between concurrent resolves of the same target", async () => {
    const resolveProxy = vi.fn(async () => "PROXY a:1");
    const cache = createSystemProxyResolver({ resolveProxy });
    const [first, second] = await Promise.all([cache.resolve(TARGET), cache.resolve(TARGET)]);
    expect(resolveProxy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("never asks Chromium about a target that is not an http(s) URL", async () => {
    const resolveProxy = vi.fn(async () => "PROXY a:1");
    const cache = createSystemProxyResolver({ resolveProxy });
    expect(await cache.resolve("mailto:x@y")).toEqual({ kind: "unresolved" });
    expect(cache.cached("mailto:x@y")).toEqual({ kind: "unresolved" });
    expect(resolveProxy).not.toHaveBeenCalled();
    expect(cache.targets()).toEqual([]);
  });

  it("bounds the tracked set, evicting oldest first", async () => {
    const cache = createSystemProxyResolver({ resolveProxy: async () => "DIRECT", maxTargets: 2 });
    cache.track("https://a.example/");
    cache.track("https://b.example/");
    cache.track("https://c.example/");
    expect(cache.targets()).toEqual(["https://b.example", "https://c.example"]);
  });

  it("refreshes every tracked target in one sweep", async () => {
    const resolveProxy = vi.fn(async () => "PROXY a:1");
    const cache = createSystemProxyResolver({ resolveProxy });
    cache.track(TARGET);
    cache.track(OTHER);
    await cache.refreshAll();
    expect(resolveProxy).toHaveBeenCalledTimes(2);
    expect(cache.cached(OTHER)).toEqual({ kind: "proxy", url: "http://a:1" });
  });

  it("does not let one failing target abort the sweep", async () => {
    const cache = createSystemProxyResolver({
      resolveProxy: async (url) => {
        if (url.includes("a.example")) {
          throw new Error("boom");
        }
        return "PROXY b:2";
      },
    });
    cache.track("https://a.example/");
    cache.track("https://b.example/");
    await expect(cache.refreshAll()).resolves.toBeUndefined();
    expect(cache.cached("https://b.example/")).toEqual({ kind: "proxy", url: "http://b:2" });
  });
});

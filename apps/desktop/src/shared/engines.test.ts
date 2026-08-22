/**
 * Unit tests for the engine-proxy carrier contract (TASK.139): the translation
 * from main's private carrier var into the HTTP(S)_PROXY family a codex/claude
 * child actually reads.
 *
 * Byte-identity is asserted by deep-equalling the WHOLE env object before and
 * after the call, not by spot-checking keys — the guarantee the slice makes is
 * that an unconfigured engine leaves every child env exactly as it was, and a
 * selective check cannot see a key the function added by accident.
 */

import { describe, expect, it } from "vitest";
import {
  ENGINE_PROXY_CARRIER_NAMES,
  ENV_CLAUDE_PROXY_URL,
  ENV_CODEX_PROXY_URL,
  LOOPBACK_NO_PROXY,
  PROXY_CARRIER_DIRECT,
  applyEngineProxyOverride,
  stripEngineProxyCarriers,
} from "./engines.js";

/** Carries `user:pass@` userinfo on purpose — the authenticated-proxy case the field exists for. */
const ENGINE_PROXY = "http://user:pass@engine-proxy.example.com:3128";
/** What a connection-level proxy looks like after it rides a builder's passthrough list into the child env. */
const CONNECTION_PROXY = "http://connection-proxy.internal:8080";

/** The COMPLETE env surface `applyEngineProxyOverride` may ever touch. */
const AFFECTED_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  ENV_CODEX_PROXY_URL,
  ENV_CLAUDE_PROXY_URL,
] as const;

describe("applyEngineProxyOverride — no carrier means byte-identical", () => {
  it("leaves the env untouched when the carrier is absent", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", PATH: "/usr/bin" };
    const before = { ...env };
    applyEngineProxyOverride(env, { HOME: "/home/me" }, ENV_CODEX_PROXY_URL);
    expect(env).toEqual(before);
  });

  it("leaves the env untouched when the carrier is blank", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY };
    const before = { ...env };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: "   " }, ENV_CODEX_PROXY_URL);
    expect(env).toEqual(before);
  });

  // Defense in depth: main only ever emits an `isProxyUrl`-validated value, so
  // reaching this branch means something upstream broke — and the required
  // failure direction is "no engine proxy", never a child env with a garbage
  // proxy var in it.
  it("leaves the env untouched when the carrier fails isProxyUrl", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY, no_proxy: "corp.internal" };
    const before = { ...env };
    for (const garbage of ["proxy.example.com:3128", "socks5://proxy.example.com:1080", "http://", "not a url"]) {
      applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: garbage }, ENV_CODEX_PROXY_URL);
      expect(env).toEqual(before);
    }
  });

  // The carriers are engine-scoped: a codex proxy must not reach a claude child.
  it("reads only its OWN carrier name", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    const before = { ...env };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CLAUDE_PROXY_URL);
    expect(env).toEqual(before);
  });
});

describe("applyEngineProxyOverride — a valid carrier", () => {
  it("writes all four family vars verbatim and both loopback exemptions", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", PATH: "/usr/bin" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(env).toEqual({
      HOME: "/home/me",
      PATH: "/usr/bin",
      HTTPS_PROXY: ENGINE_PROXY,
      HTTP_PROXY: ENGINE_PROXY,
      https_proxy: ENGINE_PROXY,
      http_proxy: ENGINE_PROXY,
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    });
  });

  // Both IPv6 spellings: undici splits each entry on `host:port`, so a bare
  // `::1` parses as host `:` + port `1` and exempts nothing, while
  // curl-convention consumers compare against the unbracketed form.
  it("exempts loopback in both IPv6 spellings", () => {
    expect(LOOPBACK_NO_PROXY).toBe("localhost,127.0.0.1,[::1],::1");
  });

  // The whole point of the slice: the engine setting beats the connection's.
  it("OVERWRITES a connection proxy that arrived through the builder's passthrough list", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/me",
      HTTPS_PROXY: CONNECTION_PROXY,
      HTTP_PROXY: CONNECTION_PROXY,
      https_proxy: CONNECTION_PROXY,
      http_proxy: CONNECTION_PROXY,
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    };
    applyEngineProxyOverride(env, { [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY }, ENV_CLAUDE_PROXY_URL);
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const) {
      expect(env[key]).toBe(ENGINE_PROXY);
    }
  });

  // Custody + allow-list discipline: the child has no use for the carrier, and
  // the builders' allow-lists never name it.
  it("never copies the carrier into the child env", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(ENV_CODEX_PROXY_URL in env).toBe(false);
    expect(ENV_CLAUDE_PROXY_URL in env).toBe(false);
  });

  // The children proxy natively (codex is Rust; the claude CLI reads the env
  // itself — measured in TASK.132). NODE_USE_ENV_PROXY switches node's own
  // global fetch and has no business in a child env.
  it("never sets NODE_USE_ENV_PROXY", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });
});

describe("applyEngineProxyOverride — NO_PROXY is family-atomic", () => {
  // Writing only the uppercase key would SHADOW the user's lowercase exemption
  // (undici resolves `no_proxy` first), routing the very hosts they excluded
  // through the proxy.
  it("touches NEITHER exemption key when NO_PROXY alone is already present", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", NO_PROXY: "corp.internal" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(env.NO_PROXY).toBe("corp.internal");
    expect("no_proxy" in env).toBe(false);
  });

  it("touches NEITHER exemption key when no_proxy alone is already present", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", no_proxy: "corp.internal" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(env.no_proxy).toBe("corp.internal");
    expect("NO_PROXY" in env).toBe(false);
  });

  it("writes both exemption keys only when neither is present", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    applyEngineProxyOverride(env, { [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY }, ENV_CLAUDE_PROXY_URL);
    expect(env.NO_PROXY).toBe(LOOPBACK_NO_PROXY);
    expect(env.no_proxy).toBe(LOOPBACK_NO_PROXY);
  });

  // A blank exemption is not an exemption — treat it as absent, the same
  // present-AND-non-blank test host-env.ts's `envPresent` applies.
  it("treats a blank exemption as absent and writes both keys", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", NO_PROXY: "" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    expect(env.NO_PROXY).toBe(LOOPBACK_NO_PROXY);
    expect(env.no_proxy).toBe(LOOPBACK_NO_PROXY);
  });
});

describe("carrier names are frozen wire contract", () => {
  // main writes these, the child-env builders read them, and the two sides
  // never import each other — a rename on one side is only caught here.
  it("pins both carrier names", () => {
    expect(ENV_CODEX_PROXY_URL).toBe("ANYCODE_CODEX_PROXY_URL");
    expect(ENV_CLAUDE_PROXY_URL).toBe("ANYCODE_CLAUDE_PROXY_URL");
  });

  it("names exactly the env surface the override may touch", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me" };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: ENGINE_PROXY }, ENV_CODEX_PROXY_URL);
    const touched = Object.keys(env).filter((key) => key !== "HOME");
    expect(touched.every((key) => (AFFECTED_KEYS as readonly string[]).includes(key))).toBe(true);
  });
});

describe("applyEngineProxyOverride — the DIRECT sentinel (TASK.141)", () => {
  // "This engine explicitly uses no proxy" has to be an ACTIVE deletion: the
  // connection's proxy is already in the child env via the builder's passthrough
  // list, so staying silent would leave the engine on it — the opposite of what
  // the user picked in the dropdown.
  it("deletes the whole family a connection proxy put in the child env", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/me",
      HTTPS_PROXY: CONNECTION_PROXY,
      HTTP_PROXY: CONNECTION_PROXY,
      https_proxy: CONNECTION_PROXY,
      http_proxy: CONNECTION_PROXY,
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: PROXY_CARRIER_DIRECT }, ENV_CODEX_PROXY_URL);
    // The exemption pair is deliberately NOT touched: the builder cannot tell a
    // shell-exported NO_PROXY from a passthrough one, and an exemption with no
    // proxy left to bypass is inert anyway.
    expect(env).toEqual({ HOME: "/home/me", NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY });
  });

  it("leaves a child env that had no proxy family byte-identical", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", PATH: "/usr/bin" };
    const before = { ...env };
    applyEngineProxyOverride(env, { [ENV_CLAUDE_PROXY_URL]: PROXY_CARRIER_DIRECT }, ENV_CLAUDE_PROXY_URL);
    expect(env).toEqual(before);
    expect(Object.keys(env)).toEqual(["HOME", "PATH"]);
  });

  it("is engine-scoped like every other carrier value", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY };
    const before = { ...env };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: PROXY_CARRIER_DIRECT }, ENV_CLAUDE_PROXY_URL);
    expect(env).toEqual(before);
  });

  it("never sets NODE_USE_ENV_PROXY or copies the carrier through", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY };
    applyEngineProxyOverride(env, { [ENV_CODEX_PROXY_URL]: PROXY_CARRIER_DIRECT }, ENV_CODEX_PROXY_URL);
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(ENV_CODEX_PROXY_URL in env).toBe(false);
  });

  it("pins the sentinel string — main writes it, the builders read it, and neither imports the other", () => {
    expect(PROXY_CARRIER_DIRECT).toBe("direct");
  });

  // F1 composed with the new value: an ambient `ANYCODE_CODEX_PROXY_URL=direct`
  // must not be able to strip a shell-exported proxy out of a child env either.
  it("an AMBIENT `direct` carrier dies in the strip like every other ambient value", () => {
    const source: NodeJS.ProcessEnv = { HTTPS_PROXY: CONNECTION_PROXY, [ENV_CODEX_PROXY_URL]: PROXY_CARRIER_DIRECT };
    stripEngineProxyCarriers(source);
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: CONNECTION_PROXY };
    applyEngineProxyOverride(env, source, ENV_CODEX_PROXY_URL);
    expect(env.HTTPS_PROXY).toBe(CONNECTION_PROXY);
  });
});

describe("stripEngineProxyCarriers — main is the sole author of the namespace (F1)", () => {
  it("deletes both carrier names and leaves every other key byte-identical", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/me",
      PATH: "/usr/bin",
      HTTPS_PROXY: CONNECTION_PROXY,
      ANYCODE_MODEL: "some-model",
      [ENV_CODEX_PROXY_URL]: ENGINE_PROXY,
      [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY,
    };
    stripEngineProxyCarriers(env);
    expect(env).toEqual({
      HOME: "/home/me",
      PATH: "/usr/bin",
      HTTPS_PROXY: CONNECTION_PROXY,
      ANYCODE_MODEL: "some-model",
    });
  });

  it("names exactly the two carriers and nothing else", () => {
    expect(ENGINE_PROXY_CARRIER_NAMES).toEqual([ENV_CODEX_PROXY_URL, ENV_CLAUDE_PROXY_URL]);
  });

  // A carrier-free env is the overwhelmingly common case; deleting an absent
  // key must not introduce one (`{k: undefined}` is NOT byte-identical to `{}`
  // under a deep-equal, and would be forwarded as an empty var by some spawns).
  it("is a no-op on an env that carries neither name, and is idempotent", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY };
    stripEngineProxyCarriers(env);
    stripEngineProxyCarriers(env);
    expect(env).toEqual({ HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY });
    expect(Object.keys(env)).toEqual(["HOME", "HTTPS_PROXY"]);
  });

  // The composed guarantee F1 exists for: a shell that exports BOTH its own
  // proxy and (by accident) a carrier name must see its own proxy survive. The
  // shell-wins gate lives in main's `engineProxyCarriers`, so the only thing
  // standing between an ambient carrier and an unconditional family clobber is
  // this strip.
  it("makes a source env with an ambient carrier inert for the child builder", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/home/me",
      HTTPS_PROXY: CONNECTION_PROXY,
      [ENV_CODEX_PROXY_URL]: ENGINE_PROXY,
    };
    stripEngineProxyCarriers(source);
    const env: NodeJS.ProcessEnv = { HOME: "/home/me", HTTPS_PROXY: CONNECTION_PROXY };
    const before = { ...env };
    applyEngineProxyOverride(env, source, ENV_CODEX_PROXY_URL);
    expect(env).toEqual(before);
    for (const key of AFFECTED_KEYS) {
      expect(env[key]).toBe(before[key]);
    }
  });
});

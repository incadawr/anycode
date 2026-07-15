/**
 * Unit tests for the loopback+PKCE OAuth engine (design slice-2.5-cut.md §3.2,

 * a simulated browser (the test performs the callback GET the browser would).
 * Covers the full happy path (PKCE params reach the token endpoint, tokens are
 * persisted), state-mismatch refusal, cancel, timeout, and the custody invariant
 * (the outcome never carries a token).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthEngine, oauthConfigFromEntry, type OAuthProviderConfig, type OAuthTokenStore } from "./oauth.js";
import type { OAuthTokenBlob } from "./vault.js";

/** In-memory OAuthTokenStore: records what the engine persists (keyed by CONNECTION id, TASK.45 §4.3). */
class FakeStore implements OAuthTokenStore {
  saved: Array<{ connectionId: string; blob: OAuthTokenBlob; allowWeak: boolean }> = [];
  setResult: { ok: boolean } = { ok: true };
  async setOAuthTokens(connectionId: string, blob: OAuthTokenBlob, opts: { allowWeak: boolean }): Promise<{ ok: boolean }> {
    if (!this.setResult.ok) {
      return this.setResult;
    }
    this.saved.push({ connectionId, blob, allowWeak: opts.allowWeak });
    return { ok: true };
  }
}

interface Idp {
  tokenUrl: string;
  authorizationUrl: string;
  lastTokenBody: () => Record<string, string>;
  respondWith: (status: number, json: unknown) => void;
  close: () => Promise<void>;
}

/** Fake IdP: POST /token echoes the form body and returns configurable tokens. */
async function startIdp(): Promise<Idp> {
  let lastBody: Record<string, string> = {};
  let status = 200;
  let payload: unknown = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 };
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        lastBody = Object.fromEntries(new URLSearchParams(body));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    tokenUrl: `http://127.0.0.1:${port}/token`,
    authorizationUrl: `http://127.0.0.1:${port}/authorize`,
    lastTokenBody: () => lastBody,
    respondWith: (s, j) => {
      status = s;
      payload = j;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** GET the engine's callback URL like the browser would after the IdP redirect. */
async function hitCallback(authUrl: string, override?: { state?: string; code?: string }): Promise<void> {
  const parsed = new URL(authUrl);
  const redirectUri = parsed.searchParams.get("redirect_uri");
  if (redirectUri === null) {
    throw new Error("no redirect_uri in auth url");
  }
  const state = override?.state ?? parsed.searchParams.get("state") ?? "";
  const code = override?.code ?? "auth-code-xyz";
  const cb = new URL(redirectUri);
  cb.searchParams.set("code", code);
  cb.searchParams.set("state", state);
  await fetch(cb.toString());
}

let idp: Idp;
beforeEach(async () => {
  idp = await startIdp();
});
afterEach(async () => {
  await idp.close();
});

function config(): OAuthProviderConfig {
  return {
    providerId: "acme",
    authorizationUrl: idp.authorizationUrl,
    tokenUrl: idp.tokenUrl,
    clientId: "client-123",
    scopes: ["a", "b"],
  };
}

describe("OAuthEngine.startFlow — happy path (fake-IdP + simulated browser)", () => {
  it("binds loopback, carries PKCE to the token endpoint, and persists the blob", async () => {
    const store = new FakeStore();
    let openedUrl = "";
    const engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => {
        openedUrl = url;
        void hitCallback(url); // the "browser"
      },
      now: () => 1_000_000,
    });

    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: true });

    // The authorization URL is a proper public-client PKCE request.
    const auth = new URL(openedUrl);
    expect(auth.searchParams.get("response_type")).toBe("code");
    expect(auth.searchParams.get("client_id")).toBe("client-123");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.searchParams.get("state")).toBeTruthy();
    expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    expect(openedUrl).not.toContain("client_secret");

    // The token exchange used the authorization_code grant + the PKCE verifier.
    const body = idp.lastTokenBody();
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("auth-code-xyz");
    expect(body.client_id).toBe("client-123");
    expect(body.code_verifier).toBeTruthy();
    expect(body.client_secret).toBeUndefined();

    // The persisted blob carries the tokens + a computed expiry, keyed by the
    // CONNECTION id threaded from settings-ipc (TASK.45 §4.3), NOT the providerId.
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.connectionId).toBe("conn-acme");
    expect(store.saved[0]?.blob).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
    expect(store.saved[0]?.allowWeak).toBe(false);
  });

  it("passes the weak-storage consent flag through to the vault write", async () => {
    const store = new FakeStore();
    const engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => void hitCallback(url),
    });
    await engine.startFlow(config(), "conn-acme", { allowWeak: true });
    expect(store.saved[0]?.allowWeak).toBe(true);
  });
});

describe("OAuthEngine.startFlow — refusals", () => {
  it("refuses a state mismatch and persists nothing", async () => {
    const store = new FakeStore();
    const engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => void hitCallback(url, { state: "not-the-state" }),
    });
    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(store.saved).toHaveLength(0);
  });

  it("cancel() aborts an in-flight flow", async () => {
    const store = new FakeStore();
    const cfg = config();
    const engine = new OAuthEngine({
      vault: store,
      openExternal: () => {
        // Browser never returns; cancel from "outside" on the next tick.
        setTimeout(() => engine.cancel(cfg.providerId), 5);
      },
    });
    const outcome = await engine.startFlow(cfg, "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(store.saved).toHaveLength(0);
  });

  it("does NOT persist a blob when cancelled DURING the token exchange (residual §6.5)", async () => {
    const store = new FakeStore();
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
    let engine!: OAuthEngine;
    engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => void hitCallback(url),
      // The token exchange is in flight when the connection is deleted: cancel
      // the flow, then let the exchange resolve. The persist must be skipped —
      // otherwise a blob lands under a connection id that no longer exists.
      fetchFn: async () => {
        engine.cancel("acme");
        await exchangeGate;
        return { ok: true, status: 200, json: async () => ({ access_token: "at", expires_in: 3600 }) };
      },
    });
    const outcome = engine.startFlow(config(), "conn-acme", { allowWeak: false });
    // Resolves once `cancel()` (inside fetchFn) settles the flow — the exchange
    // is now suspended on the gate.
    expect(await outcome).toEqual({ ok: false, reason: "cancelled" });
    // Let the cancelled exchange resolve, then give the (guarded-away) persist a
    // generous window to run before asserting it never did.
    releaseExchange();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.saved).toEqual([]);
  });

  it("times out when the browser never returns", async () => {
    const store = new FakeStore();
    const engine = new OAuthEngine({
      vault: store,
      openExternal: () => {
        /* never hit the callback */
      },
      timeoutMs: 40,
    });
    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });

  it("fails when the token endpoint rejects the exchange", async () => {
    idp.respondWith(400, { error: "invalid_grant" });
    const store = new FakeStore();
    const engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => void hitCallback(url),
    });
    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(store.saved).toHaveLength(0);
  });

  it("fails when the vault refuses to store (weak consent)", async () => {
    const store = new FakeStore();
    store.setResult = { ok: false };
    const engine = new OAuthEngine({
      vault: store,
      openExternal: (url) => void hitCallback(url),
    });
    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });
});

describe("OAuthEngine — custody (I1)", () => {
  it("the outcome never carries a token value", async () => {
    const store = new FakeStore();
    const engine = new OAuthEngine({ vault: store, openExternal: (url) => void hitCallback(url) });
    const outcome = await engine.startFlow(config(), "conn-acme", { allowWeak: false });
    expect(JSON.stringify(outcome)).not.toContain("at-1");
    expect(JSON.stringify(outcome)).not.toContain("rt-1");
  });
});

describe("oauthConfigFromEntry", () => {
  it("extracts config from an oauth entry", () => {
    expect(
      oauthConfigFromEntry({
        id: "acme",
        auth: {
          kind: "oauth",
          authorizationUrl: "https://a/authorize",
          tokenUrl: "https://a/token",
          clientId: "c",
          scopes: ["x"],
        },
      }),
    ).toEqual({
      providerId: "acme",
      authorizationUrl: "https://a/authorize",
      tokenUrl: "https://a/token",
      clientId: "c",
      scopes: ["x"],
    });
  });

  it("returns undefined for an api_key or absent entry", () => {
    expect(oauthConfigFromEntry({ id: "x", auth: { kind: "api_key" } })).toBeUndefined();
    expect(oauthConfigFromEntry(undefined)).toBeUndefined();
  });
});

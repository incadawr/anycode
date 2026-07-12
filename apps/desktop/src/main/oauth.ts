/**
 * OAuth 2.0 Authorization Code + PKCE engine for catalog providers (design

 *
 *  1. Bind an EPHEMERAL loopback listener on 127.0.0.1 BEFORE opening the system
 *     browser — so no other local process can occupy our `redirect_uri` first
 *     (the core of the threat model: bind-before-browser).
 *  2. Public-client PKCE (S256): a per-flow `verifier`/`challenge` (no
 *     `client_secret` ever lives in the binary) + a random `state`.
 *  3. `shell.openExternal(authorizationUrl?…)` (injected `openExternal`).
 *  4. Callback: STRICT path match (`/callback` only) + `state` equality (a
 *     mismatch is refused — it binds the callback to THIS flow); a code without
 *     the verifier is useless to an interceptor (PKCE).
 *  5. Exchange the code at the provider token endpoint (fetch from main) and
 *     persist the token blob to the vault. The listener is SINGLE-USE (closed
 *     after the first valid callback) and time-bounded (5 min). `cancel` tears it
 *     down early.
 *

 * learns that the provider's SecretStatus flipped to `set: true`. Loopback, not
 * deep-link (RFC 8252 §7.3): identical in dev and packaged, zero protocol
 * registration.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthTokenBlob } from "./vault.js";

/** Structural mirror of core's `CatalogAuth` (main-side modules stay core-free). */
export type CatalogAuthLike =
  | { kind: "api_key" }
  | { kind: "oauth"; authorizationUrl: string; tokenUrl: string; clientId: string; scopes: string[] };

/** The five values a flow needs, extracted from an oauth catalog entry. */
export interface OAuthProviderConfig {
  providerId: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
}

/**
 * Extracts an `OAuthProviderConfig` from a catalog entry, or `undefined` for a
 * non-oauth / absent entry (api_key providers are `unsupported` for oauth-start).
 * Structural input so main passes a `findCatalogEntry(id)` result directly.
 */
export function oauthConfigFromEntry(
  entry: { id: string; auth: CatalogAuthLike } | undefined,
): OAuthProviderConfig | undefined {
  if (entry === undefined || entry.auth.kind !== "oauth") {
    return undefined;
  }
  const { authorizationUrl, tokenUrl, clientId, scopes } = entry.auth;
  return { providerId: entry.id, authorizationUrl, tokenUrl, clientId, scopes };
}

/** Outcome of an interactive flow (settings-ipc maps this to an OAuthStartReason). */
export type OAuthOutcome = { ok: true } | { ok: false; reason: "cancelled" | "timeout" | "failed" };

/** Vault surface the engine writes tokens through (structural — tests inject a fake). */
export interface OAuthTokenStore {
  setOAuthTokens(
    providerId: string,
    blob: OAuthTokenBlob,
    opts: { allowWeak: boolean },
  ): Promise<{ ok: boolean }>;
}

/** Minimal token-endpoint fetch surface (injectable; defaults to global fetch). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export interface OAuthEngineDeps {
  vault: OAuthTokenStore;
  /** Opens the authorization URL in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => Promise<unknown> | unknown;
  /** Token-endpoint fetch (default: global fetch). */
  fetchFn?: FetchLike;
  /** Flow deadline in ms (default 5 min). */
  timeoutMs?: number;
  /** Clock (default Date.now). */
  now?: () => number;
  logger?: { warn(message: string, err?: unknown): void };
}

/** Default OAuth flow deadline (design §3.2). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackContext {
  config: OAuthProviderConfig;
  state: string;
  verifier: string;
  redirectUri: () => string;
  opts: { allowWeak: boolean };
  settle: (outcome: OAuthOutcome) => void;
}

export class OAuthEngine {
  private readonly vault: OAuthTokenStore;
  private readonly openExternal: (url: string) => Promise<unknown> | unknown;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly logger: OAuthEngineDeps["logger"];
  /** In-flight flow per provider so `cancel` (and a superseding start) can settle it. */
  private readonly inFlight = new Map<string, (outcome: OAuthOutcome) => void>();

  constructor(deps: OAuthEngineDeps) {
    this.vault = deps.vault;
    this.openExternal = deps.openExternal;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
  }

  /** Aborts an in-flight flow for a provider (idempotent; unknown id is a no-op). */
  cancel(providerId: string): void {
    this.inFlight.get(providerId)?.({ ok: false, reason: "cancelled" });
  }

  /**
   * Runs the full loopback+PKCE flow for one provider. Resolves `{ok:true}` after
   * the token blob is persisted, else a typed reason. A new flow for the same
   * provider supersedes (cancels) any prior in-flight one.
   */
  async startFlow(config: OAuthProviderConfig, opts: { allowWeak: boolean }): Promise<OAuthOutcome> {
    this.cancel(config.providerId);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");

    return new Promise<OAuthOutcome>((resolve) => {
      let settled = false;
      let redirectUri = "";
      let timer: ReturnType<typeof setTimeout>;

      const settle = (outcome: OAuthOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(config.providerId);
        server.close();
        resolve(outcome);
      };

      const server: Server = createServer((req, res) => {
        void this.handleCallback(req, res, {
          config,
          state,
          verifier,
          redirectUri: () => redirectUri,
          opts,
          settle,
        });
      });

      server.on("error", (err) => {
        this.logger?.warn("oauth: loopback server error", err);
        settle({ ok: false, reason: "failed" });
      });

      timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), this.timeoutMs);
      this.inFlight.set(config.providerId, settle);

      // Bind BEFORE the browser (threat model §3.2): the redirect_uri only exists
      // once we own the port.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        const port = addr?.port ?? 0;
        redirectUri = `http://127.0.0.1:${port}/callback`;
        const authUrl = buildAuthorizeUrl(config, redirectUri, state, challenge);
        try {
          const opened = this.openExternal(authUrl);
          if (opened instanceof Promise) {
            opened.catch((err) => {
              this.logger?.warn("oauth: openExternal failed", err);
              settle({ ok: false, reason: "failed" });
            });
          }
        } catch (err) {
          this.logger?.warn("oauth: openExternal threw", err);
          settle({ ok: false, reason: "failed" });
        }
      });
    });
  }

  private async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: CallbackContext,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Strict path match: anything but /callback (favicon probes, etc.) is ignored
    // and the flow keeps waiting.
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const errParam = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (errParam !== null) {
      respondHtml(res, "Sign-in failed. You can close this window and return to the app.");
      ctx.settle({ ok: false, reason: "failed" });
      return;
    }
    // `state` binds the callback to our flow (design §3.2): a mismatch is refused.
    if (returnedState === null || returnedState !== ctx.state) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("state mismatch");
      ctx.settle({ ok: false, reason: "failed" });
      return;
    }
    if (code === null || code === "") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing code");
      ctx.settle({ ok: false, reason: "failed" });
      return;
    }

    try {
      const blob = await this.exchangeCode(ctx.config, code, ctx.redirectUri(), ctx.verifier);
      const stored = await this.vault.setOAuthTokens(ctx.config.providerId, blob, {
        allowWeak: ctx.opts.allowWeak,
      });
      if (!stored.ok) {
        respondHtml(res, "Sign-in could not be saved. You can close this window.");
        ctx.settle({ ok: false, reason: "failed" });
        return;
      }
      respondHtml(res, "Signed in. You can close this window and return to the app.");
      ctx.settle({ ok: true });
    } catch (err) {
      this.logger?.warn("oauth: token exchange failed", err);
      respondHtml(res, "Sign-in failed. You can close this window and return to the app.");
      ctx.settle({ ok: false, reason: "failed" });
    }
  }

  private async exchangeCode(
    config: OAuthProviderConfig,
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<OAuthTokenBlob> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    }).toString();
    const res = await this.fetchFn(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`token endpoint responded ${res.status}`);
    }
    return blobFromTokenResponse(await res.json(), this.now(), "");
  }
}

/** Builds the provider authorization URL with the PKCE + state parameters. */
function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Minimal "return to the app" page shown in the system browser (single-use). */
function respondHtml(res: ServerResponse, message: string): void {
  const html =
    `<!doctype html><meta charset="utf-8"><title>AnyCode</title>` +
    `<body style="font-family:system-ui;padding:2rem"><p>${message}</p></body>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * Parses a token-endpoint JSON response into an `OAuthTokenBlob`. `expiresAt` is
 * derived from `expires_in` (seconds); `fallbackRefresh` is kept when the
 * response omits a new `refresh_token` (many providers do not rotate it).
 * Exported so the TokenBroker reuses the same parse for refresh responses.
 */
export function blobFromTokenResponse(
  json: unknown,
  now: number,
  fallbackRefresh: string,
): OAuthTokenBlob {
  if (typeof json !== "object" || json === null) {
    throw new Error("token response is not an object");
  }
  const obj = json as Record<string, unknown>;
  const accessToken = obj.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error("token response missing access_token");
  }
  const refreshToken =
    typeof obj.refresh_token === "string" && obj.refresh_token !== "" ? obj.refresh_token : fallbackRefresh;
  const expiresIn = typeof obj.expires_in === "number" ? obj.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
}

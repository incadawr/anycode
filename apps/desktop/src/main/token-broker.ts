/**
 * TokenBroker (design slice-2.5-cut.md §3.3): the single main-side authority that
 * hands a host a FRESH OAuth access token. It reads the persisted token blob from
 * the vault, returns the cached access token while it is still valid, and
 * otherwise runs a `refresh_token` grant against the provider token endpoint —
 * persisting the rotated blob back to the vault so the rotation survives a
 * respawn. Refreshes are SINGLE-FLIGHT per provider: N hosts asking at once
 * trigger exactly ONE network refresh. A definitive rejection (revoked; a 4xx
 * from the token endpoint) clears the entry so the provider's SecretStatus flips

 *
 * Also hosts `resolveProviderSelection` — the core-backed projection of the
 * selected catalog provider into a `ResolvedProviderSelection` for buildHostEnv.
 * It stays core-free by taking an injected `resolveCatalog` lookup (main supplies
 * it from `@anycode/core/catalog`).
 */

import { blobFromTokenResponse, type FetchLike, type OAuthProviderConfig } from "./oauth.js";
import type { ResolvedProviderSelection } from "./host-env.js";
import type { OAuthTokenBlob } from "./vault.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { activeConnection } from "../shared/settings.js";

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Refresh this many ms BEFORE the real expiry, to guard against clock skew / in-flight use. */
const DEFAULT_SKEW_MS = 60_000;

/** Vault surface the broker reads/writes token blobs through (structural; blob keyed by CONNECTION id). */
export interface TokenBrokerVault {
  getOAuthTokens(connectionId: string): Promise<OAuthTokenBlob | undefined>;
  setOAuthTokens(
    connectionId: string,
    blob: OAuthTokenBlob,
    opts: { allowWeak: boolean },
  ): Promise<{ ok: boolean }>;
  clearOAuthTokens(connectionId: string): Promise<void>;
}

export interface TokenBrokerDeps {
  vault: TokenBrokerVault;
  /** Per-provider oauth config (main supplies it from `@anycode/core/catalog`). */
  resolveConfig: (providerId: string) => OAuthProviderConfig | undefined;
  /** Weak-storage consent for the rotated-blob write (read fresh from settings). */
  allowWeak: () => boolean;
  fetchFn?: FetchLike;
  /** ms before expiry to trigger a refresh (default 60s). */
  skewMs?: number;
  now?: () => number;
  logger?: { warn(message: string, err?: unknown): void };
}

/** A refresh rejection; `revoked` (a 4xx) clears the entry, transient does not. */
class RefreshError extends Error {
  constructor(
    readonly revoked: boolean,
    message: string,
  ) {
    super(message);
  }
}

export class TokenBroker {
  private readonly vault: TokenBrokerVault;
  private readonly resolveConfig: (providerId: string) => OAuthProviderConfig | undefined;
  private readonly allowWeak: () => boolean;
  private readonly fetchFn: FetchLike;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly logger: TokenBrokerDeps["logger"];
  /** Single-flight: an in-progress refresh per provider, shared by concurrent callers. */
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  constructor(deps: TokenBrokerDeps) {
    this.vault = deps.vault;
    this.resolveConfig = deps.resolveConfig;
    this.allowWeak = deps.allowWeak;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
    this.skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
  }

  /**
   * The current valid access token for a CONNECTION (design §3.3 + TASK.45). The
   * token blob is keyed by `connectionId` (two accounts of the same OAuth
   * provider never collide) while the OAuth CONFIG is looked up by `providerId`.
   * Returns the cached token while it is live; otherwise runs (or joins) a
   * single-flight refresh (per connection). `undefined` = not signed in /
   * undecryptable / refresh failed (the host then falls back to its fork's static
   * env key).
   */
  async getAccessToken(connectionId: string, providerId: string): Promise<string | undefined> {
    const blob = await this.vault.getOAuthTokens(connectionId);
    if (blob === undefined) {
      return undefined;
    }
    if (this.now() < blob.expiresAt - this.skewMs) {
      return blob.accessToken; // live cache
    }
    return this.refreshSingleFlight(connectionId, providerId, blob);
  }

  /** Joins an existing refresh for this connection, or starts one and registers it. */
  private refreshSingleFlight(
    connectionId: string,
    providerId: string,
    blob: OAuthTokenBlob,
  ): Promise<string | undefined> {
    const existing = this.inFlight.get(connectionId);
    if (existing !== undefined) {
      return existing;
    }
    const started = this.doRefresh(connectionId, providerId, blob).finally(() => {
      this.inFlight.delete(connectionId);
    });
    this.inFlight.set(connectionId, started);
    return started;
  }

  private async doRefresh(
    connectionId: string,
    providerId: string,
    blob: OAuthTokenBlob,
  ): Promise<string | undefined> {
    const config = this.resolveConfig(providerId);
    if (config === undefined || blob.refreshToken === "") {
      return undefined;
    }
    try {
      const fresh = await this.exchangeRefresh(config, blob.refreshToken);
      await this.vault.setOAuthTokens(connectionId, fresh, { allowWeak: this.allowWeak() });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof RefreshError && err.revoked) {
        // Revoked: nuke the entry so readiness + UI show "sign in again".
        await this.vault.clearOAuthTokens(connectionId);
      } else {
        this.logger?.warn(`token-broker: refresh failed for ${connectionId}`, err);
      }
      return undefined;
    }
  }

  private async exchangeRefresh(config: OAuthProviderConfig, refreshToken: string): Promise<OAuthTokenBlob> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }).toString();
    const res = await this.fetchFn(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (res.status >= 400 && res.status < 500) {
      throw new RefreshError(true, `refresh rejected ${res.status}`);
    }
    if (!res.ok) {
      throw new RefreshError(false, `refresh failed ${res.status}`);
    }
    // Keep the old refresh token when the provider does not rotate it.
    return blobFromTokenResponse(await res.json(), this.now(), refreshToken);
  }
}

// ── catalog selection → host-env (slice 2.5 §1) ──

/** What main knows about a catalog provider after a core lookup (host-env stays core-free). */
export interface CatalogSelectionInfo {
  /** Resolved endpoint base for non-custom providers (custom -> settings.baseUrl wins). */
  baseUrl: string;
  authKind: "api_key" | "oauth";
  isCustom: boolean;
  /**
   * True when this entry's OWN baseUrl is empty and settings.provider.baseUrl
   * must be substituted (TASK.43 W5) — the `vllm` template entry needs this
   * even though it is NOT `isCustom` (it keeps its own per-provider vault key
   * and catalog defaults, unlike the `custom` sentinel, which bypasses to the
   * fully legacy path above). Optional/undefined behaves like `isCustom` did
   * before W5 (only the literal custom sentinel needed base-url substitution).
   */
  needsBaseUrl?: boolean;
  /** Transport used when neither env nor `settings.provider.transport` pick one (TASK.43 W5). */
  defaultTransport?: string;
  /** Every transport this endpoint is known to speak (TASK.43 W5). */
  supportedTransports?: readonly string[];
}

export interface ProviderSelectionDeps {
  settings: AnycodeSettings;
  /** Core-backed lookup: catalog id -> {baseUrl, authKind, isCustom}, or undefined (unknown id). */
  resolveCatalog: (providerId: string) => CatalogSelectionInfo | undefined;
  /** Active connection's api-key read (its connection key). */
  getApiKey: (connectionId: string) => Promise<string | undefined>;
  /** Fresh OAuth access token via the TokenBroker (blob by connectionId, config by providerId). */
  getAccessToken: (connectionId: string, providerId: string) => Promise<string | undefined>;
}

/**
 * Resolves the ACTIVE connection into the host-env selection (baseUrl, model,
 * credential, authKind). Returns `undefined` for the LEGACY path (no active
 * connection, a bare-legacy connection, an id absent from the catalog, or the
 * `custom` sentinel) so buildHostEnv falls back to its active-connection
 * legacy branch. oauth -> the credential is a fresh access token (broker);
 * api_key -> the connection key (with migrated fallback); custom -> handled by
 * the legacy branch.
 */
export async function resolveProviderSelection(
  deps: ProviderSelectionDeps,
): Promise<ResolvedProviderSelection | undefined> {
  const connection = activeConnection(deps.settings);
  if (connection === undefined) {
    return undefined;
  }
  const id = connection.providerId;
  if (id === undefined || id.trim() === "") {
    return undefined; // bare-legacy connection -> legacy branch
  }
  const info = deps.resolveCatalog(id);
  if (info === undefined) {
    return undefined;
  }

  // custom sentinel: the legacy branch reads the connection credential + the
  // connection baseUrl/model; returning undefined routes it there.
  if (info.isCustom) {
    return undefined;
  }
  const model = connection.model;
  // Carry the catalog entry's RAW defaultTransport (TASK.43 W5-FIX). The full
  // ladder (env > active-connection transport > this default, with the
  // anthropic-family suppression) is applied by buildHostEnv's single
  // `resolveEffectiveTransport` authority.
  const defaultTransport = info.defaultTransport;
  // A `needsBaseUrl` entry (vLLM template) sources its baseUrl from the
  // connection, exactly like `custom`, even though it is NOT `isCustom`.
  const baseUrl = info.needsBaseUrl === true ? connection.baseUrl : info.baseUrl;
  if (info.authKind === "oauth") {
    const apiKey = await deps.getAccessToken(connection.id, id);
    return { baseUrl, model, apiKey, authKind: "oauth", defaultTransport };
  }
  const apiKey = await deps.getApiKey(connection.id);
  return { baseUrl, model, apiKey, authKind: "api_key", defaultTransport };
}

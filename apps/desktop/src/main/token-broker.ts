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

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Refresh this many ms BEFORE the real expiry, to guard against clock skew / in-flight use. */
const DEFAULT_SKEW_MS = 60_000;

/** Vault surface the broker reads/writes token blobs through (structural). */
export interface TokenBrokerVault {
  getOAuthTokens(providerId: string): Promise<OAuthTokenBlob | undefined>;
  setOAuthTokens(
    providerId: string,
    blob: OAuthTokenBlob,
    opts: { allowWeak: boolean },
  ): Promise<{ ok: boolean }>;
  clearOAuthTokens(providerId: string): Promise<void>;
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
   * The current valid access token for a provider (design §3.3). Returns the
   * cached token while it is live; otherwise runs (or joins) a single-flight
   * refresh. `undefined` = not signed in / undecryptable / refresh failed (the
   * host then falls back to its fork's static env key).
   */
  async getAccessToken(providerId: string): Promise<string | undefined> {
    const blob = await this.vault.getOAuthTokens(providerId);
    if (blob === undefined) {
      return undefined;
    }
    if (this.now() < blob.expiresAt - this.skewMs) {
      return blob.accessToken; // live cache
    }
    return this.refreshSingleFlight(providerId, blob);
  }

  /** Joins an existing refresh for this provider, or starts one and registers it. */
  private refreshSingleFlight(providerId: string, blob: OAuthTokenBlob): Promise<string | undefined> {
    const existing = this.inFlight.get(providerId);
    if (existing !== undefined) {
      return existing;
    }
    const started = this.doRefresh(providerId, blob).finally(() => {
      this.inFlight.delete(providerId);
    });
    this.inFlight.set(providerId, started);
    return started;
  }

  private async doRefresh(providerId: string, blob: OAuthTokenBlob): Promise<string | undefined> {
    const config = this.resolveConfig(providerId);
    if (config === undefined || blob.refreshToken === "") {
      return undefined;
    }
    try {
      const fresh = await this.exchangeRefresh(config, blob.refreshToken);
      await this.vault.setOAuthTokens(providerId, fresh, { allowWeak: this.allowWeak() });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof RefreshError && err.revoked) {
        // Revoked: nuke the entry so readiness + UI show "sign in again".
        await this.vault.clearOAuthTokens(providerId);
      } else {
        this.logger?.warn(`token-broker: refresh failed for ${providerId}`, err);
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
  /** Per-provider api-key vault read (`provider.<id>.apiKey`). */
  getApiKey: (providerId: string) => Promise<string | undefined>;
  /** Fresh OAuth access token via the TokenBroker. */
  getAccessToken: (providerId: string) => Promise<string | undefined>;
}

/**
 * Resolves the selected catalog provider into the host-env selection (baseUrl,
 * model, credential, authKind). Returns `undefined` for the LEGACY path (no
 * `provider.id`, or an id absent from the catalog) so buildHostEnv falls back to
 * byte-for-byte 2.2. oauth -> the credential is a fresh access token (broker);
 * api_key -> the per-provider vault key; custom -> settings.baseUrl.
 */
export async function resolveProviderSelection(
  deps: ProviderSelectionDeps,
): Promise<ResolvedProviderSelection | undefined> {
  const id = deps.settings.provider.id;
  if (id === undefined || id.trim() === "") {
    return undefined;
  }
  const info = deps.resolveCatalog(id);
  if (info === undefined) {
    return undefined;
  }

  // legacy/custom credential; baseUrl/model already come from settings). Returning
  // undefined makes buildHostEnv read `provider.apiKey`, matching the renderer's
  // providerSecretKey (a needsBaseUrl entry uses the bare legacy key).
  if (info.isCustom) {
    return undefined;
  }
  // Per-provider persisted default (F14 §2.4): a stored defaults[id].model wins
  // over the plain settings.provider.model, mirroring buildHostEnv's legacy path.
  const model = deps.settings.provider.defaults?.[id]?.model ?? deps.settings.provider.model;
  // Wire transport ladder (TASK.43 W5): settings.provider.transport (the
  // user's explicit selection) wins over the catalog entry's default.
  const transport = deps.settings.provider.transport ?? info.defaultTransport;
  // A `needsBaseUrl` entry (vLLM template, or a future non-custom template)
  // sources its baseUrl from settings exactly like `custom` above, even though
  // it is NOT `isCustom` and did not bypass to the legacy branch.
  const baseUrl = info.needsBaseUrl === true ? deps.settings.provider.baseUrl : info.baseUrl;
  if (info.authKind === "oauth") {
    const apiKey = await deps.getAccessToken(id);
    return { baseUrl, model, apiKey, authKind: "oauth", transport };
  }
  const apiKey = await deps.getApiKey(id);
  return { baseUrl, model, apiKey, authKind: "api_key", transport };
}

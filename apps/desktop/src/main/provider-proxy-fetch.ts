/**
 * TASK.133 / Taskana 4117 — main's OWN provider network requests, proxied.
 *
 * Main makes three connection-scoped HTTP calls on the user's behalf
 * (`provider-ipc.ts` /v1/models, `oauth.ts` code exchange, `token-broker.ts`
 * refresh). Until now they rode `globalThis.fetch`, which cannot honour the
 * proxy ladder: Node's fetch reads the proxy env once at bootstrap and the
 * materialised env deliberately never touches this process anyway. This module
 * routes those requests through Electron's `net.request` on a per-credential
 * session partition, with proxy auth answered on the per-request `login`
 * event — credentials are the request's closure only and never leave it.
 *
 * Everything Electron-shaped is INJECTED (`requestFactory`, `setProxyFor`), so
 * the whole decision table is unit-testable off scriptable fakes. The routing
 * decision itself (`resolveProxyRoute`) is fail-closed: a scope that
 * configured a proxy-bearing value which turns out to be unusable refuses the
 * request (`ProxyMisconfiguredError`) rather than silently sending it around
 * the proxy — a fixed, credential-free message, because masking cannot be
 * trusted on malformed junk.
 */

import { createHash } from "node:crypto";
import {
  findProxyProfile,
  isProxyProfileUrl,
  PROXY_REF_DIRECT,
  readProxyScope,
  type MaterializedProxy,
  type ProxyScopeId,
} from "../shared/proxy.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { resolveProxyForAsync, type ProxyMaterializationDeps } from "./host-env.js";
import { effectiveNoProxy, noProxyMatchesTarget } from "./network-ipc.js";

// ── route resolution ──

export type ProxyRoute =
  | { kind: "direct"; why: "nothing-configured" | "explicit-direct" | "dangling-ref" | "system-answer" | "no-proxy-exemption" }
  | { kind: "proxy"; proxy: MaterializedProxy }
  | { kind: "misconfigured" };

export const PROXY_MISCONFIGURED_MESSAGE =
  "this connection's proxy is configured but unusable, so the request was refused rather than sent around the proxy";

export class ProxyMisconfiguredError extends Error {
  constructor() {
    super(PROXY_MISCONFIGURED_MESSAGE);
    this.name = "ProxyMisconfiguredError";
  }
}

/**
 * Resolves ONE chain to a request-time route.
 *
 * The FIRST speaking scope is validated on its RAW fields BEFORE the ladder
 * materializes anything (defect 6): a malformed value at the connection rung
 * is classified HERE — it can never be silently downgraded to the inherited
 * app rung's proxy. Valid values keep their exact canonical ladder /
 * materialization semantics (system-mode resolution, vault passwords, the
 * dangling→direct law) by delegating to `resolveProxyForAsync`.
 */
export async function resolveProxyRoute(
  settings: AnycodeSettings,
  chain: readonly ProxyScopeId[],
  deps: ProxyMaterializationDeps,
  targetUrl: string,
): Promise<ProxyRoute> {
  let first: { scope: ProxyScopeId; ref?: string; legacyUrl?: string } | undefined;
  for (const scope of chain) {
    const { ref, legacyUrl } = readProxyScope(settings, scope);
    if (ref !== undefined || legacyUrl !== undefined) {
      first = { scope, ref, legacyUrl };
      break;
    }
  }
  if (first === undefined) {
    return { kind: "direct", why: "nothing-configured" };
  }

  if (first.ref !== undefined) {
    // A ref overrides the same scope's legacy string. Classify it on the raw
    // profile BEFORE any inheritance can be materialized.
    if (first.ref === PROXY_REF_DIRECT) {
      return { kind: "direct", why: "explicit-direct" };
    }
    const profile = findProxyProfile(settings, first.ref);
    if (profile === undefined) {
      return { kind: "direct", why: "dangling-ref" }; // existing pinned law (host-env.test.ts)
    }
    if (profile.mode === "system") {
      // Materialize through the canonical authority: a resolved `proxy` answer
      // is a real proxy; unresolved/DIRECT/socks-unsupported → direct by law.
      const proxy = await resolveProxyForAsync(settings, chain, deps);
      if (proxy === undefined) {
        return { kind: "direct", why: "system-answer" };
      }
      if (proxy.noProxy !== undefined && noProxyMatchesTarget(effectiveNoProxy(proxy.noProxy), targetUrl)) {
        return { kind: "direct", why: "no-proxy-exemption" };
      }
      if (splitProxyUrl(proxy.url) === undefined) {
        return { kind: "misconfigured" };
      }
      return { kind: "proxy", proxy };
    }
    // Manual profile: the URL must clear BOTH the registry custody boundary
    // and the dispatcher's own split — a hand-edited garbage url is refused,
    // never routed around the proxy.
    if (profile.url === undefined || !isProxyProfileUrl(profile.url) || splitProxyUrl(profile.url) === undefined) {
      return { kind: "misconfigured" };
    }
    const proxy = await resolveProxyForAsync(settings, chain, deps);
    if (proxy === undefined || splitProxyUrl(proxy.url) === undefined) {
      return { kind: "misconfigured" };
    }
    if (proxy.noProxy !== undefined && noProxyMatchesTarget(effectiveNoProxy(proxy.noProxy), targetUrl)) {
      return { kind: "direct", why: "no-proxy-exemption" };
    }
    return { kind: "proxy", proxy };
  }

  // Only the legacy string spoke. It must split cleanly HERE, before any
  // inherited rung is materialized — for main's OWN fetch, the ladder's
  // fail-soft skip of a malformed legacy string would be the silent bypass
  // this task forbids.
  if (splitProxyUrl(first.legacyUrl as string) === undefined) {
    return { kind: "misconfigured" };
  }
  const proxy = await resolveProxyForAsync(settings, chain, deps);
  if (proxy === undefined || splitProxyUrl(proxy.url) === undefined) {
    return { kind: "misconfigured" };
  }
  if (proxy.noProxy !== undefined && noProxyMatchesTarget(effectiveNoProxy(proxy.noProxy), targetUrl)) {
    return { kind: "direct", why: "no-proxy-exemption" };
  }
  return { kind: "proxy", proxy };
}

// ── scheme-preserving, throw-safe split ──

export interface SplitProxy {
  rules: string;
  login?: string;
  password?: string;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined; // malformed %-sequence
  }
}

/**
 * Splits a materialized proxy URL into Chromium's `proxyRules` string plus the
 * per-request auth credentials. Scheme-preserving; Node's `URL.hostname`
 * already brackets IPv6 literals, which are used verbatim (no double
 * bracket). Any userinfo decoding failure (malformed percent-escape) yields
 * `undefined` — the caller's misconfigured arm, never a credential-less
 * request to the proxy.
 */
export function splitProxyUrl(value: string): SplitProxy | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.hostname === "") {
    return undefined;
  }
  const authority = parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  let login: string | undefined;
  let password: string | undefined;
  if (parsed.username !== "") {
    login = decode(parsed.username);
    if (login === undefined) {
      return undefined;
    }
    if (parsed.password !== "") {
      password = decode(parsed.password);
      if (password === undefined) {
        return undefined;
      }
    }
  }
  return {
    rules: `${parsed.protocol}//${authority}`,
    ...(login !== undefined ? { login, ...(password !== undefined ? { password } : {}) } : {}),
  };
}

// ── streaming fetch adapter (net.request → WHATWG Response) ──

export interface ProxyAuthInfo {
  isProxy: boolean;
  scheme: string;
  host: string;
  port: number;
  realm: string;
}
export type ProxyAuthCallback = (username?: string, password?: string) => void;

/**
 * Structural view of the `IncomingMessage` the adapter consumes — EventEmitter
 * surface ONLY (the installed electron.d.ts ~8768 types it as a
 * NodeEventEmitter; it carries no pause/resume API — the only pause/resume
 * entries in electron.d.ts are DownloadItem's). Boundedness therefore comes
 * from the adapter's own bounded queue + abort, NOT from flow-control APIs.
 */
export interface ProxyIncomingLike {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Structural view of the `ClientRequest` the adapter drives. `on` is
 * permissive (string event) because the adapter also hears the documented
 * `redirect` event (statusCode, method, redirectUrl, responseHeaders —
 * electron.d.ts ~6758-6790: when a `redirect` listener is present,
 * `followRedirect()` MUST be called synchronously or the request is
 * cancelled); `followRedirect` is optional only so structural fakes from
 * before that contract are still honest about what they support.
 */
export interface ProxyClientRequestLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  /** electron.d.ts ~6770: continue following the redirect (only meaningful with a `redirect` listener). */
  followRedirect?(): void;
  write(chunk: string): unknown;
  end(): unknown;
  abort(): void;
}

export interface ProxyDispatchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  partition: string;
  redirect: "follow" | "error" | "manual";
}

/** Returns the underlying `net.request`-shaped object; typed loosely so fakes and Electron both satisfy it. */
export type ProxyRequestFactory = (request: ProxyDispatchRequest) => unknown;

/** Sanitized cause for boundary failures — the raw error may quote the proxy URL with userinfo. */
function sanitizedCause(): Error {
  return new Error("net request failed");
}

const BOUND_QUEUE_LIMIT = 64;

function flattenHeaders(headers: Record<string, string | string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Dispatches one fetch through the injected factory on `partition`'s session.
 *
 *  - Headers normalize through `new Headers(init.headers)` (duplicate names
 *    joined by the platform, `Headers` instance / object / pair-array inputs
 *    all accepted).
 *  - `redirect` maps 1:1 onto the documented `net.request` option. Native
 *    `redirect: "error"` can surface as a request error whose message does
 *    NOT contain "redirect", so the `redirect` EVENT is additionally heard:
 *    in `error` mode it aborts the wire and rejects with a cause that DOES
 *    say "redirect" (preserving provider-ipc's `redirect_blocked`
 *    classifier); in `manual` mode the 3xx response is surfaced as-is.
 *  - The `credentials` option is deliberately unset — `omit` is documented to
 *    suppress the `login` event, which would break proxy auth. Isolation
 *    rests on per-credential partitions instead.
 *  - The Response body is a true stream: chunks enqueue incrementally,
 *    `reader.cancel()` aborts the wire, and an abort/error after headers
 *    errors the stream (not just the fetch promise). The AbortSignal listener
 *    stays attached until the body settles and its cleanup is idempotent.
 *  - Only string bodies are supported (both production call sites send
 *    forms/strings); anything else is refused BEFORE the factory is called.
 */
export async function proxyFetchVia(
  factory: ProxyRequestFactory,
  partition: string,
  creds: { login?: string; password?: string } | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new TypeError("fetch failed");
  }
  const normalized = new Headers(init.headers);
  const flat: Record<string, string> = {};
  normalized.forEach((value, name) => {
    flat[name] = value;
  });
  const redirect: "follow" | "error" | "manual" =
    init.redirect === "error" ? "error" : init.redirect === "manual" ? "manual" : "follow";
  let req: ProxyClientRequestLike;
  try {
    req = factory({ url, method: init.method ?? "GET", headers: flat, partition, redirect: "manual" }) as ProxyClientRequestLike;
  } catch (err) {
    throw sanitizedBoundaryError(err);
  }
  const signal = init.signal;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamClosed = false;
    let cleanupSignal: (() => void) | undefined;
    // Stashed outcome when chunks/end/error land before stream start() runs.
    let queuedChunks: Uint8Array[] = [];
    let queuedEnd = false;
    let queuedError: Error | undefined;

    const detachSignal = (): void => {
      cleanupSignal?.();
      cleanupSignal = undefined;
    };
    const abortWire = (): void => {
      try {
        req.abort();
      } catch {
        /* already gone */
      }
    };
    const errorStream = (reason: unknown): void => {
      if (streamController !== undefined && !streamClosed) {
        streamClosed = true;
        detachSignal();
        abortWire(); // the stream is dead; the wire must not linger either
        try {
          streamController.error(reason);
        } catch {
          /* controller already closed */
        }
      } else if (streamController === undefined && !streamClosed) {
        streamClosed = true;
        detachSignal();
        queuedError = reason instanceof Error ? reason : sanitizedCause();
        queuedEnd = false;
        queuedChunks = [];
      }
    };
    const settleError = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachSignal();
      abortWire();
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = sanitizedCause();
      reject(err);
    };
    const settleRedirectBlocked = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      detachSignal();
      abortWire();
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = new Error("redirect blocked");
      reject(err);
    };

    // AbortSignal: lives until the BODY settles (not merely the headers), and
    // its cleanup is idempotent — an abort after headers errors the stream
    // with signal.reason and aborts the wire.
    if (signal !== undefined && signal !== null) {
      const onAbort = (): void => {
        const reason: unknown =
          signal.reason ?? new DOMException("This operation was aborted", "AbortError");
        if (!settled) {
          settled = true;
          detachSignal();
          abortWire();
          reject(reason);
        } else {
          errorStream(reason);
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
      cleanupSignal = () => signal.removeEventListener("abort", onAbort);
    }

    req.on("login", ((authInfo: unknown, callback: ProxyAuthCallback) => {
      const info = authInfo as ProxyAuthInfo | null;
      if (info !== null && typeof info === "object" && info.isProxy === true && creds?.login !== undefined) {
        callback(creds.login, creds.password ?? "");
      } else {
        callback();
      }
    }) as unknown as (...args: never[]) => void);

    // Redirect transport (electron.d.ts ~6758-6790): the listener's presence
    // forces manual transport — Chromium follows ONLY on a synchronous
    // followRedirect() call, otherwise the request is cancelled. The adapter
    // always passes redirect:"manual" as the native option and implements
    // follow/error/manual itself:
    //  - follow  → followRedirect() synchronously (default-follow requests
    //              keep following; the eventual final response arrives on
    //              "response" as usual);
    //  - error   → abort + reject with a "redirect blocked" cause, so the
    //              provider guard's redirect_blocked classifier holds
    //              deterministically (native redirect:"error" can abort
    //              BEFORE the event fires, losing the classification);
    //  - manual  → surface the redirect response verbatim (status +
    //              Location header), as WHATWG manual semantics require.
    req.on("redirect", ((
      statusCode: number,
      _method: string,
      _redirectUrl: string,
      responseHeaders: Record<string, string | string[]>,
    ) => {
      if (settled) {
        return;
      }
      if (redirect === "follow") {
        const follow = req.followRedirect;
        if (typeof follow === "function") {
          follow.call(req); // synchronous, per the documented contract
          return;
        }
        // Structural fake without followRedirect support: surface the 3xx
        // itself so tests can assert the classification from the event.
        settled = true;
        detachSignal();
        abortWire();
        resolve(new Response(null, { status: statusCode, headers: flattenHeaders(responseHeaders) }));
        return;
      }
      if (redirect === "error") {
        settleRedirectBlocked();
        return;
      }
      settled = true;
      detachSignal();
      abortWire();
      resolve(new Response(null, { status: statusCode, headers: flattenHeaders(responseHeaders) }));
    }) as unknown as (...args: never[]) => void);

    req.on("response", ((incoming: ProxyIncomingLike) => {
      if (settled) {
        return;
      }
      settled = true;
      const status = incoming.statusCode ?? 200;
      const statusText = incoming.statusMessage ?? "";
      const headersInit = flattenHeaders(incoming.headers);
      if (status === 204 || status === 205 || status === 304) {
        detachSignal();
        abortWire(); // null-body status: no body will ever be read; do not leave the wire pending
        resolve(new Response(null, { status, statusText, headers: headersInit }));
        return;
      }
      // Bounded demand-driven bridge: Electron's IncomingMessage is a bare
      // EventEmitter (no pause/resume — electron.d.ts ~8768), so boundedness
      // is enforced HERE. Chunks land in the adapter's OWN capped queue and
      // flow into the platform stream only when there is demand
      // (desiredSize > 0 / pull()); a producer that outruns a held consumer
      // past BOUND_QUEUE_LIMIT aborts the wire and errors the stream instead
      // of buffering without bound.
      let ownQueue: Uint8Array[] = [];
      let ownEnd = false;
      let ownError: Error | undefined;
      let overflowed = false;
      const drain = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
        if (streamClosed) {
          return;
        }
        while (ownQueue.length > 0 && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(ownQueue.shift() as Uint8Array);
        }
        if (ownQueue.length === 0) {
          if (ownError !== undefined) {
            const err = ownError;
            ownError = undefined;
            streamClosed = true;
            detachSignal();
            try {
              controller.error(err);
            } catch {
              /* already closed */
            }
          } else if (ownEnd) {
            ownEnd = false;
            streamClosed = true;
            detachSignal();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        }
      };
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            drain(controller);
          },
          pull(controller) {
            drain(controller);
          },
          cancel() {
            streamClosed = true;
            detachSignal();
            abortWire(); // readBodyCapped's reader.cancel() reaches the wire
          },
        });
      } catch (err) {
        // Construction failed or the stream was cancelled before start():
        // never leave the wire pending.
        abortWire();
        reject(sanitizedBoundaryError(err));
        return;
      }
      resolve(new Response(stream, { status, statusText, headers: headersInit }));

      incoming.on("data", (chunk: Buffer) => {
        if (streamClosed || overflowed) {
          return;
        }
        if (streamController !== undefined) {
          if (ownQueue.length >= BOUND_QUEUE_LIMIT) {
            // Producer outran the held consumer past the cap — abort rather
            // than buffer without bound. Fixed message: no wire detail.
            overflowed = true;
            ownQueue = [];
            ownError = new Error("response stream overflow");
            ownEnd = false;
            detachSignal();
            abortWire();
            try {
              streamController.error(ownError);
              streamClosed = true;
            } catch {
              /* already closed */
            }
            return;
          }
          ownQueue.push(new Uint8Array(chunk));
          drain(streamController);
          return;
        }
        // No controller yet (defensive; start() is synchronous): cap anyway.
        if (queuedChunks.length + 1 > BOUND_QUEUE_LIMIT) {
          overflowed = true;
          queuedChunks = [];
          queuedError = new Error("response stream overflow");
          queuedEnd = false;
          detachSignal();
          abortWire();
          return;
        }
        queuedChunks.push(new Uint8Array(chunk));
      });
      incoming.on("end", () => {
        if (streamClosed || overflowed) {
          return;
        }
        if (streamController !== undefined) {
          ownEnd = true;
          drain(streamController);
        } else {
          queuedEnd = true;
        }
      });
      incoming.on("error", (err: Error) => {
        if (streamClosed) {
          return;
        }
        // Sanitized: the wire error may quote the proxy URL with userinfo.
        void err;
        const sanitized = sanitizedCause();
        if (streamController !== undefined) {
          ownError = sanitized;
          ownEnd = false;
          ownQueue = [];
          drain(streamController);
        } else {
          streamClosed = true;
          detachSignal();
          queuedError = sanitized;
          queuedEnd = false;
        }
      });

          }) as unknown as (...args: never[]) => void);

    req.on("error", ((_err: Error) => {
      // After headers, wire errors surface through the stream (erroring a
      // pending reader) rather than a dangling promise. Sanitized.
      if (!settled) {
        settleError();
        return;
      }
      errorStream(sanitizedCause());
    }) as unknown as (...args: never[]) => void);

    if (typeof body === "string") {
      try {
        req.write(body);
      } catch (err) {
        throw sanitizedBoundaryError(err);
      }
    }
    try {
      req.end();
    } catch (err) {
      throw sanitizedBoundaryError(err);
    }
  });
}

/** Sanitized boundary rejection: fixed message + fixed cause (the raw error may quote an authenticated proxy URL). */
function sanitizedBoundaryError(raw: unknown): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = sanitizedCause();
  void raw;
  return err;
}

// ── chain-fetch factory — per-credential partitions, instance-local caches ──

export interface ProxyChainFetchDeps {
  readSettings: () => AnycodeSettings | null;
  materializationFor: (targetUrl: string | undefined) => ProxyMaterializationDeps;
  requestFactory: ProxyRequestFactory;
  setProxyFor: (partition: string, rules: string) => Promise<void>;
  fallbackFetch?: typeof globalThis.fetch;
}

export function createProxyChainFetch(deps: ProxyChainFetchDeps) {
  const fallback: typeof globalThis.fetch = deps.fallbackFetch ?? ((url, init) => globalThis.fetch(url, init));
  const configuredPartitions = new Map<string, Promise<void>>(); // INSTANCE-LOCAL, not module-level
  return (chain: readonly ProxyScopeId[]) =>
    async (url: string, init: RequestInit): Promise<Response> => {
      const current = deps.readSettings();
      if (current === null) {
        return fallback(url, init);
      }
      let route: Awaited<ReturnType<typeof resolveProxyRoute>>;
      try {
        route = await resolveProxyRoute(current, chain, deps.materializationFor(url), url);
      } catch (err) {
        // TASK.133 defect 3: a raw materialization-boundary rejection could
        // quote the authenticated proxy URL — sanitize to the fetch-shaped
        // boundary error (fixed message + fixed credential-free cause).
        throw sanitizedBoundaryError(err);
      }
      if (route.kind === "direct") {
        return fallback(url, init);
      }
      if (route.kind === "misconfigured") {
        throw new ProxyMisconfiguredError();
      }
      const split = splitProxyUrl(route.proxy.url);
      if (split === undefined) {
        throw new ProxyMisconfiguredError();
      }
      // Key = FULL materialized URL (userinfo composed by the canonical
      // materialization, or the verbatim legacy string) + noProxy: two
      // accounts on one host hash differently, so Chromium's session auth
      // cache cannot leak one connection's credentials into another's
      // request. Only the sha256 prefix ever leaves this closure.
      const partition = `anycode-proxy-${createHash("sha256")
        .update(`${route.proxy.url}\n${route.proxy.noProxy ?? ""}`)
        .digest("hex")
        .slice(0, 12)}`;
      let configured = configuredPartitions.get(partition);
      if (configured === undefined) {
        // The async IIFE places the ACTUAL setProxyFor invocation inside the
        // sanitization boundary: a synchronous throw while CALLING
        // deps.setProxyFor rejects this promise just like an async rejection
        // (TASK.133 defect 3) — neither can escape with raw proxy detail.
        configured = (async () => {
          try {
            await deps.setProxyFor(partition, split.rules);
          } catch (err) {
            // Sanitized: a setProxy failure may quote the rules string; fixed
            // message + credential-free cause.
            void err;
            const errOut = new TypeError("fetch failed");
            (errOut as { cause?: unknown }).cause = sanitizedCause();
            throw errOut;
          }
        })();
        configuredPartitions.set(partition, configured);
        // Evict on failure (AFTER insertion — the failure itself may occur
        // before the map write) so a later call retries setProxyFor instead
        // of reusing a poisoned rejection.
        void configured.catch(() => {
          configuredPartitions.delete(partition);
        });
      }
      await configured;
      return proxyFetchVia(deps.requestFactory, partition, split, url, init);
    };
}

// ── updater helpers (pure) ──

/**
 * The updater's `login` handler (public `autoUpdater.on("login")` seam).
 * `readState` returns the CURRENT app-scope creds plus the host/port they
 * belong to — read dynamically on every challenge, never captured at boot.
 * Connection credentials NEVER reach this handler by construction. No creds
 * or a challenge for an unrelated host → the callback fires without
 * credentials (the challenge fails honestly).
 */
export interface UpdaterProxyAuthState {
  login: string;
  password: string;
  host: string;
  port: number;
}

export function makeUpdaterLoginHandler(
  readState: () => UpdaterProxyAuthState | undefined,
): (authInfo: ProxyAuthInfo, callback: ProxyAuthCallback) => void {
  return (authInfo, callback) => {
    const state = readState();
    const relevant =
      authInfo.isProxy === true &&
      state !== undefined &&
      challengeHostMatches(authInfo.host, state.host) &&
      authInfo.port === state.port;
    if (relevant) {
      callback(state.login, state.password);
    } else {
      callback();
    }
  };
}

/** Compares the challenge host against the configured one, normalizing IPv6 bracketing. */
function challengeHostMatches(challengeHost: string, configuredHost: string): boolean {
  const normalize = (host: string): string => {
    let h = host.trim().toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) {
      h = h.slice(1, -1);
    }
    return h;
  };
  return normalize(challengeHost) === normalize(configuredHost);
}

/** Splits an optional `:port` off a NO_PROXY entry, honouring bracketed IPv6 literals (mirrors network-ipc.ts). */
function splitEntryPort(entry: string): { host: string; port?: string } {
  const closing = entry.lastIndexOf("]");
  const colon = entry.lastIndexOf(":");
  if (colon === -1 || colon < closing) {
    return { host: entry };
  }
  if (!entry.startsWith("[") && entry.indexOf(":") !== colon) {
    return { host: entry };
  }
  const port = entry.slice(colon + 1);
  return /^\d+$/.test(port) ? { host: entry.slice(0, colon), port } : { host: entry };
}

function isIPv6Literal(host: string): boolean {
  return host.includes(":");
}

/**
 * Session-level bypass translation for the UPDATER partition ONLY (per-request
 * requests use the canonical `noProxyMatchesTarget` matcher everywhere).
 * Input is the canonical EFFECTIVE list (`effectiveNoProxy` — loopback
 * defaults included). Each DNS host exemption preserves the canonical suffix
 * semantics: both the exact host and `*.<host>` (optional pinned port
 * retained). IPv6 literals use exact bracketed rules. Entries carrying
 * wildcard characters (`192.168.*`) are DROPPED — Chromium pattern semantics
 * would risk a new broad exemption the canonical matcher never granted.
 * `*` alone means whole-route direct (`all: true`).
 */
export function updaterBypassFromNoProxy(noProxy: string | undefined): { bypass?: string; all?: boolean } {
  const entries = (noProxy ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.some((e) => e === "*")) {
    return { all: true };
  }
  const rules: string[] = [];
  const push = (rule: string): void => {
    if (!rules.includes(rule)) {
      rules.push(rule);
    }
  };
  for (const entry of entries) {
    const { host, port } = splitEntryPort(entry);
    let bare = host.startsWith(".") ? host.slice(1) : host;
    if (bare === "") {
      continue;
    }
    if (isIPv6Literal(bare)) {
      const bracketed = bare.startsWith("[") ? bare : `[${bare}]`;
      push(port !== undefined ? `${bracketed}:${port}` : bracketed);
      continue;
    }
    if (bare.includes("*")) {
      continue; // wildcard chars: not a canonical literal target — ignore
    }
    const portSuffix = port !== undefined ? `:${port}` : "";
    push(`${bare}${portSuffix}`);
    push(`*.${bare}${portSuffix}`);
  }
  return rules.length === 0 ? {} : { bypass: rules.join(",") };
}

export type UpdaterRouteDecision =
  | { kind: "untouched" } // nothing configured — NEVER touch the partition
  | { kind: "system" } // system-mode app profile → Chromium system mode
  | { kind: "direct" } // direct/dangling/'*' exemption — reset a previously managed partition
  | { kind: "fixed"; rules: string; bypass?: string }
  | { kind: "misconfigured" };

async function finishUpdaterFixed(
  settings: AnycodeSettings,
  deps: ProxyMaterializationDeps,
  feedUrl: string | undefined,
): Promise<{ decision: UpdaterRouteDecision; creds?: { login: string; password: string } }> {
  const proxy = await resolveProxyForAsync(
    settings,
    [{ kind: "app" }],
    feedUrl === undefined ? deps : { ...deps, targetUrl: feedUrl },
  );
  if (proxy === undefined || splitProxyUrl(proxy.url) === undefined) {
    return { decision: { kind: "misconfigured" } };
  }
  const noProxy = effectiveNoProxy(proxy.noProxy);
  if (updaterBypassFromNoProxy(noProxy).all === true) {
    // '*' alone: the canonical matcher exempts every target — route direct.
    return { decision: { kind: "direct" } };
  }
  const split = splitProxyUrl(proxy.url) as SplitProxy;
  const bypass = updaterBypassFromNoProxy(noProxy).bypass;
  return {
    decision: { kind: "fixed", rules: split.rules, ...(bypass !== undefined ? { bypass } : {}) },
    ...(split.login !== undefined ? { creds: { login: split.login, password: split.password ?? "" } } : {}),
  };
}

/**
 * Pure updater-route decision (side effects injected by the caller). The feed
 * URL, when known, keys the system-mode resolution and nothing else — a
 * per-destination exemption cannot be expressed session-wide, so the fixed
 * route carries the bypass LIST and each updater destination is evaluated by
 * Chromium against it (correction: never route direct merely because the
 * FEED host matches; download hosts can differ).
 */
export async function decideUpdaterRoute(
  settings: AnycodeSettings,
  deps: ProxyMaterializationDeps,
  feedUrl: string | undefined,
): Promise<{ decision: UpdaterRouteDecision; creds?: { login: string; password: string } }> {
  const { ref, legacyUrl } = readProxyScope(settings, { kind: "app" });
  if (ref === undefined && legacyUrl === undefined) {
    return { decision: { kind: "untouched" } };
  }
  if (ref !== undefined) {
    if (ref === PROXY_REF_DIRECT) {
      return { decision: { kind: "direct" } };
    }
    const profile = findProxyProfile(settings, ref);
    if (profile === undefined) {
      return { decision: { kind: "direct" } }; // dangling ref — canonical law
    }
    if (profile.mode === "system") {
      return { decision: { kind: "system" } }; // Chromium resolves PAC per real host — no dummy URL
    }
    // Manual profile: unusable url is refused closed.
    if (profile.url === undefined || !isProxyProfileUrl(profile.url) || splitProxyUrl(profile.url) === undefined) {
      return { decision: { kind: "misconfigured" } };
    }
    return finishUpdaterFixed(settings, deps, feedUrl);
  }
  // Legacy app string: classified BEFORE materialization (same law as
  // resolveProxyRoute — no silent bypass of a malformed value).
  if (splitProxyUrl(legacyUrl as string) === undefined) {
    return { decision: { kind: "misconfigured" } };
  }
  return finishUpdaterFixed(settings, deps, feedUrl);
}

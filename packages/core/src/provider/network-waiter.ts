/**
 * Network waiter (Taskana 4772): the seam through which a model port decides
 * whether a transient pre-content network failure is worth waiting out. The
 * port never opens sockets itself; the host injects a waiter. Every probe is
 * credential-free and never a model call: it is a bare TCP connect to the
 * endpoint's origin.
 */

import { connect as netConnect } from "node:net";
import { effectiveProxyUrl } from "./network-failure.js";

export interface NetworkWaiter {
  /** Is the endpoint's origin reachable right now? Must never throw; a failure answers `false`. */
  probe(baseUrl: string, signal: AbortSignal | undefined): Promise<boolean>;
  /**
   * External "the network may be back" signal (OS online / resume / Retry now).
   * Returns the unsubscribe function. Optional: a probe-only waiter has none.
   */
  onHint?(listener: () => void): () => void;
  /** Milliseconds on a MONOTONIC clock that excludes system sleep. */
  monotonicNow(): number;
}

/** Test seam for `tcpReachable`: a socket-like handle whose `destroy` is called once the answer is known. */
export interface TcpConnector {
  (host: string, port: number, done: (reachable: boolean) => void): { destroy(): void } | undefined;
}

export interface TcpReachableOptions {
  signal?: AbortSignal;
  connect?: TcpConnector;
  /**
   * Taskana 4772 review F1: environment the proxy-aware target is resolved
   * against (NODE_USE_ENV_PROXY + scheme proxies + NO_PROXY). Defaults to
   * `process.env`; an explicitly empty record keeps the origin probe.
   */
  env?: Record<string, string | undefined>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/** The host:port a TCP probe of `baseUrl` targets, or undefined for anything that is not an http(s) URL. */
export function tcpTargetOf(baseUrl: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/**
 * Taskana 4772 review F1: the host:port a probe of `baseUrl` should TARGET,
 * honoring the configured proxy. Model traffic rides Node's env-proxy path
 * only when `NODE_USE_ENV_PROXY=1`; then a scheme proxy (HTTPS_PROXY et al,
 * minus NO_PROXY) receives every request, so the probe must connect to the
 * PROXY — a raw origin probe can answer "online" while every model request
 * is offline (the origin firewalled, proxy up) or the inverse. Without the
 * env-proxy path the request goes direct and the origin remains the target.
 */
export function probeTargetOf(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): { host: string; port: number } | undefined {
  const proxy = effectiveProxyUrl(env, baseUrl);
  if (proxy === undefined) return tcpTargetOf(baseUrl);
  const port = proxy.port !== "" ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80;
  return { host: proxy.hostname.replace(/^\[|\]$/g, ""), port };
}

const defaultConnector: TcpConnector = (host, port, done) => {
  const socket = netConnect({ host, port });
  socket.once("connect", () => done(true));
  socket.on("error", () => done(false));
  return socket;
};

/**
 * TCP-level reachability of the hop `baseUrl`'s traffic actually takes — the
 * configured proxy's host:port when Node's env-proxy path is enabled (F1),
 * else the origin. Resolves `true` on connect, `false` on error, timeout,
 * abort, or an unusable URL. Never rejects, never sends an HTTP request.
 */
export function tcpReachable(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  options: TcpReachableOptions = {},
): Promise<boolean> {
  const target = options.env === undefined ? probeTargetOf(baseUrl) : probeTargetOf(baseUrl, options.env);
  if (target === undefined) return Promise.resolve(false);
  const connect = options.connect ?? defaultConnector;
  const signal = options.signal;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let handle: { destroy(): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      handle?.destroy();
      resolve(reachable);
    };
    const onAbort = (): void => finish(false);
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      handle = connect(target.host, target.port, finish);
    } catch {
      finish(false);
    }
  });
}

/**
 * The probe-only waiter the CLI (and any host without OS signals) uses:
 * TCP probes, no external hints. `performance.now()` is a monotonic clock on
 * darwin and linux and does not advance while the system sleeps, unlike
 * `Date.now()`.
 */
export function createProbeOnlyNetworkWaiter(): NetworkWaiter {
  return {
    probe: (baseUrl, signal) => tcpReachable(baseUrl, DEFAULT_PROBE_TIMEOUT_MS, { signal }),
    monotonicNow: () => performance.now(),
  };
}

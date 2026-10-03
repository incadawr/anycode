/** Shared measured undici tunnel/TLS shapes (desktop proxy-probe, TASK.134). */
export const TUNNEL_STATUS_RE = /Proxy response \((\d{3})\)\s*!==\s*200/;
export function isTlsCode(code: string | undefined, message: string): boolean {
  if (code !== undefined && (code.includes("CERT") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"))) return true;
  return /certificate|ssl|tls handshake/i.test(message) && !/proxy response/i.test(message);
}
/** Node's env-proxy path is used only when explicitly enabled. Resolve the
 * scheme and NO_PROXY before using endpoint context to name a proxy failure. */
function effectiveProxy(env: Record<string, string | undefined>, targetUrl: string | undefined): URL | undefined {
  if (env.NODE_USE_ENV_PROXY !== "1" || targetUrl === undefined) return undefined;
  try {
    const target = new URL(targetUrl);
    const targetHost = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
    for (const rule of (env.no_proxy || env.NO_PROXY || "").split(",")) {
      const entry = rule.trim().toLowerCase();
      if (entry === "*") return undefined;
      if (!entry) continue;
      if (entry === targetHost) return undefined;
      const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
      if (!match) continue;
      const host = match[1]!.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
      if ((!match[2] || match[2] === targetPort) && (targetHost === host || targetHost.endsWith(`.${host}`))) return undefined;
    }
    const raw = target.protocol === "https:" ? env.https_proxy || env.HTTPS_PROXY : target.protocol === "http:" ? env.http_proxy || env.HTTP_PROXY : undefined;
    return raw ? new URL(raw) : undefined;
  } catch { return undefined; }
}
export class NetworkConfigurationError extends Error {
  constructor(readonly configurationCode: NetworkConfigurationFailure, cause: unknown) {
    super("Proxy unavailable. Check the selected connection proxy settings.", { cause });
    this.name = "NetworkConfigurationError";
  }
}
export type NetworkConfigurationFailure = "proxy_unreachable" | "proxy_auth" | "tls";

/** No raw error text or URL escapes this classifier. Socket identity is required
 * before blaming a configured proxy: NO_PROXY may have bypassed it. */
export function classifyNetworkConfigurationFailure(
  error: unknown, env: Record<string, string | undefined> = process.env, targetUrl?: string,
): NetworkConfigurationFailure | undefined {
  if (error instanceof NetworkConfigurationError) return error.configurationCode;
  const proxyForTarget = effectiveProxy(env, targetUrl);
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  for (let n = 0; queue.length && n < 24; n++) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const e = value as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; address?: unknown; hostname?: unknown; port?: unknown; cause?: unknown; errors?: unknown };
    const message = typeof e.message === "string" ? e.message : "";
    const code = typeof e.code === "string" ? e.code : undefined;
    const tunnel = TUNNEL_STATUS_RE.exec(message);
    if (e.status === 407 || e.statusCode === 407 || tunnel?.[1] === "407") return "proxy_auth";
    if (tunnel) return "proxy_unreachable";
    if (isTlsCode(code, message)) return "tls";
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code ?? "")) {
      if (proxyForTarget !== undefined) return "proxy_unreachable";
      for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
        try {
          if (!env[name]) continue;
          const proxy = new URL(env[name]!);
          const host = proxy.hostname.replace(/^\[|\]$/g, "");
          const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
          const socketHost = typeof e.address === "string" ? e.address : e.hostname;
          // The measured ECONNREFUSED message carries address:port even when
          // a wrapper loses the structured socket fields.
          const matches = socketHost === host && (code !== "ECONNREFUSED" || Number(e.port) === port);
          if (matches || (code === "ECONNREFUSED" && message.includes(`connect ECONNREFUSED ${host}:${port}`))) return "proxy_unreachable";
        } catch { /* malformed proxy config is diagnosed by settings */ }
      }
    }
    queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, 24));
  }
  return undefined;
}


/** Preserve the original error except when endpoint context resolves a proxy
 * identity that its structured cause lost (DNS proxy → resolved socket IP). */
export function contextualizeNetworkFailure(error: unknown, targetUrl: string): unknown {
  if (classifyNetworkConfigurationFailure(error) !== undefined) return error;
  const code = classifyNetworkConfigurationFailure(error, process.env, targetUrl);
  return code === undefined ? error : new NetworkConfigurationError(code, error);
}

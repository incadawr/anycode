/**
 * WebFetch tool (design §2.14): HttpPort.fetchText -> HTML-to-text
 * (html-to-text, pure JS) -> content returned with the caller's prompt in an

 * no userinfo in the URL, private/loopback/link-local hosts rejected
 * (string + IP-literal checks; DNS rebinding is out of scope — the primary
 * gate is the permission ask). Module-level 15-minute TTL cache.
 */

import { convert } from "html-to-text";
import { WEBFETCH_CACHE_TTL_MS, WEBFETCH_MAX_BYTES, WEBFETCH_TIMEOUT_MS } from "../types/config.js";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import type { HttpTextResponse } from "../ports/http.js";
import { webFetchInputSchema, type WebFetchInput, type WebFetchOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "WebFetch",
  description:
    "Fetch a web page over HTTP(S), convert it to text and return the content together with the provided question.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "medium",
  sideEffectScope: "network",
  // Network tool: escalates allow -> ask in plan/build/edit (design §2.8).
  needsApproval: true,
  timeoutMs: WEBFETCH_TIMEOUT_MS,
  maxOutputBytes: 100_000,
};

// ---------------------------------------------------------------------------
// SSRF guards (design §2.14, §6 R10): only http/https, no userinfo, and no
// loopback/RFC1918/link-local hosts (string + IP-literal check). DNS
// rebinding is explicitly out of scope; the permission-ask gate is the
// primary defense there.

const LOCAL_HOSTNAME_SUFFIXES = [".localhost", ".local"];
const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** RFC 1918 private ranges + loopback (127/8) + link-local (169.254/16) + 0.0.0.0/8. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed literal -> fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Expands an IPv6 literal (with at most one "::" run and an optional zone id)
 * into its 8 numeric groups. Returns undefined when the literal is malformed.
 */
function expandIPv6Groups(host: string): number[] | undefined {
  const clean = (host.split("%")[0] ?? host).trim();
  if (clean.length === 0) return undefined;
  const halves = clean.split("::");
  if (halves.length > 2) return undefined; // more than one "::" is invalid

  let groupStrings: string[];
  if (halves.length === 2) {
    const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
    const tail = halves[1] === "" ? [] : (halves[1] ?? "").split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return undefined;
    groupStrings = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groupStrings = clean.split(":");
  }
  if (groupStrings.length !== 8) return undefined;

  const groups = groupStrings.map((g) => (g === "" ? Number.NaN : parseInt(g, 16)));
  return groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? undefined : groups;
}

/**
 * Loopback (::1, unspecified ::), IPv4-mapped loopback/private
 * (::ffff:a.b.c.d), unique-local (fc00::/7) and link-local (fe80::/10) IPv6
 * literals. Malformed input fails closed (treated as private).
 */
function isPrivateIPv6(host: string): boolean {
  const groups = expandIPv6Groups(host.toLowerCase());
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];

  if (groups.every((n) => n === 0)) return true; // "::" unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // IPv4-mapped: last two groups pack the four IPv4 octets.
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(host) || LOCAL_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    return isPrivateIPv6(host.slice(1, -1));
  }
  if (isIPv4Literal(host)) {
    return isPrivateIPv4(host);
  }
  if (host.includes(":")) {
    return isPrivateIPv6(host);
  }
  return false;
}

/** Returns an error message when the URL must be rejected before any request is made. */
function checkSsrfGuard(url: URL): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `WebFetch: unsupported protocol "${url.protocol}" (only http/https are allowed)`;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return "WebFetch: URLs with embedded credentials (userinfo) are not allowed";
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    return `WebFetch: refusing to fetch loopback/private/link-local host "${url.hostname}"`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Module-level TTL cache, keyed by the requested URL (design §2.14: 15 min).

interface CacheEntry {
  response: HttpTextResponse;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

function capUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

export const webFetchTool: ToolDefinition<WebFetchInput, WebFetchOutput> = {
  metadata,
  inputSchema: webFetchInputSchema,
  handler: async (input, ctx) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, error: `WebFetch: invalid URL "${input.url}"` };
    }

    const guardError = checkSsrfGuard(url);
    if (guardError) {
      return { ok: false, error: guardError };
    }

    const now = Date.now();
    const cached = responseCache.get(input.url);
    let response: HttpTextResponse;
    let cacheHit = false;

    if (cached && cached.expiresAt > now) {
      response = cached.response;
      cacheHit = true;
    } else {
      try {
        response = await ctx.ports.http.fetchText({
          url: input.url,
          timeoutMs: metadata.timeoutMs,
          maxBytes: WEBFETCH_MAX_BYTES,
          abortSignal: ctx.abortSignal,
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      responseCache.set(input.url, { response, expiresAt: now + WEBFETCH_CACHE_TTL_MS });
    }

    const isHtml = (response.contentType ?? "").toLowerCase().includes("html");
    const text = isHtml ? convert(response.body, { wordwrap: false }) : response.body;
    const combined = `question: ${input.prompt}\n\n${text}`;

    const maxOutputBytes = metadata.maxOutputBytes ?? combined.length;
    const { text: content, truncated: contentTruncated } = capUtf8Bytes(combined, maxOutputBytes);

    return {
      ok: true,
      output: {
        finalUrl: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
        content,
        truncated: response.truncated || contentTruncated,
        cacheHit,
      },
    };
  },
};

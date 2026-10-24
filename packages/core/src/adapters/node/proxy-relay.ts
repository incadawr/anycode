/**
 * Credential-free loopback proxy relay (TASK.135 / Taskana 4074 follow-up).
 *
 * TASK.135's scrub DROPS a `user:pass@` proxy URL from every non-engine child,
 * which closes the `env`-exfil vector but breaks npm/git/curl behind an
 * authenticating corporate proxy: the child connects directly and loses the
 * network. This module restores connectivity WITHOUT restoring the credential:
 * while the host holds a credentialed upstream proxy, it runs a tiny FORWARD
 * proxy on `127.0.0.1:<random port>`, and children get
 * `HTTP(S)_PROXY=http://127.0.0.1:PORT` (no userinfo). The relay owns the
 * credential in-process and adds `Proxy-Authorization: Basic …` on every hop
 * towards the upstream. The password never crosses the child boundary again —
 * a child (or a model driving it) that runs `env` sees only the credential-free
 * loopback URL.
 *
 * Implementation constraints, deliberately: node:http/net only, no new
 * dependencies, no TLS for the relay itself (loopback HTTP is the transport,
 * the CONNECT tunnel carries the encryption for https targets), 127.0.0.1 bind
 * + a peer-identity check on every connection (belt under the bind: a mis-
 * configured host stack must not turn the relay into an open authenticating
 * proxy for the LAN). The upstream half supports http:// proxies only; an
 * https:// (TLS-to-proxy) upstream is the ONE thing this relay refuses —
 * supporting it needs a TLS client per hop (a connect+handshake state machine
 * node:http cannot express without a tls socket), which is not trivial, so
 * `resolveProxyRelay` returns `undefined` and the caller keeps TASK.135's plain
 * drop behaviour (log once, children go direct). Engine tabs (claude/codex)
 * received the upstream proxy URL themselves until Taskana 4685: their host
 * builders now swap a credentialed family for the relay URL and main
 * de-credentialises engine carriers against main's own relay (this module).
 *
 * ── auth token (Taskana 4685) ──
 * The 127.0.0.1 bind + peer check keeps the LAN out, but loopback is shared
 * by EVERY local user of the machine, so before 4685 any process of any local
 * user could dial the port and get an authenticating proxy. The cross-user
 * boundary is now a per-relay random token minted at bind time and embedded
 * as a PATH SEGMENT of the relay URL (`http://127.0.0.1:port/<token>` —
 * never `@`-userinfo, so `proxyValueHasUserinfo`-based detectors never trip
 * and children can carry it in env vars). A WRONG token is rejected with 403
 * BEFORE any upstream contact on both plain-HTTP and CONNECT. An ABSENT token
 * is accepted: no env-var proxy configuration can attach a header or a path
 * to a CONNECT (npm/git/curl compatibility — the 4074 DoD), so rejecting
 * absent tokens would break exactly the children this relay exists to serve;
 * tightening that is the named follow-up (children need a proxy helper script
 * or `~/.curlrc` generation first).
 *
 * ── wire behaviour ──
 *  - `CONNECT host:port` (HTTPS tunnelling): open a socket to the upstream
 *    proxy, send `CONNECT` with `Proxy-Authorization`, pipe both ways once
 *    upstream answers 200. A non-200 CONNECT answer is relayed to the client
 *    verbatim (status line + headers + whatever body bytes arrived) and both
 *    sides are then torn down.
 *  - plain HTTP absolute-URI requests: forwarded to the upstream proxy with
 *    `Proxy-Authorization` added and hop-by-hop headers stripped; framing is
 *    re-done by node's own client/server (no raw byte splicing). Origin-form
 *    requests (`GET /x`, what a DNS-rebound browser page would send) are
 *    refused with 400 — they are not proxy requests and must never reach the
 *    upstream with the credential attached.
 *
 * ── lifecycle ──
 *  - `resolveProxyRelay(env)` NEVER throws: an unparseable URL, a missing
 *    port or an https:// upstream yields `undefined` (the drop fallback), and
 *    so does a bind failure — callers have ONE failure mode to handle. Binding
 *    is asynchronous, so callers that can await (the boot paths) use it, and
 *    sync spawn sites read `proxyRelayUrl()` — a spawn before the bind settles
 *    simply misses the relay, exactly like a `system` proxy profile's honest
 *    first-direct window.
 *  - `relay.url` is the credential-free `http://127.0.0.1:port/<token>` string
 *    to feed `buildChildEnv`'s `relayUrl`; `relay.token` is the auth token.
 *  - `relay.close()` destroys every tracked socket (client-, upstream- and
 *    tunnel-pairs) and closes the listener; safe to call more than once.
 */

import { randomBytes } from "node:crypto";
import * as http from "node:http";
import net from "node:net";

import { isProxyVarName } from "./child-env.js";

/** The relay's own URL scheme: loopback plain HTTP, always. */
const RELAY_SCHEME = "http";
/** The relay's bind address: loopback only, never 0.0.0.0. */
const RELAY_HOST = "127.0.0.1";

// ── upstream URL parsing (pure; exported for unit tests) ──

/** The pieces of an upstream proxy URL the relay needs on the wire. */
export interface UpstreamProxyEndpoint {
  host: string;
  port: number;
  /** Pre-computed `Basic base64(user:pass)` header VALUE (no leading `Proxy-Authorization: `). */
  proxyAuthorization: string;
}

/**
 * Parses a CREDENTIALED upstream proxy URL into the endpoint the relay dials.
 * `undefined` for everything the relay does not serve: a URL without userinfo
 * (nothing to protect — TASK.135 passes those through verbatim and no relay is
 * started), an https:// upstream (TLS-to-proxy is not supported; the caller
 * keeps the drop behaviour), a missing port, or anything `URL` cannot parse.
 *
 * NOTE: the returned object embeds the credential (that is its job) and is
 * CONFINED to this module — it never reaches an env, a log line or a return
 * value of the relay handle. `proxyAuthorization` is base64, not plaintext,
 * but it is still the password for anyone who holds it, so it is treated with
 * the same secrecy as the password itself.
 */
export function parseUpstreamProxyUrl(upstreamUrl: string): UpstreamProxyEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") {
    // https:// (TLS-to-proxy) is the refused case — see the file header. A
    // socks5:// "proxy" is not an HTTP forward proxy at all and is refused
    // for the same reason: no honest relay can be built for it here.
    return undefined;
  }
  // `URL.username`/`password` stay PERCENT-ENCODED (the URL parser does not
  // decode them), so a legal `%40` inside a username must be decoded here.
  // `safePercentDecode` decodes ONLY `%XX` triplets and leaves every other
  // character byte-identical (`+` stays `+`, unlike decodeURIComponent) — but
  // each triplet is decoded as a raw BYTE and the result is read back as
  // UTF-8, because the parser percent-encodes non-ASCII userinfo as UTF-8
  // bytes (`päss` → `p%C3%A4ss`): latin1-style code-point decoding would
  // double-encode at the `Buffer.from(…)` below and send a WRONG credential
  // (cross-review F1). A colon in the decoded password is fine — base64
  // wraps the whole `user:pass`.
  if (url.username === "" && url.password === "") {
    return undefined;
  }
  // No default port: an explicit one is required (a proxy URL without a port
  // is ambiguous on the wire and refusing beats guessing port 80).
  if (url.port === "") {
    return undefined;
  }
  const host = url.hostname;
  const port = Number(url.port);
  if (host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  const user = safePercentDecode(url.username);
  const pass = safePercentDecode(url.password);
  const proxyAuthorization = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  return { host, port, proxyAuthorization };
}

/**
 * Decodes only `%XX` sequences; `+` and every other literal character stay
 * byte-identical (unlike decodeURIComponent). Each triplet is decoded as a
 * raw BYTE and the collected byte string is read back as UTF-8 — the URL
 * parser emits non-ASCII userinfo as UTF-8 percent bytes, so this round
 * trips `päss`/emoji exactly (cross-review F1: a latin1 code-point decode
 * double-encoded them and silently broke the upstream credential).
 */
function safePercentDecode(text: string): string {
  const bytes: number[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") {
      bytes.push(...Buffer.from(literal, "utf8"));
      literal = "";
    }
  };
  for (let i = 0; i < text.length; ) {
    const hex = /^[0-9A-Fa-f]{2}$/.exec(text.slice(i + 1, i + 3));
    if (text[i] === "%" && hex !== null) {
      flush();
      bytes.push(parseInt(hex[0], 16));
      i += 3;
    } else {
      literal += text[i];
      i += 1;
    }
  }
  flush();
  return Buffer.from(bytes).toString("utf8");
}

// ── loopback peer check (pure; exported for unit tests) ──

/**
 * True when `remoteAddress` is a loopback address this relay will serve. This
 * is the belt under the 127.0.0.1 bind: the server REFUSES (destroys) any
 * connection whose peer is not loopback, so a misrouted or forwarded
 * connection (a misconfigured host stack, an SSH -R, a container port map)
 * cannot turn the relay into an open authenticating proxy for third parties.
 * The whole 127.0.0.0/8 range counts (`127.0.0.99` is as loopback as
 * `127.0.0.1`), plus IPv6 `::1` and IPv4-mapped IPv6 (`::ffff:127.x.x.x`).
 */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) {
    return false;
  }
  if (remoteAddress === "::1") {
    return true;
  }
  const v4 = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress;
  return isLoopbackV4(v4);
}

/** `127.0.0.0/8`: four dotted decimal octets, first octet exactly 127. */
function isLoopbackV4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return false;
  }
  if (parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part));
}

// ── the relay itself ──

/** Handle for a running relay; `url` is what children receive as HTTP(S)_PROXY. */
export interface ProxyRelay {
  /** Credential-free `http://127.0.0.1:<port>/<token>` — feed this to `buildChildEnv`'s `relayUrl`. */
  readonly url: string;
  /** The loopback port the relay listens on. */
  readonly port: number;
  /** Per-relay random auth token (Taskana 4685); also the path segment of `url`. */
  readonly token: string;
  /** Destroys every socket (client, upstream and tunnels) and closes the listener. Idempotent. */
  close(): void;
}

// ── token triage (pure; exported for unit tests) ──

/** Taskana 4685: triage of a presented relay token. `absent` is ACCEPTED (children cannot be configured to send one — see the module header); `wrong` is REJECTED before the upstream is ever dialled. */
export type RelayTokenCheck = "absent" | "valid" | "wrong";

export function checkRelayToken(presented: string | undefined, path: string | undefined, token: string): RelayTokenCheck {
  const header = presented?.trim();
  const pathToken = path !== undefined && (path === `/${token}` || path.startsWith(`/${token}/`)) ? token : undefined;
  if (header === undefined && pathToken === undefined) {
    return "absent";
  }
  if (header === token || pathToken !== undefined) {
    return "valid";
  }
  return "wrong";
}

/** RFC 9110 §7.6.1 hop-by-hop headers (plus the legacy `proxy-connection`); never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

/** Pre-200 CONNECT reply cap: an upstream that never ends its header must not grow memory unboundedly. */
const MAX_CONNECT_REPLY_HEADER_BYTES = 16 * 1024;

/**
 * Copies `headers` minus the hop-by-hop set and minus every token the
 * `Connection` header itself names. `transfer-encoding`/`content-length` are
 * KEPT: node's client/server re-frame the body from them (its strict parser
 * already refused any CL+TE conflict on the way in).
 */
export function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/**
 * Builds the fully-wired relay server (request + connect + peer-check + socket
 * set) without listening. Mints the per-relay auth token (Taskana 4685): 24
 * random bytes, base64url — 32 unambiguous URL-path characters that survive
 * every child's env handling untouched.
 */
function buildRelayServer(endpoint: UpstreamProxyEndpoint): { server: http.Server; sockets: Set<net.Socket>; token: string } {
  const token = randomBytes(24).toString("base64url");
  /** Every live socket in both directions, so close() can tear the world down. */
  const sockets = new Set<net.Socket>();
  // A DEDICATED agent, never `http.globalAgent`: under NODE_USE_ENV_PROXY=1
  // (which the desktop host fork sets) node's global agent itself honours
  // HTTP_PROXY, so the relay's upstream hop would be proxied a second time.
  const upstreamAgent = new http.Agent({ keepAlive: false });

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Plain-HTTP absolute-URI proxying. Anything else (origin-form `GET /x`,
    // `*`) is not a forward-proxy request — refuse it before the credential
    // is attached to anything.
    if (req.url === undefined || !/^http:\/\//i.test(req.url)) {
      res.writeHead(400, { "content-type": "text/plain", connection: "close" });
      res.end("anycode proxy relay: absolute http:// request URI required\n");
      return;
    }
    // Taskana 4685: token gate BEFORE any upstream contact. A WRONG token is
    // rejected here; an ABSENT one is accepted (children cannot send one via
    // env alone — the frozen 4074 compatibility ruling; see module header).
    // The ORIGINAL absolute URI is forwarded upstream unchanged below — the
    // token lives in the proxy URL's path, which node/undici-based children
    // preserve in the absolute request URI.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url);
    } catch {
      res.writeHead(400, { "content-type": "text/plain", connection: "close" });
      res.end("anycode proxy relay: absolute http:// request URI required\n");
      return;
    }
    if (checkRelayToken(req.headers["x-anycode-relay-token"] as string | undefined, requestUrl.pathname, token) === "wrong") {
      res.writeHead(403, { "content-type": "text/plain", connection: "close" });
      res.end("anycode proxy relay: invalid relay token\n");
      return;
    }
    const upstreamReq = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: req.method,
        path: req.url,
        agent: upstreamAgent,
        headers: { ...stripHopByHop(req.headers), "proxy-authorization": endpoint.proxyAuthorization },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHop(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", () => {
      res.destroy();
    });
    req.on("error", () => {
      upstreamReq.destroy();
    });
    res.on("close", () => {
      upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
    // The request's socket is the upstream dial; track it once it exists.
    upstreamReq.on("socket", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
  };

  const connectHandler = (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void => {
    // Taskana 4685: token gate BEFORE the upstream dial (CONNECT carries no
    // path, so the check is header-only; absent stays accepted — module
    // header). A wrong token must never learn whether the upstream is up.
    if (checkRelayToken(req.headers["x-anycode-relay-token"] as string | undefined, undefined, token) === "wrong") {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const target = req.url; // `host:port` per the CONNECT contract
    const upstreamSocket = connectUpstream();
    if (upstreamSocket === undefined) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }

    // Ask the upstream proxy to open the tunnel, with our credential.
    upstreamSocket.write(
      `CONNECT ${target ?? ""} HTTP/1.1\r\n` +
        `Host: ${target ?? ""}\r\n` +
        `Proxy-Authorization: ${endpoint.proxyAuthorization}\r\n` +
        `Proxy-Connection: keep-alive\r\n` +
        `\r\n`,
    );

    let headerBuffer = Buffer.alloc(0);
    let connected = false;
    const onUpstreamData = (chunk: Buffer): void => {
      if (connected) {
        // Tunnel is live: bytes are payload, pass straight to the client.
        clientSocket.write(chunk);
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (headerBuffer.length > MAX_CONNECT_REPLY_HEADER_BYTES) {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstreamSocket.destroy();
        }
        return;
      }
      const statusLine = headerBuffer.subarray(0, headerBuffer.indexOf("\r\n")).toString("latin1");
      const statusCode = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine)?.[1]);
      if (statusCode === 200) {
        // Established: reply to the client, flush any payload bytes the
        // upstream sent past the header, then pipe both ways.
        connected = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = headerBuffer.subarray(headerEnd + 4);
        if (rest.length > 0) {
          clientSocket.write(rest);
        }
        upstreamSocket.removeListener("data", onUpstreamData);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      } else {
        // Pass the upstream's refusal back verbatim: status line, headers and
        // any body bytes already received. The client sees exactly what the
        // upstream proxy said (407, 403, …), minus the credential.
        clientSocket.write(headerBuffer);
        clientSocket.end();
        upstreamSocket.destroy();
      }
      headerBuffer = Buffer.alloc(0);
    };
    upstreamSocket.on("data", onUpstreamData);
    upstreamSocket.on("error", () => {
      if (!connected && !clientSocket.writableEnded) {
        // end(), not destroy(): destroy() would discard the 502 unsent.
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } else {
        clientSocket.destroy();
      }
    });
    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
    // Either side fully closing tears the other down (graceful FINs still
    // propagate first through pipe()'s end(); this catches resets, a client
    // that leaves before the upstream answered, and close()).
    clientSocket.on("close", () => {
      upstreamSocket.destroy();
    });
    upstreamSocket.on("close", () => {
      if (connected || clientSocket.writableEnded) {
        // Flush what is queued (tunnel tail, a relayed refusal, a 502).
        clientSocket.end();
      } else {
        clientSocket.destroy();
      }
    });
    if (head.length > 0) {
      // Client payload that arrived with the CONNECT request itself.
      upstreamSocket.write(head);
    }
  };

  const connectUpstream = (): net.Socket | undefined => {
    try {
      const socket = net.connect({ host: endpoint.host, port: endpoint.port });
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
      return socket;
    } catch {
      // net.connect with a bad host can throw synchronously; treat as refusal.
      return undefined;
    }
  };

  const server = http.createServer(requestHandler);
  server.on("connect", connectHandler);
  // Belt under the 127.0.0.1 bind: verify the PEER, not just the bind. A
  // socket that is not from this machine is destroyed before a single proxy
  // byte is answered.
  server.on("connection", (socket: net.Socket) => {
    if (!isLoopbackPeer(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  return { server, sockets, token };
}
/**
 * Starts (or returns the already-started) loopback relay for the FIRST
 * credentialed proxy found in `env` — the await-able half every boot path
 * (core host, desktop host, core CLI) calls before the first child spawns.
 *
 *  - `undefined` when no relay is warranted: no proxy var carries credentials
 *    (nothing to protect — TASK.135 already passes credential-less values
 *    through verbatim), or the credentialed upstream is one this relay cannot
 *    serve (https://, socks5://, no port, unparseable), or the bind failed.
 *    Every one of those keeps TASK.135's drop behaviour untouched; for the
 *    cannot-serve case a single console.warn says so once per process (the
 *    card's "log once and fall back" rule).
 *  - Idempotent per process: the first successful call caches its relay, and
 *    `closeProxyRelay()` (test seam / shutdown hook) clears the cache so a
 *    later call can start a fresh one under a changed env. A REFUSED resolve
 *    is also remembered (cross-review F2): without that, every spawn-site
 *    `ensureProxyRelay()` re-warned the same "cannot be relayed" line and the
 *    card's "log once" contract was actually log-per-spawn.
 */
export async function resolveProxyRelay(env: NodeJS.ProcessEnv = process.env): Promise<ProxyRelay | undefined> {
  if (activeRelay !== undefined) {
    return activeRelay;
  }
  if (refusedReason !== undefined) {
    // Already refused in this process: keep TASK.135's drop behaviour
    // silently — the single warn below already said why, once.
    return undefined;
  }
  const upstreamUrl = credentialedProxyValue(env);
  if (upstreamUrl === undefined) {
    return undefined;
  }
  const relay = await createProxyRelayAsync(upstreamUrl, {
    // Log once per process, and never include the offending URL: it carries
    // the very credential this whole module exists to contain. The refused
    // state is recorded so the spawn-side `ensureProxyRelay` re-asks are
    // silent (cross-review F2).
    onRefuse: (reason) => {
      refusedReason = reason;
      console.warn(`[proxy-relay] credentialed proxy cannot be relayed (${reason}); children fall back to TASK.135's direct behaviour`);
    },
  });
  if (relay !== undefined) {
    activeRelay = relay;
  }
  return relay;
}

/** The process-wide relay cache (`undefined` until the first successful resolve). */
let activeRelay: ProxyRelay | undefined;

/**
 * The refuse memory behind "log once per PROCESS" (cross-review F2): set on
 * the first refused resolve, consulted by `resolveProxyRelay` and
 * `ensureProxyRelay`, cleared by `closeProxyRelay()` together with the
 * relay cache — so a shutdown/re-resolve cycle genuinely re-attempts.
 */
let refusedReason: RefuseReason | undefined;

/**
 * The relay URL for SYNC spawn sites (`buildChildEnv`'s third argument):
 * `activeRelay`'s URL when a relay is already up, `undefined` otherwise.
 * Reading is deliberately free of side effects — a spawn must never start
 * network machinery mid-build; the boot paths (and `ensureProxyRelay` below)
 * are the only starters.
 */
export function proxyRelayUrl(): string | undefined {
  return activeRelay?.url;
}

/**
 * Starts the relay on the FIRST child spawn if no boot path did it yet —
 * fire-and-forget, called by `NodeExecutionAdapter`'s constructor-side spawn
 * helpers and safe to call on every spawn. If the relay is already up (or
 * genuinely not warranted), this returns a settled promise and does nothing;
 * the FIRST spawn under a credentialed proxy may still see no relay (the bind
 * is one macrotask away), which is the same honest first-spawn window a
 * `system` proxy profile has. Callers that CAN await use `resolveProxyRelay`.
 */
export function ensureProxyRelay(): void {
  if (activeRelay !== undefined || refusedReason !== undefined || credentialedProxyValue(process.env) === undefined) {
    return;
  }
  // Float the promise: a bind failure must never surface as a rejection at a
  // spawn site. resolveProxyRelay never rejects by construction.
  void resolveProxyRelay().catch(() => {});
}

/** Tears down the cached relay and forgets it (idempotent; test seam + shutdown). Also clears the refuse memory so a later resolve genuinely re-attempts. */
export function closeProxyRelay(): void {
  activeRelay?.close();
  activeRelay = undefined;
  refusedReason = undefined;
}

/**
 * The one proxy-family value in `env` that carries credentials — searched in
 * HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy order FIRST (the names a
 * child's tools apply with the strongest precedence), then across the REST of
 * the family `sanitizeChildEnv` drops (ALL_PROXY, npm_config_proxy, … —
 * cross-review F4: the scrub predicate and this predicate must agree on what
 * "the proxy family" is, or a credentialed ALL_PROXY was dropped with no
 * relay, no warn and no network). Returns the FIRST credentialed value, or
 * undefined when every present member is credential-free. Detection reuses
 * the exact TASK.135 rule: a literal `@` means userinfo.
 */
function credentialedProxyValue(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = env[name];
    if (typeof value === "string" && value.includes("@")) {
      return value;
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (name === "HTTPS_PROXY" || name === "https_proxy" || name === "HTTP_PROXY" || name === "http_proxy") {
      continue; // already scanned above
    }
    if (typeof value === "string" && isProxyVarName(name) && value.includes("@")) {
      return value;
    }
  }
  return undefined;
}

/** Debug labels for the refuse reasons (never include the URL itself). */
type RefuseReason = "no_userinfo" | "unsupported_scheme" | "unparseable_url" | "no_port" | "bind_failed";

/**
 * The await-able relay factory: settles only once the OS has actually assigned the
 * port (or the bind failed), which is the honest version of "the relay is up".
 */
async function createProxyRelayAsync(
  upstreamUrl: string,
  opts: { onRefuse?: (reason: RefuseReason) => void } = {},
): Promise<ProxyRelay | undefined> {
  const endpoint = parseUpstreamProxyUrl(upstreamUrl);
  if (endpoint === undefined) {
    // Classify for the caller's one-time log, without ever printing the URL.
    let parsed: URL | undefined;
    try {
      parsed = new URL(upstreamUrl);
    } catch {
      opts.onRefuse?.("unparseable_url");
      return undefined;
    }
    if (parsed.protocol !== "http:") {
      opts.onRefuse?.("unsupported_scheme");
    } else if (parsed.username === "" && parsed.password === "") {
      opts.onRefuse?.("no_userinfo");
    } else {
      opts.onRefuse?.("no_port");
    }
    return undefined;
  }

  const { server, sockets, token } = buildRelayServer(endpoint);

  const relay = await new Promise<ProxyRelay | undefined>((settle) => {
    server.on("error", () => {
      // A bind/EADDR* failure lands here: degrade to the drop behaviour,
      // never take the host down.
      settle(undefined);
    });
    server.listen(0, RELAY_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        settle(undefined);
        return;
      }
      settle({
        url: `${RELAY_SCHEME}://${RELAY_HOST}:${address.port}/${token}`,
        token,
        port: address.port,
        close(): void {
          for (const socket of sockets) {
            socket.destroy();
          }
          sockets.clear();
          server.close();
        },
      });
    });
  });

  if (relay === undefined) {
    opts.onRefuse?.("bind_failed");
    server.close();
  }
  return relay;
}

/**
 * Test seam: `createProxyRelayAsync` without the process-wide cache and
 * without the one-time warn — the unit suite must be able to start several
 * relays (CONNECT, plain-HTTP, refusal cases) side by side against different
 * fake upstreams. Production code uses `resolveProxyRelay`/`ensureProxyRelay`
 * only.
 */
export const createProxyRelayForTest = createProxyRelayAsync;

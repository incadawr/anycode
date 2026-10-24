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
 * ── auth token (Taskana 4685, reworked) ──
 * The 127.0.0.1 bind + peer check keeps the LAN out, but loopback is shared
 * by EVERY local user of the machine, so any process of any local user could
 * dial the port and get an authenticating proxy. The cross-user boundary is
 * now a per-relay random token minted at bind time and embedded as USERINFO
 * of the relay URL handed to children: `http://anycode:<token>@127.0.0.1:<port>`
 * — curl, git, npm and node's undici all derive a
 * `Proxy-Authorization: Basic base64(user:pass)` from proxy-URL userinfo on
 * CONNECT and plain-HTTP alike, so the token rides the one channel children
 * already speak without a helper script or a curlrc. The relay REQUIRES a
 * valid `Proxy-Authorization` (constant-time compare) on EVERY request and
 * CONNECT and answers 407 otherwise; a client-presented header other than
 * the relay's own never travels upstream (`proxy-authorization` is already
 * stripped and overwritten, and the retired `x-anycode-relay-token` header
 * is dropped outright). The `@` in the URL is exempted in the child-env
 * detectors by exact shape (`isCredentialFreeRelayUrl`), nothing else.
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
 *  - `relay.url` is the `http://anycode:<token>@127.0.0.1:port` string to
 *    feed `buildChildEnv`'s `relayUrl`; `relay.token` is the auth token.
 *  - `relay.close()` destroys every tracked socket (client-, upstream- and
 *    tunnel-pairs) and closes the listener; safe to call more than once.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import net from "node:net";

import { isProxyVarName, registerRelayUrlValidator, type RelayUrlLookup } from "./child-env.js";

// Cross-review F4 (opus2): the child-env relay-URL exemption is gated on THIS
// registry — only a URL whose port AND token match a relay this process
// minted is "credential-free". Registered at module load (both modules are
// in-process siblings; child-env owns the detector, this module owns the
// truth). Exact-match on port + token, not prefix: two relays of this
// process sit on different ports, and a foreign process's relay never
// matches either.
registerRelayUrlValidator((url) => {
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    return false;
  }
  for (const relay of relays.values()) {
    if (relay.port === port && relay.token === url.password) {
      return true;
    }
  }
  return false;
});

/** The relay's own URL scheme: loopback plain HTTP, always. */
const RELAY_SCHEME = "http";
/** The relay's bind address: loopback only, never 0.0.0.0. */
const RELAY_HOST = "127.0.0.1";
/** The fixed userinfo user of every relay URL (`http://anycode:<token>@…`). */
const RELAY_URL_USER = "anycode";

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
  /** `http://anycode:<token>@127.0.0.1:<port>` — feed this to `buildChildEnv`'s `relayUrl`. */
  readonly url: string;
  /** The loopback port the relay listens on. */
  readonly port: number;
  /** Per-relay random auth token (Taskana 4685); the userinfo password of `url`. */
  readonly token: string;
  /** Destroys every socket (client, upstream and tunnels) and closes the listener. Idempotent. */
  close(): void;
}

// ── auth gate (pure; exported for unit tests) ──

/**
 * Taskana 4685 rework: the `Proxy-Authorization` value a client MUST present
 * for this relay — `Basic base64(anycode:<token>)`. Computed once at bind
 * time so the per-request compare is a single constant-time buffer check.
 */
function relayProxyAuthorization(token: string): string {
  return `Basic ${Buffer.from(`${RELAY_URL_USER}:${token}`, "utf8").toString("base64")}`;
}

/** HTTP 407 reply reason phrases for the two gate failures (`Proxy Authentication Required`). */
export type RelayAuthRejection = "absent" | "wrong";

/**
 * Constant-time compare of `presented` against the relay's expected
 * `Proxy-Authorization` value. Byte-length is compared first via the same
 * `timingSafeEqual` (a length mismatch throws, so the guard compares
 * length-encoded sentinels of equal length) — the total shape keeps the
 * comparison time independent of WHERE the first differing byte sits.
 */
function presentedMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Compare two equal-length sentinels instead of returning early, so the
    // timing profile does not disclose the expected length.
    return timingSafeEqual(Buffer.alloc(16, 1), Buffer.alloc(16, 2));
  }
  return timingSafeEqual(a, b);
}

/**
 * Taskana 4685 rework: the auth gate every request and CONNECT passes
 * through BEFORE any upstream contact. `absent` and `wrong` are both
 * rejected (407) — the relay's own children always present the token via
 * proxy-URL userinfo, so an unauthenticated request is exactly the
 * cross-user dial this token exists to refuse.
 */
export function checkRelayAuthorization(
  presented: string | undefined,
  expected: string,
): "valid" | RelayAuthRejection {
  const header = presented?.trim();
  if (header === undefined || header === "") {
    return "absent";
  }
  return presentedMatches(header, expected) ? "valid" : "wrong";
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

/**
 * Taskana 4685: the retired client-token header. Never forwarded upstream —
 * a client (or a model driving it) must not be able to smuggle an
 * anycode-specific header to a third-party host through the relay.
 */
const RELAY_TOKEN_HEADER = "x-anycode-relay-token";

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
  named.add(RELAY_TOKEN_HEADER);
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
  const expectedAuthorization = relayProxyAuthorization(token);
  /** Every live socket in both directions, so close() can tear the world down. */
  const sockets = new Set<net.Socket>();
  // A DEDICATED agent, never `http.globalAgent`: under NODE_USE_ENV_PROXY=1
  // (which the desktop host fork sets) node's global agent itself honours
  // HTTP_PROXY, so the relay's upstream hop would be proxied a second time.
  const upstreamAgent = new http.Agent({ keepAlive: false });

  /** Builds the wire-visible 407 reply: `Proxy-Authorization` is what the client must send. */
  const rejectUnauthorized = (res: http.ServerResponse): void => {
    res.writeHead(407, { "content-type": "text/plain", "proxy-authenticate": `Basic realm="anycode-relay"`, connection: "close" });
    res.end("anycode proxy relay: proxy authentication required\n");
  };

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Plain-HTTP absolute-URI proxying. Anything else (origin-form `GET /x`,
    // `*`) is not a forward-proxy request — refuse it before the credential
    // is attached to anything.
    if (req.url === undefined || !/^http:\/\//i.test(req.url)) {
      res.writeHead(400, { "content-type": "text/plain", connection: "close" });
      res.end("anycode proxy relay: absolute http:// request URI required\n");
      return;
    }
    // Taskana 4685 rework: auth gate BEFORE any upstream contact. Absent and
    // wrong `Proxy-Authorization` both answer 407 — children carry the token
    // as proxy-URL userinfo, which every proxy-aware client turns into this
    // header on plain HTTP and CONNECT alike.
    if (checkRelayAuthorization(req.headers["proxy-authorization"] as string | undefined, expectedAuthorization) !== "valid") {
      rejectUnauthorized(res);
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
    // Taskana 4685 rework: auth gate BEFORE the upstream dial, same rule as
    // plain HTTP. A wrong or absent token must never learn whether the
    // upstream is even up.
    if (checkRelayAuthorization(req.headers["proxy-authorization"] as string | undefined, expectedAuthorization) !== "valid") {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="anycode-relay"\r\n\r\n',
      );
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
 * The key a relay is cached under: the NORMALIZED credentialed upstream URL
 * — scheme, userinfo (as the URL parser canonicalises it), lowercased host,
 * port, with path/query/hash cleared (`http://u:p@Corp:8080` and
 * `http://u:p@corp:8080/` are ONE upstream with ONE relay). Taskana 4685
 * rework (blocker B2): one relay per upstream, never one per process — a
 * settings proxy profile and a shell proxy can be two DIFFERENT credentialed
 * upstreams at the same time, and every swap site must receive the relay of
 * the value IT named.
 */
export function relayRegistryKey(upstreamUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    return undefined;
  }
  if (url.username === "" && url.password === "") {
    return undefined;
  }
  url.hash = "";
  url.search = "";
  url.pathname = "";
  // `URL.toString()` appends the default "/" pathname for special schemes;
  // strip it so the key stays minimal and human-diffable.
  return url.toString().replace(/\/$/, "");
}

/**
 * Starts (or returns the already-started) loopback relay for ONE
 * credentialed upstream URL — the await-able half every boot path (core
 * host, desktop host, core CLI, desktop main's carrier materialisation)
 * calls. The registry is keyed by the normalized upstream (`relayRegistryKey`),
 * so a profile upstream and a shell upstream each get their OWN relay, lazily
 * started, closed by `closeProxyRelay()`.
 *
 *  - `undefined` when this upstream cannot be relayed: no userinfo (nothing
 *    to protect — TASK.135 passes those through verbatim), an https:///
 *    socks5:// upstream, a missing port, an unparseable URL, or a bind
 *    failure. Each keeps TASK.135's drop behaviour; for the cannot-serve
 *    case a single console.warn says so once per upstream (the card's
 *    "log once and fall back" rule).
 *  - Idempotent per upstream: the first successful call caches its relay and
 *    later calls for the SAME upstream return it; a REFUSED resolve is also
 *    remembered, so re-asks stay silent.
 *  - CONCURRENT calls for the same key share ONE in-flight promise
 *    (cross-review F1): the old check-then-await let two rapid resolves both
 *    bind, the second `relays.set` overwrote the first, and the overwritten
 *    listener leaked with the credential it fronts. The shared promise also
 *    means `closeProxyRelay()` mid-bind is observed by every waiter.
 */
export async function resolveProxyRelay(
  upstreamUrl: string,
): Promise<ProxyRelay | undefined> {
  const key = relayRegistryKey(upstreamUrl);
  if (key === undefined) {
    return undefined;
  }
  const existing = relays.get(key);
  if (existing !== undefined) {
    return existing;
  }
  if (refusedUpstreams.has(key)) {
    // Already refused in this process: keep TASK.135's drop behaviour
    // silently — the single warn below already said why, once.
    return undefined;
  }
  const inFlight = pendingResolves.get(key);
  if (inFlight !== undefined) {
    return inFlight;
  }
  // Cross-review F2: the registry generation this resolve started under. A
  // `closeProxyRelay()` while the bind is in flight bumps the generation and
  // clears the cache; a settle into the NEW generation must NOT register —
  // it closes its own relay instead, so shutdown is never undone by a late
  // `relays.set` and no listener outlives the process that minted it.
  const generation = registryGeneration;
  const attempt = (async (): Promise<ProxyRelay | undefined> => {
    const relay = await createProxyRelayAsync(upstreamUrl, {
      // Log once per upstream, and never include the offending URL: it carries
      // the very credential this whole module exists to contain.
      onRefuse: (reason) => {
        if (generation === registryGeneration) {
          refusedUpstreams.add(key);
        }
        console.warn(`[proxy-relay] credentialed proxy cannot be relayed (${reason}); children fall back to TASK.135's direct behaviour`);
      },
    });
    if (relay !== undefined && generation !== registryGeneration) {
      // Shutdown raced the bind: keep the registry empty (closeProxyRelay
      // already ran) and tear the freshly-bound listener down ourselves.
      relay.close();
      return relay;
    }
    if (relay !== undefined) {
      relays.set(key, relay);
    }
    return relay;
  })();
  pendingResolves.set(key, attempt);
  try {
    return await attempt;
  } finally {
    // The SETTLED promise leaves the in-flight map; the settled RESULT lives
    // on in `relays` (or `refusedUpstreams`) instead. A generation change
    // already cleared this entry — deleting it again is a harmless no-op.
    if (pendingResolves.get(key) === attempt) {
      pendingResolves.delete(key);
    }
  }
}

/** The per-upstream relay cache (`resolveProxyRelay` fills it lazily). */
const relays = new Map<string, ProxyRelay>();

/** The refuse memory behind "log once per upstream" (cross-review F2, keyed per upstream by B2). */
const refusedUpstreams = new Set<string>();

/**
 * In-flight `resolveProxyRelay` attempts per key (cross-review F1): the
 * check-then-await gap that let two concurrent resolves for one key both
 * bind. Cleared per key on settle and wholesale by `closeProxyRelay`.
 */
const pendingResolves = new Map<string, Promise<ProxyRelay | undefined>>();

/**
 * Cross-review F2: bumped by every `closeProxyRelay()`. A resolve that
 * settles into a generation it did not start under must not repopulate the
 * registry (and must close its own relay) — otherwise a shutdown racing a
 * bind left a credential-forwarding listener answering on 127.0.0.1 with no
 * owner and no path to teardown.
 */
let registryGeneration = 0;

/**
 * The relay URL for SYNC spawn sites (`buildChildEnv`'s third argument): the
 * URL of the relay for `upstreamUrl` when one is already up, `undefined`
 * otherwise. Reading is deliberately free of side effects — a spawn must
 * never start network machinery mid-build; the boot paths (and
 * `ensureProxyRelay` below) are the only starters. A shell proxy value is
 * the sync sites' upstream (main's carriers carry their own profile upstream
 * and materialise through the desktop-side `relayFor` dep instead).
 */
export function proxyRelayUrl(upstreamUrl?: string): string | undefined {
  if (upstreamUrl === undefined) {
    const first = relays.values().next();
    return first.done ? undefined : first.value.url;
  }
  const key = relayRegistryKey(upstreamUrl);
  return key === undefined ? undefined : relays.get(key)?.url;
}

/**
 * Taskana 4685 rework (blocker B2): the per-value lookup hand to
 * `buildChildEnv`/`sanitizeChildEnv` — resolves EACH credentialed value's
 * own relay from the already-started registry, so a swap never substitutes a
 * relay fronting a DIFFERENT upstream (distinct HTTP_PROXY vs HTTPS_PROXY
 * upstreams each keep their own path). Undefined for a value with no
 * started relay (fail-closed drop), and the whole lookup is undefined when
 * the registry is empty (nothing was prewarmed — byte-identical TASK.135
 * drop behaviour).
 */
export function proxyRelayLookup(): RelayUrlLookup | undefined {
  if (relays.size === 0 && refusedUpstreams.size === 0) {
    return undefined;
  }
  return (upstreamUrl: string): string | undefined => {
    const key = relayRegistryKey(upstreamUrl);
    return key === undefined ? undefined : relays.get(key)?.url;
  };
}

/**
 * Starts the relay for the FIRST credentialed proxy value in the host env on
 * the FIRST child spawn if no boot path did it yet — fire-and-forget, called
 * by `NodeExecutionAdapter`'s constructor-side spawn helpers and the desktop
 * PTY terminal, and safe to call on every spawn. The FIRST spawn under a
 * credentialed proxy may still see no relay (the bind is one macrotask
 * away), which is the same honest first-spawn window a `system` proxy
 * profile has. Callers that CAN await use `resolveProxyRelay`.
 */
export function ensureProxyRelay(): void {
  const upstreamUrl = credentialedProxyValue(process.env);
  if (upstreamUrl === undefined) {
    return;
  }
  const key = relayRegistryKey(upstreamUrl);
  if (key === undefined || relays.has(key) || refusedUpstreams.has(key)) {
    return;
  }
  // Float the promise: a bind failure must never surface as a rejection at a
  // spawn site. resolveProxyRelay never rejects by construction.
  void resolveProxyRelay(upstreamUrl).catch(() => {});
}

/** Tears down every cached relay and forgets them (idempotent; test seam + shutdown). Also clears the refuse memory so a later resolve genuinely re-attempts. */
export function closeProxyRelay(): void {
  for (const relay of relays.values()) {
    relay.close();
  }
  relays.clear();
  refusedUpstreams.clear();
  // Cross-review F2: a resolve whose bind is still in flight must observe
  // this shutdown when it settles — the generation bump is that signal, and
  // the pending map (F1) is dropped so a POST-close resolve for the same key
  // starts a fresh attempt instead of sharing the doomed one.
  registryGeneration += 1;
  pendingResolves.clear();
}

/**
 * Cross-review F3 (opus2): closes every registered relay whose registry key
 * is NOT in `referencedKeys` — the incremental half of `closeProxyRelay` for
 * long-lived hosts (desktop main). `prewarmProxyRelays` recomputes the set of
 * upstreams the CURRENT settings + boot env can materialise; a relay left
 * over from a PREVIOUS pass (a rotated profile password/url, a deleted
 * profile, an edited shell export) no longer has a consumer, but its
 * listener kept answering on 127.0.0.1 with the OLD credential attached to
 * every hop. Keys are matched through `relayRegistryKey` (the SAME
 * normalisation the registry caches under), so a caller that collected raw
 * upstream strings normalises identically. In-flight resolves (F1) are left
 * alone — their own generation check (F2) decides their fate.
 */
export function closeUnreferencedProxyRelays(referencedKeys: readonly string[]): void {
  const referenced = new Set(referencedKeys);
  for (const [key, relay] of relays) {
    if (!referenced.has(key)) {
      relay.close();
      relays.delete(key);
    }
  }
}

/**
 * The one proxy-family value in `env` that carries credentials — searched in
 * HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy order FIRST (the names a
 * child's tools apply with the strongest precedence), then across the REST of
 * the family `sanitizeChildEnv` drops (ALL_PROXY, npm_config_proxy, … —
 * cross-review F4). Returns the FIRST credentialed value, or undefined when
 * every present member is credential-free. Detection reuses the exact
 * TASK.135 rule: a literal `@` means userinfo — EXCEPT the relay URL's own
 * `anycode:<token>@` shape (cross-review F5a): the host env of a NESTED
 * anycode process (a CLI/host spawned as a Bash child of this one) inherits
 * the parent's relay URL as its HTTPS_PROXY, and relaying THAT would chain a
 * second relay in front of the parent's — the parent relay already owns the
 * credential, a relay-of-a-relay only adds a hop. Such values are skipped,
 * not returned.
 */
function credentialedProxyValue(env: NodeJS.ProcessEnv): string | undefined {
  return credentialedProxyValues(env, 1)[0];
}

/**
 * The plural boot scan (cross-review F5b): EVERY distinct credentialed
 * upstream in `env`, in the same family order the singular scan uses. A
 * shell with DIFFERENT credentialed HTTP_PROXY and HTTPS_PROXY upstreams
 * needs a relay for EACH (blocker B2: one relay per upstream), and the
 * first-only scan left the second upstream's children going direct behind an
 * authenticating proxy. Deduplicated by exact string (the registry key
 * normalises case/slash on its own); relay-shaped values are skipped exactly
 * as in the singular scan.
 */
export function credentialedProxyValuesForRelay(env: NodeJS.ProcessEnv): string[] {
  return credentialedProxyValues(env, Number.POSITIVE_INFINITY);
}

/** Shared body of the two scans above: up to `limit` distinct credentialed upstreams, relay-shaped values skipped. */
function credentialedProxyValues(env: NodeJS.ProcessEnv, limit: number): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const consider = (value: string | undefined): void => {
    if (found.length >= limit) {
      return;
    }
    if (typeof value !== "string" || !value.includes("@") || isRelayUrlShaped(value)) {
      return;
    }
    if (!seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
  };
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    consider(env[name]);
  }
  for (const [name, value] of Object.entries(env)) {
    if (name === "HTTPS_PROXY" || name === "https_proxy" || name === "HTTP_PROXY" || name === "http_proxy") {
      continue; // already scanned above
    }
    if (typeof value === "string" && isProxyVarName(name)) {
      consider(value);
    }
  }
  return found;
}

/**
 * True for a value SHAPED like one of this module's relay URLs
 * (`http://anycode:<token>@127.0.0.1:<port>`), regardless of whether THIS
 * process minted it (cross-review F5a). The scan-side skip is deliberately
 * shape-based, NOT registry-gated like `isCredentialFreeRelayUrl`: a nested
 * anycode's env holds the PARENT's relay URL — minted by another process, so
 * a registry check would MISS it — and fronting it with a second relay is
 * wrong regardless of who minted it. The user `anycode` and the loopback
 * host are ours alone (no real corporate proxy is `anycode@127.0.0.1`), so
 * the shape test is exact for this purpose.
 */
function isRelayUrlShaped(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.username === RELAY_URL_USER && url.password !== "";
}

/**
 * The boot-scan half `resolveProxyRelay` callers without a single named
 * upstream use (core CLI, core host, desktop host): the first credentialed
 * proxy value of `env`, whose relay the boot path then starts. Exported for
 * those boot paths; the registry itself stays keyed by the explicit upstream.
 */
export function credentialedProxyValueForRelay(env: NodeJS.ProcessEnv): string | undefined {
  return credentialedProxyValue(env);
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
        url: `${RELAY_SCHEME}://${RELAY_URL_USER}:${token}@${RELAY_HOST}:${address.port}`,
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

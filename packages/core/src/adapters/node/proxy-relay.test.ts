/**
 * TASK.135 / Taskana 4074 follow-up: unit suite for the credential-free
 * loopback proxy relay.
 *
 * The fake upstream is a plain node http server that (a) records the
 * `Proxy-Authorization` header of every request/CONNECT it receives and
 * (b) answers CONNECT with 200 and then echoes tunnel bytes back. The
 * fixture credential is `user:secret@` — the ONLY place the password may
 * appear is the upstream-side assertion (what the relay must SEND), never a
 * client-side or relay-URL observation.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import net from "node:net";
import {
  checkRelayToken,
  closeProxyRelay,
  createProxyRelayForTest,
  isLoopbackPeer,
  parseUpstreamProxyUrl,
  resolveProxyRelay,
  stripHopByHop,
} from "./proxy-relay.js";

/** Fixture credential — never asserted to appear anywhere client-side. */
const UPSTREAM_URL = "http://user:secret@127.0.0.1:1"; // port replaced per-test

interface RecordedAuth {
  connect: string[];
  request: string[];
}

/**
 * The fake upstream proxy: answers CONNECT 200 (then echoes), and GET with a
 * marker body. Records every Proxy-Authorization it saw.
 */
function startFakeUpstream(): Promise<{ server: http.Server; port: number; auth: RecordedAuth }> {
  const auth: RecordedAuth = { connect: [], request: [] };
  const server = http.createServer((req, res) => {
    auth.request.push(String(req.headers["proxy-authorization"] ?? ""));
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("UPSTREAM-GET-OK");
  });
  server.on("connect", (req, clientSocket, head) => {
    auth.connect.push(String(req.headers["proxy-authorization"] ?? ""));
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Echo server: whatever the tunnel carries comes straight back.
    clientSocket.write(head);
    clientSocket.pipe(clientSocket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake upstream failed to listen");
      }
      resolve({ server, port: address.port, auth });
    });
  });
}

/** The client-side CONNECT handshake against the relay, per the proxy contract. */
function connectThrough(
  port: number,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ socket: net.Socket; response: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let settled = false;
    socket.on("connect", () => {
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const headerEnd = all.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        settled = true;
        resolve({
          socket,
          response: all.subarray(0, headerEnd).toString("latin1"),
          rest: all.subarray(headerEnd + 4),
        });
      }
    });
    socket.on("error", reject);
  });
}

describe("parseUpstreamProxyUrl", () => {
  it("accepts a credentialed http:// URL with an explicit port", () => {
    const endpoint = parseUpstreamProxyUrl("http://user:secret@proxy.corp:3128");
    expect(endpoint).toBeDefined();
    expect(endpoint!.host).toBe("proxy.corp");
    expect(endpoint!.port).toBe(3128);
  });

  it("refuses credential-less, https, socks and port-less URLs", () => {
    expect(parseUpstreamProxyUrl("http://proxy.corp:3128")).toBeUndefined();
    expect(parseUpstreamProxyUrl("https://user:secret@proxy.corp:3128")).toBeUndefined();
    expect(parseUpstreamProxyUrl("socks5://user:secret@proxy.corp:1080")).toBeUndefined();
    expect(parseUpstreamProxyUrl("http://user:secret@proxy.corp")).toBeUndefined();
    expect(parseUpstreamProxyUrl("not a url")).toBeUndefined();
  });

  it("base64-encodes percent-decoded userinfo", () => {
    const endpoint = parseUpstreamProxyUrl("http://us%40er:p%40ss@proxy:3128")!;
    expect(endpoint.proxyAuthorization).toBe(`Basic ${Buffer.from("us@er:p@ss").toString("base64")}`);
  });

  // F1 repro: a URL-parser-canonicalised non-ASCII password (what every
  // `new URL(...)` round trip produces — `päss` becomes the UTF-8 bytes
  // `p%C3%A4ss`) must decode to the ORIGINAL string, not its bytes misread
  // as latin1 (the old safePercentDecode double-encoded them, so the relay
  // sent a wrong Proxy-Authorization and every upstream answered 407).
  it("F1 repro: UTF-8 (non-ASCII, emoji) userinfo yields the exact Basic credential", () => {
    const url = new URL("http://user:päss@proxy:3128").toString(); // password percent-encoded as UTF-8
    const endpoint = parseUpstreamProxyUrl(url)!;
    expect(endpoint.proxyAuthorization).toBe(`Basic ${Buffer.from("user:päss").toString("base64")}`);

    const emojiUrl = new URL("http://user:🔑@proxy:3128").toString();
    const emojiEndpoint = parseUpstreamProxyUrl(emojiUrl)!;
    expect(emojiEndpoint.proxyAuthorization).toBe(`Basic ${Buffer.from("user:🔑").toString("base64")}`);
  });
});

describe("checkRelayToken (Taskana 4685)", () => {
  it("triangulates header and path tokens", () => {
    expect(checkRelayToken("t", "/t", "t")).toBe("valid");
    expect(checkRelayToken("t", "/t/x", "t")).toBe("valid");
    expect(checkRelayToken(undefined, undefined, "t")).toBe("absent");
    expect(checkRelayToken("nope", undefined, "t")).toBe("wrong");
    // Header whitespace is trimmed.
    expect(checkRelayToken("  t  ", undefined, "t")).toBe("valid");
    // A wrong header with a non-matching path is "wrong"; a VALID path
    // shields a wrong header (the snippet's short-circuit: a correct path
    // token already proves knowledge of the token).
    expect(checkRelayToken("nope", "/t", "t")).toBe("valid");
    expect(checkRelayToken("nope", "/other", "t")).toBe("wrong");
    // Note (deviation from the brief's two rows): a header-less request with
    // a NON-matching path (`/other`, `/tprefix`) is "absent", not "wrong" —
    // the frozen 4074 rule that header-less curl/git/npm plain-HTTP requests
    // (absolute URI whose path is the TARGET's path, no proxy token) are
    // accepted. The `/t`-must-not-prefix-match-`/tprefix` property still
    // holds: `/tprefix` is absent, never "valid".
    expect(checkRelayToken(undefined, "/other", "t")).toBe("absent");
    expect(checkRelayToken(undefined, "/tprefix", "t")).toBe("absent");
  });
});

describe("isLoopbackPeer", () => {
  it("accepts loopback v4, v6 and v4-mapped forms only", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("127.0.0.99")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.42.0.3")).toBe(true);
    expect(isLoopbackPeer("10.0.0.1")).toBe(false);
    expect(isLoopbackPeer("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackPeer("192.168.1.5")).toBe(false);
    expect(isLoopbackPeer("fe80::1")).toBe(false);
    expect(isLoopbackPeer("::ffff:127.0.o.1")).toBe(false); // dotted-quad structure enforced
    expect(isLoopbackPeer(undefined)).toBe(false);
  });
});

describe("proxy relay (CONNECT + plain HTTP)", () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let cleanup: (() => void)[];

  afterEach(async () => {
    closeProxyRelay();
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
  });

  it("tunnels CONNECT through the upstream with the credential added, invisible to the client", async () => {
    upstream = await startFakeUpstream();
    cleanup = [
      () =>
        new Promise<void>((resolve) => {
          upstream.server.closeAllConnections();
          upstream.server.close(() => resolve());
          // A lingering keep-alive socket can hold close() open; resolve anyway.
          setTimeout(resolve, 200);
        }),
    ];
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    expect(relay).toBeDefined();
    cleanup.push(() => new Promise<void>((resolve) => { relay!.close(); resolve(); }));

    // The relay URL carries no userinfo — that is the whole point. Taskana
    // 4685: it ends with the per-relay token as a path segment.
    expect(relay!.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(relay!.url).toBe(`http://127.0.0.1:${relay!.port}/${relay!.token}`);
    expect(relay!.url).not.toContain("@");
    expect(relay!.url).not.toContain("secret");

    // A loopback client CONNECTs to an arbitrary target; the fake upstream
    // answers 200 and ECHOES the tunnel, so the client's own bytes come back.
    const { socket, response } = await connectThrough(relay!.port, "example.com:443");
    cleanup.push(() => new Promise<void>((resolve) => { socket.destroy(); resolve(); }));
    expect(response).toContain("200");
    // The echo round trip proves bytes flow client -> relay -> upstream ->
    // back; whatever the client sent traversed the full tunnel.
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.write("ping-through-tunnel");
    });
    expect(reply).toContain("ping-through-tunnel");

    // THE assertion: the upstream saw the exact Basic credential the relay holds.
    const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
    expect(upstream.auth.connect).toContain(expected);
  });

  it("passes a non-200 CONNECT answer from the upstream back to the client", async () => {
    // An upstream that always refuses CONNECT with 407.
    const seen: string[] = [];
    const refusing = http.createServer();
    refusing.on("connect", (req, clientSocket) => {
      seen.push(String(req.headers["proxy-authorization"] ?? ""));
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nX-Upstream: yes\r\n\r\n");
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const port = (refusing.address() as net.AddressInfo).port;
    upstream = { server: refusing, port, auth: { connect: seen, request: [] } };
    cleanup = [
      () => new Promise<void>((resolve) => {
        refusing.closeAllConnections();
        refusing.close(() => resolve());
      }),
    ];

    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${port}`);
    expect(relay).toBeDefined();
    cleanup.push(() => new Promise<void>((resolve) => { relay!.close(); resolve(); }));

    const { socket, response } = await connectThrough(relay!.port, "example.com:443");
    cleanup.push(() => new Promise<void>((resolve) => { socket.destroy(); resolve(); }));
    expect(response).toContain("407");
    expect(response).toContain("X-Upstream: yes");
  });

  it("forwards a plain HTTP absolute-URI request with Proxy-Authorization added", async () => {
    upstream = await startFakeUpstream();
    cleanup = [
      () => new Promise<void>((resolve) => {
        upstream.server.closeAllConnections();
        upstream.server.close(() => resolve());
      }),
    ];
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    expect(relay).toBeDefined();
    cleanup.push(() => new Promise<void>((resolve) => { relay!.close(); resolve(); }));

    // A plain request through the relay as an HTTP proxy.
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: relay!.port, path: "http://example.com/x", agent: false },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
    });
    expect(body).toBe("UPSTREAM-GET-OK");
    const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
    expect(upstream.auth.request).toContain(expected);
  });

  it("resolveProxyRelay: no relay without a credentialed proxy in the env; relay reused on the second call", async () => {
    const clean = { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.corp:3128" };
    const first = await resolveProxyRelay(clean);
    expect(first).toBeUndefined();

    const credentialed = { PATH: "/usr/bin", HTTPS_PROXY: "http://user:secret@127.0.0.1:9" };
    // Port 9 (discard) is closed on a dev box — the bind still succeeds; the
    // relay only fails to reach its upstream when a client actually connects,
    // which these assertions never do.
    const second = await resolveProxyRelay(credentialed);
    expect(second).toBeDefined();
    const third = await resolveProxyRelay(credentialed);
    expect(third).toBe(second); // idempotent: same handle
    expect(second!.url).not.toContain("secret");
    // Taskana 4685: the cached handle's URL ends with its token; after
    // closeProxyRelay a fresh resolve mints a NEW token.
    expect(second!.url).toBe(`http://127.0.0.1:${second!.port}/${second!.token}`);
    closeProxyRelay();
    const fresh = await resolveProxyRelay(credentialed);
    expect(fresh).toBeDefined();
    expect(fresh!.url).toBe(`http://127.0.0.1:${fresh!.port}/${fresh!.token}`);
    expect(fresh!.token).not.toBe(second!.token);
    fresh!.close();
  });

  it("Taskana 4685: plain HTTP with a WRONG token header gets 403 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: relay!.port,
            path: "http://example.com/x",
            headers: { "x-anycode-relay-token": "deadbeef" },
            agent: false,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
      });
      expect(status).toBe(403);
      expect(upstream.auth.request).toEqual([]);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("Taskana 4685: plain HTTP with the CORRECT token header passes through", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: relay!.port,
            path: "http://example.com/x",
            headers: { "x-anycode-relay-token": relay!.token },
            agent: false,
          },
          (res) => {
            let text = "";
            res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
            res.on("end", () => resolve(text));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("UPSTREAM-GET-OK");
      const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
      expect(upstream.auth.request).toContain(expected);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("Taskana 4685: plain HTTP with NO token header is accepted (frozen absent-accepted rule)", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: relay!.port, path: "http://example.com/x", agent: false },
          (res) => {
            let text = "";
            res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
            res.on("end", () => resolve(text));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("UPSTREAM-GET-OK");
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("Taskana 4685: CONNECT with a WRONG token header gets 403 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    let socket: net.Socket | undefined;
    try {
      const { socket: s, response } = await connectThrough(relay!.port, "example.com:443", {
        "x-anycode-relay-token": "deadbeef",
      });
      socket = s;
      expect(response).toContain("403");
      expect(upstream.auth.connect).toEqual([]);
    } finally {
      socket?.destroy();
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("Taskana 4685: CONNECT with the CORRECT token header tunnels through", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    let socket: net.Socket | undefined;
    try {
      const { socket: s, response } = await connectThrough(relay!.port, "example.com:443", {
        "x-anycode-relay-token": relay!.token,
      });
      socket = s;
      expect(response).toContain("200");
      const reply = await new Promise<string>((resolve) => {
        socket!.once("data", (chunk: Buffer) => resolve(chunk.toString()));
        socket!.write("ping-tokened-tunnel");
      });
      expect(reply).toContain("ping-tokened-tunnel");
      const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
      expect(upstream.auth.connect).toContain(expected);
    } finally {
      socket?.destroy();
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("refuses an https:// upstream (logs once, falls back to drop)", async () => {
    const relay = await resolveProxyRelay({ HTTPS_PROXY: "https://user:secret@proxy.corp:3128" });
    expect(relay).toBeUndefined();
  });

  // F4 repro: the scrub-side drop covers the WHOLE proxy family (ALL_PROXY,
  // npm_config_proxy, …) but the relay detection only scanned the four
  // HTTP(S)_PROXY names — a credentialed ALL_PROXY was silently dropped with
  // no relay and no warn, reproducing the exact breakage 4074 exists to fix
  // one variable name later. Both must now start a relay.
  it("F4 repro: a credentialed ALL_PROXY / npm_config_https_proxy also starts the relay", async () => {
    closeProxyRelay();
    const fromAllProxy = await resolveProxyRelay({ ALL_PROXY: "http://user:secret@127.0.0.1:9" });
    expect(fromAllProxy).toBeDefined();
    expect(fromAllProxy!.url).not.toContain("secret");
    closeProxyRelay();

    const fromNpm = await resolveProxyRelay({ npm_config_https_proxy: "http://user:secret@127.0.0.1:9" });
    expect(fromNpm).toBeDefined();
    closeProxyRelay();
  });

  // F2 repro: the card's "log once" contract. A refused upstream must warn
  // exactly once per process no matter how many spawn sites re-ask
  // (ensureProxyRelay fires on EVERY Bash/PTY spawn); closeProxyRelay() is
  // the documented re-arm seam. Asserted via console.warn spy — the warn is
  // the contract's user-visible surface.
  it("F2 repro: a refused upstream warns once per process across repeated resolves (re-armed by closeProxyRelay)", async () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => {
      warns.push(String(msg));
    };
    try {
      const env = { HTTPS_PROXY: "https://user:secret@proxy.corp:3128" } as NodeJS.ProcessEnv;
      for (let i = 0; i < 5; i += 1) {
        const relay = await resolveProxyRelay(env);
        expect(relay).toBeUndefined();
      }
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("unsupported_scheme");

      // closeProxyRelay() clears the refused state with the cache — a later
      // resolve re-attempts (and warns again exactly once for the new cycle).
      closeProxyRelay();
      const again = await resolveProxyRelay(env);
      expect(again).toBeUndefined();
      expect(warns).toHaveLength(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("proxy relay hardening (review follow-up)", () => {
  it("stripHopByHop drops hop-by-hop and Connection-named headers, keeps framing", () => {
    const out = stripHopByHop({
      connection: "keep-alive, x-secret-hop",
      "keep-alive": "timeout=5",
      "proxy-connection": "keep-alive",
      "proxy-authorization": "Basic client-supplied",
      upgrade: "websocket",
      te: "trailers",
      trailer: "x-checksum", // cross-review F7 triage: Trailer IS stripped — no dangling trailer promise post-relay
      "x-secret-hop": "1",
      "transfer-encoding": "chunked",
      "content-type": "text/plain",
      host: "example.com",
    });
    expect(out).toEqual({ "transfer-encoding": "chunked", "content-type": "text/plain", host: "example.com" });
  });

  it("refuses an origin-form request with 400 and never contacts the upstream", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: relay!.port, path: "/x", agent: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
      });
      expect(status).toBe(400);
      expect(upstream.auth.request).toEqual([]);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("close() tears down a live CONNECT tunnel on both sides", async () => {
    const upstream = await startFakeUpstream();
    const upstreamSockets: net.Socket[] = [];
    upstream.server.on("connect", (_req, socket: net.Socket) => upstreamSockets.push(socket));
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    const { socket } = await connectThrough(relay!.port, "example.com:443");
    try {
      const clientClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      const upstreamClosed = new Promise<void>((resolve) => upstreamSockets[0]!.once("close", () => resolve()));
      relay!.close();
      await Promise.all([clientClosed, upstreamClosed]);
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  // F8(a): an upstream whose CONNECT reply never terminates its header block
  // must not grow relay memory unboundedly — past the 16 KiB cap the client
  // gets a 502 and both sides are torn down.
  it("a never-terminated CONNECT reply header is cut off at the 16 KiB cap with a 502", async () => {
    const rambling = http.createServer();
    rambling.on("connect", (_req, socket: net.Socket) => {
      // Header bytes forever, never a \r\n\r\n.
      const interval = setInterval(() => {
        try {
          if (socket.writable) {
            socket.write("X-More: " + "b".repeat(1024) + "\r\n");
          } else {
            clearInterval(interval);
          }
        } catch {
          clearInterval(interval); // EPIPE after the relay tore its side down
        }
      }, 5);
      socket.on("close", () => clearInterval(interval));
      socket.on("error", () => clearInterval(interval));
      socket.write("HTTP/1.1 999 Never Finishing\r\nX-Filler: " + "a".repeat(64) + "\r\n");
    });
    await new Promise<void>((resolve) => rambling.listen(0, "127.0.0.1", resolve));
    const ramblingPort = (rambling.address() as net.AddressInfo).port;
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${ramblingPort}`);
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(relay!.port, "127.0.0.1");
        const chunks: Buffer[] = [];
        socket.on("connect", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
        socket.on("error", reject);
        // Safety net: never hang the suite on a regression that neither 502s nor closes.
        setTimeout(() => {
          socket.destroy();
          resolve(Buffer.concat(chunks).toString("latin1"));
        }, 5000);
      });
      expect(response).toContain("502");
      expect(response).not.toContain("999");
    } finally {
      relay!.close();
      rambling.closeAllConnections();
      rambling.close();
    }
  });

  // F8(c): a CONNECT refusal that carries body bytes must pass them through
  // verbatim alongside the status line and headers.
  it("a non-200 CONNECT answer with body bytes relays the body too", async () => {
    const refusing = http.createServer();
    refusing.on("connect", (_req, socket: net.Socket) => {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nX-Upstream: yes\r\n\r\ncredentials-rejected");
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const port = (refusing.address() as net.AddressInfo).port;
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${port}`);
    try {
      const { socket, response, rest } = await connectThrough(relay!.port, "example.com:443");
      // The refusal body may arrive with the header chunk (rest) or as the
      // next data event; collect whatever follows the header block.
      const body = await new Promise<string>((resolve) => {
        if (rest.length > 0) {
          resolve(rest.toString());
          return;
        }
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
        socket.once("close", () => resolve(""));
      });
      expect(response).toContain("407");
      expect(body).toContain("credentials-rejected");
      socket.destroy();
    } finally {
      relay!.close();
      refusing.closeAllConnections();
      refusing.close();
    }
  });

  // F8(e): the smuggling property that matters most — a client-supplied
  // Proxy-Authorization must never ride along to (or override the relay's
  // credential at) the upstream. The upstream sees ONLY the relay's value.
  it("strips a client-supplied Proxy-Authorization end-to-end (the relay's credential is the only one upstream)", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: relay!.port,
            path: "http://example.com/x",
            agent: false,
            headers: { "proxy-authorization": "Basic Y2xpZW50LWZvcmdlZA==" }, // client-forged
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve("done"));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("done");
      const expected = `Basic ${Buffer.from("user:secret").toString("base64")}`;
      expect(upstream.auth.request).toEqual([expected]); // exactly one, and it is the relay's
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  // F1 end-to-end companion: the exact-UTF-8 credential parse fix, exercised
  // through a LIVE relay — the fake upstream must see the base64 of the
  // original password, not the double-encoded bytes.
  it("sends the exact UTF-8 Basic credential upstream through a live relay (F1 e2e)", async () => {
    const upstream = await startFakeUpstream();
    const encoded = new URL(`http://user:päss@127.0.0.1:${upstream.port}`).toString();
    const relay = await createProxyRelayForTest(encoded);
    try {
      const { socket, response } = await connectThrough(relay!.port, "example.com:443");
      expect(response).toContain("200");
      socket.destroy();
      const expected = `Basic ${Buffer.from("user:päss", "utf8").toString("base64")}`;
      expect(upstream.auth.connect).toEqual([expected]);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });
});

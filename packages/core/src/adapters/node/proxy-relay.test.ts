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
  checkRelayAuthorization,
  closeProxyRelay,
  credentialedProxyValueForRelay,
  createProxyRelayForTest,
  isLoopbackPeer,
  parseUpstreamProxyUrl,
  relayRegistryKey,
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

/** The `Proxy-Authorization: Basic base64(anycode:<token>)` the relay's gate requires. */
function relayProxyAuth(token: string): string {
  return `Basic ${Buffer.from(`anycode:${token}`).toString("base64")}`;
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

describe("checkRelayAuthorization (Taskana 4685 rework — blocker B1)", () => {
  const expected = `Basic ${Buffer.from(`anycode:t`).toString("base64")}`;

  it("B1: a request with NO Proxy-Authorization is `absent` — rejected, never accepted", () => {
    expect(checkRelayAuthorization(undefined, expected)).toBe("absent");
    expect(checkRelayAuthorization("", expected)).toBe("absent");
    expect(checkRelayAuthorization("   ", expected)).toBe("absent");
  });

  it("B1: a WRONG value is `wrong`; the RIGHT value is `valid` (whitespace trimmed)", () => {
    expect(checkRelayAuthorization("Basic bm90LXRoZS1ub3Jt", expected)).toBe("wrong");
    expect(checkRelayAuthorization(expected, expected)).toBe("valid");
    expect(checkRelayAuthorization(`  ${expected}  `, expected)).toBe("valid");
  });

  it("relayRegistryKey: one key per normalized upstream; credential-less values have none (B2)", () => {
    expect(relayRegistryKey("http://u:p@Corp:8080")).toBe("http://u:p@corp:8080");
    expect(relayRegistryKey("http://u:p@corp:8080/")).toBe("http://u:p@corp:8080");
    expect(relayRegistryKey("http://u:p@corp:8080/path?q=1#f")).toBe("http://u:p@corp:8080");
    expect(relayRegistryKey("http://corp:8080")).toBeUndefined();
    expect(relayRegistryKey("not a url")).toBeUndefined();
    // A DIFFERENT credential is a DIFFERENT upstream (its own relay) — even
    // at the same host:port.
    expect(relayRegistryKey("http://u:p2@corp:8080")).not.toBe(relayRegistryKey("http://u:p@corp:8080"));
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

    // Taskana 4685 rework: the relay URL carries the token as USERINFO
    // (`http://anycode:<token>@127.0.0.1:<port>`) — curl/git/npm/undici all
    // turn this into the Proxy-Authorization the gate below requires. The
    // upstream password ("secret") appears NOWHERE in it.
    expect(relay!.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(relay!.url).toBe(`http://anycode:${relay!.token}@127.0.0.1:${relay!.port}`);
    expect(relay!.url).not.toContain("secret");

    // A loopback client CONNECTs to an arbitrary target (presenting the
    // relay's own Proxy-Authorization, exactly as proxy-URL userinfo makes
    // every real client do); the fake upstream answers 200 and ECHOES the
    // tunnel, so the client's own bytes come back.
    const { socket, response } = await connectThrough(relay!.port, "example.com:443", {
      "proxy-authorization": relayProxyAuth(relay!.token),
    });
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

    const { socket, response } = await connectThrough(relay!.port, "example.com:443", {
      "proxy-authorization": relayProxyAuth(relay!.token),
    });
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

    // A plain request through the relay as an HTTP proxy, presenting the
    // relay's own Proxy-Authorization (what proxy-URL userinfo produces).
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: relay!.port,
          path: "http://example.com/x",
          agent: false,
          headers: { "proxy-authorization": relayProxyAuth(relay!.token) },
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
  });

  it("B2: resolveProxyRelay is keyed per upstream — two upstreams get TWO relays, one upstream is reused", async () => {
    // A credential-less value names no upstream: no relay (TASK.135 passthrough).
    expect(await resolveProxyRelay("http://proxy.corp:3128")).toBeUndefined();
    // Port 9 (discard) is closed on a dev box — the bind still succeeds; the
    // relay only fails to reach its upstream when a client actually connects,
    // which these assertions never do.
    const upstreamA = "http://user:secret@127.0.0.1:9";
    const upstreamB = "http://user:other@127.0.0.1:9";
    const a1 = await resolveProxyRelay(upstreamA);
    expect(a1).toBeDefined();
    const a2 = await resolveProxyRelay(upstreamA);
    expect(a2).toBe(a1); // idempotent per upstream: same handle
    const b = await resolveProxyRelay(upstreamB);
    expect(b).toBeDefined();
    expect(b).not.toBe(a1); // a DIFFERENT upstream is a DIFFERENT relay
    expect(a1!.url).not.toBe(b!.url);
    expect(a1!.token).not.toBe(b!.token);
    // The registry key normalizes: same upstream modulo case/slash reuses.
    const a3 = await resolveProxyRelay("http://user:secret@127.0.0.1:9/");
    expect(a3).toBe(a1);
    // The URL carries the per-relay token as userinfo, never the password.
    expect(a1!.url).toBe(`http://anycode:${a1!.token}@127.0.0.1:${a1!.port}`);
    expect(a1!.url).not.toContain("secret");
    expect(b!.url).not.toContain("other");
    // closeProxyRelay tears down EVERY registered relay; a fresh resolve
    // mints a NEW token.
    closeProxyRelay();
    const fresh = await resolveProxyRelay(upstreamA);
    expect(fresh).toBeDefined();
    expect(fresh!.url).toBe(`http://anycode:${fresh!.token}@127.0.0.1:${fresh!.port}`);
    expect(fresh!.token).not.toBe(a1!.token);
    fresh!.close();
  });

  // ── Taskana 4685 rework (blocker B1): the auth gate matrix. No token and a
  // wrong token are BOTH rejected with 407, on plain HTTP and CONNECT alike,
  // before any upstream contact; the right token passes both. The token is
  // never printed or logged — the assertions only ever see status codes and
  // bodies (spy below).
  it("B1: plain HTTP with NO Proxy-Authorization gets 407 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: relay!.port, path: "http://example.com/x", agent: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
      });
      expect(status).toBe(407);
      expect(upstream.auth.request).toEqual([]);
      // B1: the token never reaches a log line (nor anywhere else client-visible).
      for (const line of warns) {
        expect(line).not.toContain(relay!.token);
      }
    } finally {
      console.warn = originalWarn;
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("B1: plain HTTP with a WRONG Proxy-Authorization gets 407 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port: relay!.port,
            path: "http://example.com/x",
            agent: false,
            headers: { "proxy-authorization": "Basic ZGVhZGJlZWY6bm90LXRoZS10b2tlbg==" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
      });
      expect(status).toBe(407);
      expect(upstream.auth.request).toEqual([]);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("B1: plain HTTP with the CORRECT Proxy-Authorization (relay-URL userinfo) passes through", async () => {
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
            headers: { "proxy-authorization": relayProxyAuth(relay!.token) },
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

  it("B1: CONNECT with NO Proxy-Authorization gets 407 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    let socket: net.Socket | undefined;
    try {
      const { socket: s, response } = await connectThrough(relay!.port, "example.com:443");
      socket = s;
      expect(response).toContain("407");
      expect(upstream.auth.connect).toEqual([]);
    } finally {
      socket?.destroy();
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("B1: CONNECT with a WRONG Proxy-Authorization gets 407 and the upstream is never contacted", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    let socket: net.Socket | undefined;
    try {
      const { socket: s, response } = await connectThrough(relay!.port, "example.com:443", {
        "proxy-authorization": "Basic d3Jvbmc6d3Jvbmc=",
      });
      socket = s;
      expect(response).toContain("407");
      expect(upstream.auth.connect).toEqual([]);
    } finally {
      socket?.destroy();
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("B1: CONNECT with the CORRECT Proxy-Authorization tunnels through", async () => {
    const upstream = await startFakeUpstream();
    const relay = await createProxyRelayForTest(`http://user:secret@127.0.0.1:${upstream.port}`);
    let socket: net.Socket | undefined;
    try {
      const { socket: s, response } = await connectThrough(relay!.port, "example.com:443", {
        "proxy-authorization": relayProxyAuth(relay!.token),
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

  it("B1: a client-sent x-anycode-relay-token header is dropped, never forwarded upstream", async () => {
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
            headers: {
              "proxy-authorization": relayProxyAuth(relay!.token),
              "x-anycode-relay-token": "smuggled-value",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve("done"));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("done");
      // The fake upstream records only proxy-authorization; to prove the
      // anycode header was dropped we assert via stripHopByHop plus the fact
      // the request SUCCEEDED (a forwarded unknown header would still pass,
      // so the strip unit test below carries the precise assertion).
      expect(upstream.auth.request.length).toBe(1);
    } finally {
      relay!.close();
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
  });

  it("refuses an https:// upstream (logs once, falls back to drop)", async () => {
    const relay = await resolveProxyRelay("https://user:secret@proxy.corp:3128");
    expect(relay).toBeUndefined();
  });

  // F4 repro: the scrub-side drop covers the WHOLE proxy family (ALL_PROXY,
  // npm_config_proxy, …) but the relay detection only scanned the four
  // HTTP(S)_PROXY names — a credentialed ALL_PROXY was silently dropped with
  // no relay and no warn, reproducing the exact breakage 4074 exists to fix
  // one variable name later. Both must now start a relay.
  it("F4 repro: the boot scan finds a credentialed ALL_PROXY / npm_config_https_proxy too", async () => {
    closeProxyRelay();
    const fromAllProxy = await resolveProxyRelay(credentialedProxyValueForRelay({ ALL_PROXY: "http://user:secret@127.0.0.1:9" })!);
    expect(fromAllProxy).toBeDefined();
    expect(fromAllProxy!.url).not.toContain("secret");
    closeProxyRelay();

    const fromNpm = await resolveProxyRelay(credentialedProxyValueForRelay({ npm_config_https_proxy: "http://user:secret@127.0.0.1:9" })!);
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
      const upstream = "https://user:secret@proxy.corp:3128";
      for (let i = 0; i < 5; i += 1) {
        const relay = await resolveProxyRelay(upstream);
        expect(relay).toBeUndefined();
      }
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("unsupported_scheme");

      // closeProxyRelay() clears the refused state with the cache — a later
      // resolve re-attempts (and warns again exactly once for the new cycle).
      closeProxyRelay();
      const again = await resolveProxyRelay(upstream);
      expect(again).toBeUndefined();
      expect(warns).toHaveLength(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// B2 companion: the refuse memory is PER UPSTREAM — a refused https://
// upstream does not silence the warn for a different, relayable one.
describe("refuse memory per upstream (Taskana 4685 rework B2)", () => {
  it("two refused upstreams each warn once; a refused key never blocks a different upstream", async () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
      const refused = "https://user:secret@proxy.corp:3128";
      expect(await resolveProxyRelay(refused)).toBeUndefined();
      expect(await resolveProxyRelay(refused)).toBeUndefined();
      expect(warns).toHaveLength(1); // once for THIS upstream
      const refused2 = "https://user:secret@other.corp:3128";
      expect(await resolveProxyRelay(refused2)).toBeUndefined();
      expect(warns).toHaveLength(2); // a different upstream warns again
      const ok = await resolveProxyRelay("http://user:secret@127.0.0.1:9");
      expect(ok).toBeDefined(); // unaffected by the refused keys
      ok!.close();
    } finally {
      console.warn = originalWarn;
      closeProxyRelay();
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
      "x-anycode-relay-token": "client-smuggled", // Taskana 4685 rework: retired header, dropped outright
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
    const { socket } = await connectThrough(relay!.port, "example.com:443", {
      "proxy-authorization": relayProxyAuth(relay!.token),
    });
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
        socket.on("connect", () =>
          socket.write(
            `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${relayProxyAuth(relay!.token)}\r\n\r\n`,
          ),
        );
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
      const { socket, response, rest } = await connectThrough(relay!.port, "example.com:443", {
        "proxy-authorization": relayProxyAuth(relay!.token),
      });
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

  // F8(e): the smuggling property that matters most — the upstream sees ONLY
  // the relay's credential. Since the 4685 rework gate a client MUST present
  // the relay's own token to get past the 407, and the relay OVERWRITES
  // `proxy-authorization` with the upstream credential before forwarding, a
  // client-crafted value can never ride along (a different value is 407-gated
  // before any upstream contact — see the B1 matrix above).
  it("the relay's credential is the only one upstream (client auth never forwards)", async () => {
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
            headers: { "proxy-authorization": relayProxyAuth(relay!.token) },
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
      const { socket, response } = await connectThrough(relay!.port, "example.com:443", {
        "proxy-authorization": relayProxyAuth(relay!.token),
      });
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

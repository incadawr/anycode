/**
 * NodeHttpAdapter tests run against a real local http.Server (loopback only —
 * no network I/O leaves the machine): status/contentType/finalUrl capture,
 * redirect-following, the maxBytes streaming cap, and timeout/abort handling.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeHttpAdapter } from "./node-http.js";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: RequestHandler): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("NodeHttpAdapter", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it("captures status, contentType, finalUrl and body", async () => {
    const listening = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("hello world");
    });
    server = listening.server;

    const adapter = new NodeHttpAdapter();
    const result = await adapter.fetchText({ url: listening.url, timeoutMs: 5000, maxBytes: 1_000_000 });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/plain; charset=utf-8");
    expect(result.finalUrl).toBe(`${listening.url}/`);
    expect(result.body).toBe("hello world");
    expect(result.truncated).toBe(false);
  });

  it("follows redirects and reports the final URL", async () => {
    const listening = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/landed" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("landed page");
    });
    server = listening.server;

    const adapter = new NodeHttpAdapter();
    const result = await adapter.fetchText({
      url: `${listening.url}/start`,
      timeoutMs: 5000,
      maxBytes: 1_000_000,
    });

    expect(result.finalUrl).toBe(`${listening.url}/landed`);
    expect(result.body).toBe("landed page");
  });

  it("caps the body at maxBytes and sets truncated without buffering past it", async () => {
    const bigBody = "y".repeat(50_000);
    const listening = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(bigBody);
    });
    server = listening.server;

    const adapter = new NodeHttpAdapter();
    const result = await adapter.fetchText({ url: listening.url, timeoutMs: 5000, maxBytes: 100 });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body, "utf-8")).toBeLessThanOrEqual(100);
  });

  it(
    "rejects when the server exceeds the timeout",
    async () => {
      const listening = await listen((_req, res) => {
        setTimeout(() => {
          res.writeHead(200);
          res.end("too late");
        }, 2000);
      });
      server = listening.server;

      const adapter = new NodeHttpAdapter();
      await expect(
        adapter.fetchText({ url: listening.url, timeoutMs: 100, maxBytes: 1_000 }),
      ).rejects.toThrow();
    },
    10_000,
  );

  it("rejects immediately when the caller's abortSignal is already aborted", async () => {
    const listening = await listen((_req, res) => {
      res.writeHead(200);
      res.end("should not be read");
    });
    server = listening.server;

    const controller = new AbortController();
    controller.abort();

    const adapter = new NodeHttpAdapter();
    await expect(
      adapter.fetchText({
        url: listening.url,
        timeoutMs: 5000,
        maxBytes: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

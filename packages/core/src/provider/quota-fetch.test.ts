/**
 * Tests for wrapFetchWithQuota (Taskana 4090 / TASK.71, §3 test 2).
 * Real node:http loopback server (pattern: apps/desktop provider-ipc.test.ts)
 * returning fixture headers — no external network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaUpdate } from "./quota.js";
import { wrapFetchWithQuota } from "./quota-fetch.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("wrapFetchWithQuota", () => {
  it("passes the response through untouched (body byte-identical) and fires the callback with the parsed update", async () => {
    const body = JSON.stringify({ ok: true, nested: "payload" });
    const origin = await listen((req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "20",
        "x-ratelimit-requests-reset": "1789999999",
      });
      res.end(body);
    });

    const seen: Array<{ update: ProviderQuotaUpdate | null; baseUrl: string }> = [];
    const wrapped = wrapFetchWithQuota(fetch, (update, baseUrl) => seen.push({ update, baseUrl }), "http://base.example");

    const res = await wrapped(`${origin}/v1/messages`, { method: "POST", body: "request-body" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body); // byte-identical passthrough

    expect(seen).toHaveLength(1);
    expect(seen[0]!.baseUrl).toBe("http://base.example");
    expect(seen[0]!.update).toEqual({
      primary: { usedPercent: 80, resetsAt: 1_789_999_999 },
      primarySource: "x-ratelimit-requests-limit",
      sources: ["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining", "x-ratelimit-requests-reset"],
    });
  });

  it("swallows a callback throw — the response still resolves", async () => {
    const origin = await listen((req, res) => {
      res.writeHead(200, { "x-ratelimit-requests-limit": "10", "x-ratelimit-requests-remaining": "1" });
      res.end("ok");
    });
    const onQuota = vi.fn(() => {
      throw new Error("observer exploded");
    });
    const wrapped = wrapFetchWithQuota(fetch, onQuota, "http://base.example");
    const res = await wrapped(origin);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(onQuota).toHaveBeenCalledTimes(1);
  });

  it("forwards init verbatim (method/headers/signal)", async () => {
    const body = "init-forwarded";
    let received: { method?: string; authorization?: string; contentType?: string } = {};
    const origin = await listen((req, res) => {
      received = {
        method: req.method,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
      };
      res.writeHead(200, { "x-ratelimit-requests-limit": "5", "x-ratelimit-requests-remaining": "4" });
      res.end(body);
    });

    const seen: ProviderQuotaUpdate[] = [];
    const wrapped = wrapFetchWithQuota(
      fetch,
      (update) => {
        if (update !== null) seen.push(update);
      },
      "http://base.example",
    );

    const controller = new AbortController();
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: '{"ping":1}',
      signal: controller.signal,
    };
    const res = await wrapped(`${origin}/v1/chat/completions`, init);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);

    expect(received.method).toBe("POST");
    expect(received.authorization).toBe("Bearer test-key");
    expect(received.contentType).toBe("application/json");
    expect(seen[0]?.primary).toEqual({ usedPercent: 20 });
  });

  it("reports null to the callback when the response carries no quota headers", async () => {
    const origin = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain");
    });
    const seen: Array<ProviderQuotaUpdate | null> = [];
    const wrapped = wrapFetchWithQuota(fetch, (update) => seen.push(update), "http://base.example");
    await wrapped(origin);
    expect(seen).toEqual([null]);
  });
});

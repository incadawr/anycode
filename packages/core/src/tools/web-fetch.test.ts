/**
 * WebFetch tests use a mock HttpPort (no real network I/O): cap/truncated,
 * cache-hit, content-type-driven HTML conversion, and the SSRF guard list
 * (each rejected case must never reach the mock's fetchText).
 */

import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import type { HttpPort, HttpTextRequest, HttpTextResponse } from "../ports/http.js";
import { webFetchTool } from "./web-fetch.js";

class MockHttpPort implements HttpPort {
  calls: HttpTextRequest[] = [];
  private queue: HttpTextResponse[];

  constructor(...responses: HttpTextResponse[]) {
    this.queue = [...responses];
  }

  async fetchText(req: HttpTextRequest): Promise<HttpTextResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error("MockHttpPort: no more queued responses");
    return next;
  }
}

function response(overrides: Partial<HttpTextResponse> = {}): HttpTextResponse {
  return {
    status: 200,
    statusText: "OK",
    finalUrl: "https://example.com/page",
    contentType: "text/html; charset=utf-8",
    body: "<html><body><h1>Hello</h1><p>World</p></body></html>",
    truncated: false,
    ...overrides,
  };
}

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxWithHttp(http: HttpPort): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/tmp",
    ports: { fs, exec, http, todos: new InMemoryTodoStore() },
  };
}

describe("webFetchTool", () => {
  it("converts HTML to text and prefixes the output with the question", async () => {
    const mock = new MockHttpPort(response());

    const result = await webFetchTool.handler(
      { url: "https://example.com/wf-basic", prompt: "what does this page say?" },
      ctxWithHttp(mock),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.content.startsWith("question: what does this page say?")).toBe(true);
    // html-to-text uppercases <h1> by default; match case-insensitively.
    expect(result.output?.content).toMatch(/hello/i);
    expect(result.output?.content).toContain("World");
    expect(result.output?.status).toBe(200);
    expect(result.output?.contentType).toBe("text/html; charset=utf-8");
    expect(result.output?.finalUrl).toBe("https://example.com/page");
    expect(result.output?.cacheHit).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  it("passes non-HTML content through unconverted", async () => {
    const mock = new MockHttpPort(
      response({ contentType: "application/json", body: '{"ok":true}' }),
    );

    const result = await webFetchTool.handler(
      { url: "https://example.com/wf-json", prompt: "is ok true?" },
      ctxWithHttp(mock),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.content).toContain('{"ok":true}');
  });

  it("propagates HttpPort truncation into the output", async () => {
    const mock = new MockHttpPort(response({ truncated: true, body: "short body" }));

    const result = await webFetchTool.handler(
      { url: "https://example.com/wf-http-truncated", prompt: "q" },
      ctxWithHttp(mock),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.truncated).toBe(true);
  });

  it("caps output at maxOutputBytes (100000) and sets truncated", async () => {
    const bigBody = "x".repeat(150_000);
    const mock = new MockHttpPort(response({ contentType: "text/plain", body: bigBody, truncated: false }));

    const result = await webFetchTool.handler(
      { url: "https://example.com/wf-big", prompt: "q" },
      ctxWithHttp(mock),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.truncated).toBe(true);
    expect(Buffer.byteLength(result.output?.content ?? "", "utf-8")).toBeLessThanOrEqual(100_000);
  });

  it("caches by URL: a second fetch of the same URL is a cache hit and does not re-call HttpPort", async () => {
    const mock = new MockHttpPort(response({ body: "<p>cached content</p>" }));
    const url = "https://example.com/wf-cache";

    const first = await webFetchTool.handler({ url, prompt: "q1" }, ctxWithHttp(mock));
    expect(first.output?.cacheHit).toBe(false);
    expect(mock.calls).toHaveLength(1);

    const second = await webFetchTool.handler({ url, prompt: "q2 (different prompt, same url)" }, ctxWithHttp(mock));
    expect(second.output?.cacheHit).toBe(true);
    expect(mock.calls).toHaveLength(1); // no additional network call
    expect(second.output?.content).toContain("cached content");
    expect(second.output?.content.startsWith("question: q2")).toBe(true);
  });

  describe("SSRF guards — rejected before any request is made", () => {
    const cases: Array<{ label: string; url: string }> = [
      { label: "file: protocol", url: "file:///etc/passwd" },
      { label: "ftp: protocol", url: "ftp://example.com/file" },
      { label: "userinfo in URL", url: "https://user:pass@example.com/" },
      { label: "localhost hostname", url: "http://localhost:8080/" },
      { label: "*.localhost hostname", url: "http://foo.localhost/" },
      { label: "loopback IPv4", url: "http://127.0.0.1/" },
      { label: "IPv4 0.0.0.0", url: "http://0.0.0.0/" },
      { label: "RFC1918 10.x", url: "http://10.0.0.5/" },
      { label: "RFC1918 172.16-31.x", url: "http://172.20.3.4/" },
      { label: "RFC1918 192.168.x", url: "http://192.168.1.1/" },
      { label: "link-local 169.254.x (cloud metadata)", url: "http://169.254.169.254/latest/meta-data" },
      { label: "IPv6 loopback ::1", url: "http://[::1]/" },
      { label: "IPv6 link-local fe80::", url: "http://[fe80::1]/" },
      { label: "IPv6 unique-local fc00::", url: "http://[fc00::1]/" },
      { label: "IPv4-mapped IPv6 loopback", url: "http://[::ffff:127.0.0.1]/" },
    ];

    for (const { label, url } of cases) {
      it(`rejects ${label}`, async () => {
        const mock = new MockHttpPort(response());

        const result = await webFetchTool.handler({ url, prompt: "q" }, ctxWithHttp(mock));

        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
        expect(mock.calls).toHaveLength(0);
      });
    }

    it("allows a normal public https URL through the guard", async () => {
      const mock = new MockHttpPort(response());

      const result = await webFetchTool.handler(
        { url: "https://example.com/wf-public", prompt: "q" },
        ctxWithHttp(mock),
      );

      expect(result.ok).toBe(true);
      expect(mock.calls).toHaveLength(1);
    });
  });

  it("returns an error outcome (not a throw) when HttpPort rejects", async () => {
    const failing: HttpPort = {
      fetchText: () => Promise.reject(new Error("network unreachable")),
    };

    const result = await webFetchTool.handler(
      { url: "https://example.com/wf-fail", prompt: "q" },
      ctxWithHttp(failing),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network unreachable");
  });
});

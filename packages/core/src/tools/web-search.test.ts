/**
 * WebSearch tool tests use a mock HttpPort (no real network I/O) exercised
 * against the real Wave-A buildSearchUrl/parseSearchResults (websearch/*),
 * so these also double as an integration check of the tool <-> websearch
 * contract. MockHttpPort idiom mirrors web-fetch.test.ts. Every error path is
 * probed for the API key leaking into model-visible text (design

 */

import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import type { HttpPort, HttpTextRequest, HttpTextResponse } from "../ports/http.js";
import type { ResolvedWebSearchBackend } from "../websearch/index.js";
import { WEBSEARCH_SNIPPET_MAX_CHARS } from "../types/config.js";
import { createWebSearchTool } from "./web-search.js";

const SECRET_KEY = "brave-secret-key-abc123";

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

function braveBody(results: Array<{ title: string; url: string; description: string }>): string {
  return JSON.stringify({ web: { results } });
}

function response(overrides: Partial<HttpTextResponse> = {}): HttpTextResponse {
  return {
    status: 200,
    statusText: "OK",
    finalUrl: "https://api.search.brave.com/res/v1/web/search?q=test",
    contentType: "application/json",
    body: braveBody([
      { title: "Result One", url: "https://example.com/1", description: "First snippet" },
      { title: "Result Two", url: "https://example.com/2", description: "Second snippet" },
    ]),
    truncated: false,
    ...overrides,
  };
}

function braveBackend(overrides: Partial<ResolvedWebSearchBackend> = {}): ResolvedWebSearchBackend {
  return {
    kind: "brave",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    headers: { "X-Subscription-Token": SECRET_KEY, Accept: "application/json" },
    maxResults: 5,
    ...overrides,
  };
}

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxWithHttp(http: HttpPort, abortSignal?: AbortSignal): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: abortSignal ?? new AbortController().signal,
    cwd: "/tmp",
    ports: { fs, exec, http, todos: new InMemoryTodoStore() },
  };
}

/** Fails the assertion if the API key surfaces anywhere in the tool's result. */
function assertNoKeyLeak(result: unknown): void {
  expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
}

describe("createWebSearchTool", () => {
  it("returns parsed results and threads headers verbatim to the port", async () => {
    const mock = new MockHttpPort(response());
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "hello world" }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      backend: "brave",
      query: "hello world",
      results: [
        { title: "Result One", url: "https://example.com/1", snippet: "First snippet" },
        { title: "Result Two", url: "https://example.com/2", snippet: "Second snippet" },
      ],
      truncated: false,
    });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.headers).toEqual({ "X-Subscription-Token": SECRET_KEY, Accept: "application/json" });
  });

  it("percent-encodes the query into a single q param (no URL-structure injection)", async () => {
    const mock = new MockHttpPort(response());
    const tool = createWebSearchTool(braveBackend());

    await tool.handler({ query: "rm -rf / & q=evil#frag" }, ctxWithHttp(mock));

    const call = mock.calls[0];
    expect(call).toBeDefined();
    const calledUrl = new URL(call!.url);
    expect(calledUrl.searchParams.getAll("q")).toHaveLength(1);
    expect(calledUrl.searchParams.get("q")).toBe("rm -rf / & q=evil#frag");
    // The literal '&' inside the value must be percent-encoded, not a param separator.
    expect(call!.url).toContain("%26");
  });

  it("overrides the default count with max_results, capped at WEBSEARCH_MAX_RESULTS (10)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `R${i}`,
      url: `https://example.com/${i}`,
      description: `snippet ${i}`,
    }));
    const mock = new MockHttpPort(response({ body: braveBody(many) }));
    const tool = createWebSearchTool(braveBackend({ maxResults: 5 }));

    const result = await tool.handler({ query: "q", max_results: 999 }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output?.results).toHaveLength(10);
    expect(result.output?.truncated).toBe(true);
  });

  it("honors an explicit max_results smaller than backend.maxResults", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `R${i}`,
      url: `https://example.com/${i}`,
      description: `snippet ${i}`,
    }));
    const mock = new MockHttpPort(response({ body: braveBody(many) }));
    const tool = createWebSearchTool(braveBackend({ maxResults: 5 }));

    const result = await tool.handler({ query: "q", max_results: 3 }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output?.results).toHaveLength(3);
    expect(result.output?.truncated).toBe(true);
  });

  it("defaults the count to backend.maxResults when max_results is omitted", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      title: `R${i}`,
      url: `https://example.com/${i}`,
      description: `snippet ${i}`,
    }));
    const mock = new MockHttpPort(response({ body: braveBody(six) }));
    const tool = createWebSearchTool(braveBackend({ maxResults: 4 }));

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output?.results).toHaveLength(4);
    expect(result.output?.truncated).toBe(true);
  });

  it("returns ok:true with an empty results array (no items, not an error)", async () => {
    const mock = new MockHttpPort(response({ body: braveBody([]) }));
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output?.results).toEqual([]);
    expect(result.output?.truncated).toBe(false);
  });

  it("caps a single result's snippet length (parseSearchResults integration)", async () => {
    const longSnippet = "x".repeat(WEBSEARCH_SNIPPET_MAX_CHARS + 500);
    const mock = new MockHttpPort(
      response({ body: braveBody([{ title: "T", url: "https://example.com/1", description: longSnippet }]) }),
    );
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    expect(result.ok).toBe(true);
    expect(result.output?.results[0]?.snippet.length).toBeLessThanOrEqual(WEBSEARCH_SNIPPET_MAX_CHARS);
  });

  it("threads the abort signal into the HttpPort request", async () => {
    const controller = new AbortController();
    const mock = new MockHttpPort(response());
    const tool = createWebSearchTool(braveBackend());

    await tool.handler({ query: "q" }, ctxWithHttp(mock, controller.signal));

    expect(mock.calls[0]?.abortSignal).toBe(controller.signal);
  });

  describe("non-200 responses", () => {
    it("401 => actionable key hint, no key leak", async () => {
      const mock = new MockHttpPort(response({ status: 401, statusText: "Unauthorized" }));
      const tool = createWebSearchTool(braveBackend());

      const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

      expect(result.ok).toBe(false);
      expect(result.error).toContain("401");
      expect(result.error).toContain("check the API key env var");
      assertNoKeyLeak(result);
    });

    it("403 => actionable key hint, no key leak", async () => {
      const mock = new MockHttpPort(response({ status: 403, statusText: "Forbidden" }));
      const tool = createWebSearchTool(braveBackend());

      const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

      expect(result.ok).toBe(false);
      expect(result.error).toContain("403");
      expect(result.error).toContain("check the API key env var");
      assertNoKeyLeak(result);
    });

    it("429 => rate-limited hint, no key leak", async () => {
      const mock = new MockHttpPort(response({ status: 429, statusText: "Too Many Requests" }));
      const tool = createWebSearchTool(braveBackend());

      const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

      expect(result.ok).toBe(false);
      expect(result.error).toContain("429");
      expect(result.error).toContain("rate limited");
      assertNoKeyLeak(result);
    });

    it("500 => plain status text, no hint, no key leak", async () => {
      const mock = new MockHttpPort(response({ status: 500, statusText: "Internal Server Error" }));
      const tool = createWebSearchTool(braveBackend());

      const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

      expect(result.ok).toBe(false);
      expect(result.error).toContain("500");
      expect(result.error).not.toContain("check the API key env var");
      expect(result.error).not.toContain("rate limited");
      assertNoKeyLeak(result);
    });
  });

  it("non-JSON body degrades to ok:false, not a throw", async () => {
    const mock = new MockHttpPort(response({ body: "this is not json at all" }));
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    assertNoKeyLeak(result);
  });

  it("truncated response body is rejected before parsing, no key leak", async () => {
    const mock = new MockHttpPort(response({ truncated: true, body: "partial" }));
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("size cap");
    assertNoKeyLeak(result);
  });

  it("returns an error outcome (not a throw) when HttpPort rejects, no key leak", async () => {
    const failing: HttpPort = {
      fetchText: () => Promise.reject(new Error("network unreachable")),
    };
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(failing));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network unreachable");
    assertNoKeyLeak(result);
  });

  it("happy-path output never contains the API key", async () => {
    const mock = new MockHttpPort(response());
    const tool = createWebSearchTool(braveBackend());

    const result = await tool.handler({ query: "q" }, ctxWithHttp(mock));

    assertNoKeyLeak(result);
  });
});

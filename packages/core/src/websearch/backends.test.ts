/**
 * backends.test.ts (slice 6.3 A5): buildSearchUrl (structural encoding, one q
 * param, count, endpoint-with-existing-query-params, searxng trailing slash)
 * and parseSearchResults (happy path per backend, defensive narrowing on
 * malformed/hostile bodies, snippet cap, item skip on non-string fields).
 */

import { describe, expect, it } from "vitest";
import { buildSearchUrl, parseSearchResults } from "./backends.js";
import type { ResolvedWebSearchBackend } from "./config.js";

function brave(overrides: Partial<ResolvedWebSearchBackend> = {}): ResolvedWebSearchBackend {
  return {
    kind: "brave",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    headers: { "X-Subscription-Token": "secret-key", Accept: "application/json" },
    maxResults: 5,
    ...overrides,
  };
}

function searxng(overrides: Partial<ResolvedWebSearchBackend> = {}): ResolvedWebSearchBackend {
  return {
    kind: "searxng",
    endpoint: "http://127.0.0.1:8080",
    headers: { Accept: "application/json" },
    maxResults: 5,
    ...overrides,
  };
}

describe("buildSearchUrl — brave", () => {
  it("builds ?q=&count= against the endpoint", () => {
    const url = new URL(buildSearchUrl(brave(), "hello world", 7));
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("count")).toBe("7");
  });

  it("percent-encodes metacharacters/unicode/&/# as a single structural q param", () => {
    const query = "\"; rm -rf / & q=evil#frag åäö %00";
    const built = buildSearchUrl(brave(), query, 5);
    const url = new URL(built);
    // exactly one q param -- the raw & / # in the query never split the URL structure
    expect(url.searchParams.getAll("q")).toHaveLength(1);
    expect(url.searchParams.get("q")).toBe(query);
    expect(url.search.startsWith("?")).toBe(true);
  });

  it("never puts the API key in the URL", () => {
    const built = buildSearchUrl(brave(), "q", 5);
    expect(built).not.toContain("secret-key");
  });

  it("preserves pre-existing query params on a configured endpoint", () => {
    const backend = brave({ endpoint: "https://proxy.example.com/search?source=anycode" });
    const url = new URL(buildSearchUrl(backend, "q", 3));
    expect(url.searchParams.get("source")).toBe("anycode");
    expect(url.searchParams.get("q")).toBe("q");
    expect(url.searchParams.get("count")).toBe("3");
  });
});

describe("buildSearchUrl — searxng", () => {
  it("appends /search?q=&format=json to the instance base", () => {
    const url = new URL(buildSearchUrl(searxng(), "cats", 5));
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:8080/search");
    expect(url.searchParams.get("q")).toBe("cats");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("tolerates a trailing slash on the instance base (no double slash)", () => {
    const url = new URL(buildSearchUrl(searxng({ endpoint: "http://127.0.0.1:8080/" }), "cats", 5));
    expect(url.pathname).toBe("/search");
  });

  it("preserves pre-existing query params on a configured endpoint", () => {
    const backend = searxng({ endpoint: "http://127.0.0.1:8080?instance=x" });
    const url = new URL(buildSearchUrl(backend, "q", 5));
    expect(url.searchParams.get("instance")).toBe("x");
    expect(url.searchParams.get("q")).toBe("q");
  });
});

describe("parseSearchResults — brave happy path", () => {
  it("extracts title/url/description from web.results", () => {
    const body = JSON.stringify({
      web: {
        results: [
          { title: "A", url: "https://a.example.com", description: "desc A" },
          { title: "B", url: "https://b.example.com", description: "desc B" },
        ],
      },
    });
    const result = parseSearchResults("brave", body);
    expect(result).toEqual({
      ok: true,
      results: [
        { title: "A", url: "https://a.example.com", snippet: "desc A" },
        { title: "B", url: "https://b.example.com", snippet: "desc B" },
      ],
    });
  });

  it("returns ok:true with an empty array when results is empty", () => {
    const result = parseSearchResults("brave", JSON.stringify({ web: { results: [] } }));
    expect(result).toEqual({ ok: true, results: [] });
  });
});

describe("parseSearchResults — searxng happy path", () => {
  it("extracts title/url/content from results", () => {
    const body = JSON.stringify({
      results: [{ title: "X", url: "https://x.example.com", content: "content X" }],
    });
    const result = parseSearchResults("searxng", body);
    expect(result).toEqual({
      ok: true,
      results: [{ title: "X", url: "https://x.example.com", snippet: "content X" }],
    });
  });
});

describe("parseSearchResults — defensive narrowing (never throws)", () => {
  it("ok:false on non-JSON body", () => {
    const result = parseSearchResults("brave", "not json at all {{{");
    expect(result.ok).toBe(false);
  });

  it("ok:false on a JSON array (not an object)", () => {
    const result = parseSearchResults("brave", JSON.stringify([1, 2, 3]));
    expect(result.ok).toBe(false);
  });

  it("ok:false on a JSON primitive", () => {
    const result = parseSearchResults("searxng", JSON.stringify("just a string"));
    expect(result.ok).toBe(false);
  });

  it("ok:false when brave response has no web.results array", () => {
    const result = parseSearchResults("brave", JSON.stringify({ web: {} }));
    expect(result.ok).toBe(false);
  });

  it("ok:false when brave response has no web key at all", () => {
    const result = parseSearchResults("brave", JSON.stringify({ unrelated: true }));
    expect(result.ok).toBe(false);
  });

  it("ok:false when searxng response has no results array", () => {
    const result = parseSearchResults("searxng", JSON.stringify({ unrelated: true }));
    expect(result.ok).toBe(false);
  });

  it("ok:false when results is present but not an array", () => {
    const result = parseSearchResults("searxng", JSON.stringify({ results: "oops" }));
    expect(result.ok).toBe(false);
  });

  it("never throws on deeply malformed input", () => {
    expect(() => parseSearchResults("brave", "{")).not.toThrow();
    expect(() => parseSearchResults("brave", "")).not.toThrow();
    expect(() => parseSearchResults("searxng", "null")).not.toThrow();
  });
});

describe("parseSearchResults — per-item defensive handling", () => {
  it("skips items whose title or url is not a string", () => {
    const body = JSON.stringify({
      web: {
        results: [
          { title: "Good", url: "https://good.example.com", description: "ok" },
          { title: 123, url: "https://bad.example.com", description: "bad title" },
          { title: "Bad url", url: null, description: "bad url" },
          { url: "https://missing-title.example.com", description: "missing title" },
          "not even an object",
        ],
      },
    });
    const result = parseSearchResults("brave", body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([{ title: "Good", url: "https://good.example.com", snippet: "ok" }]);
    }
  });

  it("defaults snippet to empty string when the snippet field is missing/non-string", () => {
    const body = JSON.stringify({ results: [{ title: "T", url: "https://t.example.com" }] });
    const result = parseSearchResults("searxng", body);
    expect(result).toEqual({ ok: true, results: [{ title: "T", url: "https://t.example.com", snippet: "" }] });
  });

  it("caps a snippet at WEBSEARCH_SNIPPET_MAX_CHARS", () => {
    const longDescription = "x".repeat(5_000);
    const body = JSON.stringify({ web: { results: [{ title: "T", url: "https://t.example.com", description: longDescription }] } });
    const result = parseSearchResults("brave", body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0]!.snippet).toHaveLength(1_000);
    }
  });
});

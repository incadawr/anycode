/**
 * Unit tests for the catalog `headers` template resolver: the one place that
 * turns `CatalogProviderEntry.headers` templates into concrete per-session
 * request headers. The resolution happens once per boot (CLI run or desktop
 * host fork) and the result rides EndpointConfig.headers into every factory.
 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { declaredUserAgent, resolveProviderHeaders, wrapFetchWithUserAgent } from "./session-headers.js";

function entry(headers: Record<string, string> | undefined): CatalogProviderEntry {
  return {
    id: "opencode",
    name: "OpenCode Go (Anthropic)",
    baseUrl: "https://opencode.ai/inference/go/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    ...(headers !== undefined ? { headers } : {}),
    models: [],
  } as CatalogProviderEntry;
}

describe("resolveProviderHeaders", () => {
  it("substitutes {sessionId} and {version} in every value", () => {
    expect(resolveProviderHeaders(
      entry({ "user-agent": "Anycode/{version}", "x-opencode-session": "{sessionId}" }),
      "sess-123",
      "9.9.9",
    )).toEqual({
      "user-agent": "Anycode/9.9.9",
      "x-opencode-session": "sess-123",
    });
  });

  it("falls back to the dev version when the host stamps none", () => {
    const headers = resolveProviderHeaders(
      entry({ "user-agent": "Anycode/{version}" }),
      "s",
      undefined,
    );
    expect(headers).toEqual({ "user-agent": "Anycode/dev" });
  });

  it("leaves values without tokens untouched", () => {
    expect(resolveProviderHeaders(entry({ "x-static": "keep-me" }), "s", "1")).toEqual({
      "x-static": "keep-me",
    });
  });

  it("returns undefined for an entry without headers (every other provider stays byte-identical)", () => {
    expect(resolveProviderHeaders(entry(undefined), "s", "1")).toBeUndefined();
  });

  it("returns undefined for an unmatched connection (no catalog entry)", () => {
    expect(resolveProviderHeaders(undefined, "s", "1")).toBeUndefined();
  });
});

describe("declaredUserAgent", () => {
  it("finds the user-agent regardless of key casing", () => {
    expect(declaredUserAgent({ "User-Agent": "Anycode/1" })).toBe("Anycode/1");
    expect(declaredUserAgent({ "user-agent": "Anycode/2" })).toBe("Anycode/2");
  });

  it("returns undefined without a user-agent key", () => {
    expect(declaredUserAgent({ "x-other": "v" })).toBeUndefined();
    expect(declaredUserAgent(undefined)).toBeUndefined();
  });
});

describe("wrapFetchWithUserAgent", () => {
  it("rewrites the outgoing user-agent to exactly the declared value", async () => {
    // The SDK appends its own markers to the header value; the wrapper is the
    // last writer, so the captured init must carry the exact declared string.
    let captured: Headers | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    };
    await wrapFetchWithUserAgent(fetchImpl, "Anycode/9.9.9")("https://endpoint.example/v1/messages", {
      headers: { "user-agent": "Anycode/9.9.9 ai-sdk/anthropic/4.0.7 runtime/node.js/22", "x-opencode-session": "s" },
    });
    expect(captured!.get("user-agent")).toBe("Anycode/9.9.9");
    expect(captured!.get("x-opencode-session")).toBe("s");
  });
});

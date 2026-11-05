import { describe, expect, it, vi } from "vitest";
import { AccountHttpError, fetchAccountDocument } from "./client.js";

describe("account API client", () => {
  it("uses the configured path, passes bearer only to it, and refuses redirects", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ schemaVersion: "anycode.account-catalog.v1", accountId: "a", revision: "r", complete: true, models: [] })));
    const result = await fetchAccountDocument(fetcher, "https://gateway.example.com/account/v1", "catalog", "key", new AbortController().signal);
    expect(result.kind).toBe("catalog");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://gateway.example.com/account/v1/catalog");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer key" } });
  });
  it("surfaces auth failures without parsing the body and rejects oversized responses", async () => {
    const fetch401 = async () => new Response("denied", { status: 401 });
    await expect(fetchAccountDocument(fetch401, "https://gateway.example.com/", "budget", undefined, new AbortController().signal)).rejects.toBeInstanceOf(AccountHttpError);
    const large = async () => new Response("x".repeat(65537));
    await expect(fetchAccountDocument(large, "https://gateway.example.com/", "budget", undefined, new AbortController().signal)).rejects.toThrow("too large");
  });
});

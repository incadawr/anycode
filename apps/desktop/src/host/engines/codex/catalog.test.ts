import { describe, expect, it, vi } from "vitest";
import { CODEX_MODEL_LIST_MAX_PAGES } from "../../../shared/codex-timeouts.js";
import { CodexModelCatalog, type CodexCatalogClient } from "./catalog.js";

/** A paginated `model/list` server, shaped exactly like the live one (fixture w1-p4). */
function pagedClient(pages: { data: unknown[]; nextCursor: string | null }[]): CodexCatalogClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    request: vi.fn(<T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method !== "model/list") return Promise.resolve({} as T);
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      const index = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve((pages[index] ?? { data: [], nextCursor: null }) as T);
    }) as CodexCatalogClient["request"],
  };
}

describe("CodexModelCatalog", () => {
  it("follows nextCursor across pages and de-duplicates", async () => {
    const client = pagedClient([
      { data: [{ id: "a" }, { id: "b" }], nextCursor: "1" },
      { data: [{ id: "b" }, { id: "c" }], nextCursor: null },
    ]);
    const catalog = await CodexModelCatalog.load(client);

    expect(catalog.choices().map((choice) => choice.id)).toEqual(["a", "b", "c"]);
    expect(client.calls).toEqual([
      { method: "model/list", params: {} },
      { method: "model/list", params: { cursor: "1" } },
    ]);
  });

  it("stops at the page cap", async () => {
    // Every page points at the next: without the cap this would never end.
    const pages = Array.from({ length: 20 }, (_, index) => ({
      data: [{ id: `model-${index}` }],
      nextCursor: String(index + 1),
    }));
    const client = pagedClient(pages);
    const catalog = await CodexModelCatalog.load(client);

    expect(catalog.choices()).toHaveLength(CODEX_MODEL_LIST_MAX_PAGES);
  });

  it("stops on a repeated cursor (a server that never advances)", async () => {
    const client: CodexCatalogClient & { count: number } = {
      count: 0,
      request: <T,>(): Promise<T> => {
        client.count += 1;
        // Always the SAME cursor: the page cap alone would still spin 5 times.
        return Promise.resolve({ data: [{ id: `m${client.count}` }], nextCursor: "stuck" } as T);
      },
    };
    const catalog = await CodexModelCatalog.load(client);

    expect(client.count).toBe(2);
    expect(catalog.choices().map((choice) => choice.id)).toEqual(["m1", "m2"]);
  });

  it("degrades to an unavailable catalog when model/list fails — it never throws into boot", async () => {
    const client: CodexCatalogClient = { request: () => Promise.reject(new Error("timed out")) };
    const catalog = await CodexModelCatalog.load(client);

    expect(catalog.available).toBe(false);
    expect(catalog.loadError).toBe("timed out");
    // An unavailable catalog validates NOTHING — that is what keeps an
    // unverifiable model off the wire instead of onto a burned turn.
    expect(catalog.has("gpt-5.6-sol")).toBe(false);
    expect(catalog.choices()).toEqual([]);
  });

  it("bounds each page with a timeout", async () => {
    const seen: (number | undefined)[] = [];
    const client: CodexCatalogClient = {
      request: <T,>(_method: string, _params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => {
        seen.push(opts?.timeoutMs);
        return Promise.resolve({ data: [], nextCursor: null } as T);
      },
    };
    await CodexModelCatalog.load(client, { pageTimeoutMs: 1_234 });

    expect(seen).toEqual([1_234]);
  });

  it("decodes image input only when the model explicitly advertises it", async () => {
    const client = pagedClient([
      {
        data: [
          { id: "vision", inputModalities: ["text", "image"] },
          { id: "text-only", inputModalities: ["text"] },
          { id: "legacy-without-modalities" },
        ],
        nextCursor: null,
      },
    ]);
    const catalog = await CodexModelCatalog.load(client);

    expect(catalog.supportsImages("vision")).toBe(true);
    expect(catalog.supportsImages("text-only")).toBe(false);
    expect(catalog.supportsImages("legacy-without-modalities")).toBe(false);
    expect(catalog.supportsImages("not-in-the-catalog")).toBe(false);
  });

  describe("resolveEffort", () => {
    const catalog = CodexModelCatalog.of([
      { id: "wide", label: "Wide", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
      { id: "narrow", label: "Narrow", efforts: ["medium"], defaultEffort: "medium", isDefault: false },
      { id: "effortless", label: "Effortless", efforts: [], isDefault: false },
    ]);

    it("keeps the thread's own effective effort when the model advertises it", () => {
      // The live thread echo reported "high" while the model's catalog default is
      // "medium": re-asserting the catalog default would silently DOWNGRADE the
      // user's configured effort on every turn.
      expect(catalog.resolveEffort("wide", "high")).toBe("high");
    });

    it("falls back to the model's own default when it does not", () => {
      expect(catalog.resolveEffort("narrow", "high")).toBe("medium");
    });

    it("yields nothing for an unknown model or a model with no efforts (the override then omits `effort`)", () => {
      expect(catalog.resolveEffort("ghost", "high")).toBeUndefined();
      expect(catalog.resolveEffort("effortless", "high")).toBeUndefined();
    });
  });
});

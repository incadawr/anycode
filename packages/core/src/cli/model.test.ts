/**
 * Unit coverage for cli/model.ts (design slice-4.6-cut.md §2.1/§7 B2):
 * SwitchableModelPort's transparent delegation + between-turns hot-swap, the
 * catalog endpoint matcher (normalize-based, custom-entry-safe), and the two
 * /model show-line forms of formatModelInfo.
 */

import { describe, expect, it } from "vitest";
import { formatModelInfo, matchCatalogEntryByBaseUrl, SwitchableModelPort } from "./model.js";
import { getBuiltinCatalog } from "../provider/catalog-data.js";
import type { CatalogProviderEntry, ProviderCatalog } from "../provider/catalog.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";

/** Replays a fixed event script for every call; records call count + the last request seen. */
class ScriptedModelPort implements ModelPort {
  calls = 0;
  lastRequest: ModelRequest | undefined;

  constructor(private readonly events: ModelStreamEvent[]) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.lastRequest = request;
    const events = this.events;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/* */
class CountingModelPort implements ModelPort {
  calls = 0;

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    return (async function* () {
      yield { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent;
    })();
  }
}

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

const emptyRequest: ModelRequest = { messages: [], tools: [] };

describe("SwitchableModelPort", () => {
  it("delegates streamText verbatim: same events, same order, same request forwarded", async () => {
    const events: ModelStreamEvent[] = [
      { type: "start" },
      { type: "text_start", id: "1" },
      { type: "text_delta", id: "1", text: "hi" },
      { type: "text_end", id: "1" },
      { type: "finish", finishReason: "stop", usage: { totalTokens: 3 } },
    ];
    const underlying = new ScriptedModelPort(events);
    const switchable = new SwitchableModelPort(underlying);

    const result = await collect(switchable.streamText(emptyRequest));

    expect(result).toEqual(events);
    expect(underlying.calls).toBe(1);
    expect(underlying.lastRequest).toBe(emptyRequest);
  });

  it("routes the NEXT call into the new port after setPort (hot-swap between turns)", async () => {
    const first = new ScriptedModelPort([{ type: "finish", finishReason: "stop", usage: {} }]);
    const second = new ScriptedModelPort([{ type: "start" }]);
    const switchable = new SwitchableModelPort(first);

    await collect(switchable.streamText(emptyRequest));
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);

    switchable.setPort(second);
    const secondResult = await collect(switchable.streamText(emptyRequest));

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(secondResult).toEqual([{ type: "start" }]);
  });

  it("is a call-count no-op: counting through the wrapper equals counting directly (hazard A3)", async () => {
    const direct = new CountingModelPort();
    const wrapped = new CountingModelPort();
    const switchable = new SwitchableModelPort(wrapped);

    for (let i = 0; i < 3; i += 1) {
      await collect(direct.streamText(emptyRequest));
      await collect(switchable.streamText(emptyRequest));
    }

    expect(wrapped.calls).toBe(direct.calls);
    expect(wrapped.calls).toBe(3);
  });
});

describe("matchCatalogEntryByBaseUrl", () => {
  const catalog = getBuiltinCatalog();

  it("matches the z-ai entry regardless of trailing slash / missing v1 suffix", () => {
    const zai = catalog.providers.find((entry) => entry.id === "z-ai");
    expect(zai).toBeDefined();
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.z.ai/api/anthropic")).toBe(zai);
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.z.ai/api/anthropic/")).toBe(zai);
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.z.ai/api/anthropic/v1")).toBe(zai);
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.z.ai/api/anthropic/v1/")).toBe(zai);
  });

  it("matches the anthropic entry", () => {
    const anthropic = catalog.providers.find((entry) => entry.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.anthropic.com")).toBe(anthropic);
    expect(matchCatalogEntryByBaseUrl(catalog, "https://api.anthropic.com/v1")).toBe(anthropic);
  });

  it("returns undefined for an endpoint not in the catalog (and does not throw walking past the custom entry)", () => {
    // The builtin catalog's LAST entry is `custom` (baseUrl ""); a non-match
    // forces `.find` to walk the full array, including custom. Without the

    // undefined.
    expect(() =>
      matchCatalogEntryByBaseUrl(catalog, "https://example.com/not-a-provider"),
    ).not.toThrow();
    expect(matchCatalogEntryByBaseUrl(catalog, "https://example.com/not-a-provider")).toBeUndefined();
  });

  it("never matches the custom entry, even in a catalog that holds only the custom entry", () => {
    const customOnly: ProviderCatalog = {
      schemaVersion: "anycode.model-providers.v1",
      providers: [
        {
          id: "custom",
          name: "Custom endpoint",
          baseUrl: "",
          defaultTransport: "anthropic-messages",
          supportedTransports: ["anthropic-messages"],
          auth: { kind: "api_key" },
          models: [],
        },
      ],
    };
    expect(() => matchCatalogEntryByBaseUrl(customOnly, "https://api.anthropic.com")).not.toThrow();
    expect(matchCatalogEntryByBaseUrl(customOnly, "https://api.anthropic.com")).toBeUndefined();
  });
});

describe("formatModelInfo", () => {
  it("shows the current model plus catalog hints when a matched entry has models", () => {
    const entry: CatalogProviderEntry = {
      id: "z-ai",
      name: "Z.AI (GLM)",
      baseUrl: "https://api.z.ai/api/anthropic",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [
        { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000 },
        { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128_000 },
        { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128_000 },
      ],
    };
    expect(formatModelInfo("glm-4.6", entry)).toBe(
      "[model] glm-4.6\n" +
        "[model] provider: Z.AI (GLM) — models: glm-4.6, glm-4.5, glm-4.5-air (switch: /model <id>)\n",
    );
  });

  it("falls back to the generic switch line when no entry matched", () => {
    expect(formatModelInfo("some-custom-model", undefined)).toBe(
      "[model] some-custom-model\n[model] switch: /model <model-id> (any model id accepted)\n",
    );
  });

  it("falls back to the generic switch line when the matched entry has no static hints", () => {
    const entry: CatalogProviderEntry = {
      id: "custom",
      name: "Custom endpoint",
      baseUrl: "",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(formatModelInfo("whatever-id", entry)).toBe(
      "[model] whatever-id\n[model] switch: /model <model-id> (any model id accepted)\n",
    );
  });
});

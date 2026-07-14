/**
 * Provider catalog + resolveEndpoint tests (slice 2.5 §2.2). Covers the pure
 * baseUrl+model projection for every built-in entry (ruling U2 set), the


 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { resolveEndpoint } from "./catalog.js";
import {
  CUSTOM_PROVIDER_ID,
  catalogProviderIds,
  findCatalogEntry,
  getBuiltinCatalog,
  isCustomProvider,
} from "./catalog-data.js";

describe("built-in catalog v1 (slice 2.5 §2.2)", () => {
  it("ships exactly the ruling-U2 set, all api_key auth (ruling U1)", () => {
    const catalog = getBuiltinCatalog();
    expect(catalog.schemaVersion).toBe("anycode.model-providers.v1");
    expect(catalogProviderIds()).toEqual(["anthropic", "z-ai", "deepseek", "moonshot", "custom"]);
    for (const entry of catalog.providers) {
      expect(entry.auth.kind).toBe("api_key");
      // Every built-in entry speaks the Anthropic wire protocol today, and none
      // advertises a transport the dispatcher cannot build.
      expect(entry.defaultTransport).toBe("anthropic-messages");
      expect(entry.supportedTransports).toEqual(["anthropic-messages"]);
      expect(entry.supportedTransports).toContain(entry.defaultTransport);
    }
  });

  it("maps the known anthropic-compatible base URLs", () => {
    expect(findCatalogEntry("anthropic")?.baseUrl).toBe("https://api.anthropic.com");
    expect(findCatalogEntry("z-ai")?.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(findCatalogEntry("deepseek")?.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(findCatalogEntry("moonshot")?.baseUrl).toBe("https://api.moonshot.ai/anthropic");
  });

  it("custom carries an empty baseUrl and no static model hints", () => {
    const custom = findCatalogEntry(CUSTOM_PROVIDER_ID);
    expect(custom?.baseUrl).toBe("");
    expect(custom?.models).toEqual([]);
    expect(isCustomProvider(CUSTOM_PROVIDER_ID)).toBe(true);
    expect(isCustomProvider("anthropic")).toBe(false);
  });

  it("declares per-model effort levels for reasoning-capable models", () => {
    const anthropic = findCatalogEntry("anthropic");
    const zAi = findCatalogEntry("z-ai");
    expect(anthropic?.models.find((model) => model.id === "claude-sonnet-4-20250514")?.effortLevels).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(zAi?.models.find((model) => model.id === "glm-5.2")?.effortLevels).toEqual(["off", "high", "max"]);
    expect(zAi?.models.find((model) => model.id === "glm-4.6")?.effortLevels).toBeUndefined();
  });

  it("declares GLM-5.2's documented 1M context and 128K wire-output ceiling", () => {
    const glm52 = findCatalogEntry("z-ai")?.models.find((model) => model.id === "glm-5.2");
    expect(glm52).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
  });

  it("findCatalogEntry returns undefined for an unknown id", () => {
    expect(findCatalogEntry("nope")).toBeUndefined();
  });
});

describe("resolveEndpoint (slice 2.5 §2.2)", () => {
  it("projects each built-in entry to {baseUrl, model}", () => {
    for (const id of catalogProviderIds()) {
      const entry = findCatalogEntry(id);
      expect(entry).toBeDefined();
      const resolved = resolveEndpoint(entry as CatalogProviderEntry, "some-model", "sk-xxx");
      expect(resolved.baseUrl).toBe(entry?.baseUrl);
      expect(resolved.model).toBe("some-model");
    }
  });

  it("passes a free-text model id through verbatim (ruling R5)", () => {
    const anthropic = findCatalogEntry("anthropic") as CatalogProviderEntry;
    expect(resolveEndpoint(anthropic, "totally-made-up-model-9000", "k").model).toBe(
      "totally-made-up-model-9000",
    );
  });

  it("returns an empty baseUrl for custom (caller substitutes settings baseUrl)", () => {
    const custom = findCatalogEntry(CUSTOM_PROVIDER_ID) as CatalogProviderEntry;
    expect(resolveEndpoint(custom, "my-model", "k")).toEqual({ baseUrl: "", model: "my-model" });
  });

  it("uses the transport-specific base URL when the entry declares one", () => {
    const entry: CatalogProviderEntry = {
      id: "x",
      name: "X",
      baseUrl: "https://host.example/api/anthropic",
      transportBaseUrls: {
        "anthropic-messages": "https://host.example/api/anthropic",
        "openai-chat-completions": "https://host.example/v1",
      },
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages", "openai-chat-completions"],
      auth: { kind: "api_key" },
      models: [],
    };
    // Default transport wins when the caller does not name one...
    expect(resolveEndpoint(entry, "m", "k").baseUrl).toBe("https://host.example/api/anthropic");
    // ...and the projection follows the requested transport, verbatim: these are
    // complete prefixes, never a base with a guessed `/v1` appended (§0.5).
    expect(resolveEndpoint(entry, "m", "k", "openai-chat-completions").baseUrl).toBe("https://host.example/v1");
  });

  it("falls back to the plain baseUrl for a transport with no declared base URL", () => {
    const entry: CatalogProviderEntry = {
      id: "x",
      name: "X",
      baseUrl: "https://host.example",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveEndpoint(entry, "m", "k", "openai-responses").baseUrl).toBe("https://host.example");
  });
});

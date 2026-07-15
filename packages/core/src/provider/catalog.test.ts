/**
 * Provider catalog + resolveEndpoint tests (slice 2.5 §2.2). Covers the pure
 * baseUrl+model projection for every built-in entry (ruling U2 set), the


 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { assertTransportContract, resolveEndpoint } from "./catalog.js";
import {
  CUSTOM_PROVIDER_ID,
  catalogProviderIds,
  findCatalogEntry,
  getBuiltinCatalog,
  isCustomProvider,
} from "./catalog-data.js";

describe("built-in catalog v1 (slice 2.5 §2.2 + TASK.43 W5)", () => {
  it("ships the ruling-U2 + W5 public set, all api_key auth (ruling U1)", () => {
    const catalog = getBuiltinCatalog();
    expect(catalog.schemaVersion).toBe("anycode.model-providers.v1");
    expect(catalogProviderIds()).toEqual([
      "anthropic",
      "z-ai",
      "deepseek",
      "moonshot",
      "openai",
      "openrouter",
      "vllm",
      "custom",
    ]);
    for (const entry of catalog.providers) {
      expect(entry.auth.kind).toBe("api_key");
      // None advertises a default transport it doesn't also support.
      expect(entry.supportedTransports).toContain(entry.defaultTransport);
    }
  });

  it("keeps every pre-W5 entry pinned to the anthropic-messages transport (byte-compat)", () => {
    for (const id of ["anthropic", "z-ai", "deepseek", "moonshot"]) {
      const entry = findCatalogEntry(id);
      expect(entry?.defaultTransport).toBe("anthropic-messages");
      expect(entry?.supportedTransports).toEqual(["anthropic-messages"]);
      expect(entry?.authOptional).toBeUndefined();
    }
  });

  it("declares the new public OpenAI-family entries (W5)", () => {
    expect(findCatalogEntry("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      defaultTransport: "openai-responses",
      supportedTransports: ["openai-responses", "openai-chat-completions"],
    });
    expect(findCatalogEntry("openrouter")).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      defaultTransport: "openai-chat-completions",
      supportedTransports: ["openai-chat-completions", "openai-responses"],
    });
    expect(findCatalogEntry("vllm")).toMatchObject({
      baseUrl: "",
      defaultTransport: "openai-chat-completions",
      supportedTransports: ["openai-chat-completions"],
      authOptional: true,
    });
  });

  it("widens custom to all three transports now both OpenAI factories exist (W5), default unchanged", () => {
    expect(findCatalogEntry(CUSTOM_PROVIDER_ID)).toMatchObject({
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages", "openai-chat-completions", "openai-responses"],
    });
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

  it("falls back to the plain baseUrl for a SUPPORTED transport with no declared transportBaseUrls entry", () => {
    const entry: CatalogProviderEntry = {
      id: "x",
      name: "X",
      baseUrl: "https://host.example",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages", "openai-responses"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveEndpoint(entry, "m", "k", "openai-responses").baseUrl).toBe("https://host.example");
  });

  // Replaces the old silent-fallback test (MEDIUM#3/W1#4, CONFIRMED REAL):
  // resolveEndpoint used to accept ANY transport unconditionally, silently
  // returning entry.baseUrl for a protocol the entry never declared it speaks
  // (cut Risk #3 — "a typo in env/catalog gets old 400/404s with no
  // explanation"). It must now throw instead of degrading quietly.
  it("throws when the requested transport is not in the entry's supportedTransports", () => {
    const entry: CatalogProviderEntry = {
      id: "x",
      name: "X",
      baseUrl: "https://host.example",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(() => resolveEndpoint(entry, "m", "k", "openai-responses")).toThrow(/does not support transport/);
  });

  it("the unsupported-transport throw names the entry and lists what IS supported", () => {
    const entry: CatalogProviderEntry = {
      id: "vllm",
      name: "vLLM",
      baseUrl: "",
      defaultTransport: "openai-chat-completions",
      supportedTransports: ["openai-chat-completions"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(() => resolveEndpoint(entry, "m", "k", "anthropic-messages")).toThrow(
      /"vllm".*anthropic-messages.*openai-chat-completions/s,
    );
  });
});

describe("assertTransportContract (dev-time invariant, TASK.43 W5)", () => {
  it("passes when defaultTransport is included in supportedTransports", () => {
    const entry: CatalogProviderEntry = {
      id: "x",
      name: "X",
      baseUrl: "https://host.example",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(() => assertTransportContract(entry)).not.toThrow();
  });

  it("throws when defaultTransport is missing from supportedTransports", () => {
    const entry: CatalogProviderEntry = {
      id: "broken",
      name: "Broken",
      baseUrl: "https://host.example",
      defaultTransport: "openai-responses",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(() => assertTransportContract(entry)).toThrow(/"broken".*defaultTransport/s);
  });

  it("every built-in entry already satisfies the invariant (exercised again explicitly, not just at module load)", () => {
    for (const entry of getBuiltinCatalog().providers) {
      expect(() => assertTransportContract(entry)).not.toThrow();
    }
  });
});

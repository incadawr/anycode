/**
 * Provider catalog + resolveEndpoint tests (slice 2.5 §2.2). Covers the pure
 * baseUrl+model projection for every built-in entry (ruling U2 set), the


 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { assertBrandContract, assertTransportContract, resolveEndpoint } from "./catalog.js";
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
      "kimi",
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
    expect(findCatalogEntry("kimi")?.baseUrl).toBe("https://api.kimi.com/coding");
  });

  it("declares the Kimi subscription entry (kimi.com sk-kimi-* keys; distinct from the moonshot platform)", () => {
    const kimi = findCatalogEntry("kimi");
    expect(kimi).toMatchObject({
      baseUrl: "https://api.kimi.com/coding",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
    });
    // TASK.70 (Taskana 4089): both Kimi entries belong to one brand card.
    expect(findCatalogEntry("moonshot")).toMatchObject({
      brand: "kimi",
      modeLabel: "Platform API (moonshot.ai)",
    });
    expect(findCatalogEntry("kimi")).toMatchObject({
      brand: "kimi",
      modeLabel: "Subscription (kimi.com)",
    });
    expect(kimi?.authOptional).toBeUndefined();
    expect(kimi?.models.map((model) => model.id)).toEqual([
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]);
    // Thinking-only models: no "off" tier; k3 mirrors its native low/high/max set.
    expect(kimi?.models.find((model) => model.id === "kimi-for-coding")?.effortLevels).toEqual(["low", "medium", "high"]);
    expect(kimi?.models.find((model) => model.id === "k3")?.effortLevels).toEqual(["low", "high", "max"]);
    for (const model of kimi?.models ?? []) {
      expect(model).toMatchObject({ contextWindow: 262_144, reasoning: true, imageInput: true });
    }
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

  // TASK.163 (2026-08-28): docs.z.ai/guides/llm/glm-5.3 states "GLM-5.3 always
  // operates with reasoning enabled" and "Disabling reasoning is no longer
  // supported", with three documented effort levels "low", "high", and "max"
  // (default "max"). The pre-existing row's `["off", "high", "max"]` was stale
  // — `off` was never a real option for 5.3, and `low` was missing entirely.
  it("corrects the stale glm-5.3 effortLevels: reasoning cannot be disabled (docs.z.ai/guides/llm/glm-5.3, accessed 2026-08-28)", () => {
    const glm53 = findCatalogEntry("z-ai")?.models.find((model) => model.id === "glm-5.3");
    expect(glm53?.effortLevels).toEqual(["low", "high", "max"]);
    // Unaffected fields stay pinned to the existing spec-box values.
    expect(glm53).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
  });

  // TASK.163 (2026-08-28): docs.z.ai/guides/vlm/glm-5.3-flash states "Text
  // parameters are consistent with GLM-5.3" (1M-token context window) and
  // "`thinking.type` only supports `enabled`; thinking cannot be disabled" —
  // same low/high/max family as glm-5.3, no `off`.
  //
  // TASK.170 (2026-08-29): the page's spec card now states "Maximum Output
  // Tokens: 128K" (re-verified via raw-HTML fetch, not just the summarized
  // fetch, to rule out a hallucinated/conflated number) — the 2026-08-28 "not
  // specified anywhere" claim this test used to pin no longer holds; the page
  // was filled in after that pass. Leaving `maxOutputTokens` empty meant a
  // subagent spawned on this model fell to DEFAULT_MAX_OUTPUT_TOKENS (32_768)
  // instead of the real 131_072 the parent glm-5.3 already declared.
  //
  // TASK.197 (2026-08-30): `imageInput: true`. The row is the catalog's VLM
  // entry (docs.z.ai/guides/vlm/, spec card "Input Modality: Video / Image /
  // Text / File") and the owner runs it daily with images. Two earlier passes
  // withheld the flag pending an Anthropic-messages-endpoint proof that was
  // never demanded of the kimi.com or moonshot rows on the SAME transport;
  // this test no longer pins that asymmetry.
  it("declares the glm-5.3-flash row with its documented 128K output ceiling and its image-input capability (docs.z.ai/guides/vlm/glm-5.3-flash, accessed 2026-08-29; owner ruling 2026-08-30)", () => {
    const flash = findCatalogEntry("z-ai")?.models.find((model) => model.id === "glm-5.3-flash");
    expect(flash).toEqual({
      id: "glm-5.3-flash",
      name: "GLM-5.3 Flash",
      contextWindow: 1_000_000,
      usableContextWindow: 300_000,
      maxOutputTokens: 131_072,
      imageInput: true,
      reasoning: true,
      effortLevels: ["low", "high", "max"],
    });
  });

  // The sibling LLM row stays text-only on purpose: glm-5.3 is documented
  // under guides/llm/, its own spec card claims no image modality, and nobody
  // has reported images working on it. A guess here would repeat exactly the
  // mistake TASK.197 corrected, in the other direction.
  it("leaves the non-flash glm-5.3 row without an image-input claim", () => {
    const glm53 = findCatalogEntry("z-ai")?.models.find((model) => model.id === "glm-5.3");
    expect(glm53?.imageInput).toBeUndefined();
  });

  it("findCatalogEntry returns undefined for an unknown id", () => {
    expect(findCatalogEntry("nope")).toBeUndefined();
  });

  // TASK 4241 (2026-10-10): rows refreshed from the supplied authoritative
  // live GET /models facts. Default effort high is comment-only in the
  // catalog (no default-effort field exists on CatalogModel).
  it("declares the refreshed DeepSeek rows (live GET /models facts, 2026-10-10)", () => {
    const deepseek = findCatalogEntry("deepseek");
    expect(deepseek?.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    const flash = deepseek?.models.find((m) => m.id === "deepseek-flash");
    expect(flash).toEqual({
      id: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      imageInput: true,
      reasoning: true,
      effortLevels: ["low", "high", "max"],
    });
    const pro = deepseek?.models.find((m) => m.id === "deepseek-v4-pro");
    expect(pro).toEqual({
      id: "deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      reasoning: true,
      effortLevels: ["low", "high", "max"],
    });
    expect("imageInput" in (pro ?? {})).toBe(false);
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

describe("modelsUrl (4244)", () => {
  it("4244: deepseek declares modelsUrl at the bare origin; every other entry leaves it absent", () => {
    expect(findCatalogEntry("deepseek")?.modelsUrl).toBe("https://api.deepseek.com/models");
    for (const id of ["anthropic", "z-ai", "moonshot", "kimi", "openai", "openrouter", "vllm", "custom"]) {
      expect(findCatalogEntry(id)?.modelsUrl).toBeUndefined();
    }
  });
});

// TASK.70 (Taskana 4089): one brand = one card. Only the Kimi pair declares a
// brand; every other entry stays brandless so the flat list is byte-identical.
describe("brand grouping (TASK.70, Taskana 4089)", () => {
  it("4089: the Kimi brand declares exactly two modes and no other entry declares a brand", () => {
    const branded = getBuiltinCatalog().providers.filter((entry) => entry.brand === "kimi");
    // Catalog order: moonshot (index 3) precedes kimi (index 4) — same order
    // the drawer's brand group must preserve.
    expect(branded.map((entry) => entry.id)).toEqual(["moonshot", "kimi"]);
    for (const entry of getBuiltinCatalog().providers) {
      if (entry.id !== "kimi" && entry.id !== "moonshot") {
        expect(entry.brand).toBeUndefined();
        expect(entry.modeLabel).toBeUndefined();
      }
    }
  });
});

describe("assertBrandContract (TASK.70 dev-time invariant)", () => {
  it("passes for the built-in catalog", () => {
    expect(() => assertBrandContract(getBuiltinCatalog().providers)).not.toThrow();
  });

  it("throws on modeLabel without brand", () => {
    const entry = {
      id: "x",
      name: "X",
      modeLabel: "Some mode",
    } as unknown as CatalogProviderEntry;
    expect(() => assertBrandContract([entry])).toThrow(/declares modeLabel without brand/);
  });

  it("throws when a brand has a single entry", () => {
    const entry = {
      id: "x",
      name: "X",
      brand: "lonely",
      modeLabel: "Only mode",
    } as unknown as CatalogProviderEntry;
    expect(() => assertBrandContract([entry])).toThrow(/Brand "lonely" has a single entry/);
  });
});

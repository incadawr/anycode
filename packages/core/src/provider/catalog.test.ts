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
      brand: "Kimi",
      modeLabel: "Platform API (moonshot.ai)",
    });
    expect(findCatalogEntry("kimi")).toMatchObject({
      brand: "Kimi",
      modeLabel: "Subscription (kimi.com)",
    });
    expect(kimi?.authOptional).toBeUndefined();
    // Current kimi.com/coding ids (kimi.com/code/docs/en/kimi-code/models,
    // checked 2026-10-27); the K3.1 Pro pair is the newest generation and now
    // leads the list.
    expect(kimi?.models.map((model) => model.id)).toEqual([
      "k3.1-pro",
      "k3.1-pro-highspeed",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]);
    // Thinking-only models: no "off" tier; k3/3.1 mirror their native
    // low/high/max set and document "default high".
    expect(kimi?.models.find((model) => model.id === "k3.1-pro")?.effortLevels).toEqual(["low", "high", "max"]);
    expect(kimi?.models.find((model) => model.id === "k3.1-pro")?.defaultEffort).toBe("high");
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
    for (const model of anthropic?.models ?? []) {
      expect(model.reasoning).toBe(true);
      expect(model.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
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
      pricing: { basisId: "glm-5.3-flash-zai-2026-10-27", input: 0.15, cachedInput: 0.03, cacheWrite: 0.15, output: 0.5 },
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
  // live GET /models facts. Taskana 4894 carries the documented "default
  // effort is high" as a real `defaultEffort` field, so a session with no
  // explicit pick shows and sends `high` rather than the vocabulary's `low`.
  it("declares the refreshed DeepSeek rows (live GET /models facts, 2026-10-10)", () => {
    const deepseek = findCatalogEntry("deepseek");
    expect(deepseek?.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    const flash = deepseek?.models.find((m) => m.id === "deepseek-flash");
    expect(flash?.todoReminderEvery).toBe(20);
    expect(deepseek?.models.find((m) => m.id === "deepseek-v4-pro")?.todoReminderEvery).toBe(20);
    expect(flash).toEqual({
      id: "deepseek-flash",
      pricing: { basisId: "deepseek-flash-deepseek-peak-2026-10-27", input: 0.3, cachedInput: 0.006, output: 1.2 },
      name: "DeepSeek-V4.1-Flash",
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      imageInput: true,
      reasoning: true,
      effortLevels: ["low", "high", "max"],
      defaultEffort: "high",
      todoReminderEvery: 20,
    });
    const pro = deepseek?.models.find((m) => m.id === "deepseek-v4-pro");
    expect(pro).toEqual({
      id: "deepseek-v4-pro",
      pricing: { basisId: "deepseek-v4-pro-deepseek-peak-2026-10-27", input: 1.32, cachedInput: 0.044, output: 3.96 },
      name: "DeepSeek-V4-Pro",
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      reasoning: true,
      effortLevels: ["low", "high", "max"],
      defaultEffort: "high",
      todoReminderEvery: 20,
    });
    expect("imageInput" in (pro ?? {})).toBe(false);
  });

  // Taskana 4894: GLM-5.3's docs.z.ai page states the default tier is "max"
  // (see catalog-data.ts's TASK.163 note) — recorded as data, not a guess.
  it("records GLM-5.3's documented default effort and leaves undocumented rows alone", () => {
    const zai = findCatalogEntry("z-ai");
    expect(zai?.models.find((m) => m.id === "glm-5.3")?.defaultEffort).toBe("max");
    // No recorded provider default for these: their docs state levels, not a
    // default, so no `defaultEffort` may be invented (Taskana 4894).
    expect(zai?.models.find((m) => m.id === "glm-5.3-flash")?.defaultEffort).toBeUndefined();
    expect(zai?.models.find((m) => m.id === "glm-5.2")?.defaultEffort).toBeUndefined();
    for (const id of ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"]) {
      expect(findCatalogEntry("kimi")?.models.find((m) => m.id === id)?.defaultEffort).toBeUndefined();
    }
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
    const branded = getBuiltinCatalog().providers.filter((entry) => entry.brand === "Kimi");
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

// A `pricing` snapshot per model (rates checked 2026-10-27), so the
// context popover can show $ per step / per session for more than one model.
// Every rate below was read off the provider's OWN pricing page on 2026-10-27
// (URL and tier in the comment above each catalog row); a model whose provider
// does not publish a USD per-1M-token rate is deliberately left unpriced — the
// popover then says "price unknown" instead of inventing one.
describe("model pricing", () => {
  // What the calculator (apps/desktop/src/host/usage-cost.ts) needs to price a
  // step at all: input, cached input and output present and positive.
  const PRICED = {
    anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    "z-ai": ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"],
    deepseek: ["deepseek-flash", "deepseek-v4-pro"],
    moonshot: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"],
    openai: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra", "gpt-6-sol"],
  };

  it("gives every priced model a complete, self-consistent rate snapshot", () => {
    const rows = Object.entries(PRICED).flatMap(([providerId, ids]) =>
      ids.map((id) => ({
        providerId,
        id,
        model: findCatalogEntry(providerId)?.models.find((candidate) => candidate.id === id),
      })),
    );
    // Guard against a typo in PRICED itself hiding behind `?.` below.
    expect(rows.map((row) => row.model).filter((model) => model !== undefined)).toHaveLength(rows.length);

    for (const { providerId, id, model } of rows) {
      const label = `${providerId}/${id}`;
      const pricing = model?.pricing;
      expect(pricing, `${label} has pricing`).toBeDefined();
      if (!pricing) continue;
      for (const field of ["input", "cachedInput", "output"] as const) {
        expect(Number.isFinite(pricing[field]), `${label}.${field} is a number`).toBe(true);
        expect(pricing[field], `${label}.${field} is positive`).toBeGreaterThan(0);
      }
      // A cache hit can never cost more than a miss: usage-cost.ts bills the
      // gap as the saving the popover reports.
      expect(pricing.cachedInput, `${label}.cachedInput ≤ input`).toBeLessThanOrEqual(pricing.input);
      // A declared write rate must be priceable too. 0 is legitimate (Z.AI
      // currently waives cache storage); undefined means "provider never bills
      // one", which usage-cost.ts treats as "rate unknown" for non-zero writes.
      if (pricing.cacheWrite !== undefined) {
        expect(Number.isFinite(pricing.cacheWrite), `${label}.cacheWrite is a number`).toBe(true);
        expect(pricing.cacheWrite, `${label}.cacheWrite is non-negative`).toBeGreaterThanOrEqual(0);
      }
      // basisId = "<model id>-<source>-<date checked>", so a stale rate is
      // traceable back to the page and the day it was read.
      expect(pricing.basisId.startsWith(`${id}-`), `${label} basisId names the model: ${pricing.basisId}`).toBe(true);
      expect(pricing.basisId, `${label} basisId carries the check date`).toMatch(/-\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("prices exactly the listed models — a new rate or a new unpriced row is a deliberate edit", () => {
    const priced = getBuiltinCatalog().providers.flatMap((entry) =>
      entry.models.filter((model) => model.pricing !== undefined).map((model) => `${entry.id}/${model.id}`),
    );
    expect(priced).toEqual(
      Object.entries(PRICED).flatMap(([providerId, ids]) => ids.map((id) => `${providerId}/${id}`)),
    );
  });

  it("uses the published Kimi platform rates", () => {
    const models = findCatalogEntry("moonshot")!.models;
    for (const [id, input, cachedInput, cacheWrite, output] of [
      ["kimi-k3.1-pro", 2, 0.2, 2, 10],
      ["kimi-k3.1-pro-highspeed", 4, 0.2, 4, 20],
      ["kimi-k3", 3, 0.3, 3, 15],
    ] as const) {
      expect(models.find((model) => model.id === id)?.pricing).toMatchObject({ input, cachedInput, cacheWrite, output });
    }
  });

  it("records the documented current model defaults", () => {
    for (const [provider, model, effort] of [
      ["openai", "gpt-6.1-sol", "medium"], ["openai", "gpt-6.1-terra", "medium"],
      ["openai", "gpt-6-sol", "medium"], ["openai", "gpt-6-luna", "medium"],
      ["anthropic", "claude-opus-5-5", "medium"], ["anthropic", "claude-haiku-5-5", "medium"],
      ["anthropic", "claude-sonnet-5-5", "high"], ["anthropic", "claude-fable-5-1", "high"],
    ] as const) {
      expect(findCatalogEntry(provider)?.models.find((row) => row.id === model)?.defaultEffort).toBe(effort);
    }
  });

  it("leaves models with no published official rate unpriced rather than guessing", () => {
    const unpriced: ReadonlyArray<readonly [string, string]> = [
      ["moonshot", "kimi-k2.7-code"],
      ["moonshot", "kimi-k2.7-code-highspeed"],
      ["moonshot", "kimi-k2.6"],
      // Kimi For Coding: membership quota, no USD per-token rate (see the
      // catalog comment) — a connection states "subscription" instead.
      ["kimi", "k3.1-pro"],
      ["kimi", "k3.1-pro-highspeed"],
      ["kimi", "kimi-for-coding"],
      ["kimi", "kimi-for-coding-highspeed"],
      ["kimi", "k3"],
      ["kimi", "k3-256k"],
    ];
    for (const [providerId, id] of unpriced) {
      expect(findCatalogEntry(providerId)?.models.find((model) => model.id === id)?.pricing, `${providerId}/${id}`).toBeUndefined();
    }
  });

  it("prices both DeepSeek rows at peak, so a cache hit is cheaper than a miss", () => {
    for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
      const pricing = findCatalogEntry("deepseek")?.models.find((model) => model.id === id)?.pricing;
      expect(pricing).toBeDefined();
      expect(pricing?.cachedInput).toBeLessThan(pricing?.input ?? 0);
      expect(pricing?.output).toBeGreaterThan(pricing?.input ?? 0);
    }
    // Off-peak is exactly half of peak (DeepSeek's own note), and the recorded
    // rate is the peak ceiling of the pair.
    expect(findCatalogEntry("deepseek")?.models.find((model) => model.id === "deepseek-v4-pro")?.pricing).toEqual({
      basisId: "deepseek-v4-pro-deepseek-peak-2026-10-27",
      input: 1.32,
      cachedInput: 0.044,
      output: 3.96,
    });
  });
});

// The catalog's model lists are refreshed against the providers' OWN pages
// (all fetched 2026-10-27): OpenAI's models page + each model's own page,
// Anthropic's models overview, Z.AI's model matrix and the Kimi platform model
// list. These rows are what a picker shows, so a stale entry is a UI lie even
// when nothing else breaks.
describe("current model lineups (checked 2026-10-27)", () => {
  it("ships the GPT-6 family with its documented windows and caps", () => {
    const openai = findCatalogEntry("openai");
    expect(openai?.models.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
      "gpt-6-astra",
      "gpt-6-sol",
    ]);
    for (const model of openai?.models ?? []) {
      // developers.openai.com/api/docs/models/<id>: 1,050,000 context window,
      // 128,000 max output, text+image input.
      expect(model).toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000, imageInput: true });
    }
  });

  it("ships the Claude 5 family with 1M context and 128K output", () => {
    const anthropic = findCatalogEntry("anthropic");
    expect(anthropic?.models.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]);
    for (const model of anthropic?.models ?? []) {
      expect(model).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072, imageInput: true });
    }
  });

  it("adds GLM-5.3-FlashX and drops the rows Z.AI no longer lists", () => {
    const ids = (findCatalogEntry("z-ai")?.models ?? []).map((model) => model.id);
    expect(ids).toContain("glm-5.3-flashx");
    // GLM-5 Turbo is gone from the pricing page AND the model matrix;
    // GLM-4.5/4.5-Air survive only in the collapsed "Other Pricing" table.
    expect(ids).not.toContain("glm-5-turbo");
    expect(ids).not.toContain("glm-4.5");
    expect(ids).not.toContain("glm-4.5-air");
    // The K3.1 Pro pair is the current kimi.com/coding generation.
    const kimi = (findCatalogEntry("kimi")?.models ?? []).map((model) => model.id);
    expect(kimi.slice(0, 2)).toEqual(["k3.1-pro", "k3.1-pro-highspeed"]);
  });

  it("never lists an id the provider has retired", () => {
    const retired = new Set([
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku-20241022",
      "gpt-5.1",
      "gpt-4o",
      "gpt-4o-mini",
      "glm-5-turbo",
      "glm-4.5",
      "glm-4.5-air",
      "kimi-k2-0711-preview",
      "moonshot-v1-128k",
    ]);
    for (const entry of getBuiltinCatalog().providers) {
      for (const model of entry.models) {
        expect(retired.has(model.id), `${entry.id}/${model.id} is retired`).toBe(false);
      }
    }
  });
});

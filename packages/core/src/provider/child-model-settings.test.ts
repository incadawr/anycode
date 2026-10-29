/**
 * child-model-settings: composes the existing capabilities.ts resolvers
 * against a CHILD's own model id, never the parent's already-resolved values
 * (the F6 defect this module removes). Conservative-not-parent failure
 * semantics are the decisive property under test.
 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../types/config.js";
import { UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS } from "./capabilities.js";
import { buildChildModelSettingsResolver } from "./child-model-settings.js";

// Fixture entry, model-agnostic on purpose (this module has no A2 dependency):
// "glm-5.3-flash" here is a deliberately synthetic stand-in for "a known
// model with no declared output ceiling" (1M context, low/high/max efforts) —
// it no longer mirrors the real catalog row of the same id, which gained a
// declared 131_072 ceiling in TASK.170. "glm-5.3" mirrors the corrected row
// (a declared ceiling, same effort family). The resolver under test is
// exercised purely against these local models, never the real catalog, so
// this drift is cosmetic — see capabilities.test.ts / catalog.test.ts for
// coverage tied to the actual catalog data.
const Z_AI_ENTRY: CatalogProviderEntry = {
  id: "z-ai",
  name: "Z.AI (GLM)",
  baseUrl: "https://api.z.ai/api/anthropic",
  defaultTransport: "anthropic-messages",
  supportedTransports: ["anthropic-messages"],
  auth: { kind: "api_key" },
  models: [
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 1_000_000, reasoning: true, effortLevels: ["low", "high", "max"] },
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, effortLevels: ["low", "high", "max"] },
  ],
};

describe("buildChildModelSettingsResolver", () => {
  it("known z-ai model with no declared output ceiling: DEFAULT ceiling, effort kept, catalog window", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    expect(resolve("glm-5.3-flash", "low")).toEqual({
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: "low",
      contextWindowTokens: 1_000_000,
    });
  });

  it("catalog-unknown model id degrades honestly: DEFAULT ceiling, effort dropped, assumed 8192 window (TASK.142)", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    expect(resolve("glm-5.3-flash-nonexistent", "high")).toEqual({
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: undefined,
      contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
    });
  });

  it("env overrides win over catalog values (ceiling and window)", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: 5_000,
      envContextWindow: 300_000,
    });
    const settings = resolve("glm-5.3", "high");
    expect(settings.maxOutputTokens).toBe(5_000);
    expect(settings.contextWindowTokens).toBe(300_000);
  });

  it("onClamp fires exactly once when the env override exceeds the catalog ceiling", () => {
    const clamps: Array<{ requested: number; clamped: number; modelId: string }> = [];
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: 200_000,
      envContextWindow: undefined,
      onClamp: (requested, clamped, modelId) => clamps.push({ requested, clamped, modelId }),
    });
    const settings = resolve("glm-5.3", "high");
    expect(settings.maxOutputTokens).toBe(128_000);
    expect(clamps).toEqual([{ requested: 200_000, clamped: 128_000, modelId: "glm-5.3" }]);
  });

  it("selectedTier undefined yields no reasoning effort", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    expect(resolve("glm-5.3", undefined).reasoningEffort).toBeUndefined();
  });

  it("a tier outside the child's declared effortLevels is dropped, fail-closed", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    // "medium" is not in glm-5.3-flash's declared ["low","high","max"].
    expect(resolve("glm-5.3-flash", "medium").reasoningEffort).toBeUndefined();
  });

  it("a resolver-internal throw (poisoned catalog entry) returns the conservative unknown-model shape, never a parent-derived one", () => {
    const poisoned = new Proxy({} as CatalogProviderEntry, {
      get(_target, prop) {
        if (prop === "models") throw new Error("catalog entry corrupted");
        return undefined;
      },
    });
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: poisoned,
      envMaxOutputTokens: 4_096,
      envContextWindow: 999_999,
    });
    expect(resolve("glm-5.3", "high")).toEqual({
      maxOutputTokens: 4_096,
      reasoningEffort: undefined,
      contextWindowTokens: 999_999,
    });
  });

  it("the catch path preserves a MATCHING bound override, and yields 8192 for a mismatched one (TASK.142)", () => {
    const poisoned = new Proxy({} as CatalogProviderEntry, {
      get(_target, prop) {
        if (prop === "models") throw new Error("catalog entry corrupted");
        return undefined;
      },
    });
    const matching = buildChildModelSettingsResolver({
      catalogEntry: poisoned,
      envMaxOutputTokens: undefined,
      envContextWindow: 999_999,
      envContextWindowModel: "glm-5.3",
    });
    expect(matching("glm-5.3", "high").contextWindowTokens).toBe(999_999);

    const mismatched = buildChildModelSettingsResolver({
      catalogEntry: poisoned,
      envMaxOutputTokens: undefined,
      envContextWindow: 999_999,
      envContextWindowModel: "other-model",
    });
    expect(mismatched("glm-5.3", "high").contextWindowTokens).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS);

    // A shell-global override (no binding) survives the catch path too.
    const global = buildChildModelSettingsResolver({
      catalogEntry: poisoned,
      envMaxOutputTokens: undefined,
      envContextWindow: 999_999,
    });
    expect(global("glm-5.3", "high").contextWindowTokens).toBe(999_999);
  });

  // TASK.142: the child's window follows ITS model, not the parent's bound pair.

  it("a bound override beats the catalog for the model it names, and is ignored for a different model", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: 50_000,
      envContextWindowModel: "glm-5.3",
    });
    expect(resolve("glm-5.3", "high").contextWindowTokens).toBe(50_000);
    // Child on B: A's saved window must NOT govern B — B resolves its catalog window.
    expect(resolve("glm-5.3-flash", "high").contextWindowTokens).toBe(1_000_000);
  });

  it("a catalog model with no override resolves its catalog window", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
      envContextWindowModel: "glm-5.3",
    });
    expect(resolve("glm-5.3-flash", "high").contextWindowTokens).toBe(1_000_000);
  });

  // TASK.170: onStubFallback names the child spawned on a model the catalog
  // declares no ceiling for — the case a bare onClamp wiring cannot surface,
  // since there is no ceiling to clamp an override against.

  it("onStubFallback fires exactly once for a known model with no declared ceiling and no override", () => {
    const stubs: Array<{ modelId: string; applied: number }> = [];
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
      onStubFallback: (modelId, applied) => stubs.push({ modelId, applied }),
    });
    const settings = resolve("glm-5.3-flash", "low");
    expect(settings.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(stubs).toEqual([{ modelId: "glm-5.3-flash", applied: DEFAULT_MAX_OUTPUT_TOKENS }]);
  });

  it("onStubFallback also fires for a catalog-unknown model id (the degraded-shape branch), not only the matched-but-ceilingless one", () => {
    const stubs: Array<{ modelId: string; applied: number }> = [];
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
      onStubFallback: (modelId, applied) => stubs.push({ modelId, applied }),
    });
    resolve("glm-5.3-flash-nonexistent", "high");
    expect(stubs).toEqual([{ modelId: "glm-5.3-flash-nonexistent", applied: DEFAULT_MAX_OUTPUT_TOKENS }]);
  });

  it("onStubFallback stays silent when the catalog declares a ceiling (nothing was defaulted)", () => {
    const stubs: unknown[] = [];
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
      onStubFallback: () => stubs.push(1),
    });
    resolve("glm-5.3", "high");
    expect(stubs).toEqual([]);
  });

  it("onStubFallback stays silent when an explicit env override is supplied (nothing was defaulted)", () => {
    const stubs: unknown[] = [];
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: 5_000,
      envContextWindow: undefined,
      onStubFallback: () => stubs.push(1),
    });
    resolve("glm-5.3-flash", "high");
    expect(stubs).toEqual([]);
  });

  // ── Taskana 4118: children get live caps for catalog-unknown models too ──

  it("Taskana 4118: catalog-unknown model + liveCapabilitiesFor keeps a tier inside the live vocabulary", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
      liveCapabilitiesFor: (modelId) =>
        modelId === "openrouter/foreign-model" ? { reasoning: true, effortLevels: ["high", "max"] } : undefined,
    });
    // Model id absent from the entry; live declares ["high","max"].
    expect(resolve("openrouter/foreign-model", "high").reasoningEffort).toBe("high");
    // "low" maps to nothing in the live vocabulary — dropped, fail-closed.
    expect(resolve("openrouter/foreign-model", "low").reasoningEffort).toBeUndefined();
    // Unknown to BOTH catalog and live ⇒ pre-4118 regression shape.
    expect(resolve("openrouter/unlisted-model", "high").reasoningEffort).toBeUndefined();
  });

  it("Taskana 4118: without the dep the resolver is unchanged (regression)", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    expect(resolve("openrouter/foreign-model", "high").reasoningEffort).toBeUndefined();
  });
});


it("uses a connection model-window resolver independently for each child", () => {
  const resolve = buildChildModelSettingsResolver({
    catalogEntry: undefined, envMaxOutputTokens: undefined, envContextWindow: undefined,
    contextWindowFor: (model) => model === "a" ? 128000 : 64000,
  });
  expect(resolve("a", undefined).contextWindowTokens).toBe(128000);
  expect(resolve("b", undefined).contextWindowTokens).toBe(64000);
});

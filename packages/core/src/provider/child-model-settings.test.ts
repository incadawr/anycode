/**
 * child-model-settings: composes the existing capabilities.ts resolvers
 * against a CHILD's own model id, never the parent's already-resolved values
 * (the F6 defect this module removes). Conservative-not-parent failure
 * semantics are the decisive property under test.
 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "../types/config.js";
import { buildChildModelSettingsResolver } from "./child-model-settings.js";

// Fixture entry, model-agnostic on purpose (this module has no A2 dependency):
// glm-5.3-flash mirrors the documented row A2 adds (no declared output
// ceiling, 1M context, low/high/max efforts); glm-5.3 mirrors the corrected
// row (a declared ceiling, same effort family).
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

  it("catalog-unknown model id degrades honestly: DEFAULT ceiling, effort dropped, DEFAULT window", () => {
    const resolve = buildChildModelSettingsResolver({
      catalogEntry: Z_AI_ENTRY,
      envMaxOutputTokens: undefined,
      envContextWindow: undefined,
    });
    expect(resolve("glm-5.3-flash-nonexistent", "high")).toEqual({
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: undefined,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
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
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
  });
});

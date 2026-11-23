/**
 * Reasoning for models the catalog does not list yet: a provider's
 * `unknownModelReasoning` profile supplies the effort vocabulary and default,
 * live facts take priority, and providers without a profile behave as before.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../types/model.js";
import { findCatalogEntry } from "./catalog-data.js";
import { buildChildModelSettingsResolver } from "./child-model-settings.js";
import { resolveEffortLevels, resolveChildReasoningEffort, resolveReasoningEffort, unknownModelProfileRow } from "./capabilities.js";
import { reasoningRequestOptions } from "./model-port.js";

const zai = findCatalogEntry("z-ai");
const minimax = findCatalogEntry("minimax");
const deepseek = findCatalogEntry("deepseek");

describe("unknownModelReasoning profile", () => {
  it("Z.AI: an unlisted 5.x model gets levels and the max default", () => {
    expect(resolveEffortLevels("glm-5.5", zai)).toEqual(["low", "high", "max"]);
    expect(resolveReasoningEffort("glm-5.5", zai, undefined)).toBe("max");
    expect(resolveReasoningEffort("glm-5.5", zai, "low")).toBe("low");
    expect(resolveReasoningEffort("GLM-6", zai, "high")).toBe("high");
  });

  it("Z.AI: an unsupported level is rejected, off is not offered", () => {
    expect(resolveReasoningEffort("glm-5.5", zai, "medium")).toBeUndefined();
    expect(resolveReasoningEffort("glm-5.5", zai, "off")).toBeUndefined();
  });

  it("Z.AI: the resolved effort reaches the wire options with thinking enabled and a budget", () => {
    const request = { reasoningEffort: resolveReasoningEffort("glm-5.5", zai, undefined) } as ModelRequest;
    expect(reasoningRequestOptions(request, "Z.AI (GLM)")).toEqual({
      providerOptions: { anthropic: { effort: "max", thinking: { type: "enabled", budgetTokens: 32_000 } } },
    });
  });

  it("Z.AI: a child session resolves the profile for its own model", () => {
    expect(resolveChildReasoningEffort("glm-5.5", zai, "xhigh")).toBe("max");
    const resolve = buildChildModelSettingsResolver({ catalogEntry: zai, envMaxOutputTokens: undefined, envContextWindow: undefined });
    expect(resolve("glm-5.5", "high").reasoningEffort).toBe("high");
    expect(resolve("glm-5.5", undefined).reasoningEffort).toBe("max");
  });

  it("does not touch listed models, retired models or ids outside the pattern", () => {
    expect(resolveEffortLevels("glm-4.7", zai)).toBeUndefined();
    expect(resolveEffortLevels("glm-5.1", zai)).toBeUndefined();
    expect(resolveEffortLevels("glm-5-turbo", zai)).toBeUndefined();
    expect(resolveEffortLevels("glm-4.6v", zai)).toBeUndefined();
    expect(resolveEffortLevels("glm-5.4v", zai)).toBeUndefined();
    expect(resolveReasoningEffort("glm-4.7", zai, "high")).toBeUndefined();
    expect(resolveEffortLevels("glm-5.2", zai)).toEqual(["off", "high", "max"]);
    expect(resolveReasoningEffort("glm-5.4", zai, undefined)).toBe("max");
  });

  it("live capabilities take priority over the profile", () => {
    expect(resolveEffortLevels("glm-5.5", zai, { reasoning: false })).toBeUndefined();
    expect(resolveReasoningEffort("glm-5.5", zai, "high", { reasoning: false })).toBeUndefined();
    expect(resolveEffortLevels("glm-5.5", zai, { reasoning: true, effortLevels: ["low", "medium"] })).toEqual(["low", "medium"]);
    expect(resolveReasoningEffort("glm-5.5", zai, "medium", { reasoning: true, effortLevels: ["low", "medium"] })).toBe("medium");
  });

  it("an explicit declared vocabulary wins over the profile levels", () => {
    expect(resolveEffortLevels("glm-5.5", zai, undefined, ["low", "high"])).toEqual(["low", "high"]);
  });

  it("MiniMax: an unlisted Flash version keeps always-on thinking with a max default", () => {
    expect(resolveEffortLevels("MiniMax-M3.2-Flash", minimax)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(resolveReasoningEffort("MiniMax-M3.2-Flash", minimax, undefined)).toBe("max");
    expect(resolveReasoningEffort("MiniMax-M3.2-Flash", minimax, "off")).toBe("max");
    expect(resolveEffortLevels("MiniMax-M3", minimax)).toBeUndefined();
    expect(resolveEffortLevels("MiniMax-M4", minimax)).toBeUndefined();
  });

  it("DeepSeek: unlisted V-series pro/flash get low/high/max, legacy ids do not", () => {
    expect(resolveEffortLevels("deepseek-v5-pro", deepseek)).toEqual(["low", "high", "max"]);
    expect(resolveReasoningEffort("deepseek-v4.2-flash", deepseek, undefined)).toBe("high");
    expect(resolveEffortLevels("deepseek-chat", deepseek)).toBeUndefined();
    expect(resolveEffortLevels("deepseek-reasoner", deepseek)).toBeUndefined();
  });

  it("providers without a profile keep the old behaviour", () => {
    for (const id of ["anthropic", "openai", "kimi", "moonshot", "xiaomi-mimo-api"]) {
      const entry = findCatalogEntry(id);
      expect(entry?.unknownModelReasoning).toBeUndefined();
      expect(resolveEffortLevels("brand-new-model-9", entry)).toBeUndefined();
      expect(resolveReasoningEffort("brand-new-model-9", entry, "high")).toBeUndefined();
    }
    expect(unknownModelProfileRow("glm-5.5", undefined)).toBeUndefined();
  });
});

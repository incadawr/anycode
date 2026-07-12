/**

 * override × catalog-hint × unknown-model, all fail-closed.
 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import {
  resolveContextWindow,
  resolveEffortLevels,
  resolveImageInput,
  resolveMaxOutputTokens,
  resolveReasoningEffort,
} from "./capabilities.js";

const VISION_ENTRY: CatalogProviderEntry = {
  id: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  defaultKind: "anthropic",
  auth: { kind: "api_key" },
  models: [
    { id: "claude-vision", name: "Claude Vision", contextWindow: 200_000, imageInput: true },
    { id: "claude-textonly", name: "Claude Text", contextWindow: 200_000 },
  ],
};

describe("resolveImageInput (slice 6.2 §2-B4, fail-closed)", () => {
  it("override 'on' wins even for an unmarked / unknown model", () => {
    expect(resolveImageInput("claude-textonly", VISION_ENTRY, "on")).toBe(true);
    expect(resolveImageInput("no-such-model", VISION_ENTRY, "on")).toBe(true);
    expect(resolveImageInput("anything", undefined, "on")).toBe(true);
  });

  it("override 'off' wins even for a marked model", () => {
    expect(resolveImageInput("claude-vision", VISION_ENTRY, "off")).toBe(false);
    expect(resolveImageInput("claude-vision", VISION_ENTRY, undefined)).toBe(true);
  });

  it("without override, an imageInput:true model resolves true", () => {
    expect(resolveImageInput("claude-vision", VISION_ENTRY, undefined)).toBe(true);
  });

  it("without override, an unmarked model resolves false", () => {
    expect(resolveImageInput("claude-textonly", VISION_ENTRY, undefined)).toBe(false);
  });

  it("without override, an unknown model id resolves false", () => {
    expect(resolveImageInput("ghost-model", VISION_ENTRY, undefined)).toBe(false);
  });

  it("without override, a missing entry resolves false", () => {
    expect(resolveImageInput("claude-vision", undefined, undefined)).toBe(false);
  });

  it("an entry with no matching model resolves false (custom endpoint case)", () => {
    const custom: CatalogProviderEntry = {
      id: "custom",
      name: "Custom",
      baseUrl: "",
      defaultKind: "anthropic",
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveImageInput("whatever-model", custom, undefined)).toBe(false);
    expect(resolveImageInput("whatever-model", custom, "on")).toBe(true);
  });
});

describe("output and reasoning capability resolution", () => {
  const entry: CatalogProviderEntry = { id: "z-ai", name: "Z.AI", baseUrl: "https://api.z.ai/api/anthropic", defaultKind: "anthropic", auth: { kind: "api_key" }, models: [
    { id: "glm-5.2", contextWindow: 200_000, maxOutputTokens: 32_768, reasoning: true, effortLevels: ["off", "high", "max"] },
    { id: "claude-test", contextWindow: 200_000, reasoning: true },
    { id: "glm-basic", contextWindow: 128_000, maxOutputTokens: 16_384 },
  ] };

  it("resolves env > catalog > non-Claude fallback while leaving Claude native", () => {
    expect(resolveMaxOutputTokens("glm-5.2", entry, 1234)).toBe(1234);
    expect(resolveMaxOutputTokens("glm-5.2", entry, undefined)).toBe(32_768);
    expect(resolveMaxOutputTokens("custom-model", entry, undefined)).toBe(8_192);
    expect(resolveMaxOutputTokens("claude-custom", entry, undefined)).toBeUndefined();
  });

  it("gates reasoning to known reasoning-capable models", () => {
    expect(resolveReasoningEffort("glm-5.2", entry, "high")).toBe("high");
    expect(resolveReasoningEffort("glm-5.2", entry, "low")).toBeUndefined();
    expect(resolveReasoningEffort("glm-basic", entry, "high")).toBeUndefined();
    expect(resolveReasoningEffort("custom-model", entry, "medium")).toBeUndefined();
    expect(resolveReasoningEffort("glm-5.2", entry, "off")).toBeUndefined();
  });

  it("resolves provider-declared effort levels for GLM and legacy Claude-style reasoning models", () => {
    expect(resolveEffortLevels("glm-5.2", entry)).toEqual(["off", "high", "max"]);
    expect(resolveEffortLevels("claude-test", entry)).toEqual(["off", "low", "medium", "high"]);
    expect(resolveEffortLevels("custom-model", entry)).toBeUndefined();
    expect(resolveEffortLevels("glm-basic", entry)).toBeUndefined();
    expect(resolveEffortLevels("glm-5.2", undefined)).toBeUndefined();
  });
});

const Z_AI_ENTRY: CatalogProviderEntry = {
  id: "z-ai",
  name: "Z.AI (GLM)",
  baseUrl: "https://api.z.ai/api/anthropic",
  defaultKind: "anthropic",
  auth: { kind: "api_key" },
  models: [
    { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200_000 },
    { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128_000 },
    { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128_000 },
  ],
};

describe("resolveContextWindow (slice 6.4 §2-B1, mirror of resolveImageInput)", () => {
  it("an explicit override wins even for a known model", () => {
    expect(resolveContextWindow("glm-4.5", Z_AI_ENTRY, 50_000)).toBe(50_000);
  });

  it("an explicit override wins for an unknown model / missing entry", () => {
    expect(resolveContextWindow("no-such-model", Z_AI_ENTRY, 50_000)).toBe(50_000);
    expect(resolveContextWindow("anything", undefined, 50_000)).toBe(50_000);
  });

  it("without override, a matched catalog model resolves its contextWindow", () => {
    expect(resolveContextWindow("glm-4.5", Z_AI_ENTRY, undefined)).toBe(128_000);
    expect(resolveContextWindow("glm-4.6", Z_AI_ENTRY, undefined)).toBe(200_000);
  });

  it("without override, an unknown model id resolves undefined", () => {
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, undefined)).toBeUndefined();
  });

  it("without override, a missing entry resolves undefined", () => {
    expect(resolveContextWindow("glm-4.5", undefined, undefined)).toBeUndefined();
  });

  it("an entry with no matching model resolves undefined (custom endpoint case)", () => {
    const custom: CatalogProviderEntry = {
      id: "custom",
      name: "Custom",
      baseUrl: "",
      defaultKind: "anthropic",
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveContextWindow("whatever-model", custom, undefined)).toBeUndefined();
    expect(resolveContextWindow("whatever-model", custom, 50_000)).toBe(50_000);
  });

  it("an id from a different entry does not match (entry-scoped, R4)", () => {
    expect(resolveContextWindow("claude-opus-4-20250514", Z_AI_ENTRY, undefined)).toBeUndefined();
  });
});

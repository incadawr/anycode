/**

 * override × catalog-hint × unknown-model, all fail-closed.
 */

import { describe, expect, it } from "vitest";
import type { CatalogProviderEntry } from "./catalog.js";
import { findCatalogEntry } from "./catalog-data.js";
import {
  liveEffortLevels,
  mapForeignEffortLevels,
  resolveContextWindow,
  resolveContextWindowInfo,
  resolveEffortLevels,
  resolveImageInput,
  resolveMaxOutputTokens,
  resolveReasoningEffort,
  UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
} from "./capabilities.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../types/config.js";
import { compactThresholdTokens, effectiveWindowTokens, resolveContextBudgetConfig } from "../context/budget.js";

const VISION_ENTRY: CatalogProviderEntry = {
  id: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  defaultTransport: "anthropic-messages",
  supportedTransports: ["anthropic-messages"],
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
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveImageInput("whatever-model", custom, undefined)).toBe(false);
    expect(resolveImageInput("whatever-model", custom, "on")).toBe(true);
  });
});

describe("output and reasoning capability resolution", () => {
  const entry: CatalogProviderEntry = { id: "z-ai", name: "Z.AI", baseUrl: "https://api.z.ai/api/anthropic", defaultTransport: "anthropic-messages", supportedTransports: ["anthropic-messages"], auth: { kind: "api_key" }, models: [
    { id: "glm-5.2", contextWindow: 200_000, maxOutputTokens: 32_768, reasoning: true, effortLevels: ["off", "high", "max"] },
    { id: "claude-test", contextWindow: 200_000, reasoning: true },
    { id: "glm-basic", contextWindow: 128_000, maxOutputTokens: 16_384 },
  ] };

  // TASK.159: an above-catalog override now CLAMPS (see the dedicated describe
  // below); this pin keeps the pre-existing arms that must not move — a legal
  // below-catalog override, the bare catalog hint, the non-Claude DEFAULT
  // fallback, and Claude's undefined native ceiling.
  it("resolves override ≤ catalog > fallback while leaving Claude native", () => {
    expect(resolveMaxOutputTokens("glm-5.2", entry, 1234)).toBe(1234);
    expect(resolveMaxOutputTokens("glm-5.2", entry, undefined)).toBe(32_768);
    // TASK.150: an on-prem / non-catalog model id lands on the DEFAULT, and 8_192
    // was low enough that a reasoning model spent the whole budget thinking and
    // finished at `length` before emitting a visible character. Pinned against
    // the two references measured 2026-08-23 (ZCode 32_000, Claude Code 32_000).
    expect(resolveMaxOutputTokens("custom-model", entry, undefined)).toBe(32_768);
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

// ── TASK.159 slice A: a hand-typed override no longer outruns the catalog — ──

describe("resolveMaxOutputTokens override × catalog clamp (TASK.159)", () => {
  const entry: CatalogProviderEntry = { id: "z-ai", name: "Z.AI", baseUrl: "https://api.z.ai/api/anthropic", defaultTransport: "anthropic-messages", supportedTransports: ["anthropic-messages"], auth: { kind: "api_key" }, models: [
    { id: "glm-5.2", contextWindow: 200_000, maxOutputTokens: 32_768, reasoning: true, effortLevels: ["off", "high", "max"] },
    { id: "claude-test", contextWindow: 200_000, reasoning: true },
    { id: "glm-basic", contextWindow: 128_000, maxOutputTokens: 16_384 },
  ] };

  it("override > catalog clamps to the catalog ceiling and reports it via onClamp", () => {
    const clamps: Array<{ requested: number; clamped: number; modelId: string }> = [];
    // A 65_536 override on a model pinned to 32_768 is a guaranteed provider
    // 400; the resolved value must be the ceiling, and the clamp must be
    // observable without spying on console.
    expect(resolveMaxOutputTokens("glm-5.2", entry, 65_536, (requested, clamped, modelId) => clamps.push({ requested, clamped, modelId }))).toBe(32_768);
    expect(clamps).toEqual([{ requested: 65_536, clamped: 32_768, modelId: "glm-5.2" }]);
  });

  it("a clamp at exact equality never fires (override == catalog passes, no report)", () => {
    const clamps: number[] = [];
    expect(resolveMaxOutputTokens("glm-5.2", entry, 32_768, (requested) => clamps.push(requested))).toBe(32_768);
    expect(clamps).toEqual([]);
  });

  it("override < catalog passes through unchanged and onClamp stays silent", () => {
    const clamps: number[] = [];
    expect(resolveMaxOutputTokens("glm-basic", entry, 4_096, (requested) => clamps.push(requested))).toBe(4_096);
    expect(clamps).toEqual([]);
  });

  it("no catalog ceiling for the matched model -> override wins as-is, unclamped", () => {
    // claude-test declares no maxOutputTokens; the claude- branch sits AFTER
    // the lookup, so an explicit override still reaches the wire untouched.
    expect(resolveMaxOutputTokens("claude-test", entry, 65_536)).toBe(65_536);
  });

  it("no entry / no model match -> override passes through (TASK.151 not regressed)", () => {
    expect(resolveMaxOutputTokens("glm-5.2", undefined, 999_999)).toBe(999_999);
    expect(resolveMaxOutputTokens("on-prem-model", entry, 999_999)).toBe(999_999);
  });

  it("without an onClamp argument the clamp still resolves correctly (callers unchanged)", () => {
    expect(resolveMaxOutputTokens("glm-5.2", entry, 65_536)).toBe(32_768);
  });
});

const Z_AI_ENTRY: CatalogProviderEntry = {
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

describe("resolveContextWindowInfo provenance (Taskana 4127)", () => {
  it("a catalog model reports source catalog", () => {
    expect(resolveContextWindowInfo("glm-4.5", Z_AI_ENTRY, undefined)).toEqual({ tokens: 128_000, source: "catalog" });
  });

  it("an explicit override (also for an unknown model, or a matching binding) reports source override", () => {
    expect(resolveContextWindowInfo("glm-4.5", Z_AI_ENTRY, 50_000)).toEqual({ tokens: 50_000, source: "override" });
    expect(resolveContextWindowInfo("ghost", undefined, 50_000, "ghost")).toEqual({ tokens: 50_000, source: "override" });
  });

  it("an unknown model with no applicable override is assumed at 8192", () => {
    expect(resolveContextWindowInfo("ghost", Z_AI_ENTRY, undefined)).toEqual({ tokens: 8_192, source: "assumed" });
    expect(resolveContextWindowInfo("ghost", undefined, 50_000, "other-model")).toEqual({ tokens: 8_192, source: "assumed" });
  });
});

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

  it("without override, a model's usableContextWindow caps its advertised window; an override still wins", () => {
    const entry: CatalogProviderEntry = {
      ...Z_AI_ENTRY,
      models: [{ id: "big", contextWindow: 1_000_000, usableContextWindow: 300_000 }],
    };
    expect(resolveContextWindow("big", entry, undefined)).toBe(300_000);
    expect(resolveContextWindow("big", entry, 800_000)).toBe(800_000);
  });

  it("the shipped GLM-5.x rows budget at 300k, not their advertised 1M (owner, 2026-10-07)", () => {
    const zai = findCatalogEntry("z-ai");
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.2"]) {
      expect(resolveContextWindow(id, zai, undefined)).toBe(300_000);
    }
  });

  it("without override, an unknown model id resolves the ASSUMED 8192 fallback (TASK.142)", () => {
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, undefined)).toBe(8_192);
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, undefined)).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS);
  });

  it("without override, a missing entry resolves the ASSUMED 8192 fallback (TASK.142)", () => {
    expect(resolveContextWindow("glm-4.5", undefined, undefined)).toBe(8_192);
  });

  it("an entry with no matching model resolves the ASSUMED 8192 fallback (custom endpoint case)", () => {
    const custom: CatalogProviderEntry = {
      id: "custom",
      name: "Custom",
      baseUrl: "",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [],
    };
    expect(resolveContextWindow("whatever-model", custom, undefined)).toBe(8_192);
    expect(resolveContextWindow("whatever-model", custom, 50_000)).toBe(50_000);
  });

  it("an id from a different entry does not match (entry-scoped, R4)", () => {
    expect(resolveContextWindow("claude-opus-4-20250514", Z_AI_ENTRY, undefined)).toBe(8_192);
  });

  it("a bound override applies to ITS model only; a mismatched binding falls through to the catalog, not the override (TASK.142)", () => {
    // A-bound override on A: the override wins over the catalog.
    expect(resolveContextWindow("glm-4.5", Z_AI_ENTRY, 50_000, "glm-4.5")).toBe(50_000);
    // A-bound override on B: ignored; B resolves through the catalog.
    expect(resolveContextWindow("glm-4.6", Z_AI_ENTRY, 50_000, "glm-4.5")).toBe(200_000);
    // A-bound override on an unknown model: ignored; the assumed fallback applies.
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, 50_000, "glm-4.5")).toBe(8_192);
  });

  it("a shell-global override (no binding) still wins over the catalog and over the assumed fallback", () => {
    expect(resolveContextWindow("glm-4.5", Z_AI_ENTRY, 50_000, undefined)).toBe(50_000);
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, 50_000, undefined)).toBe(50_000);
  });

  it("a mismatched binding WITH a catalog match uses the catalog window, not the override", () => {
    expect(resolveContextWindow("glm-4.6", Z_AI_ENTRY, 50_000, "other-model")).toBe(200_000);
  });

  it("a binding with NO override changes nothing (inert binding)", () => {
    expect(resolveContextWindow("glm-4.5", Z_AI_ENTRY, undefined, "glm-4.5")).toBe(128_000);
    expect(resolveContextWindow("ghost-model", Z_AI_ENTRY, undefined, "ghost-model")).toBe(8_192);
  });

  it("the 8192 assumed fallback produces the degraded-window budget the contract computes (TASK.142)", () => {
    const applied = resolveContextWindow("on-prem-8b", undefined, undefined);
    expect(applied).toBe(8_192);
    expect(effectiveWindowTokens(resolveContextBudgetConfig({ contextWindowTokens: applied }))).toBe(2_048);
    expect(compactThresholdTokens(resolveContextBudgetConfig({ contextWindowTokens: applied }))).toBe(1_884);
  });
});

// ── TASK.170: a child spawned on a catalog-known non-claude model must resolve ──
// ── ITS OWN declared ceiling, never the DEFAULT_MAX_OUTPUT_TOKENS stub. ──

describe("resolveMaxOutputTokens catalog completeness (TASK.170, real catalog)", () => {
  it("glm-5.3-flash resolves its own declared ceiling, not the DEFAULT stub", () => {
    const zAiEntry = findCatalogEntry("z-ai");
    expect(zAiEntry).toBeDefined();
    // Parent: glm-5.3 explicitly declares 131_072 in the catalog.
    expect(resolveMaxOutputTokens("glm-5.3", zAiEntry, undefined)).toBe(131_072);
    // Child: before TASK.170, glm-5.3-flash had no maxOutputTokens row, so a
    // subagent spawned on the flash model silently fell to
    // DEFAULT_MAX_OUTPUT_TOKENS (32_768) here — a ~4x drop from the parent's
    // 131_072 for no reason other than a missing catalog row. It must now
    // resolve to its OWN catalog ceiling instead.
    expect(resolveMaxOutputTokens("glm-5.3-flash", zAiEntry, undefined)).toBe(131_072);
    expect(resolveMaxOutputTokens("glm-5.3-flash", zAiEntry, undefined)).not.toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

// ── TASK.170: the DEFAULT_MAX_OUTPUT_TOKENS stub must no longer be silent — ──
// ── an optional onStubFallback callback fires exactly when the catalog truly ──
// ── knows nothing (mirrors onClamp's shape/contract, TASK.159). ──

describe("resolveMaxOutputTokens stub-fallback notice (TASK.170)", () => {
  const entry: CatalogProviderEntry = {
    id: "z-ai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/anthropic",
    defaultTransport: "anthropic-messages",
    supportedTransports: ["anthropic-messages"],
    auth: { kind: "api_key" },
    models: [
      { id: "glm-basic", contextWindow: 128_000, maxOutputTokens: 16_384 },
      { id: "claude-test", contextWindow: 200_000, reasoning: true },
    ],
  };

  it("fires onStubFallback exactly once when the catalog has no ceiling and none is overridden", () => {
    const stubs: Array<{ modelId: string; applied: number }> = [];
    const result = resolveMaxOutputTokens("ghost-model", entry, undefined, undefined, (modelId, applied) =>
      stubs.push({ modelId, applied }),
    );
    expect(result).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(stubs).toEqual([{ modelId: "ghost-model", applied: DEFAULT_MAX_OUTPUT_TOKENS }]);
  });

  it("stays silent when the catalog declares a ceiling (nothing was defaulted)", () => {
    const stubs: number[] = [];
    expect(resolveMaxOutputTokens("glm-basic", entry, undefined, undefined, () => stubs.push(1))).toBe(16_384);
    expect(stubs).toEqual([]);
  });

  it("stays silent for claude- models (undefined native ceiling is intentional, not a stub)", () => {
    const stubs: number[] = [];
    expect(resolveMaxOutputTokens("claude-test", entry, undefined, undefined, () => stubs.push(1))).toBeUndefined();
    expect(stubs).toEqual([]);
  });

  it("stays silent when an explicit override is supplied (nothing was defaulted)", () => {
    const stubs: number[] = [];
    expect(resolveMaxOutputTokens("ghost-model", entry, 12_000, undefined, () => stubs.push(1))).toBe(12_000);
    expect(stubs).toEqual([]);
  });

  it("without an onStubFallback argument the stub still resolves correctly (callers unchanged)", () => {
    expect(resolveMaxOutputTokens("ghost-model", entry, undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

// ── Taskana 4118: live capabilities supplement the catalog (never override) ──

describe("Taskana 4118 — live capabilities supplement the catalog", () => {
  const entry: CatalogProviderEntry = { id: "z-ai", name: "Z.AI", baseUrl: "https://api.z.ai/api/anthropic", defaultTransport: "anthropic-messages", supportedTransports: ["anthropic-messages"], auth: { kind: "api_key" }, models: [
    { id: "glm-5.2", contextWindow: 200_000, reasoning: true, effortLevels: ["off", "high", "max"] },
    { id: "glm-basic", contextWindow: 128_000 },
  ] };

  it("mapForeignEffortLevels keeps exact-name matches in source order, dedupes, drops the rest", () => {
    expect(mapForeignEffortLevels(["xhigh", "high", "low", "minimal"])).toEqual(["high", "low"]);
    // Case-sensitive by design: HIGH is a foreign spelling, not our enum value.
    expect(mapForeignEffortLevels(["high", "HIGH"])).toEqual(["high"]);
    expect(mapForeignEffortLevels([])).toEqual([]);
    expect(mapForeignEffortLevels(["xhigh", "minimal", "none", "default"])).toEqual([]);
  });

  it("liveEffortLevels: reasoning!==true ⇒ undefined; no efforts ⇒ legacy four; all-unknown ⇒ undefined", () => {
    expect(liveEffortLevels(undefined)).toBeUndefined();
    expect(liveEffortLevels({ reasoning: false })).toBeUndefined();
    expect(liveEffortLevels({})).toBeUndefined();
    expect(liveEffortLevels({ reasoning: true })).toEqual(["off", "low", "medium", "high"]);
    expect(liveEffortLevels({ reasoning: true, effortLevels: [] })).toEqual(["off", "low", "medium", "high"]);
    expect(liveEffortLevels({ reasoning: true, effortLevels: ["xhigh"] })).toBeUndefined();
    expect(liveEffortLevels({ reasoning: true, effortLevels: ["high", "xhigh", "max"] })).toEqual(["high", "max"]);
  });

  it("resolveEffortLevels: catalog match is unchanged, with AND without live meta", () => {
    // D-Priority: live must not narrow (or widen) a catalog-known model's list.
    expect(resolveEffortLevels("glm-5.2", entry)).toEqual(["off", "high", "max"]);
    expect(resolveEffortLevels("glm-5.2", entry, { reasoning: true, effortLevels: ["low"] })).toEqual(["off", "high", "max"]);
    // A catalog model without reasoning stays undefined even with live meta.
    expect(resolveEffortLevels("glm-basic", entry, { reasoning: true, effortLevels: ["high"] })).toBeUndefined();
  });

  it("resolveEffortLevels: catalog miss consults live", () => {
    expect(resolveEffortLevels("unknown-reasoner", entry, { reasoning: true })).toEqual(["off", "low", "medium", "high"]);
    expect(resolveEffortLevels("unknown-reasoner", entry, { reasoning: true, effortLevels: ["high", "max"] })).toEqual(["high", "max"]);
    // No live ⇒ pre-4118 behaviour (undefined) is unchanged.
    expect(resolveEffortLevels("unknown-model", entry)).toBeUndefined();
    expect(resolveEffortLevels("unknown-model", entry, { reasoning: true, effortLevels: ["xhigh"] })).toBeUndefined();
  });

  it("resolveReasoningEffort: catalog-miss override must be inside the live vocabulary", () => {
    const live = { reasoning: true, effortLevels: ["high", "max"] };
    expect(resolveReasoningEffort("unknown-reasoner", entry, "high", live)).toBe("high");
    expect(resolveReasoningEffort("unknown-reasoner", entry, "medium", live)).toBeUndefined();
    expect(resolveReasoningEffort("unknown-reasoner", entry, "high")).toBeUndefined();
    expect(resolveReasoningEffort("unknown-reasoner", entry, "high", { reasoning: true, effortLevels: ["xhigh"] })).toBeUndefined();
  });
});

/**
 * Unit tests for `resolveProviderConnection` (TASK.102 CUT-S2 §10.9.3, F4):
 * the pure policy behind an EXPLICIT `Agent(tier:"session", provider:…)`
 * spawn's provider-id -> connection resolution. This is the shared/settings.ts
 * half of F4 — `main/index.ts` wires it into `TabHostManager`'s
 * `resolveProviderConnection` dep (`main/tabs.ts:539`) via a one-line adapter;
 * this file discriminates the POLICY itself (active-wins / first-by-order /
 * bare-sentinel / unknown-provider), not merely the symbol's existence.
 */

import { describe, expect, it } from "vitest";
import type { AnycodeSettings } from "./settings.js";
import { activeProviderView, mergeModelIds, normalizeModelId, resolveProviderConnection } from "./settings.js";
import { connectionFixture, providerV2Multi } from "./provider-v2-fixture.js";

function settingsWith(activeConnectionId: string | undefined, connections: ReturnType<typeof connectionFixture>[]): AnycodeSettings {
  return {
    version: 2,
    provider: providerV2Multi(activeConnectionId, connections),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

describe("resolveProviderConnection (TASK.102 CUT-S2 §10.9.3 F4)", () => {
  it("the active connection wins when it matches the requested providerId, even though a later connection also matches", () => {
    const active = connectionFixture({ id: "anthropic", connectionId: "conn-active" });
    const other = connectionFixture({ id: "anthropic", connectionId: "conn-other" });
    const settings = settingsWith("conn-active", [other, active]);

    const resolved = resolveProviderConnection(settings, "anthropic");

    expect(resolved?.id).toBe("conn-active");
  });

  it("falls back to the first-by-storage-order match when no connection is active", () => {
    const first = connectionFixture({ id: "openai", connectionId: "conn-first" });
    const second = connectionFixture({ id: "openai", connectionId: "conn-second" });
    const settings = settingsWith(undefined, [first, second]);

    const resolved = resolveProviderConnection(settings, "openai");

    expect(resolved?.id).toBe("conn-first");
  });

  it("falls back to the first-by-storage-order match when the active connection's providerId does not match the request", () => {
    const active = connectionFixture({ id: "anthropic", connectionId: "conn-active" });
    const firstMatch = connectionFixture({ id: "openai", connectionId: "conn-first" });
    const secondMatch = connectionFixture({ id: "openai", connectionId: "conn-second" });
    const settings = settingsWith("conn-active", [firstMatch, secondMatch]);

    const resolved = resolveProviderConnection(settings, "openai");

    expect(resolved?.id).toBe("conn-first");
  });

  it("the bare/custom sentinel providerId (\"\") never resolves, even if a bare connection is active", () => {
    const bare = connectionFixture({ connectionId: "conn-legacy" });
    const settings = settingsWith("conn-legacy", [bare]);

    expect(resolveProviderConnection(settings, "")).toBeUndefined();
  });

  it("an unknown/deleted providerId resolves to undefined", () => {
    const known = connectionFixture({ id: "anthropic", connectionId: "conn-known" });
    const settings = settingsWith("conn-known", [known]);

    expect(resolveProviderConnection(settings, "z-ai")).toBeUndefined();
  });

  it("resolves to undefined against an empty connections list (fresh install)", () => {
    const settings = settingsWith(undefined, []);

    expect(resolveProviderConnection(settings, "anthropic")).toBeUndefined();
  });
});

describe("activeProviderView — connection-level authOptional projection (TASK.152)", () => {
  it("projects authOptional === true for a connection that declares it", () => {
    const settings = settingsWith("conn-legacy", [
      connectionFixture({ id: "custom", model: "m", authOptional: true }),
    ]);

    expect(activeProviderView(settings).authOptional).toBe(true);
  });

  it("projects NO authOptional key for a connection without the flag", () => {
    const settings = settingsWith("conn-legacy", [
      connectionFixture({ id: "custom", model: "m" }),
    ]);

    expect("authOptional" in activeProviderView(settings)).toBe(false);
  });
});

describe("normalizeModelId (TASK.183: durable manually entered models)", () => {
  it("accepts an unknown id with slash/colon/dot/dash and arbitrary vendor characters, unchanged", () => {
    expect(normalizeModelId("deepseek-ai/DeepSeek-V3.1")).toBe("deepseek-ai/DeepSeek-V3.1");
    expect(normalizeModelId("openai/gpt-5:2026-01-01")).toBe("openai/gpt-5:2026-01-01");
    expect(normalizeModelId("meta-llama/Llama-3.3-70B-Instruct")).toBe("meta-llama/Llama-3.3-70B-Instruct");
  });

  it("accepts Unicode and preserves case", () => {
    expect(normalizeModelId("qwen3-Модель")).toBe("qwen3-Модель");
    expect(normalizeModelId("模型-α")).toBe("模型-α");
    expect(normalizeModelId("GLM-5.3")).toBe("GLM-5.3");
  });

  it("trims ordinary surrounding spaces only", () => {
    expect(normalizeModelId("  glm-4.6  ")).toBe("glm-4.6");
    expect(normalizeModelId("\tglm-4.6\t")).toBeNull();
    expect(normalizeModelId("\nglm-4.6\n")).toBeNull();
  });

  it("has no arbitrary length cap", () => {
    const long = "m".repeat(5000);
    expect(normalizeModelId(long)).toBe(long);
  });

  it("rejects empty/space-only, non-strings, and interior whitespace", () => {
    expect(normalizeModelId("")).toBeNull();
    expect(normalizeModelId("   ")).toBeNull();
    expect(normalizeModelId(null)).toBeNull();
    expect(normalizeModelId(7)).toBeNull();
    expect(normalizeModelId({ id: "x" })).toBeNull();
    expect(normalizeModelId("glm 4.6")).toBeNull();
    expect(normalizeModelId("glm\t4.6")).toBeNull();
  });

  it("rejects C0/C1 controls anywhere, including a leading/trailing newline or tab", () => {
    expect(normalizeModelId("\n")).toBeNull();
    expect(normalizeModelId("\t")).toBeNull();
    expect(normalizeModelId("glm-\n4.6")).toBeNull();
    expect(normalizeModelId("glm-4.6\u0000")).toBeNull();
    expect(normalizeModelId("glm-4.6\u007f")).toBeNull();
    expect(normalizeModelId("glm-4.6\u009f")).toBeNull();
  });
});

describe("mergeModelIds (TASK.183: stable primary-first union)", () => {
  it("dedupes case-sensitively, keeping the first occurrence's order", () => {
    expect(mergeModelIds(["a", "b", "a"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeModelIds(["GLM-5"], ["glm-5"])).toEqual(["GLM-5", "glm-5"]);
  });

  it("trims ids and drops empties", () => {
    expect(mergeModelIds([" a ", "", "  "], [" b "])).toEqual(["a", "b"]);
  });

  it("is primary-first: existing stored order survives, manual additions append", () => {
    expect(mergeModelIds(["fetched-1", "fetched-2"], ["manual-1"])).toEqual(["fetched-1", "fetched-2", "manual-1"]);
  });

  it("preserves legacy nonempty ids verbatim (no retrospective re-validation)", () => {
    expect(mergeModelIds(["legacy id with spaces"])).toEqual(["legacy id with spaces"]);
  });

  it("defaults the secondary list to empty", () => {
    expect(mergeModelIds(["a"])).toEqual(["a"]);
  });
});

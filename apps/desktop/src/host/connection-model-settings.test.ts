import { describe, expect, it } from "vitest";
import { resolveEffortLevels, resolveReasoningEffort, type ReasoningEffort } from "@anycode/core";
import { createConnectionModelSettings, nearestSupportedEffort } from "./connection-model-settings.js";
import { findCatalogEntry } from "@anycode/core/catalog";
import { createHarness } from "./test-harness.js";

const connection = {
  modelOverrides: {
    a: { contextWindowTokens: 128_000, reasoningEffort: "max" as const, reasoningSupported: true as const },
    b: { contextWindowTokens: 64_000, reasoningEffort: "low" as const, reasoningSupported: true as const },
  },
};
const make = () => createConnectionModelSettings({ connection, liveCapabilitiesFor: () => undefined });

describe("connection model settings (GitHub #26)", () => {
  it("resolves independent windows and an unknown sibling without inheriting the parent's window", () => {
    const settings = make();
    expect(settings.contextFor("a")).toEqual({ tokens: 128_000, source: "override" });
    expect(settings.contextFor("b")).toEqual({ tokens: 64_000, source: "override" });
    expect(settings.contextFor("unknown")).toEqual({ tokens: 8192, source: "assumed" });
  });

  it("preserves shell-global and model-bound context overrides ahead of the saved map", () => {
    const global = createConnectionModelSettings({ connection, liveCapabilitiesFor: () => undefined, envContextWindow: 32_000 });
    expect(global.contextFor("b").tokens).toBe(32_000);
    const bound = createConnectionModelSettings({ connection, liveCapabilitiesFor: () => undefined, envContextWindow: 32_000, envContextWindowModel: "a" });
    expect(bound.contextFor("a").tokens).toBe(32_000);
    expect(bound.contextFor("b").tokens).toBe(64_000);
  });

  it("keeps selected effort through a model that suppresses reasoning, and restores each model's own selection", () => {
    const settings = make();
    expect(settings.switchEffort("a", "b", "max")).toBe("low");
    expect(settings.switchEffort("b", "unknown", "low")).toBe("off");
    expect(settings.switchEffort("unknown", "a", "off")).toBe("max");
    settings.remember("a", "high");
    expect(settings.switchEffort("a", "b", "high")).toBe("low");
    expect(settings.switchEffort("b", "a", "low")).toBe("high");
  });

  it("an explicit queued choice wins over the destination's saved selection", () => {
    const settings = make();
    settings.remember("a", "max");
    expect(settings.switchEffort("a", "b", "high", true)).toBe("high");
    expect(settings.switchEffort("b", "a", "high")).toBe("max");
  });

  it("keeps shell-global off across models while a settings-bound effort applies to its own model", () => {
    const global = createConnectionModelSettings({ connection, liveCapabilitiesFor: () => undefined, envReasoningEffort: "off" });
    expect(global.switchEffort("a", "b", "off")).toBe("off");
    const bound = createConnectionModelSettings({ connection, liveCapabilitiesFor: () => undefined, envReasoningEffort: "max", envReasoningEffortModel: "a" });
    expect(bound.switchEffort("a", "b", "max")).toBe("low");
  });

  it("a manual reasoning declaration exposes levels on a custom model without metadata", () => {
    const settings = make();
    expect(resolveEffortLevels("a", undefined, settings.capabilitiesFor("a"))).toContain("max");
    expect(resolveReasoningEffort("a", undefined, "max", settings.capabilitiesFor("a"))).toBe("max");
    expect(resolveEffortLevels("unknown", undefined, settings.capabilitiesFor("unknown"))).toBeUndefined();
  });

  it("restores the selected tier through the real Session and CoreEngine, including an explicit edit after switching", async () => {
    const settings = make();
    let currentModel = "a";
    const h = createHarness({
      steps: [], selectedEffort: "max", reasoningSupported: true,
      availableEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      switchModel: (id, tier, explicit) => {
        const selectedReasoningEffort = settings.switchEffort(currentModel, id, tier ?? "off", explicit);
        currentModel = id;
        return {
          model: id, selectedReasoningEffort,
          reasoningEffort: resolveReasoningEffort(id, undefined, selectedReasoningEffort, settings.capabilitiesFor(id)) ?? "off",
          availableEffortLevels: resolveEffortLevels(id, undefined, settings.capabilitiesFor(id)),
        };
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((message) => message.type === "host_ready");
      const switchTo = async (model: string, effort: ReasoningEffort) => {
        const count = h.received.filter((m) => m.type === "model_changed").length;
        h.send({ type: "set_model", model });
        await h.waitUntil(() => h.received.filter((m) => m.type === "model_changed").length > count);
        expect(h.received.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ model, reasoningEffort: effort });
      };
      await switchTo("b", "low");
      await switchTo("unknown", "off");
      await switchTo("a", "max");
      h.send({ type: "set_reasoning_effort", effort: "high" });
      await h.waitFor((m) => m.type === "reasoning_effort_changed");
      await switchTo("b", "low");
      await switchTo("a", "high");
    } finally {
      h.close();
    }
  });
});


it("reloads saved windows and invalidates cached effort on a running session's model switches", () => {
  let persisted: NonNullable<Parameters<typeof createConnectionModelSettings>[0]["connection"]> = structuredClone(connection);
  const settings = createConnectionModelSettings({
    connection: persisted, readConnection: () => persisted, liveCapabilitiesFor: () => undefined,
    envContextWindow: 128000, envContextWindowModel: "a", envContextWindowFromSettings: true,
    envReasoningEffort: "max", envReasoningEffortModel: "a", envReasoningEffortFromSettings: true,
  });
  settings.remember("a", "max");
  expect(settings.switchEffort("a", "b", "max")).toBe("low");
  persisted = {
    modelOverrides: {
      a: { ...persisted.modelOverrides?.a, contextWindowTokens: 96000, reasoningEffort: "medium" },
      b: { ...persisted.modelOverrides?.b, contextWindowTokens: 80000, reasoningEffort: "high" },
    },
  };
  expect(settings.switchEffort("b", "a", "low")).toBe("medium");
  expect(settings.contextFor("a").tokens).toBe(96000);
  expect(settings.switchEffort("a", "b", "medium")).toBe("high");
  expect(settings.contextFor("b").tokens).toBe(80000);
});

it("applies a cleared override at the next safe refresh instead of restoring its boot environment value", () => {
  let persisted: Parameters<typeof createConnectionModelSettings>[0]["connection"] = structuredClone(connection);
  const settings = createConnectionModelSettings({
    connection: persisted, readConnection: () => persisted, liveCapabilitiesFor: () => undefined,
    envContextWindow: 128000, envContextWindowModel: "a", envContextWindowFromSettings: true,
    envReasoningEffort: "max", envReasoningEffortModel: "a", envReasoningEffortFromSettings: true,
  });
  settings.remember("a", "max");
  persisted = { modelOverrides: {} };
  expect(settings.refresh()).toBe(true);
  expect(settings.switchEffort("a", "a", "max")).toBe("off");
  expect(settings.contextFor("a")).toEqual({ tokens: 8192, source: "assumed" });
});

it("keeps real shell overrides authoritative when connection settings are refreshed", () => {
  let persisted: Parameters<typeof createConnectionModelSettings>[0]["connection"] = structuredClone(connection);
  const settings = createConnectionModelSettings({
    connection: persisted, readConnection: () => persisted, liveCapabilitiesFor: () => undefined,
    envContextWindow: 32000, envReasoningEffort: "off",
  });
  persisted = { modelOverrides: { b: {contextWindowTokens: 96000, reasoningEffort: "high"} } };
  expect(settings.switchEffort("a", "b", "off")).toBe("off");
  expect(settings.contextFor("b").tokens).toBe(32000);
});



it("uses boot settings until a read succeeds, then honours a clear instead of a stale env backup", () => {
  let readable = false;
  const settings = createConnectionModelSettings({
    readConnection: () => readable ? {} : null,
    envContextWindow:128000, envContextWindowFromSettings:true,
    envReasoningEffort:"high", envReasoningEffortFromSettings:true,
    liveCapabilitiesFor:() => undefined,
  });
  settings.remember("a", "high");
  expect(settings.contextFor("a").tokens).toBe(128000);
  expect(settings.effortFor("a")).toBe("high");
  expect(settings.refresh()).toBe(false);
  readable = true;
  expect(settings.refresh()).toBe(true);
  expect(settings.contextFor("a").tokens).toBe(8192);
  expect(settings.effortFor("a")).toBeUndefined();
  expect(settings.switchEffort("a", "a", "high")).toBe("off");
});


it("retains the last pricing snapshot on an unreadable read and refreshes on recovery", () => {
  let saved: any = { pricing: { mode: "subscription" }, modelOverrides: { a: { pricing: { input: 1, cachedInput: 0, output: 2 } } } };
  const settings = createConnectionModelSettings({ connection: saved, readConnection: () => saved, liveCapabilitiesFor: () => undefined });
  const before = settings.pricingSnapshot();
  saved = null;
  expect(settings.refresh()).toBe(false);
  expect(settings.pricingSnapshot()).toEqual(before);
  saved = { modelOverrides: { a: { pricing: { input: 3, cachedInput: 0, output: 4 } } } };
  expect(settings.refresh()).toBe(true);
  expect(settings.pricingSnapshot()).toEqual({ fallback: undefined, models: { a: { input: 3, cachedInput: 0, output: 4 } } });
});


describe("nearest supported effort", () => {
  it.each([
    ["off", ["low", "max"], "low"],
    ["medium", ["high", "low"], "low"],
    ["max", ["low", "high"], "high"],
    ["high", ["max", "off"], "max"],
    ["low", [], "low"],
  ] as const)("maps %s against %s to %s", (tier, levels, expected) => {
    expect(nearestSupportedEffort(tier, [...levels])).toBe(expected);
  });
});


describe("catalog model switch effort", () => {
  const catalogEntry = findCatalogEntry("z-ai")!;
  const makeSettings = (connection: Parameters<typeof createConnectionModelSettings>[0]["connection"] = {}) =>
    createConnectionModelSettings({ connection, catalogEntry, liveCapabilitiesFor: () => undefined });

  it("restores the documented default and the source preference", () => {
    const settings = makeSettings({modelOverrides:{"glm-5.2":{reasoningEffort:"off"}}});
    expect(settings.switchEffort("glm-5.2", "glm-5.3", "off")).toBe("max");
    expect(settings.switchEffort("glm-5.3", "glm-5.2", "max")).toBe("off");
  });
  it.each([
    {reasoningEffort:"off" as const},
    {modelOverrides:{"glm-5.3":{reasoningEffort:"off" as const}}},
  ])("normalizes an unsupported saved candidate", (connection) => {
    const settings = makeSettings(connection);
    expect(settings.switchEffort("glm-5.2", "glm-5.3", "off")).toBe("low");
    expect(settings.takeAdjustment()).toEqual({from:"off", to:"low"});
    expect(settings.switchEffort("glm-5.3", "glm-5.3", "low")).toBe("low");
    expect(settings.takeAdjustment()).toBeUndefined();
  });
  it("normalizes an explicit switch while retaining the source", () => {
    const settings = makeSettings({modelOverrides:{"glm-5.2":{reasoningEffort:"off"}}});
    expect(settings.switchEffort("glm-5.2", "glm-5.3", "off", true)).toBe("low");
    expect(settings.switchEffort("glm-5.3", "glm-5.2", "low")).toBe("off");
    expect(settings.normalize("glm-5.3", "off")).toBe("low");
  });
  it("uses the previous level when a model has no recorded default", () => {
    const settings = makeSettings();
    expect(settings.switchEffort("glm-5.2", "glm-5.3-flash", "off")).toBe("low");
  });
});

it("declared levels override fetched levels when normalizing a model switch", () => {
  const settings = createConnectionModelSettings({
    connection: { modelOverrides: { b: { effortLevels: ["low", "high"] } } },
    liveCapabilitiesFor: () => ({ reasoning: true, effortLevels: ["off", "max"] }),
  });
  expect(settings.switchEffort("a", "b", "off", true)).toBe("low");
  expect(settings.takeAdjustment()).toEqual({ from: "off", to: "low" });
  expect(settings.normalize("b", "max")).toBe("high");
});

it("refreshes manual vocabularies without borrowing a sibling's levels", () => {
  let saved = { modelOverrides: { a: { effortLevels: ["low", "high"] as ReasoningEffort[] } } };
  const settings = createConnectionModelSettings({ readConnection: () => saved, liveCapabilitiesFor: () => undefined });
  settings.refresh();
  expect(settings.effortLevelsFor("a")).toEqual(["low", "high"]);
  expect(settings.effortLevelsFor("constructor")).toBeUndefined();
  saved = { modelOverrides: { a: { effortLevels: ["xhigh"] } } };
  settings.refresh();
  expect(settings.effortLevelsFor("a")).toEqual(["xhigh"]);
});

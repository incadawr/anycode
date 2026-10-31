import { describe, expect, it } from "vitest";
import type { CatalogSummary, ProviderConnection } from "../../shared/settings.js";
import { resolveRoleModels, roleModelSelection, pickEngineModels, routePatch, nextCustomMode } from "./role-model-options.js";
import { CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
import { addFallback, patchEntry, moveFallback, toDraft, fromDraft, fromDraftEntry, toDraftEntry, sameDraftChoice } from "./role-editor-model.js";

const catalog: CatalogSummary = [{ id: "vendor", name: "Vendor", authKind: "api_key", models: [
  { id: "new", name: "New model" }, { id: "old" },
] }];
const connections: ProviderConnection[] = [
  { id: "active", providerId: "vendor", models: ["live", "old", "live"] },
  { id: "custom", providerId: "custom:test" },
];
const sources = {
  connections, activeConnectionId: "active", catalog,
  custom: [{ id: "custom:test", name: "Test", baseUrl: "https://example.com", kind: "openai-compatible" as const, models: ["custom-model"] }],
  engineModels: { claude: [{ id: "sonnet", label: "Sonnet" }], codex: [{ id: "codex-live", label: "Codex live" }] },
};

describe("role route model options", () => {
  it("uses the composer's catalog-first union for This connection, preserving labels and deduplicating live ids", () => {
    expect(resolveRoleModels(toDraftEntry(undefined), sources)).toEqual([
      { id: "new", name: "New model" }, { id: "old" }, { id: "live" },
    ]);
  });
  it("resolves an explicit custom connection instead of the active connection", () => {
    expect(resolveRoleModels(toDraftEntry({ connection: "custom" }), sources)).toEqual([{ id: "custom-model" }]);
  });
  it.each(["claude", "codex"] as const)("uses the supplied %s composer engine list, never the provider catalog", (engine) => {
    const choices = sources.engineModels[engine];
    expect(resolveRoleModels(toDraftEntry({ engine }), sources)).toEqual(choices.map((m) => ({ id: m.id, name: m.label })));
  });
  it("returns no invented models for a missing route or unavailable engine catalog", () => {
    expect(resolveRoleModels(toDraftEntry({ connection: "deleted" }), sources)).toEqual([]);
    expect(resolveRoleModels(toDraftEntry(undefined), { ...sources, activeConnectionId: undefined })).toEqual([]);
    expect(resolveRoleModels(toDraftEntry({ engine: "codex" }), { ...sources, engineModels: {} })).toEqual([]);
  });
  it("distinguishes empty default, offered ids and unknown custom values without id collisions", () => {
    const models = [{ id: "custom" }, { id: "default" }];
    expect(roleModelSelection("", models)).toBe("default");
    expect(roleModelSelection("custom", models)).toBe("model:0");
    expect(roleModelSelection("default", models)).toBe("model:1");
    expect(roleModelSelection("saved-unknown", models)).toBe("custom");
    expect(roleModelSelection("custom", [])).toBe("custom");
  });
});

describe("role model review regressions", () => {
  it("uses live engine models when available, otherwise the shared draft catalogs", () => {
    const claude = [{ id: "sonnet" }];
    const codex = [{ id: "codex-store" }];
    const live = [{ id: "live" }];
    expect(pickEngineModels(null, claude, codex)).toEqual({ claude, codex });
    expect(pickEngineModels({ id: "claude", model: { current: "live", available: live } }, claude, codex)).toEqual({ claude: live, codex });
    expect(pickEngineModels({ id: "codex", model: { current: "live", available: live } }, claude, codex)).toEqual({ claude, codex: live });
    expect(pickEngineModels({ id: "codex" }, claude, codex).codex).toBe(codex);
  });
  it("offers only the empty default for engine routes, while preserving a connection's literal default id", () => {
    const models = resolveRoleModels(toDraftEntry({ engine: "claude" }), { ...sources, engineModels: { claude: CLAUDE_DRAFT_MODELS } });
    expect(models.some((model) => model.id === "default")).toBe(false);
    expect(models.some((model) => model.id === "sonnet")).toBe(true);
    expect(roleModelSelection("default", models, "claude")).toBe("default");
    expect(roleModelSelection("default", [{ id: "default" }], "")).toBe("model:0");
    expect(fromDraftEntry(toDraftEntry({ engine: "claude", model: "default" }))).toEqual({ engine: "claude" });
  });
  it.each(["engine:claude", "engine:codex", "connection:active", "connection:custom"])("clears model and custom mode when switching to %s", (route) => {
    const patch = routePatch(route);
    expect(patch).toMatchObject({ model: "", customModel: false });
    expect(patch).toMatchObject(route.startsWith("engine:") ? { engine: route.slice(7), connection: "" } : { engine: "", connection: route === "connection:active" ? "" : "custom" });
  });
  it("keeps empty Custom explicit, then clears custom mode when typing an offered id", () => {
    const models = [{ id: "sonnet" }];
    expect(nextCustomMode(true, "", models)).toBe(true);
    expect(nextCustomMode(true, "my-model", models)).toBe(true);
    expect(nextCustomMode(true, "sonnet", models)).toBe(false);
    expect(nextCustomMode(false, "", models)).toBe(false);
  });
  it("keeps custom mode attached to a fallback through reordering, and clears it on draft replacement", () => {
    let draft = addFallback(addFallback(toDraft({}), "executor"), "executor");
    draft = patchEntry(draft, "executor", 0, { customModel: true });
    draft = moveFallback(draft, "executor", 0, 1);
    expect(draft.executor.fallbacks[1]!.customModel).toBe(true);
    expect(draft.executor.fallbacks[0]!.customModel).toBeUndefined();
    expect(toDraft(fromDraft(draft).roles).executor.fallbacks[1]!.customModel).toBeUndefined();
  });
});

describe("sameDraftChoice — a draft compares by what the editor shows, not only by its persisted routes", () => {
  it("sees an open, still-empty Custom input as a difference (fromDraft would drop it)", () => {
    const seed = toDraft({ executor: { primary: { connection: "conn-1" } } });
    const opened = patchEntry(seed, "executor", null, { model: "", customModel: true });
    // The persisted routes are identical: the flag is UI-only.
    expect(fromDraft(opened).roles).toEqual(fromDraft(seed).roles);
    expect(sameDraftChoice(seed, opened)).toBe(false);
  });

  it("ignores the Custom flag on a fallback only when both sides agree", () => {
    let a = addFallback(toDraft({}), "executor");
    let b = addFallback(toDraft({}), "executor");
    expect(sameDraftChoice(a, b)).toBe(true);
    b = patchEntry(b, "executor", 0, { customModel: true });
    expect(sameDraftChoice(a, b)).toBe(false);
    a = patchEntry(a, "executor", 0, { customModel: true });
    expect(sameDraftChoice(a, b)).toBe(true);
  });

  it("still treats blank/absent route fields as equal", () => {
    const a = toDraft({ planner: { primary: { engine: "claude", connection: "" } } });
    const b = toDraft({ planner: { primary: { engine: "claude" } } });
    expect(sameDraftChoice(a, b)).toBe(true);
  });
});

/**
 * TASK.131 — unit tests for the New Session model picker's pure decision
 * logic (start-model-picker.ts). Same discipline as StartScreen.test.ts:
 * this package's vitest runs `environment: "node"`, so only plain functions
 * are exercised — the popover's JSX consumes them verbatim.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../../shared/settings.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import {
  buildStartModelGroups,
  buildStartModelPopularRows,
  carryDraftEffort,
  connectionBaseUrlHost,
  connectionOfferedModels,
  deriveRecentModelIds,
  orderModelsByCatalog,
  resolveStartModelEffort,
  startModelEffortLevels,
  startModelLevelHeightPx,
  startModelMenuFlipsUp,
  startModelMenuMaxHeightPx,
  START_MODEL_DEFAULT_EFFORTS,
  START_MODEL_DIVIDER_PX,
  START_MODEL_MENU_MARGIN_PX,
  START_MODEL_MENU_PADDING_PX,
  START_MODEL_ROW_HEIGHT_PX,
} from "./start-model-picker.js";

function connection(over: Partial<ProviderConnection> & { id: string; providerId: string }): ProviderConnection {
  return over;
}

const CATALOG: CatalogSummary = [
  {
    id: "z-ai",
    name: "Z.AI (GLM)",
    authKind: "api_key",
    models: [
      { id: "glm-5.3", name: "GLM-5.3" },
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-4.5", name: "GLM-4.5" },
    ],
  },
  {
    id: "kimi",
    name: "Kimi",
    authKind: "api_key",
    models: [
      { id: "kimi-for-coding", name: "K2.7 Coding" },
      { id: "k3", name: "K3" },
    ],
  },
];

describe("orderModelsByCatalog (TASK.131 D4 — catalog order, not the provider's alphabet)", () => {
  it("re-orders a live list that covers catalog ids back into the catalog's curated (fresh-first) order", () => {
    // z.ai /v1/models answers alphabetically; the catalog is fresh-first.
    const ordered = orderModelsByCatalog(CATALOG[0]!.models, [{ id: "glm-4.5" }, { id: "glm-5.3" }, { id: "glm-5.2" }]);
    expect(ordered.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.2", "glm-4.5"]);
  });

  it("keeps live-only ids the catalog doesn't know, appended after the catalog's own ids in the live list's order", () => {
    const ordered = orderModelsByCatalog(CATALOG[0]!.models, [{ id: "zz-experimental" }, { id: "glm-5.3" }]);
    expect(ordered.map((m) => m.id)).toEqual(["glm-5.3", "zz-experimental"]);
  });

  it("returns the offered list as-is when the provider has no catalog entry", () => {
    const offered = [{ id: "m2" }, { id: "m1" }];
    expect(orderModelsByCatalog(undefined, offered)).toEqual(offered);
  });
});

describe("connectionOfferedModels (TASK.131 D4)", () => {
  it("resolves via providerModelsFor (live list wins) and orders catalog-first", () => {
    const conn = connection({ id: "c1", providerId: "z-ai", models: ["glm-4.5", "glm-5.3"] });
    expect(connectionOfferedModels(conn, CATALOG, undefined)?.map((m) => m.id)).toEqual(["glm-5.3", "glm-4.5"]);
  });

  it("a curated custom subset resolves for a custom:<slug> connection and orders against the custom record's own catalog miss (no catalog entry → offered order)", () => {
    const custom: CustomProviderRecord[] = [
      { id: "custom:bridge", name: "bridge", baseUrl: "https://b.example", kind: "openai-compatible", models: ["m1", "m2"] },
    ];
    const conn = connection({ id: "c1", providerId: "custom:bridge" });
    expect(connectionOfferedModels(conn, CATALOG, custom)?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("undefined for an unknown provider with no live list (the D1 empty case)", () => {
    expect(connectionOfferedModels(connection({ id: "c1", providerId: "mystery" }), CATALOG, undefined)).toBeUndefined();
  });
});

describe("buildStartModelGroups (TASK.131 D1 — empty connections out, current first, count desc)", () => {
  it("D1: connections offering zero models leave the rail entirely (the smoke's leading 0-model rows)", () => {
    const connections = [
      connection({ id: "conn-empty-1", providerId: "mystery", label: "test" }),
      connection({ id: "conn-empty-2", providerId: "custom:x", label: "local-gemma" }),
      connection({ id: "conn-glm", providerId: "z-ai", label: "GLM coding plan" }),
    ];
    const groups = buildStartModelGroups(connections, CATALOG, undefined, { connectionId: "conn-glm", modelId: "glm-5.3" });
    expect(groups.map((g) => g.connectionId)).toEqual(["conn-glm"]);
  });

  it("D1: a live models:[] fetch on a catalog provider falls back to the static catalog (still offered, still in the rail)", () => {
    const conn = connection({ id: "c1", providerId: "z-ai", models: [] });
    const groups = buildStartModelGroups([conn], CATALOG, undefined, { connectionId: "c1", modelId: "glm-5.3" });
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["glm-5.3", "glm-5.2", "glm-4.5"]);
  });

  it("D1 ordering: current pair first, then descending model count, ties keep settings order", () => {
    const connections = [
      connection({ id: "conn-small", providerId: "kimi", label: "Kimi" }),
      connection({ id: "conn-big", providerId: "z-ai", label: "GLM" }),
      connection({ id: "conn-mid", providerId: "z-ai", label: "GLM 2" }),
    ];
    const groups = buildStartModelGroups(connections, CATALOG, undefined, { connectionId: "conn-small", modelId: "k3" });
    expect(groups.map((g) => g.connectionId)).toEqual(["conn-small", "conn-big", "conn-mid"]);
    // Same count (3 vs 3 → both z-ai catalogs): settings order preserved.
    expect(groups[1]?.label).toBe("GLM");
    expect(groups[2]?.label).toBe("GLM 2");
  });

  it("the current connection survives even when it offers nothing, carrying its current model as the single row", () => {
    const connections = [
      connection({ id: "cur", providerId: "mystery", label: "Empty" }),
      connection({ id: "other", providerId: "z-ai", label: "GLM" }),
    ];
    const groups = buildStartModelGroups(connections, CATALOG, undefined, { connectionId: "cur", modelId: "manual-id" });
    expect(groups.map((g) => g.connectionId)).toEqual(["cur", "other"]);
    expect(groups[0]?.items).toEqual([{ id: "manual-id", name: "manual-id", current: true }]);
  });

  it("the current pair's row carries the checkmark; the same id in another connection's group does not", () => {
    const connections = [
      connection({ id: "conn-a", providerId: "z-ai", label: "A" }),
      connection({ id: "conn-b", providerId: "z-ai", label: "B" }),
    ];
    const groups = buildStartModelGroups(connections, CATALOG, undefined, { connectionId: "conn-b", modelId: "glm-5.2" });
    expect(groups[0]?.connectionId).toBe("conn-b");
    expect(groups[0]?.items.find((i) => i.id === "glm-5.2")?.current).toBe(true);
    expect(groups[1]?.items.find((i) => i.id === "glm-5.2")?.current).toBe(false);
  });

  it("D2: colliding auto-labels get the baseUrl host as a muted subtitle; unique labels get none", () => {
    const connections = [
      connection({ id: "c1", providerId: "custom:a", label: "test", baseUrl: "https://api.one.example/v1" }),
      connection({ id: "c2", providerId: "custom:b", label: "test", baseUrl: "https://api.two.example/v1" }),
      connection({ id: "c3", providerId: "z-ai", label: "GLM" }),
    ];
    const groups = buildStartModelGroups(
      connections,
      CATALOG,
      [
        { id: "custom:a", name: "a", baseUrl: "https://api.one.example", kind: "openai-compatible", models: ["m1"] },
        { id: "custom:b", name: "b", baseUrl: "https://api.two.example", kind: "openai-compatible", models: ["m2"] },
      ],
      { connectionId: "c3", modelId: "glm-5.3" },
    );
    expect(groups.find((g) => g.connectionId === "c1")?.subtitle).toBe("api.one.example");
    expect(groups.find((g) => g.connectionId === "c2")?.subtitle).toBe("api.two.example");
    expect(groups.find((g) => g.connectionId === "c3")?.subtitle).toBeUndefined();
  });
});

describe("connectionBaseUrlHost (TASK.131 D2)", () => {
  it("extracts the host", () => {
    expect(connectionBaseUrlHost("https://api.example.com/v1")).toBe("api.example.com");
  });

  it("undefined for a malformed URL — the raw string is never shown", () => {
    expect(connectionBaseUrlHost("not a url")).toBeUndefined();
  });
});

describe("deriveRecentModelIds (TASK.131 D6 — popularity is measured, not curated)", () => {
  function session(over: Partial<SessionSummary> & { id: string; model: string; updatedAt: number }): SessionSummary {
    return { workspace: "/w", mode: "auto", createdAt: over.updatedAt, ...over };
  }

  it("newest first, regardless of the order the list arrives in", () => {
    const ids = deriveRecentModelIds([
      session({ id: "s1", model: "glm-4.5", updatedAt: 10 }),
      session({ id: "s2", model: "glm-5.3", updatedAt: 30 }),
      session({ id: "s3", model: "k3", updatedAt: 20 }),
    ]);
    expect(ids).toEqual(["glm-5.3", "k3", "glm-4.5"]);
  });

  it("windowed: an abandoned model cannot outvote this month's by accumulated count", () => {
    const old = Array.from({ length: 40 }, (_, i) => session({ id: `old-${i}`, model: "ancient", updatedAt: i }));
    const fresh = session({ id: "fresh", model: "glm-5.3", updatedAt: 1_000 });
    expect(deriveRecentModelIds([...old, fresh], 3)).toEqual(["glm-5.3", "ancient", "ancient"]);
  });
});

describe("buildStartModelPopularRows (TASK.131 D6 + owner decision 17.08 — top 3)", () => {
  const groups = buildStartModelGroups(
    [
      connection({ id: "conn-glm", providerId: "z-ai", label: "GLM" }),
      connection({ id: "conn-kimi", providerId: "kimi", label: "Kimi" }),
    ],
    CATALOG,
    undefined,
    { connectionId: "conn-glm", modelId: "glm-5.3" },
  );

  it("ranks by usage count, ties by recency, and names the group each pick comes from", () => {
    const rows = buildStartModelPopularRows(groups, ["k3", "glm-4.5", "k3", "glm-5.2"], "conn-glm");
    expect(rows.map((r) => r.modelId)).toEqual(["k3", "glm-4.5", "glm-5.2"]);
    expect(rows[0]).toMatchObject({ connectionId: "conn-kimi", groupLabel: "Kimi", name: "K3" });
  });

  it("prefers the CURRENT connection's group when two connections offer the same model id", () => {
    const twoGlm = buildStartModelGroups(
      [connection({ id: "conn-a", providerId: "z-ai", label: "A" }), connection({ id: "conn-b", providerId: "z-ai", label: "B" })],
      CATALOG,
      undefined,
      { connectionId: "conn-b", modelId: "glm-5.3" },
    );
    expect(buildStartModelPopularRows(twoGlm, ["glm-4.5"], "conn-b")[0]?.connectionId).toBe("conn-b");
  });

  it("drops ids no connected group offers (a deleted connection's model, a Codex session's own id)", () => {
    const rows = buildStartModelPopularRows(groups, ["gpt-5-codex", "glm-5.2"], "conn-glm", 3);
    expect(rows.map((r) => r.modelId)).not.toContain("gpt-5-codex");
    expect(rows[0]?.modelId).toBe("glm-5.2");
  });

  it("no history at all: tops up from the current connection's own catalog order (fresh first), never an empty strip", () => {
    const rows = buildStartModelPopularRows(groups, [], "conn-glm");
    expect(rows.map((r) => r.modelId)).toEqual(["glm-5.3", "glm-5.2", "glm-4.5"]);
    expect(rows[0]?.current).toBe(true);
  });

  it("never repeats a model id across the ranked and topped-up halves", () => {
    const rows = buildStartModelPopularRows(groups, ["glm-4.5"], "conn-glm");
    expect(new Set(rows.map((r) => r.modelId)).size).toBe(rows.length);
  });
});

describe("startModelEffortLevels (TASK.131 — the vocabulary belongs to the MODEL)", () => {
  const EFFORT_CATALOG: CatalogSummary = [
    {
      id: "z-ai",
      name: "Z.AI",
      authKind: "api_key",
      models: [
        { id: "glm-5.2", name: "GLM-5.2", reasoning: true, effortLevels: ["off", "high", "max"] },
        { id: "glm-4.6", name: "GLM-4.6" },
        { id: "claude-ish", name: "Claude-ish", reasoning: true },
      ],
    },
  ];

  it("gives each model its OWN declared levels", () => {
    expect(startModelEffortLevels("z-ai", "glm-5.2", EFFORT_CATALOG)).toEqual(["off", "high", "max"]);
  });

  it("a reasoning model with no explicit list gets core's legacy four — the same fallback resolveEffortLevels applies", () => {
    expect(startModelEffortLevels("z-ai", "claude-ish", EFFORT_CATALOG)).toEqual(START_MODEL_DEFAULT_EFFORTS);
  });

  it("undefined for a non-reasoning model, an unknown model id, and an unknown provider — no effort level is rendered at all", () => {
    expect(startModelEffortLevels("z-ai", "glm-4.6", EFFORT_CATALOG)).toBeUndefined();
    expect(startModelEffortLevels("z-ai", "live-only-id", EFFORT_CATALOG)).toBeUndefined();
    expect(startModelEffortLevels("mystery", "glm-5.2", EFFORT_CATALOG)).toBeUndefined();
    expect(startModelEffortLevels("z-ai", "glm-5.2", undefined)).toBeUndefined();
  });
});

describe("effort carry/resolve (TASK.131)", () => {
  it("carryDraftEffort: kept when the new model also declares it, dropped otherwise — never coerced", () => {
    expect(carryDraftEffort("high", ["off", "high", "max"])).toBe("high");
    expect(carryDraftEffort("medium", ["off", "high", "max"])).toBeUndefined();
    expect(carryDraftEffort("high", undefined)).toBeUndefined();
    expect(carryDraftEffort(undefined, ["off", "high"])).toBeUndefined();
  });

  it("resolveStartModelEffort: draft pick wins, else the connection's persisted effort, else the vocabulary's first level", () => {
    expect(resolveStartModelEffort("max", "high", ["off", "high", "max"])).toBe("max");
    expect(resolveStartModelEffort(undefined, "high", ["off", "high", "max"])).toBe("high");
    expect(resolveStartModelEffort(undefined, undefined, ["off", "high", "max"])).toBe("off");
    // A stale pick the current model doesn't declare falls through to the
    // connection's own effort rather than being displayed as selected.
    expect(resolveStartModelEffort("medium", "high", ["off", "high", "max"])).toBe("high");
  });

  it("resolveStartModelEffort: undefined with no vocabulary — exactly when no effort level exists", () => {
    expect(resolveStartModelEffort("high", "high", undefined)).toBeUndefined();
    expect(resolveStartModelEffort("high", "high", [])).toBeUndefined();
  });
});

describe("popover geometry (TASK.131 — the popover MOVES, it never grows a scrollbar)", () => {
  it("startModelLevelHeightPx: rows×30 + dividers×9 + the popover's own padding", () => {
    expect(startModelLevelHeightPx(9)).toBe(9 * START_MODEL_ROW_HEIGHT_PX + START_MODEL_MENU_PADDING_PX);
    expect(startModelLevelHeightPx(5, 2)).toBe(
      5 * START_MODEL_ROW_HEIGHT_PX + 2 * START_MODEL_DIVIDER_PX + START_MODEL_MENU_PADDING_PX,
    );
  });

  it("startModelMenuFlipsUp: stays down while the tallest level fits below; flips when below is starved and above is roomier", () => {
    const chip = { top: 500, bottom: 524 };
    expect(startModelMenuFlipsUp(900, chip, 340, 8)).toBe(false);
    const lowChip = { top: 700, bottom: 724 };
    expect(startModelMenuFlipsUp(800, lowChip, 400, 8)).toBe(true);
    // Starved on BOTH sides: take the roomier one anyway — a window too small
    // for any placement should still show as many rows as it can.
    expect(startModelMenuFlipsUp(300, { top: 150, bottom: 174 }, 400, 8)).toBe(true);
    expect(startModelMenuFlipsUp(300, { top: 100, bottom: 124 }, 400, 8)).toBe(false);
  });

  it("startModelMenuMaxHeightPx: measures from the chip's BOTTOM edge downward and its TOP edge upward", () => {
    const chip = { top: 500, bottom: 524 };
    // Down: 900 - 524 - 8 - 12. Measuring from `top` (the predecessor's bug)
    // would have claimed the chip's own 24px as available room.
    expect(startModelMenuMaxHeightPx(900, chip, false, 8)).toBe(900 - 524 - 8 - START_MODEL_MENU_MARGIN_PX);
    expect(startModelMenuMaxHeightPx(900, chip, true, 8)).toBe(500 - 8 - START_MODEL_MENU_MARGIN_PX);
  });

  it("startModelMenuMaxHeightPx: never invents room that isn't there — a starved side yields a starved cap, not a floor", () => {
    // The predecessor clamped UP to a 5-row minimum here, which is how the
    // popover came to run past the window's bottom edge on the live smoke.
    const cap = startModelMenuMaxHeightPx(300, { top: 250, bottom: 274 }, false, 8);
    expect(cap).toBeLessThan(5 * START_MODEL_ROW_HEIGHT_PX);
    expect(cap).toBeGreaterThan(0);
  });
});

/**
 * TASK.106 cut-2 §D4/§D3 — unit tests for the running session's drill-down
 * decision layer (model-drill-rows.ts). Same discipline as
 * start-model-picker.test.ts: this package's vitest runs `environment:
 * "node"`, so only plain functions are exercised — `model-drill-menu.tsx`
 * renders whatever they return.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSummary, ProviderConnection } from "../../../shared/settings.js";
import {
  buildSessionDrillRows,
  isForeignPick,
  modelDrillEffortLabel,
  pickSessionDrillRow,
  resolveRebindEffort,
} from "./model-drill-rows.js";

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
      { id: "glm-5.2", name: "GLM-5.2", reasoning: true, effortLevels: ["off", "high", "max"] },
    ],
  },
  {
    id: "moonshot",
    name: "Kimi",
    authKind: "api_key",
    models: [{ id: "k3", name: "K3", reasoning: true, effortLevels: ["low", "high", "max"] }],
  },
];

const CONNECTIONS: ProviderConnection[] = [
  connection({ id: "c-zai", providerId: "z-ai" }),
  connection({ id: "c-kimi", providerId: "moonshot", reasoningEffort: "high" }),
];

describe("buildSessionDrillRows (TASK.106 cut-2 §D4 — every connection, the TAB's pair)", () => {
  it("groups every connected connection, current one first, with the tab's model checkmarked", () => {
    const { groups } = buildSessionDrillRows({
      connections: CONNECTIONS,
      catalog: CATALOG,
      custom: undefined,
      currentConnectionId: "c-kimi",
      currentModelId: "k3",
      recentModelIds: [],
    });
    expect(groups.map((group) => group.connectionId)).toEqual(["c-kimi", "c-zai"]);
    expect(groups[0]!.label).toBe("Kimi");
    expect(groups[0]!.items).toEqual([{ id: "k3", name: "K3", current: true }]);
    expect(groups[1]!.items.map((item) => item.id)).toEqual(["glm-5.3", "glm-5.2"]);
    // The same model id in another connection's group is NOT the current pair.
    expect(groups[1]!.items.every((item) => !item.current)).toBe(true);
  });

  it("builds the root level as popular picks + one row per group + the effort row of the CURRENT pair", () => {
    const { rows, popular, efforts, effort } = buildSessionDrillRows({
      connections: CONNECTIONS,
      catalog: CATALOG,
      custom: undefined,
      currentConnectionId: "c-kimi",
      currentModelId: "k3",
      recentModelIds: ["glm-5.3", "glm-5.3", "k3"],
      currentEffort: "max",
    });
    // The vocabulary belongs to the MODEL: k3 declares low/high/max.
    expect(efforts).toEqual(["low", "high", "max"]);
    expect(effort).toBe("max");
    // Popular = the two ranked history ids; the top-up to three only fires
    // when fewer than `limit` history ids resolve — two is already two.
    expect(popular.map((row) => row.modelId)).toEqual(["glm-5.3", "k3"]);
    expect(rows.map((row) => row.kind)).toEqual(["popular", "popular", "group", "group", "effort-open"]);
    expect(rows.at(-1)).toEqual({ kind: "effort-open", value: "max" });
    // A popular pick carries the group it will be picked FROM — glm-5.3 lives
    // in the other connection, so picking it would switch connection.
    expect(rows[0]).toMatchObject({ kind: "popular", connectionId: "c-zai", modelId: "glm-5.3", groupLabel: "Z.AI (GLM)" });
  });

  it("omits the effort row when the current model declares no vocabulary", () => {
    const { rows, efforts, effort } = buildSessionDrillRows({
      connections: CONNECTIONS,
      catalog: CATALOG,
      custom: undefined,
      currentConnectionId: "c-zai",
      currentModelId: "glm-5.3", // not reasoning-capable in the catalog
      recentModelIds: [],
    });
    expect(efforts).toBeUndefined();
    expect(effort).toBeUndefined();
    expect(rows.some((row) => row.kind === "effort-open")).toBe(false);
  });

  it("lists the OPEN group's models on the group level", () => {
    const { rows } = buildSessionDrillRows({
      connections: CONNECTIONS,
      catalog: CATALOG,
      custom: undefined,
      currentConnectionId: "c-kimi",
      currentModelId: "k3",
      recentModelIds: [],
      page: { kind: "group", connectionId: "c-zai" },
    });
    expect(rows).toEqual([
      { kind: "model", connectionId: "c-zai", modelId: "glm-5.3", name: "GLM-5.3", current: false },
      { kind: "model", connectionId: "c-zai", modelId: "glm-5.2", name: "GLM-5.2", current: false },
    ]);
  });

  it("lists the current model's own levels on the effort level, checkmarking the resolved one", () => {
    const { rows } = buildSessionDrillRows({
      connections: CONNECTIONS,
      catalog: CATALOG,
      custom: undefined,
      currentConnectionId: "c-kimi",
      currentModelId: "k3",
      recentModelIds: [],
      page: { kind: "effort" },
      // No explicit pick: the connection's own persisted effort ("high") stands.
    });
    expect(rows).toEqual([
      { kind: "effort", value: "low", current: false },
      { kind: "effort", value: "high", current: true },
      { kind: "effort", value: "max", current: false },
    ]);
  });
});

describe("pickSessionDrillRow (TASK.106 cut-2 §D3 — set_model vs rebind)", () => {
  it("keeps a pick from the tab's OWN connection on the live set_model path", () => {
    expect(
      pickSessionDrillRow({
        currentConnectionId: "c-kimi",
        row: { kind: "model", connectionId: "c-kimi", modelId: "kimi-for-coding" },
      }),
    ).toEqual({ kind: "set_model", modelId: "kimi-for-coding" });
  });

  it("turns a pick from ANOTHER connection into a rebind carrying that row's pair", () => {
    expect(
      pickSessionDrillRow({
        currentConnectionId: "c-kimi",
        row: { kind: "popular", connectionId: "c-zai", modelId: "glm-5.3" },
      }),
    ).toEqual({ kind: "rebind", connectionId: "c-zai", modelId: "glm-5.3" });
  });

  it("treats every row of an UNPINNED tab as a rebind (fail-closed — main's guards decide)", () => {
    expect(
      pickSessionDrillRow({
        currentConnectionId: undefined,
        row: { kind: "model", connectionId: "c-zai", modelId: "glm-5.2" },
      }),
    ).toEqual({ kind: "rebind", connectionId: "c-zai", modelId: "glm-5.2" });
  });
});

describe("resolveRebindEffort (TASK.106 cut-2 §D3 — carried, or reset EXPLICITLY)", () => {
  it("carries the current effort when the target model's vocabulary contains it", () => {
    expect(
      resolveRebindEffort({
        currentEffort: "high",
        targetProviderId: "z-ai",
        targetModelId: "glm-5.2", // off/high/max
        catalog: CATALOG,
        targetConnectionEffort: undefined,
      }),
    ).toEqual({ carried: "high", resetTo: undefined, dropped: false });
  });

  it("resets to the target connection's own effort and reports the drop when the level is not accepted", () => {
    // "low" is k3's, not glm-5.2's; the target connection persists "max".
    expect(
      resolveRebindEffort({
        currentEffort: "low",
        targetProviderId: "z-ai",
        targetModelId: "glm-5.2",
        catalog: CATALOG,
        targetConnectionEffort: "max",
      }),
    ).toEqual({ carried: undefined, resetTo: "max", dropped: true });
  });

  it("falls back to the vocabulary's first level when the target connection's effort is invalid too", () => {
    expect(
      resolveRebindEffort({
        currentEffort: "low",
        targetProviderId: "z-ai",
        targetModelId: "glm-5.2",
        catalog: CATALOG,
        targetConnectionEffort: "medium",
      }),
    ).toEqual({ carried: undefined, resetTo: "off", dropped: true });
  });

  it("neither carries nor resets when the target model declares no vocabulary", () => {
    expect(
      resolveRebindEffort({
        currentEffort: "high",
        targetProviderId: "z-ai",
        targetModelId: "glm-5.3", // not reasoning-capable
        catalog: CATALOG,
        targetConnectionEffort: "max",
      }),
    ).toEqual({ carried: undefined, resetTo: undefined, dropped: false });
  });

  it("reports no drop for a session that carries no effort at all", () => {
    expect(
      resolveRebindEffort({
        currentEffort: undefined,
        targetProviderId: "moonshot",
        targetModelId: "k3",
        catalog: CATALOG,
        targetConnectionEffort: "high",
      }),
    ).toEqual({ carried: undefined, resetTo: undefined, dropped: false });
  });
});

describe("isForeignPick / modelDrillEffortLabel", () => {
  it("is false only for the connection already in use", () => {
    expect(isForeignPick("c-kimi", "c-kimi")).toBe(false);
    expect(isForeignPick("c-zai", "c-kimi")).toBe(true);
    expect(isForeignPick("c-zai", undefined)).toBe(true);
  });

  it("names the known effort levels and passes an unknown one through", () => {
    expect(modelDrillEffortLabel("off")).toBe("No thinking");
    expect(modelDrillEffortLabel("max")).toBe("Max");
    expect(modelDrillEffortLabel("turbo")).toBe("turbo");
  });
});

/**
 * Taskana 4704 R1 (re-review #3): the child spawn-mode cell the host's port and
 * the test harness share. Pure: a fake Session stands in for the real one.
 */
import { describe, expect, it } from "vitest";
import { createSpawnModeCell, type SpawnModeConfig, type SpawnModeSession } from "./spawn-mode-cell.js";

function fakeSession(pre: "build" | "auto" | "yolo" | "plan" | undefined, mode: "build" | "plan"): SpawnModeSession {
  return {
    childSpawnMode: () => (pre === undefined ? mode : pre === "plan" ? "build" : pre),
    childSpawnPreOrchestrateMode: () => pre,
  };
}

describe("createSpawnModeCell", () => {
  it("before a session exists: orchestrate off => live mode", () => {
    const config: SpawnModeConfig = { mode: "yolo" };
    const cell = createSpawnModeCell(config, () => null);
    expect(cell.read()).toBe("yolo");
  });

  it("R1: enable from yolo AFTER the flip to plan still answers yolo (the pre-orchestrate mode)", () => {
    const config: SpawnModeConfig = { mode: "yolo" };
    let session: SpawnModeSession | null = null;
    const cell = createSpawnModeCell(config, () => session);
    // The Session flips config.mode to plan BEFORE the host callback fires.
    config.mode = "plan";
    session = fakeSession("yolo", "plan");
    cell.onOrchestrateChanged(true);
    expect(config.orchestrate).toBe(true);
    expect(cell.read()).toBe("yolo");
  });

  it("R1: plan pre-mode is coerced to build for children", () => {
    const config: SpawnModeConfig = { mode: "plan" };
    const cell = createSpawnModeCell(config, () => fakeSession("plan", "plan"));
    cell.onOrchestrateChanged(true);
    expect(cell.read()).toBe("build");
  });

  it("disable clears config.orchestrate and the cell answers the live mode again", () => {
    const config: SpawnModeConfig = { mode: "build" };
    const cell = createSpawnModeCell(config, () => null);
    cell.onOrchestrateChanged(true);
    config.mode = "build";
    cell.onOrchestrateChanged(false);
    expect("orchestrate" in config).toBe(false);
    expect(cell.read()).toBe("build");
  });
});

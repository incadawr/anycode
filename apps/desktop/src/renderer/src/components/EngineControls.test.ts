/**
 * Pure-logic tests for the Codex/engine model+preset controls (TASK.39). Like
 * ModeMenu.test.ts/ModelPill.test.ts, this is `.test.ts` under a node
 * (no-jsdom) vitest env — every piece of decision logic is exported as a
 * plain function and covered directly rather than DOM-rendering the popover.
 */
import { describe, expect, it } from "vitest";
import {
  activeEnginePreset,
  engineChipLabel,
  engineControlDisabled,
  engineModelDisplayName,
  engineModelItems,
  enginePresetTooltip,
} from "./EngineControls.js";

describe("engineControlDisabled", () => {
  it("is disabled while a turn is running", () => {
    expect(engineControlDisabled("running", null, true)).toBe(true);
  });

  it("is disabled while a queued item is in flight (idle-but-not-truly-idle window)", () => {
    expect(engineControlDisabled("idle", { requestId: "r1", item: { id: "q1", text: "hi", images: [] } }, true)).toBe(true);
  });

  it("is disabled while the connection isn't ready", () => {
    expect(engineControlDisabled("idle", null, false)).toBe(true);
  });

  it("is enabled only when truly idle and connected", () => {
    expect(engineControlDisabled("idle", null, true)).toBe(false);
  });
});

describe("engineModelDisplayName", () => {
  it("uses the catalog entry's label when the id matches", () => {
    expect(engineModelDisplayName("gpt-5.6-terra", [{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }])).toBe("GPT-5.6 Terra");
  });

  it("falls back to the raw id when there is no label or no catalog match", () => {
    expect(engineModelDisplayName("gpt-5.6-terra", [{ id: "gpt-5.6-terra" }])).toBe("gpt-5.6-terra");
    expect(engineModelDisplayName("unknown-model", [{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }])).toBe("unknown-model");
  });
});

describe("engineModelItems", () => {
  const catalog = [
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-mini", label: "GPT-5.6 Mini" },
  ];

  it("lists the engine's own catalog verbatim", () => {
    expect(engineModelItems("gpt-5.6-terra", catalog)).toEqual([
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-mini", label: "GPT-5.6 Mini" },
    ]);
  });

  it("appends the current model when it is somehow absent from the catalog (defensive)", () => {
    expect(engineModelItems("stale-model", catalog)).toEqual([
      ...catalog,
      { id: "stale-model", label: "stale-model" },
    ]);
  });
});

describe("engineChipLabel", () => {
  it("shows only the active label with no pending change", () => {
    expect(engineChipLabel("Ask", undefined)).toBe("Ask");
  });

  it("keeps the ACTIVE label first and marks the queued target explicitly — a pending change must never read as already active", () => {
    expect(engineChipLabel("Ask", "Read-only")).toBe("Ask → Read-only (next turn)");
  });
});

describe("activeEnginePreset", () => {
  const presets = [
    { id: "read-only", label: "Read-only", description: "Codex can read files but cannot run commands, write files, or reach the network." },
    { id: "ask", label: "Ask", description: "Codex asks before running commands or changing files (default)." },
  ];

  it("finds the preset matching the active id", () => {
    expect(activeEnginePreset(presets, "ask")?.label).toBe("Ask");
  });

  it("returns undefined for a stale/removed preset id (defensive)", () => {
    expect(activeEnginePreset(presets, "danger-full-access")).toBeUndefined();
  });
});

describe("enginePresetTooltip", () => {
  it("is the active preset's own host-provided description with no pending change", () => {
    expect(enginePresetTooltip("Ask", "Codex asks before running commands or changing files (default).", undefined)).toBe(
      "Codex asks before running commands or changing files (default).",
    );
  });

  it("falls back to the label when the active preset carries no description", () => {
    expect(enginePresetTooltip("Ask", undefined, undefined)).toBe("Ask");
  });

  it("appends an explicit next-turn sentence while a different preset is queued", () => {
    expect(enginePresetTooltip("Ask", "Codex asks before running commands or changing files (default).", "Read-only")).toBe(
      'Codex asks before running commands or changing files (default). Switching to "Read-only" — applies from the next turn.',
    );
  });
});

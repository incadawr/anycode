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
  engineEffortControlState,
  engineEffortOptions,
  engineEffortSummary,
  engineMenuChipLabel,
  engineModelDisplayName,
  engineModelItems,
  enginePresetTooltip,
  engineSelectedEffort,
  engineSelectedModel,
  nativeEffortControl,
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

// ── Native effort gating ─────────────────────────────────────────────────
// Capability comes from the SELECTED model's advertised vocabulary — never
// from the existence of a current effort value, and never from AnyCode's
// provider catalog (the synthetic model below has no catalog entry at all).
describe("engineEffortOptions", () => {
  const nativeModel = {
    current: "gpt-6.1-terra",
    available: [
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "plain", label: "Plain" },
    ],
  };

  it("offers native effort without a known current effort", () => {
    // No `effort.current` is supplied anywhere: the row must still be offered.
    expect(engineEffortOptions(nativeModel)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(engineEffortSummary({ current: undefined })).toBe("Default");
    expect(engineEffortSummary(undefined)).toBe("Default");
    expect(engineMenuChipLabel(nativeModel, undefined, { current: undefined })).toBe("GPT-6.1 Terra · Default");
  });

  it("uses the pending model's vocabulary while a model switch is queued", () => {
    expect(engineEffortOptions(nativeModel, "plain")).toEqual([]);
    expect(engineEffortOptions(nativeModel, "gpt-6.1-terra")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("offers nothing for a model the catalog does not list (no invented vocabulary)", () => {
    expect(engineEffortOptions({ current: "not-in-catalog", available: [{ id: "other", efforts: ["high"] }] })).toEqual([]);
  });

  it("shows active and pending model and effort separately", () => {
    // The ACTIVE value always reads first; the queued target is explicitly
    // marked, so a pending pick can never masquerade as applied.
    expect(engineEffortSummary({ current: "high", pending: "xhigh" })).toBe("high → xhigh (next turn)");
    // Adding an effort row must NOT suppress a pending model label.
    expect(engineMenuChipLabel(nativeModel, "plain", { current: "xhigh", pending: "low" })).toBe(
      "GPT-6.1 Terra → Plain (next turn) · xhigh → low (next turn)",
    );
    // While a model switch is queued the applied effort belongs to the OLD
    // model: the selected model's effort is unknown, so it reads `Default`
    // rather than borrowing `high` from the model being switched away from.
    const switching = {
      current: "gpt-6.1-terra",
      available: [...nativeModel.available, { id: "codex-2", label: "Codex 2", efforts: ["low", "medium", "high"] }],
      effort: "high",
    };
    expect(engineMenuChipLabel(switching, "codex-2", engineEffortControlState(switching, "codex-2", undefined))).toBe(
      "GPT-6.1 Terra → Codex 2 (next turn) · Default",
    );
    expect(engineMenuChipLabel(nativeModel, undefined, undefined)).toBe("GPT-6.1 Terra");
  });

  it("compares a pick against the NEXT-TURN effort of the SELECTED model", () => {
    // The applied model/effort is what a pick must be able to CANCEL: with
    // `xhigh` queued and `medium` applied, picking `medium` is a change.
    expect(engineSelectedModel(nativeModel, undefined)).toBe("gpt-6.1-terra");
    expect(engineSelectedModel(nativeModel, "plain")).toBe("plain");
    expect(engineSelectedEffort({ current: "medium", selected: "medium" })).toBe("medium");
    expect(engineSelectedEffort({ current: "medium", selected: "xhigh", pending: "xhigh" })).toBe("xhigh");
    expect(engineSelectedEffort({ current: undefined })).toBeUndefined();
    // A queued model switch leaves the selected effort UNKNOWN: the applied
    // model's value must never stand in for it, or the pick for the new model
    // is swallowed as "no change". Unknown is unequal to every level.
    const switching = {
      current: "gpt-6.1-terra",
      available: [...nativeModel.available, { id: "codex-2", label: "Codex 2", efforts: ["low", "medium", "high"] }],
      effort: "medium",
    };
    const switched = engineEffortControlState(switching, "codex-2", undefined);
    expect(switched).toBeDefined();
    expect(switched?.current).toBeUndefined();
    expect(engineSelectedEffort(switched)).toBeUndefined();
  });

  it("supplies the effort control from the vocabulary, without a known current effort", () => {
    // No `effort` value at all: the control still exists (capability, not a value).
    const control = nativeEffortControl(nativeModel, undefined, "xhigh", () => {});
    expect(control).toBeDefined();
    expect(control?.current).toBeUndefined();
    expect(control?.selected).toBe("xhigh");
    expect(control?.pending).toBe("xhigh");
    // A model with no advertised levels gets no control.
    expect(nativeEffortControl({ current: "plain", available: nativeModel.available }, undefined, undefined, () => {})).toBeUndefined();
    // The SELECTED (queued) model's vocabulary decides.
    expect(nativeEffortControl(nativeModel, "plain", undefined, () => {})).toBeUndefined();
  });
});

/**
 * Model-catalog tests on the synthetic `initialize` response in
 * `w0-16-setmodel.jsonl` (cut §1.4). The load-bearing discriminator is the
 * `value` / `resolvedModel` split: `fable` is what you SEND,
 * `claude-fable-5-1` is the simulated read-back, and a round-trip assert
 * against the requested id would fire a false mismatch on every switch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_DRAFT_MODELS } from "../../../renderer/src/claude-draft-models.js";
import { CLAUDE_ENGINE_CAPABILITIES } from "./claude-engine.js";
import { CLAUDE_EFFORT_LEVELS, ClaudeModelCatalog, isClaudeEffortLevel } from "./models.js";
import {
  CLAUDE_PERMISSION_PRESETS,
  DEFAULT_CLAUDE_PRESET,
  claudePresetChoices,
  findClaudePreset,
} from "./presets.js";
import { permissionModeToFlag } from "./protocol.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/** The id a caller SENDS to select Fable — deliberately read through a function so it is not a literal type at the comparison site. */
function fableRequestedId(): string {
  return "fable";
}

/** The synthetic `initialize` response's `models[]`. */
function fixtureModels(): unknown {
  const lines = readFileSync(join(FIXTURES_DIR, "w0-16-setmodel.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { raw: Record<string, unknown> });
  const init = lines.find(
    (line) =>
      line.raw.type === "control_response" &&
      Array.isArray((line.raw.response as { response?: { models?: unknown } }).response?.models),
  );
  if (init === undefined) throw new Error("w0-16 fixture is missing the initialize response");
  return (init.raw.response as { response: { models: unknown } }).response.models;
}

describe("ClaudeModelCatalog — built from synthetic initialize models[]", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(fixtureModels());

  it("decodes the synthetic catalog", () => {
    expect(catalog.available).toBe(true);
    const ids = catalog.choices().map((choice) => choice.id);
    // The synthetic catalog set; this is not evidence of CLI availability.
    expect(ids).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
    expect(catalog.defaultValue()).toBe("default");
  });

  it("projects versioned display names and resolves ordinary Opus without extended context", () => {
    expect(catalog.choices().map(choice => choice.label)).toEqual([
      "Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5",
    ]);
    expect(catalog.resolveId("claude-opus-5-5")).toBe("opus");
    expect(catalog.get(catalog.defaultValue()!)!.resolvedModel).toBe("claude-opus-5-5");
  });

  it("keeps `value` and `resolvedModel` distinct — wire alias and resolved id differ", () => {
    const fable = catalog.get("fable")!;
    expect(fable.value).toBe("fable");
    expect(fable.resolvedModel).toBe("claude-fable-5-1");
    expect(fable.value).not.toBe(fable.resolvedModel);
    expect(catalog.get("opus")!.resolvedModel).toBe("claude-opus-5-5");
  });

  it("read-back compares against resolvedModel, so a get_context_usage echo matches (NOT a round-trip assert)", () => {
    // Simulated get_context_usage read-back after selecting fable.
    expect(catalog.readBackMatches("fable", "claude-fable-5-1")).toBe(true);
    // A naive requested-vs-reported string comparison would have failed here:
    const requested: string = fableRequestedId();
    expect(requested).not.toBe("claude-fable-5-1");
    // The sent id also matches (both directions of the split resolve).
    expect(catalog.readBackMatches("fable", "fable")).toBe(true);
    // A genuinely different model still fails the check.
    expect(catalog.readBackMatches("fable", "claude-haiku-5-5")).toBe(false);
  });

  it("findByResolved maps a CLI-reported id back to its catalog entry", () => {
    expect(catalog.findByResolved("claude-opus-5-5")!.value).toBe("default");
    expect(catalog.findByResolved("claude-sonnet-5-5")!.value).toBe("sonnet");
    expect(catalog.findByResolved("no-such-model")).toBeUndefined();
  });

  it("host-side validation is fail-closed for an unknown id (an unverifiable id never reaches the wire)", () => {
    expect(catalog.has("sonnet")).toBe(true);
    expect(catalog.has("no-such-model-xyz")).toBe(false);
    expect(catalog.get("no-such-model-xyz")).toBeUndefined();
  });

  it("effort levels come from the entry's own supportedEffortLevels; haiku (no effort support) offers none", () => {
    expect(catalog.effortsFor("sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(catalog.supportsEffort("sonnet", "high")).toBe(true);
    expect(catalog.supportsEffort("sonnet", "ultra")).toBe(false);
    // The live haiku entry carries neither supportsEffort nor the levels array.
    expect(catalog.effortsFor("haiku")).toEqual([]);
    expect(catalog.choices().find((choice) => choice.id === "haiku")!.efforts).toBeUndefined();
  });

  it("an unreadable catalog is empty and validates nothing (fail-closed)", () => {
    const empty = ClaudeModelCatalog.fromInitialize(undefined);
    expect(empty.available).toBe(false);
    expect(empty.has("sonnet")).toBe(false);
    expect(empty.defaultValue()).toBeUndefined();
  });

  it("tolerates malformed entries without dropping the usable ones", () => {
    const mixed = ClaudeModelCatalog.fromInitialize([{ displayName: "no value" }, null, { value: "ok" }]);
    expect(mixed.choices().map((choice) => choice.id)).toEqual(["ok"]);
    // A missing resolvedModel degrades to an identity read-back, never a throw.
    expect(mixed.get("ok")!.resolvedModel).toBe("ok");
  });
});

describe("CLAUDE_EFFORT_LEVELS / isClaudeEffortLevel — the fixed pre-spawn vocabulary", () => {
  it("the claude engine declares reasoning-effort support, and the selector helper exposes exactly the 5 CLI levels", () => {
    expect(CLAUDE_ENGINE_CAPABILITIES.supportsReasoningEffort).toBe(true);
    expect(CLAUDE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("exposes exactly the CLI's own --help vocabulary, in order", () => {
    expect(CLAUDE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("accepts every listed level and rejects anything else", () => {
    for (const level of CLAUDE_EFFORT_LEVELS) expect(isClaudeEffortLevel(level)).toBe(true);
    expect(isClaudeEffortLevel("ultra")).toBe(false);
    expect(isClaudeEffortLevel("")).toBe(false);
    expect(isClaudeEffortLevel("High")).toBe(false); // case-sensitive — the CLI's own values are lowercase
  });
});

describe("ClaudeModelCatalog.resolveEffort — per-model memory normalization", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(fixtureModels());

  it("keeps a preferred effort the model still supports", () => {
    expect(catalog.resolveEffort("sonnet", "high")).toBe("high");
  });

  it("drops a preferred effort the model does not support", () => {
    expect(catalog.resolveEffort("sonnet", "ultra")).toBeUndefined();
    // haiku carries no effort levels live at all (models.test.ts above).
    expect(catalog.resolveEffort("haiku", "high")).toBeUndefined();
  });

  it("no preference at all resolves to nothing — never guesses a default", () => {
    expect(catalog.resolveEffort("sonnet", undefined)).toBeUndefined();
  });

  it("an unknown model id resolves to nothing", () => {
    expect(catalog.resolveEffort("no-such-model-xyz", "high")).toBeUndefined();
  });
});

describe("Claude permission presets — frozen table (cut §1.4)", () => {
  it("maps the three exposed presets to their wire modes", () => {
    expect(CLAUDE_PERMISSION_PRESETS.map((preset) => [preset.id, preset.mode])).toEqual([
      ["read-only", "plan"],
      ["ask", "default"],
      ["workspace", "acceptEdits"],
    ]);
    expect(DEFAULT_CLAUDE_PRESET).toBe("ask");
    expect(findClaudePreset("ask")!.mode).toBe("default");
  });

  it("the default preset's WIRE value is `default` but its CLI FLAG value is `manual` (probe #8 asymmetry)", () => {
    const ask = findClaudePreset("ask")!;
    expect(ask.mode).toBe("default");
    expect(permissionModeToFlag(ask.mode)).toBe("manual");
    // Every other mode is spelled identically at both layers.
    expect(permissionModeToFlag(findClaudePreset("read-only")!.mode)).toBe("plan");
    expect(permissionModeToFlag(findClaudePreset("workspace")!.mode)).toBe("acceptEdits");
  });

  it("dontAsk / auto / bypassPermissions are NOT exposed (no approval visibility — probe #8)", () => {
    const modes = CLAUDE_PERMISSION_PRESETS.map((preset) => String(preset.mode));
    for (const hidden of ["dontAsk", "auto", "bypassPermissions"]) {
      expect(modes).not.toContain(hidden);
    }
  });

  it("an unknown preset id resolves to nothing (the caller falls back to the default)", () => {
    expect(findClaudePreset("workspace-write")).toBeUndefined();
  });

  it("the wire projection carries labels only, never the mode values", () => {
    const choices = claudePresetChoices();
    expect(choices.map((choice) => choice.id)).toEqual(["read-only", "ask", "workspace"]);
    for (const choice of choices) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice).not.toHaveProperty("mode");
    }
  });
});

describe("ClaudeModelCatalog.resolveId — a wire alias and a full CLI id both name the same model", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(fixtureModels());

  it("accepts the catalog `value` (what the picker sends) unchanged", () => {
    expect(catalog.resolveId("haiku")).toBe("haiku");
    expect(catalog.resolveId("sonnet")).toBe("sonnet");
  });

  it("maps the CLI's FULL resolved id onto the value that may go on the wire", () => {
    // The reported defect: `create_session {model: "claude-haiku-…"}` was
    // matched only against `value`, so every full-id request looked unknown to
    // the engine and was silently replaced by the default.
    expect(catalog.resolveId("claude-haiku-5-5")).toBe("haiku");
    expect(catalog.resolveId("claude-sonnet-5-5")).toBe("sonnet");
    expect(catalog.resolveId("claude-fable-5-1")).toBe("fable");
  });

  it("prefers a concrete alias over `default` for an id both resolve to", () => {
    expect(catalog.resolveId("claude-opus-5-5")).toBe("opus");
  });

  it("resolves the exact reported shape: value `haiku`, resolvedModel `claude-haiku-5-5`", () => {
    const synthetic = ClaudeModelCatalog.fromInitialize([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
    ]);
    expect(synthetic.resolveId("claude-haiku-5-5")).toBe("haiku");
    expect(synthetic.resolveId("haiku")).toBe("haiku");
  });

  it("answers undefined for an id nothing offers — never a guess at a default", () => {
    expect(catalog.resolveId("claude-imaginary-9")).toBeUndefined();
    expect(catalog.resolveId("")).toBeUndefined();
  });

  it("an unreadable catalog resolves nothing (fail-closed)", () => {
    const empty = ClaudeModelCatalog.fromInitialize(undefined);
    expect(empty.resolveId("haiku")).toBeUndefined();
  });
});

describe("ClaudeModelCatalog.selectableForResolved — the ambiguous read-back (cut §1.5 hazard (б))", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(fixtureModels());

  it("prefers a CONCRETE alias over `default` when both resolve to the same model", () => {
    // Synthetic ambiguity case: `default` and `opus` share `claude-opus-5-5`, and
    // `default` is listed first — so plain `findByResolved` answers `default`.
    expect(catalog.findByResolved("claude-opus-5-5")!.value).toBe("default");
    // Persisting `default` for a session actually pinned to opus would silently
    // re-point it the day the account's default model changes.
    expect(catalog.selectableForResolved("claude-opus-5-5")!.value).toBe("opus");
  });

  it("answers the unambiguous cases identically to findByResolved", () => {
    expect(catalog.selectableForResolved("claude-sonnet-5-5")!.value).toBe("sonnet");
    expect(catalog.selectableForResolved("claude-haiku-5-5")!.value).toBe("haiku");
    expect(catalog.selectableForResolved("no-such-model")).toBeUndefined();
  });

  it("an exact `value` hit wins outright (the CLI reporting a selectable id verbatim)", () => {
    expect(catalog.selectableForResolved("sonnet")!.value).toBe("sonnet");
  });
});

it("resolves every fallback id through the synthetic initialize catalog", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(fixtureModels());
  expect(CLAUDE_DRAFT_MODELS.map(model => catalog.resolveId(model.id))).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
});

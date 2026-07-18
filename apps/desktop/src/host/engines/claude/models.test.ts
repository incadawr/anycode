/**
 * Model-catalog tests on the LIVE `initialize` response captured in
 * `w0-16-setmodel.jsonl` (cut §1.4). The load-bearing discriminator is the
 * `value` / `resolvedModel` split: `claude-fable-5[1m]` is what you SEND,
 * `claude-fable-5` is what the CLI REPORTS back, and a round-trip assert
 * against the requested id would fire a false mismatch on every switch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeModelCatalog } from "./models.js";
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
  return "claude-fable-5[1m]";
}

/** The live `initialize` response's `models[]`. */
function liveModels(): unknown {
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

describe("ClaudeModelCatalog — built from the live initialize models[], never a static enum", () => {
  const catalog = ClaudeModelCatalog.fromInitialize(liveModels());

  it("decodes the live catalog", () => {
    expect(catalog.available).toBe(true);
    const ids = catalog.choices().map((choice) => choice.id);
    // The observed live set (cut §1.4 / contract §2.1).
    expect(ids).toEqual(["default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"]);
    expect(catalog.defaultValue()).toBe("default");
  });

  it("keeps `value` and `resolvedModel` distinct — they genuinely differ live", () => {
    const fable = catalog.get("claude-fable-5[1m]")!;
    expect(fable.value).toBe("claude-fable-5[1m]");
    expect(fable.resolvedModel).toBe("claude-fable-5");
    expect(fable.value).not.toBe(fable.resolvedModel);
    expect(catalog.get("opus[1m]")!.resolvedModel).toBe("claude-opus-4-8[1m]");
  });

  it("read-back compares against resolvedModel, so a get_context_usage echo matches (NOT a round-trip assert)", () => {
    // What `get_context_usage.model` actually reports after selecting fable.
    expect(catalog.readBackMatches("claude-fable-5[1m]", "claude-fable-5")).toBe(true);
    // A naive requested-vs-reported string comparison would have failed here:
    const requested: string = fableRequestedId();
    expect(requested).not.toBe("claude-fable-5");
    // The sent id also matches (both directions of the split resolve).
    expect(catalog.readBackMatches("claude-fable-5[1m]", "claude-fable-5[1m]")).toBe(true);
    // A genuinely different model still fails the check.
    expect(catalog.readBackMatches("claude-fable-5[1m]", "claude-haiku-4-5-20251001")).toBe(false);
  });

  it("findByResolved maps a CLI-reported id back to its catalog entry", () => {
    expect(catalog.findByResolved("claude-opus-4-8[1m]")!.value).toBe("default");
    expect(catalog.findByResolved("claude-sonnet-5")!.value).toBe("sonnet");
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

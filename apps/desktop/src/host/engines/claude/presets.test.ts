/**
 * The frozen preset table (cut §1.4). Two things are pinned here, and the
 * second is the one that matters:
 *
 *  1. The three exposed presets map to the three WIRE modes, including the
 *     `ask -> default` / flag `manual` asymmetry (probe #8).
 *  2. `dontAsk`, `auto` and `bypassPermissions` are NOT reachable through any
 *     exposed preset. That exclusion is measured behaviour, not caution: the
 *     first two make tool use invisible to the approval bridge (auto-deny with
 *     no control event / silent classifier approval), so a preset that reached
 *     them would present an approval UI that is never consulted.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_PERMISSION_PRESETS,
  DEFAULT_CLAUDE_PRESET,
  claudePresetChoices,
  findClaudePreset,
} from "./presets.js";
import { permissionModeToFlag } from "./protocol.js";

/** Every CLI permission mode that must never be reachable from an exposed preset. */
const WITHHELD_MODES = ["dontAsk", "auto", "bypassPermissions"] as const;

describe("CLAUDE_PERMISSION_PRESETS (frozen table)", () => {
  it("exposes exactly read-only/ask/workspace, mapped to plan/default/acceptEdits", () => {
    expect(CLAUDE_PERMISSION_PRESETS.map((preset) => [preset.id, preset.mode])).toEqual([
      ["read-only", "plan"],
      ["ask", "default"],
      ["workspace", "acceptEdits"],
    ]);
  });

  it("defaults to `ask`, whose WIRE mode is `default` and whose CLI FLAG is `manual` (the asymmetry, probe #8)", () => {
    expect(DEFAULT_CLAUDE_PRESET).toBe("ask");
    const fallback = findClaudePreset(DEFAULT_CLAUDE_PRESET);
    expect(fallback).toBeDefined();
    expect(fallback!.mode).toBe("default");
    // The discriminator: a build that dropped the flag translation would send
    // the wire word `default` on the spawn argv, which the CLI does not accept.
    expect(permissionModeToFlag(fallback!.mode)).toBe("manual");
  });

  it("never exposes dontAsk/auto/bypassPermissions — not as a mode, not as an id", () => {
    const modes = CLAUDE_PERMISSION_PRESETS.map((preset) => preset.mode as string);
    for (const withheld of WITHHELD_MODES) {
      expect(modes).not.toContain(withheld);
      // Also unreachable by asking for one BY NAME: `findClaudePreset` is the
      // only lookup the engine has, and it answers off this same table.
      expect(findClaudePreset(withheld)).toBeUndefined();
    }
  });

  it("is genuinely frozen at the type level and stable across reads", () => {
    // `claudePresetChoices()` must not hand out a reference callers can mutate
    // back into the table.
    const first = claudePresetChoices();
    first.push({ id: "bypass", label: "Bypass", description: "should not stick" });
    expect(claudePresetChoices().map((choice) => choice.id)).toEqual(["read-only", "ask", "workspace"]);
    expect(CLAUDE_PERMISSION_PRESETS).toHaveLength(3);
  });

  it("the wire projection carries labels only — never the mode values (the renderer must not learn them)", () => {
    for (const choice of claudePresetChoices()) {
      expect(Object.keys(choice).sort()).toEqual(["description", "id", "label"]);
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.description.length).toBeGreaterThan(0);
    }
  });

  it("an unknown id resolves to nothing, so callers must apply their own fallback", () => {
    expect(findClaudePreset("nope")).toBeUndefined();
    expect(findClaudePreset("")).toBeUndefined();
  });
});

/**
 * Taskana 4704 §3.9 (part B) — preset derivation pins. Pure-function tests
 * over deriveRolePresets/presetApplicable/autoSelectPreset
 * (the dialog JSX renders what these return; this package's vitest is node,
 * no jsdom).
 */
import { describe, expect, it } from "vitest";
import {
  activePresetId,
  autoSelectPreset,
  deriveRolePresets,
  presetApplicable,
  presetMatchesRoles,
  presetUnavailableReason,
  ROLE_PRESET_ROLES,
} from "./role-presets.js";

const ACTIVE = "conn-active";

describe("deriveRolePresets", () => {
  it("P1: Claude leads, Codex builds — exact per-role chains", () => {
    const presets = deriveRolePresets({ claudeReady: true, codexReady: true }, ACTIVE);
    const p1 = presets[0]!;
    expect(p1.id).toBe("claude-leads-codex-builds");
    expect(p1.label).toBe("Claude leads, Codex builds");
    expect(p1.roles.orchestrator).toEqual({ primary: { engine: "claude" } });
    expect(p1.roles.planner).toEqual({ primary: { engine: "claude" } });
    expect(p1.roles.reviewer).toEqual({ primary: { engine: "claude" } });
    expect(p1.roles.executor).toEqual({
      primary: { engine: "codex" },
      fallbacks: [{ connection: ACTIVE }],
    });
    expect(p1.roles.explore).toEqual({ primary: { connection: ACTIVE } });
  });

  it("P2: All Claude — every role claude, explore falls back to the active connection", () => {
    const presets = deriveRolePresets({ claudeReady: true, codexReady: true }, ACTIVE);
    const p2 = presets[1]!;
    expect(p2.id).toBe("all-claude");
    for (const role of ROLE_PRESET_ROLES) {
      expect(p2.roles[role].primary).toEqual({ engine: "claude" });
    }
    expect(p2.roles.explore.fallbacks).toEqual([{ connection: ACTIVE }]);
    // Only explore carries a fallback in P2.
    expect(p2.roles.executor.fallbacks).toBeUndefined();
  });

  it("P3: Current connection — every role pins the connection active now", () => {
    const presets = deriveRolePresets({ claudeReady: false, codexReady: false }, ACTIVE);
    const p3 = presets[2]!;
    expect(p3.id).toBe("this-connection");
    expect(p3.label).toBe("Current connection");
    expect(p3.description).toBe("Every role is pinned to the connection active now.");
    for (const role of ROLE_PRESET_ROLES) {
      expect(p3.roles[role]).toEqual({ primary: { connection: ACTIVE } });
    }
  });

  it("derivation is independent of engine readiness (same three presets, same order)", () => {
    const ready = deriveRolePresets({ claudeReady: true, codexReady: true }, ACTIVE).map((p) => p.id);
    const none = deriveRolePresets({ claudeReady: false, codexReady: false }, ACTIVE).map((p) => p.id);
    expect(ready).toEqual(["claude-leads-codex-builds", "all-claude", "this-connection"]);
    expect(none).toEqual(ready);
  });
});

describe("presetApplicable", () => {
  const presets = deriveRolePresets({ claudeReady: true, codexReady: true }, ACTIVE);
  const p1 = presets[0]!;
  const p2 = presets[1]!;
  const p3 = presets[2]!;

  it("P1 requires BOTH claude and codex ready", () => {
    expect(presetApplicable(p1, { claudeReady: true, codexReady: true })).toBe(true);
    expect(presetApplicable(p1, { claudeReady: true, codexReady: false })).toBe(false);
    expect(presetApplicable(p1, { claudeReady: false, codexReady: true })).toBe(false);
  });

  it("P2 requires claude only", () => {
    expect(presetApplicable(p2, { claudeReady: true, codexReady: false })).toBe(true);
    expect(presetApplicable(p2, { claudeReady: false, codexReady: true })).toBe(false);
  });

  it("P3 is always applicable", () => {
    expect(presetApplicable(p3, { claudeReady: false, codexReady: false })).toBe(true);
  });
});

describe("autoSelectPreset", () => {
  it("both engines ready -> P1", () => {
    expect(autoSelectPreset({ claudeReady: true, codexReady: true }, ACTIVE).id).toBe("claude-leads-codex-builds");
  });

  it("claude only -> P2", () => {
    expect(autoSelectPreset({ claudeReady: true, codexReady: false }, ACTIVE).id).toBe("all-claude");
  });

  it("neither engine -> P3 (never null)", () => {
    expect(autoSelectPreset({ claudeReady: false, codexReady: false }, ACTIVE).id).toBe("this-connection");
  });
});

describe("activePresetId — the highlighted chip follows the shown values", () => {
  const presets = deriveRolePresets({ claudeReady: true, codexReady: true }, ACTIVE);

  it("matches a preset chain regardless of key order", () => {
    const p1 = presets[0]!;
    const reordered = {
      explore: { primary: { connection: ACTIVE } },
      reviewer: { primary: { engine: "claude" as const } },
      executor: { fallbacks: [{ connection: ACTIVE }], primary: { engine: "codex" as const } },
      planner: { primary: { engine: "claude" as const } },
      orchestrator: { primary: { engine: "claude" as const } },
    };
    expect(presetMatchesRoles(p1, reordered)).toBe(true);
    expect(activePresetId(presets, reordered)).toBe("claude-leads-codex-builds");
  });

  it("highlights nothing for a persisted engine chain when no engine is ready (the audit's Claude/Codex + 'Current connection' contradiction)", () => {
    const unready = deriveRolePresets({ claudeReady: false, codexReady: false }, ACTIVE);
    const readiness = { claudeReady: false, codexReady: false };
    // Persisted defaults an older profile can carry: Claude leads, Codex builds.
    const persisted = presets[0]!.roles;
    expect(activePresetId(unready, persisted, readiness)).toBeNull();
    // With both engines ready the SAME chain is honestly P1 — and never P3.
    expect(activePresetId(presets, persisted, { claudeReady: true, codexReady: true })).toBe("claude-leads-codex-builds");
    expect(activePresetId(unready, unready[2]!.roles, readiness)).toBe("this-connection");
  });

  it("highlights nothing once the user edits one route", () => {
    const edited = { ...presets[2]!.roles, orchestrator: { primary: { connection: "other" } } };
    expect(activePresetId(presets, edited)).toBeNull();
  });
});

describe("presetUnavailableReason — disabled presets explain themselves in words", () => {
  it("names every missing engine", () => {
    const presets = deriveRolePresets({ claudeReady: false, codexReady: false }, ACTIVE);
    expect(presetUnavailableReason(presets[0]!, { claudeReady: false, codexReady: false }))
      .toBe("Requires Claude and Codex to be set up and signed in.");
    expect(presetUnavailableReason(presets[1]!, { claudeReady: false, codexReady: true }))
      .toBe("Requires Claude to be set up and signed in.");
  });

  it("returns null for an applicable preset, P3 included", () => {
    const presets = deriveRolePresets({ claudeReady: true, codexReady: false }, ACTIVE);
    expect(presetUnavailableReason(presets[1]!, { claudeReady: true, codexReady: false })).toBeNull();
    expect(presetUnavailableReason(presets[2]!, { claudeReady: false, codexReady: false })).toBeNull();
  });
});

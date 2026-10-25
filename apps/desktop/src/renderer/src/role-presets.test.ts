/**
 * Taskana 4704 §3.9 (part B) — preset derivation pins. Pure-function tests
 * over deriveRolePresets/presetApplicable/autoSelectPreset/entryModelPrefill
 * (the dialog JSX renders what these return; this package's vitest is node,
 * no jsdom).
 */
import { describe, expect, it } from "vitest";
import {
  autoSelectPreset,
  deriveRolePresets,
  entryModelPrefill,
  presetApplicable,
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

  it("P3: This connection — every role on the active connection", () => {
    const presets = deriveRolePresets({ claudeReady: false, codexReady: false }, ACTIVE);
    const p3 = presets[2]!;
    expect(p3.id).toBe("this-connection");
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

describe("entryModelPrefill", () => {
  it("an explicit entry model wins", () => {
    expect(entryModelPrefill({ connection: ACTIVE, model: "explicit" }, "conn-model", ["m1"])).toBe("explicit");
  });

  it("falls back to the connection's model, then its first models[] entry, then empty", () => {
    expect(entryModelPrefill({ connection: ACTIVE }, "conn-model", ["m1", "m2"])).toBe("conn-model");
    expect(entryModelPrefill({ connection: ACTIVE }, undefined, ["m1", "m2"])).toBe("m1");
    expect(entryModelPrefill({ connection: ACTIVE }, undefined, undefined)).toBe("");
    expect(entryModelPrefill({ connection: ACTIVE }, "", ["m1"])).toBe("m1");
  });

  it("an engine entry ignores connection facts (the connection is not the route) and prefills empty", () => {
    // §3.9: the prefill reads the CONNECTION the entry names; an engine entry
    // names no connection, so no connection model applies — free text.
    expect(entryModelPrefill({ engine: "claude" }, "conn-model", ["m1"])).toBe("");
    expect(entryModelPrefill({ engine: "claude", model: "sonnet" }, "conn-model", ["m1"])).toBe("sonnet");
  });
});

/**
 * Taskana 4704 §3.9 (part B) — RolePickerDialog behavior tests. This
 * package's vitest runs `environment: "node"` (no jsdom), so the JSX itself
 * cannot mount here; what the dialog RENDERS is the pure draft model
 * (role-editor-model.ts) seeded from the pure presets (role-presets.ts), and
 * those two are what these tests pin — including the exact save payload
 * shape a Save click produces (fromDraft of the seeded draft) and the
 * fallback add/remove/reorder edits.
 */
import { describe, expect, it } from "vitest";
import { autoSelectPreset } from "../role-presets.js";
import {
  addFallback,
  draftValid,
  fromDraft,
  fromDraftEntry,
  moveFallback,
  patchEntry,
  removeFallback,
  toDraft,
  toDraftEntry,
} from "../role-editor-model.js";

const ACTIVE = "conn-active";

describe("RolePickerDialog draft model", () => {
  it("seeding from the auto-selected P1 preset yields the P1 save payload", () => {
    const preset = autoSelectPreset({ claudeReady: true, codexReady: true }, ACTIVE);
    const draft = toDraft(preset.roles);
    // The round-trip preserves every role's chain exactly.
    expect(fromDraft(draft).roles).toEqual(preset.roles);
  });

  it("seeding from persisted roles round-trips them (Settings edit mode; unspecified roles persist as blank entries)", () => {
    const persisted = {
      executor: { primary: { connection: ACTIVE, model: "m-exec" }, fallbacks: [{ engine: "codex" as const }] },
    };
    const draft = toDraft(persisted);
    const saved = fromDraft(draft).roles;
    // The EDITED role round-trips exactly...
    expect(saved.executor).toEqual(persisted.executor);
    // ...and the draft carries the other four as blank entries (primary {},
    // no fallbacks) — the editor always shows all five roles; a blank primary
    // means "no route configured" (host reads null -> built-in defaults).
    expect(saved.orchestrator).toEqual({ primary: {} });
    expect(saved.planner).toEqual({ primary: {} });
    expect(saved.reviewer).toEqual({ primary: {} });
    expect(saved.explore).toEqual({ primary: {} });
  });

  it("editing a fallback row's model patches only that entry", () => {
    const draft = toDraft(autoSelectPreset({ claudeReady: true, codexReady: true }, ACTIVE).roles);
    const patched = patchEntry(draft, "executor", 0, { model: "glm-flash" });
    expect(patched.executor.fallbacks[0]!.model).toBe("glm-flash");
    // Primary untouched.
    expect(patched.executor.primary).toEqual(draft.executor.primary);
  });

  it("add/remove/reorder fallbacks produce the expected lists", () => {
    let draft = toDraft({});
    draft = addFallback(draft, "planner");
    draft = addFallback(draft, "planner");
    expect(draft.planner.fallbacks).toHaveLength(2);
    draft = patchEntry(draft, "planner", 0, { model: "a" });
    draft = patchEntry(draft, "planner", 1, { model: "b" });
    // Move up: [a, b] -> [b, a]
    draft = moveFallback(draft, "planner", 1, -1);
    expect(draft.planner.fallbacks.map((f) => f.model)).toEqual(["b", "a"]);
    // Moving the first entry up is a no-op.
    expect(moveFallback(draft, "planner", 0, -1).planner.fallbacks.map((f) => f.model)).toEqual(["b", "a"]);
    // Remove the first fallback.
    draft = removeFallback(draft, "planner", 0);
    expect(draft.planner.fallbacks.map((f) => f.model)).toEqual(["a"]);
  });

  it("an engine+connection entry is invalid (Save disabled); either alone is valid", () => {
    const base = toDraft({});
    const both = patchEntry(base, "reviewer", null, { engine: "claude", connection: ACTIVE });
    expect(draftValid(both)).toBe(false);
    expect(draftValid(patchEntry(base, "reviewer", null, { engine: "claude" }))).toBe(true);
    expect(draftValid(patchEntry(base, "reviewer", null, { connection: ACTIVE }))).toBe(true);
    // A bad fallback entry also invalidates the draft.
    const withFallback = addFallback(both, "reviewer");
    expect(draftValid(withFallback)).toBe(false);
  });

  it("fromDraftEntry drops empty strings and trims", () => {
    expect(fromDraftEntry({ engine: "", connection: "  ", model: "  m  ", effort: "" })).toEqual({ model: "m" });
    expect(fromDraftEntry(toDraftEntry(undefined))).toEqual({});
    expect(fromDraftEntry({ engine: "codex", connection: "", model: "", effort: "high" })).toEqual({ engine: "codex", effort: "high" });
  });
});

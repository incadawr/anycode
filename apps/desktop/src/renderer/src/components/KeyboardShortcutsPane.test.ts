/**
 * Pure-logic tests for KeyboardShortcutsPane's exported helpers (P7.24/F20
 * W3, design/slice-P7.24-cut.md §1.4/§4). Same `.test.ts`-only, no-jsdom
 * rationale as every other Settings pane in this directory (vitest.config.ts
 * runs `environment: "node"` — see SkillsPane.test.ts's own docstring): the
 * record-mode DOM listener is deliberately thin (a straight pass-through to
 * `classifyRecordedStroke`), so this file pins the row builder, the search
 * filter, the four mutation helpers (record/remove/clear/reset), and the
 * stroke classifier + its error copy — the exact values the component's
 * click/keydown handlers feed into `setPatch`.
 */
import { describe, expect, it } from "vitest";
import type { KeybindingOverride } from "../../../shared/settings.js";
import type { DesktopPlatform } from "../../../shared/window.js";
import { ACTION_CATALOG, RESERVED_CHORDS, normalizeOverrides, type KeyStroke } from "../keymap.js";
import {
  applyRecord,
  classifyRecordedStroke,
  clearAllBindings,
  filterShortcutRows,
  isModifierOnlyStroke,
  recordErrorMessage,
  removeBinding,
  resetAction,
  shortcutRows,
} from "./KeyboardShortcutsPane.js";

function stroke(overrides: Partial<KeyStroke>): KeyStroke {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

// ── shortcutRows ──

describe("shortcutRows", () => {
  it("one row per ACTION_CATALOG entry, in catalog order", () => {
    const rows = shortcutRows(undefined, "darwin");
    expect(rows.map((r) => r.action)).toEqual(ACTION_CATALOG.map((m) => m.action));
  });

  it("no overrides -> every editable row shows its built-in default badge(s)", () => {
    const rows = shortcutRows(undefined, "darwin");
    const paletteToggle = rows.find((r) => r.action === "palette.toggle")!;
    expect(paletteToggle.editable).toBe(true);
    expect(paletteToggle.bindings).toEqual(["⌘K"]);
    expect(paletteToggle.overridden).toBe(false);
    expect(paletteToggle.unassigned).toBe(false);
  });

  it("an action with two default rows (palette.sessions) shows two badges in declaration order", () => {
    const rows = shortcutRows(undefined, "darwin");
    const sessions = rows.find((r) => r.action === "palette.sessions")!;
    expect(sessions.bindings).toEqual(["⌘P", "⌘G"]);
  });

  it("win32/linux formats with Ctrl+ text", () => {
    const rows = shortcutRows(undefined, "win32");
    const paletteToggle = rows.find((r) => r.action === "palette.toggle")!;
    expect(paletteToggle.bindings).toEqual(["Ctrl+K"]);
  });

  it("tab.activate renders a fixed platform-formatted hint, non-editable", () => {
    const darwinRow = shortcutRows(undefined, "darwin").find((r) => r.action === "tab.activate")!;
    expect(darwinRow.editable).toBe(false);
    expect(darwinRow.bindings).toEqual(["⌘1–⌘9"]);
    expect(darwinRow.unassigned).toBe(false);

    const win32Row = shortcutRows(undefined, "win32").find((r) => r.action === "tab.activate")!;
    expect(win32Row.bindings).toEqual(["Ctrl+1–Ctrl+9"]);
  });

  it("turn.interrupt renders its fixed Esc binding, non-editable, unaffected by overrides", () => {
    const overrides: KeybindingOverride[] = [{ action: "turn.interrupt", bindings: ["mod+z"] }];
    const row = shortcutRows(overrides, "darwin").find((r) => r.action === "turn.interrupt")!;
    expect(row.editable).toBe(false);
    expect(row.bindings).toEqual(["esc"]);
    expect(row.overridden).toBe(false);
  });

  it("an override entry marks the row overridden and drives its badge text", () => {
    const overrides: KeybindingOverride[] = [{ action: "session.new", bindings: ["mod+shift+n"] }];
    const row = shortcutRows(overrides, "darwin").find((r) => r.action === "session.new")!;
    expect(row.overridden).toBe(true);
    expect(row.bindings).toEqual(["⇧⌘N"]);
    expect(row.unassigned).toBe(false);
  });

  it("an explicit empty override -> Unassigned, still overridden", () => {
    const overrides: KeybindingOverride[] = [{ action: "session.new", bindings: [] }];
    const row = shortcutRows(overrides, "darwin").find((r) => r.action === "session.new")!;
    expect(row.overridden).toBe(true);
    expect(row.bindings).toEqual([]);
    expect(row.unassigned).toBe(true);
  });

  it("an unparsable stored chord is dropped fail-soft, not thrown", () => {
    const overrides: KeybindingOverride[] = [{ action: "session.new", bindings: ["garbage", "mod+q"] }];
    const row = shortcutRows(overrides, "darwin").find((r) => r.action === "session.new")!;
    // "garbage" fails to parse and is skipped; "mod+q" parses fine (chordOwner/reservation is a
    // separate concern from display formatting) and renders as its own badge.
    expect(row.bindings).toEqual(["⌘Q"]);
  });

  it("an unknown action in overrides is simply ignored (not present in ACTION_CATALOG, no row to attach to)", () => {
    const overrides: KeybindingOverride[] = [{ action: "totally.unknown", bindings: ["mod+z"] }];
    expect(() => shortcutRows(overrides, "darwin")).not.toThrow();
  });
});

// ── filterShortcutRows ──

describe("filterShortcutRows", () => {
  const rows = shortcutRows(undefined, "darwin");

  it("blank query -> every row, unchanged order", () => {
    expect(filterShortcutRows(rows, "")).toEqual(rows);
    expect(filterShortcutRows(rows, "   ")).toEqual(rows);
  });

  it("matches by name, case-insensitively", () => {
    const hits = filterShortcutRows(rows, "COMMAND palette");
    expect(hits.map((r) => r.action)).toEqual(["palette.toggle"]);
  });

  it("matches by description substring", () => {
    const hits = filterShortcutRows(rows, "integrated terminal");
    expect(hits.map((r) => r.action)).toEqual(["terminal.toggle"]);
  });

  it("matches by formatted badge text", () => {
    const hits = filterShortcutRows(rows, "⌘K");
    expect(hits.map((r) => r.action)).toEqual(["palette.toggle"]);
  });

  it("a garbage query matches nothing", () => {
    expect(filterShortcutRows(rows, "zzz-nope-zzz")).toEqual([]);
  });
});

// ── applyRecord / removeBinding / clearAllBindings / resetAction ──

describe("applyRecord", () => {
  it("records into a fresh slot 0 for an action with no override yet", () => {
    const next = applyRecord(undefined, "session.new", 0, { key: "y", mod: true, shift: false });
    expect(next).toEqual([{ action: "session.new", bindings: ["mod+y"] }]);
  });

  it("appends when slotIndex is past the current end", () => {
    const overrides: KeybindingOverride[] = [{ action: "session.new", bindings: ["mod+y"] }];
    const next = applyRecord(overrides, "session.new", 5, { key: "u", mod: true, shift: false });
    expect(next).toEqual([{ action: "session.new", bindings: ["mod+y", "mod+u"] }]);
  });

  it("replaces an existing slot in place", () => {
    const overrides: KeybindingOverride[] = [{ action: "palette.sessions", bindings: ["mod+p", "mod+g"] }];
    const next = applyRecord(overrides, "palette.sessions", 1, { key: "h", mod: true, shift: false });
    expect(next).toEqual([{ action: "palette.sessions", bindings: ["mod+p", "mod+h"] }]);
  });

  it("self-cleaning: recording exactly back onto the built-in default drops the override entry", () => {
    const overrides: KeybindingOverride[] = [{ action: "session.new", bindings: ["mod+y"] }];
    const next = applyRecord(overrides, "session.new", 0, { key: "n", mod: true, shift: false });
    expect(next).toEqual([]);
  });

  it("leaves other actions' override entries untouched", () => {
    const overrides: KeybindingOverride[] = [{ action: "terminal.toggle", bindings: ["mod+t"] }];
    const next = applyRecord(overrides, "session.new", 0, { key: "y", mod: true, shift: false });
    expect(next).toContainEqual({ action: "terminal.toggle", bindings: ["mod+t"] });
    expect(next).toContainEqual({ action: "session.new", bindings: ["mod+y"] });
  });
});

describe("removeBinding", () => {
  it("removes one badge from a multi-binding action", () => {
    const overrides: KeybindingOverride[] = [{ action: "palette.sessions", bindings: ["mod+p", "mod+g"] }];
    const next = removeBinding(overrides, "palette.sessions", 0);
    expect(next).toEqual([{ action: "palette.sessions", bindings: ["mod+g"] }]);
  });

  it("removing the last binding commits an explicit empty override (Unassigned)", () => {
    const next = removeBinding(undefined, "session.new", 0);
    expect(next).toEqual([{ action: "session.new", bindings: [] }]);
  });

  it("removing back down to exactly the defaults self-cleans (no override entry)", () => {
    const overrides: KeybindingOverride[] = [{ action: "palette.sessions", bindings: ["mod+p", "mod+g", "mod+h"] }];
    const next = removeBinding(overrides, "palette.sessions", 2);
    expect(next).toEqual([]);
  });
});

describe("clearAllBindings", () => {
  it("clears every binding for the action to an explicit empty override", () => {
    const overrides: KeybindingOverride[] = [{ action: "palette.sessions", bindings: ["mod+p", "mod+g"] }];
    const next = clearAllBindings(overrides, "palette.sessions");
    expect(next).toEqual([{ action: "palette.sessions", bindings: [] }]);
  });

  it("leaves other actions untouched", () => {
    const overrides: KeybindingOverride[] = [
      { action: "palette.sessions", bindings: ["mod+p"] },
      { action: "terminal.toggle", bindings: ["mod+t"] },
    ];
    const next = clearAllBindings(overrides, "palette.sessions");
    expect(next).toContainEqual({ action: "terminal.toggle", bindings: ["mod+t"] });
    expect(next).toContainEqual({ action: "palette.sessions", bindings: [] });
  });
});

describe("resetAction", () => {
  it("drops the override entry entirely, reverting to built-in defaults", () => {
    const overrides: KeybindingOverride[] = [
      { action: "session.new", bindings: ["mod+y"] },
      { action: "terminal.toggle", bindings: ["mod+t"] },
    ];
    const next = resetAction(overrides, "session.new");
    expect(next).toEqual([{ action: "terminal.toggle", bindings: ["mod+t"] }]);
  });

  it("no-op on undefined overrides", () => {
    expect(resetAction(undefined, "session.new")).toEqual([]);
  });
});

// ── isModifierOnlyStroke / classifyRecordedStroke / recordErrorMessage ──

describe("isModifierOnlyStroke", () => {
  it("true for a bare modifier keydown", () => {
    for (const key of ["Shift", "Meta", "Control", "Alt", "OS"]) {
      expect(isModifierOnlyStroke(stroke({ key }))).toBe(true);
    }
  });

  it("false for a real key", () => {
    expect(isModifierOnlyStroke(stroke({ key: "k" }))).toBe(false);
  });
});

describe("classifyRecordedStroke", () => {
  const platform: DesktopPlatform = "darwin";

  it("ignores a bare modifier keydown", () => {
    expect(classifyRecordedStroke(stroke({ key: "Meta", metaKey: true }), platform, "session.new", undefined)).toEqual({
      kind: "ignored",
    });
  });

  it("no primary modifier down -> needs-mod", () => {
    expect(classifyRecordedStroke(stroke({ key: "y" }), platform, "session.new", undefined)).toEqual({
      kind: "needs-mod",
    });
  });

  it("alt down -> needs-mod even with the primary modifier held", () => {
    expect(
      classifyRecordedStroke(stroke({ key: "y", metaKey: true, altKey: true }), platform, "session.new", undefined),
    ).toEqual({ kind: "needs-mod" });
  });

  it("a role-menu reserved chord is refused", () => {
    expect(classifyRecordedStroke(stroke({ key: "q", metaKey: true }), platform, "session.new", undefined)).toEqual({
      kind: "reserved",
    });
  });

  it("a chord already owned by a different action is a conflict", () => {
    expect(classifyRecordedStroke(stroke({ key: "k", metaKey: true }), platform, "session.new", undefined)).toEqual({
      kind: "conflict",
      ownerAction: "palette.toggle",
    });
  });

  it("re-recording an action's own current chord is a self-match -> accept", () => {
    expect(classifyRecordedStroke(stroke({ key: "n", metaKey: true }), platform, "session.new", undefined)).toEqual({
      kind: "accept",
      chord: { key: "n", mod: true, shift: false },
    });
  });

  it("a free chord accepts", () => {
    expect(classifyRecordedStroke(stroke({ key: "y", metaKey: true, shiftKey: true }), platform, "session.new", undefined)).toEqual({
      kind: "accept",
      chord: { key: "y", mod: true, shift: true },
    });
  });

  it("win32/linux require ctrlKey, not metaKey", () => {
    expect(classifyRecordedStroke(stroke({ key: "y", metaKey: true }), "win32", "session.new", undefined)).toEqual({
      kind: "needs-mod",
    });
    expect(classifyRecordedStroke(stroke({ key: "y", ctrlKey: true }), "win32", "session.new", undefined)).toEqual({
      kind: "accept",
      chord: { key: "y", mod: true, shift: false },
    });
  });
});

describe("recordErrorMessage", () => {
  it("returns null for ignored/accept", () => {
    expect(recordErrorMessage({ kind: "ignored" })).toBeNull();
    expect(recordErrorMessage({ kind: "accept", chord: { key: "y", mod: true, shift: false } })).toBeNull();
  });

  it("returns the needs-mod hint verbatim", () => {
    expect(recordErrorMessage({ kind: "needs-mod" })).toBe("Use ⌘/Ctrl + key");
  });

  it("returns the reserved copy", () => {
    expect(recordErrorMessage({ kind: "reserved" })).toBe("Reserved shortcut");
  });

  it("names the owning action for a conflict", () => {
    expect(recordErrorMessage({ kind: "conflict", ownerAction: "palette.toggle" })).toBe(
      'Already used by "Command palette"',
    );
  });
});

// ── W5-FIX adversarial hardening (codex review) ──

describe("F3/F5 — pane display equals what dispatch fires", () => {
  it("duplicate override entries: the row shows the last-entry-wins binding", () => {
    const overrides: KeybindingOverride[] = [
      { action: "session.new", bindings: ["mod+y"] },
      { action: "session.new", bindings: ["mod+u"] },
    ];
    const row = shortcutRows(overrides, "darwin").find((r) => r.action === "session.new")!;
    expect(row.bindings).toEqual(["⌘U"]);
    expect(row.overridden).toBe(true);
  });

  it("cross-action duplicate chord: the losing action shows Unassigned, not the phantom chord", () => {
    const overrides: KeybindingOverride[] = [
      { action: "session.new", bindings: ["mod+y"] },
      { action: "terminal.toggle", bindings: ["mod+y"] },
    ];
    const rows = shortcutRows(overrides, "darwin");
    expect(rows.find((r) => r.action === "session.new")!.bindings).toEqual(["⌘Y"]);
    const term = rows.find((r) => r.action === "terminal.toggle")!;
    expect(term.bindings).toEqual([]);
    expect(term.unassigned).toBe(true);
  });
});

describe("F4 — normalized working array has no slot-index skew", () => {
  it("a corrupt leading chord no longer skews edit/remove indices", () => {
    const raw: KeybindingOverride[] = [{ action: "palette.sessions", bindings: ["garbage", "mod+g", "mod+h"] }];
    const norm = normalizeOverrides(raw);
    expect(norm).toEqual([{ action: "palette.sessions", bindings: ["mod+g", "mod+h"] }]);
    // Displayed badges map 1:1 onto the normalized slots.
    const row = shortcutRows(norm, "darwin").find((r) => r.action === "palette.sessions")!;
    expect(row.bindings).toEqual(["⌘G", "⌘H"]);
    // Removing displayed badge index 0 (⌘G) removes mod+g — NOT the stripped
    // "garbage" slot the old raw-index path would have hit.
    expect(removeBinding(norm, "palette.sessions", 0)).toEqual([
      { action: "palette.sessions", bindings: ["mod+h"] },
    ]);
  });
});

describe("F6 — record mode rejects extra modifiers", () => {
  it("darwin: Ctrl+Cmd+Y is refused (needs-mod), never stored as mod+y", () => {
    const out = classifyRecordedStroke(
      stroke({ key: "y", metaKey: true, ctrlKey: true }),
      "darwin",
      "session.new",
      undefined,
    );
    expect(out).toEqual({ kind: "needs-mod" });
  });

  it("non-darwin: Ctrl+Meta+Y is refused", () => {
    const out = classifyRecordedStroke(
      stroke({ key: "y", ctrlKey: true, metaKey: true }),
      "win32",
      "session.new",
      undefined,
    );
    expect(out).toEqual({ kind: "needs-mod" });
  });
});

// ── cross-check: every RESERVED_CHORDS entry classifies as reserved ──

describe("RESERVED_CHORDS integration", () => {
  it("every reserved role-menu chord refuses via classifyRecordedStroke", () => {
    for (const chordStr of RESERVED_CHORDS) {
      const key = chordStr.slice("mod+".length);
      const outcome = classifyRecordedStroke(stroke({ key, metaKey: true }), "darwin", "session.new", undefined);
      expect(outcome).toEqual({ kind: "reserved" });
    }
  });
});

// ── W6-FIX (codex R2): mod+physical-Digit[1-9] is reserved by `code`, not `key` ──
// matchKeymap's tab.activate special-case matches event.code, so a non-QWERTY
// layout (AZERTY: mod+physical-1 -> key "&", code "Digit1") must be refused
// here too, or the pane would record a chord dispatch can never fire.

describe("W6-FIX — record mode reserves mod+physical-Digit[1-9] by code", () => {
  it("AZERTY: mod+physical-1 (key '&', code 'Digit1') is reserved, not stored as mod+&", () => {
    const out = classifyRecordedStroke(
      stroke({ key: "&", code: "Digit1", metaKey: true }),
      "darwin",
      "session.new",
      undefined,
    );
    expect(out).toEqual({ kind: "reserved" });
  });

  it("every physical Digit1..Digit9 code is reserved regardless of key", () => {
    for (let n = 1; n <= 9; n++) {
      const out = classifyRecordedStroke(
        stroke({ key: `layout-char-${n}`, code: `Digit${n}`, metaKey: true }),
        "darwin",
        "session.new",
        undefined,
      );
      expect(out).toEqual({ kind: "reserved" });
    }
  });

  it("does not over-reject mod+d (a normal letter chord, unrelated code)", () => {
    const out = classifyRecordedStroke(stroke({ key: "d", code: "KeyD", metaKey: true }), "darwin", "session.new", undefined);
    expect(out).toEqual({ kind: "accept", chord: { key: "d", mod: true, shift: false } });
  });

  it("does not over-reject Shift+mod+Digit1 (dispatch's tab-activate case requires !shiftKey)", () => {
    const out = classifyRecordedStroke(
      stroke({ key: "1", code: "Digit1", metaKey: true, shiftKey: true }),
      "darwin",
      "session.new",
      undefined,
    );
    expect(out).toEqual({ kind: "accept", chord: { key: "1", mod: true, shift: true } });
  });
});

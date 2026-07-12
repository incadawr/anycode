/**
 * Pure-logic tests for the renderer keymap (ui-roadmap §4-R5). `.test.ts`, node
 * env (no jsdom): `KeyStroke` is a structural subset of KeyboardEvent, so every
 * case passes a plain object — no DOM, no React. Covers the matcher's
 * platform/exact-chord/digit rules and the two formatters.
 */
import { describe, expect, it } from "vitest";
import type { DesktopPlatform } from "../../shared/window.js";
import {
  ACTION_CATALOG,
  KEYMAP,
  RESERVED_CHORDS,
  bindingFor,
  chordOwner,
  formatBinding,
  formatTabHint,
  matchKeymap,
  normalizeOverrides,
  parseChord,
  resolveKeymap,
  serializeChord,
  type ActionId,
  type KeyBinding,
  type KeyStroke,
} from "./keymap.js";
import type { KeybindingOverride } from "../../shared/settings.js";

/** Builds a KeyStroke with everything up by default; overrides set the pressed keys/modifiers. */
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

describe("matchKeymap — platform primary modifier", () => {
  it("darwin: meta+k matches, ctrl+k does not", () => {
    expect(matchKeymap(stroke({ key: "k", metaKey: true }), "darwin")).toEqual({ action: "palette.toggle" });
    expect(matchKeymap(stroke({ key: "k", ctrlKey: true }), "darwin")).toBeNull();
  });

  it("win32 and linux: ctrl+k matches, meta+k does not", () => {
    for (const platform of ["win32", "linux"] as const satisfies readonly DesktopPlatform[]) {
      expect(matchKeymap(stroke({ key: "k", ctrlKey: true }), platform)).toEqual({ action: "palette.toggle" });
      expect(matchKeymap(stroke({ key: "k", metaKey: true }), platform)).toBeNull();
    }
  });
});

describe("matchKeymap — full non-docOnly sweep", () => {
  const cases: Array<{ over: Partial<KeyStroke>; action: ActionId }> = [
    { over: { key: "k", metaKey: true }, action: "palette.toggle" },
    { over: { key: "p", metaKey: true }, action: "palette.sessions" },
    { over: { key: "g", metaKey: true }, action: "palette.sessions" },
    { over: { key: "n", metaKey: true }, action: "session.new" },
    { over: { key: "j", metaKey: true }, action: "terminal.toggle" },
    { over: { key: ",", metaKey: true }, action: "settings.open" },
    { over: { key: "b", metaKey: true }, action: "sidebar.toggle" },
    { over: { key: "m", metaKey: true, shiftKey: true }, action: "mode.focus" },
  ];
  for (const { over, action } of cases) {
    it(`${JSON.stringify(over)} → ${action}`, () => {
      expect(matchKeymap(stroke(over), "darwin")).toEqual({ action });
    });
  }
});

describe("matchKeymap — shift and chord exactness", () => {
  it("shift exactness: meta+m (no shift) and meta+shift+k → null", () => {
    expect(matchKeymap(stroke({ key: "m", metaKey: true }), "darwin")).toBeNull();
    expect(matchKeymap(stroke({ key: "k", metaKey: true, shiftKey: true }), "darwin")).toBeNull();
  });

  it("chord exactness: meta+alt+k and meta+ctrl+k → null", () => {
    expect(matchKeymap(stroke({ key: "k", metaKey: true, altKey: true }), "darwin")).toBeNull();
    expect(matchKeymap(stroke({ key: "k", metaKey: true, ctrlKey: true }), "darwin")).toBeNull();
  });
});

describe("matchKeymap — digits and case", () => {
  it("digits map on event.code", () => {
    expect(matchKeymap(stroke({ code: "Digit1", metaKey: true }), "darwin")).toEqual({
      action: "tab.activate",
      tabIndex: 0,
    });
    expect(matchKeymap(stroke({ code: "Digit9", metaKey: true }), "darwin")).toEqual({
      action: "tab.activate",
      tabIndex: 8,
    });
    expect(matchKeymap(stroke({ code: "Digit0", metaKey: true }), "darwin")).toBeNull();
    expect(matchKeymap(stroke({ code: "Digit1", metaKey: true, shiftKey: true }), "darwin")).toBeNull();
  });

  it("case-insensitive: key 'K' (CapsLock) still matches", () => {
    expect(matchKeymap(stroke({ key: "K", metaKey: true }), "darwin")).toEqual({ action: "palette.toggle" });
  });
});

describe("matchKeymap — no-mod and docOnly", () => {
  it("plain k (no mod) → null", () => {
    expect(matchKeymap(stroke({ key: "k" }), "darwin")).toBeNull();
  });

  it("docOnly Escape is never returned", () => {
    expect(matchKeymap(stroke({ key: "Escape" }), "darwin")).toBeNull();
    expect(matchKeymap(stroke({ key: "escape", metaKey: true }), "darwin")).toBeNull();
  });
});

describe("formatBinding", () => {
  const binding = (over: Partial<KeyBinding>): KeyBinding => ({
    action: "palette.toggle",
    key: "k",
    mod: true,
    shift: false,
    ...over,
  });

  it("darwin glyphs", () => {
    expect(formatBinding(binding({ key: "k" }), "darwin")).toBe("⌘K");
    expect(formatBinding(binding({ key: "m", shift: true }), "darwin")).toBe("⇧⌘M");
    expect(formatBinding(binding({ key: "," }), "darwin")).toBe("⌘,");
    expect(formatBinding(binding({ key: "escape", mod: false }), "darwin")).toBe("esc");
  });

  it("win32 and linux glyphs (linux ≡ win32)", () => {
    for (const platform of ["win32", "linux"] as const satisfies readonly DesktopPlatform[]) {
      expect(formatBinding(binding({ key: "k" }), platform)).toBe("Ctrl+K");
      expect(formatBinding(binding({ key: "m", shift: true }), platform)).toBe("Ctrl+Shift+M");
      expect(formatBinding(binding({ key: "escape", mod: false }), platform)).toBe("Esc");
    }
  });
});

describe("formatTabHint", () => {
  it("darwin and win32", () => {
    expect(formatTabHint(3, "darwin")).toBe("⌘3");
    expect(formatTabHint(3, "win32")).toBe("Ctrl+3");
  });
});

describe("bindingFor", () => {
  it("returns the first declared binding for an action (⌘P for palette.sessions)", () => {
    const found = bindingFor("palette.sessions");
    expect(found).toEqual({ action: "palette.sessions", key: "p", mod: true, shift: false });
    // First-declared discipline: the ⌘P row precedes ⌘G in KEYMAP.
    expect(KEYMAP.filter((b) => b.action === "palette.sessions").map((b) => b.key)).toEqual(["p", "g"]);
  });
});

describe("sidebar.search — ⌘F (R9)", () => {
  it("matches ⌘F on darwin and Ctrl+F on linux", () => {
    expect(matchKeymap(stroke({ key: "f", code: "KeyF", metaKey: true }), "darwin")).toEqual({
      action: "sidebar.search",
    });
    expect(matchKeymap(stroke({ key: "f", code: "KeyF", ctrlKey: true }), "linux")).toEqual({
      action: "sidebar.search",
    });
  });

  it("rejects ⇧⌘F (shift mismatch) and plain f (no mod)", () => {
    expect(matchKeymap(stroke({ key: "f", code: "KeyF", metaKey: true, shiftKey: true }), "darwin")).toBeNull();
    expect(matchKeymap(stroke({ key: "f", code: "KeyF" }), "darwin")).toBeNull();
  });

  it("formats as ⌘F on darwin and Ctrl+F on linux", () => {
    expect(formatBinding(bindingFor("sidebar.search")!, "darwin")).toBe("⌘F");
    expect(formatBinding(bindingFor("sidebar.search")!, "linux")).toBe("Ctrl+F");
  });
});

// ── F20 keyboard-shortcuts override overlay (slice-P7.24-cut.md §1.4/§2/§3) ──

describe("ACTION_CATALOG (§1.4)", () => {
  it("covers every ActionId exactly once, in KEYMAP declaration order", () => {
    const catalogActions = ACTION_CATALOG.map((m) => m.action);
    // Declaration order = first appearance in KEYMAP + the two special-case rows.
    expect(catalogActions).toEqual([
      "palette.toggle",
      "palette.sessions",
      "session.new",
      "terminal.toggle",
      "settings.open",
      "sidebar.toggle",
      "sidebar.search",
      "tab.activate",
      "mode.focus",
      "turn.interrupt",
    ]);
    expect(new Set(catalogActions).size).toBe(catalogActions.length); // no dupes
  });

  it("marks only tab.activate and turn.interrupt non-editable", () => {
    const nonEditable = ACTION_CATALOG.filter((m) => !m.editable).map((m) => m.action);
    expect(nonEditable).toEqual(["tab.activate", "turn.interrupt"]);
    expect(ACTION_CATALOG.filter((m) => m.editable)).toHaveLength(8);
  });

  it("gives every entry a non-empty name and description", () => {
    for (const m of ACTION_CATALOG) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});

describe("parseChord / serializeChord (§1.4)", () => {
  it("parses canonical chords", () => {
    expect(parseChord("mod+k")).toEqual({ key: "k", mod: true, shift: false });
    expect(parseChord("mod+shift+m")).toEqual({ key: "m", mod: true, shift: true });
    expect(parseChord("mod+,")).toEqual({ key: ",", mod: true, shift: false });
  });

  it("round-trips serializeChord(parseChord(s)) === s for valid s", () => {
    for (const s of ["mod+k", "mod+shift+m", "mod+,", "mod+1", "mod+shift+f"]) {
      expect(serializeChord(parseChord(s)!)).toBe(s);
    }
  });

  it("returns null on non-canonical / garbage input", () => {
    for (const bad of [
      "", // empty
      "k", // bare key, no mod
      "mod", // no terminal key
      "mod+shift", // no terminal key after shift
      "mod+alt+k", // alt not allowed
      "alt+k", // wrong leading modifier
      "shift+k", // no mod
      "mod+K", // uppercase key
      "mod+shift+", // empty terminal
      "mod++k", // empty middle token
      "mod+ctrl+k", // ctrl as terminal-position modifier word
      "Mod+k", // wrong-case mod
      "ctrl+k", // literal ctrl instead of mod
    ]) {
      expect(parseChord(bad)).toBeNull();
    }
  });
});

describe("resolveKeymap (§2)", () => {
  it("identity fast-path: no / empty overrides returns the KEYMAP reference", () => {
    expect(resolveKeymap()).toBe(KEYMAP);
    expect(resolveKeymap([])).toBe(KEYMAP);
  });

  it("identity fast-path: overrides that all fail to apply return KEYMAP", () => {
    expect(resolveKeymap([{ action: "nope.unknown", bindings: ["mod+z"] }])).toBe(KEYMAP);
    expect(resolveKeymap([{ action: "tab.activate", bindings: ["mod+t"] }])).toBe(KEYMAP); // non-editable
  });

  it("override replaces an action's default rows in place", () => {
    const table = resolveKeymap([{ action: "palette.toggle", bindings: ["mod+shift+p"] }]);
    expect(table).not.toBe(KEYMAP);
    const rows = table.filter((b) => b.action === "palette.toggle");
    expect(rows).toEqual([{ action: "palette.toggle", key: "p", mod: true, shift: true }]);
    // Position preserved: palette.toggle stays first.
    expect(table[0]).toEqual({ action: "palette.toggle", key: "p", mod: true, shift: true });
    // Un-overridden neighbour untouched.
    expect(table.find((b) => b.action === "session.new")).toEqual({
      action: "session.new",
      key: "n",
      mod: true,
      shift: false,
    });
  });

  it("supports multiple bindings per action", () => {
    const table = resolveKeymap([{ action: "session.new", bindings: ["mod+n", "mod+shift+n"] }]);
    expect(table.filter((b) => b.action === "session.new")).toEqual([
      { action: "session.new", key: "n", mod: true, shift: false },
      { action: "session.new", key: "n", mod: true, shift: true },
    ]);
  });

  it("Unassigned (bindings:[]) drops the action from the effective table", () => {
    const table = resolveKeymap([{ action: "terminal.toggle", bindings: [] }]);
    expect(table.find((b) => b.action === "terminal.toggle")).toBeUndefined();
    // Everything else survives.
    expect(table.find((b) => b.action === "palette.toggle")).toBeDefined();
  });

  it("fail-soft: unparsable chords are skipped, valid ones kept, other actions untouched", () => {
    const table = resolveKeymap([
      { action: "settings.open", bindings: ["garbage", "mod+shift+s"] },
      { action: "totally.unknown", bindings: ["mod+z"] },
    ]);
    expect(table.filter((b) => b.action === "settings.open")).toEqual([
      { action: "settings.open", key: "s", mod: true, shift: true },
    ]);
    // docOnly turn.interrupt row is never disturbed.
    expect(table.find((b) => b.action === "turn.interrupt")?.docOnly).toBe(true);
  });

  it("the effective table drives matchKeymap through the defaulted param", () => {
    const table = resolveKeymap([{ action: "palette.toggle", bindings: ["mod+shift+p"] }]);
    // Default ⌘K no longer toggles the palette in the effective table…
    expect(matchKeymap(stroke({ key: "k", metaKey: true }), "darwin", table)).toBeNull();
    // …but ⇧⌘P does.
    expect(matchKeymap(stroke({ key: "p", metaKey: true, shiftKey: true }), "darwin", table)).toEqual({
      action: "palette.toggle",
    });
    // bindingFor reads the effective table too.
    expect(bindingFor("palette.toggle", table)).toEqual({
      action: "palette.toggle",
      key: "p",
      mod: true,
      shift: true,
    });
  });
});

describe("chordOwner (§3)", () => {
  it("returns the owning action for a bound chord", () => {
    expect(chordOwner({ key: "k", mod: true, shift: false })).toBe("palette.toggle");
    expect(chordOwner({ key: "m", mod: true, shift: true })).toBe("mode.focus");
  });

  it("returns null for a free chord", () => {
    expect(chordOwner({ key: "y", mod: true, shift: false })).toBeNull();
    expect(chordOwner({ key: "k", mod: true, shift: true })).toBeNull();
  });

  it("reports reserved chords: ⌘1–9, any escape, darwin role-menu keys", () => {
    expect(chordOwner({ key: "1", mod: true, shift: false })).toBe("reserved");
    expect(chordOwner({ key: "9", mod: true, shift: false })).toBe("reserved");
    expect(chordOwner({ key: "escape", mod: false, shift: false })).toBe("reserved");
    for (const k of ["q", "w", "c", "v", "x", "a", "z"]) {
      expect(chordOwner({ key: k, mod: true, shift: false })).toBe("reserved");
    }
  });

  it("sees overrides — a rebound chord's new owner and the vacated default", () => {
    const overrides = [{ action: "palette.toggle", bindings: ["mod+shift+p"] }];
    // ⌘K is now free (its default was dropped)…
    expect(chordOwner({ key: "k", mod: true, shift: false }, overrides)).toBeNull();
    // …and ⇧⌘P now owned by palette.toggle.
    expect(chordOwner({ key: "p", mod: true, shift: true }, overrides)).toBe("palette.toggle");
  });

  it("exports RESERVED_CHORDS (darwin role-menu set)", () => {
    expect(RESERVED_CHORDS).toEqual(["mod+q", "mod+w", "mod+c", "mod+v", "mod+x", "mod+a", "mod+z"]);
  });
});

// ── W5-FIX adversarial hardening (codex review) ──

describe("resolveKeymap — F1 total/defensive on adversarial input", () => {
  it("bindings:null degrades to defaults and never throws", () => {
    const corrupt = [{ action: "palette.toggle", bindings: null }] as unknown as KeybindingOverride[];
    expect(() => resolveKeymap(corrupt)).not.toThrow();
    // A corrupt blob can only ever degrade to defaults — palette.toggle keeps ⌘K.
    expect(resolveKeymap(corrupt)).toBe(KEYMAP);
  });

  it("non-array overrides and non-object entries degrade to defaults", () => {
    expect(resolveKeymap("nope" as unknown as KeybindingOverride[])).toBe(KEYMAP);
    expect(resolveKeymap([null, 42] as unknown as KeybindingOverride[])).toBe(KEYMAP);
  });

  it("a non-editable action's bindings:null does not crash a mixed list", () => {
    const mixed = [
      { action: "tab.activate", bindings: null },
      { action: "session.new", bindings: ["mod+shift+n"] },
    ] as unknown as KeybindingOverride[];
    expect(() => resolveKeymap(mixed)).not.toThrow();
    expect(resolveKeymap(mixed).filter((b) => b.action === "session.new")).toEqual([
      { action: "session.new", key: "n", mod: true, shift: true },
    ]);
  });
});

describe("resolveKeymap — F2 corruption ≠ intentional Unassigned", () => {
  it("a NON-empty all-unparsable override keeps the action's DEFAULT rows", () => {
    const table = resolveKeymap([{ action: "session.new", bindings: ["garbage", "also-bad"] }]);
    expect(table.filter((b) => b.action === "session.new")).toEqual([
      { action: "session.new", key: "n", mod: true, shift: false },
    ]);
  });

  it("only a literal empty [] unassigns the action", () => {
    const table = resolveKeymap([{ action: "session.new", bindings: [] }]);
    expect(table.find((b) => b.action === "session.new")).toBeUndefined();
  });
});

describe("normalizeOverrides / resolveKeymap — F3/F5 single canonicalization authority", () => {
  it("F3: duplicate entries for one action collapse last-entry-wins (dispatch == canonical)", () => {
    const overrides: KeybindingOverride[] = [
      { action: "session.new", bindings: ["mod+y"] },
      { action: "session.new", bindings: ["mod+u"] },
    ];
    expect(normalizeOverrides(overrides)).toEqual([{ action: "session.new", bindings: ["mod+u"] }]);
    expect(resolveKeymap(overrides).filter((b) => b.action === "session.new")).toEqual([
      { action: "session.new", key: "u", mod: true, shift: false },
    ]);
  });

  it("F5: a chord claimed by two actions is kept by the FIRST in ACTION_CATALOG order", () => {
    const overrides: KeybindingOverride[] = [
      { action: "session.new", bindings: ["mod+y"] },
      { action: "terminal.toggle", bindings: ["mod+y"] },
    ];
    const table = resolveKeymap(overrides);
    // Exactly ONE row carries ⌘Y, owned by the earlier catalog action.
    const owners = table.filter((b) => b.mod && !b.shift && b.key === "y").map((b) => b.action);
    expect(owners).toEqual(["session.new"]);
    // Dispatch fires session.new for ⌘Y — no ambiguous duplicate row.
    expect(matchKeymap(stroke({ key: "y", metaKey: true }), "darwin", table)).toEqual({ action: "session.new" });
    // The losing action drops that chord from its canonical form.
    expect(normalizeOverrides(overrides)).toEqual([
      { action: "session.new", bindings: ["mod+y"] },
      { action: "terminal.toggle", bindings: [] },
    ]);
  });

  it("F5: duplicate chords WITHIN one entry collapse to the first occurrence", () => {
    expect(normalizeOverrides([{ action: "session.new", bindings: ["mod+y", "mod+y"] }])).toEqual([
      { action: "session.new", bindings: ["mod+y"] },
    ]);
  });

  it("normalizeOverrides on undefined/empty is a cheap no-op", () => {
    expect(normalizeOverrides()).toEqual([]);
    expect(normalizeOverrides([])).toEqual([]);
  });
});

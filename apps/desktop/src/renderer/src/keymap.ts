/**
 * Renderer keyboard map (ui-roadmap §4-R5). Single source of truth for the
 * shell's shortcut table: which chord runs which action, and how each chord is
 * rendered for the command palette's per-row hint (the palette IS the shortcut
 * sheet — no separate reference ships).
 *
 * Pure module law (frozen pure-export/test law): no React, no DOM types beyond
 * the structural `KeyStroke` subset, no side effects. The only import is a type
 * import of `DesktopPlatform`; matching + formatting are total functions over
 * plain data, unit-tested directly in a node env (keymap.test.ts).
 *
 * `mod` is the platform-primary modifier: `metaKey` (⌘) on darwin, `ctrlKey`
 * on win32/linux. The matcher enforces exact chords — the OTHER primary
 * modifier or `altKey` being down rejects the stroke.
 */
import type { DesktopPlatform } from "../../shared/window.js";
import type { KeybindingOverride } from "../../shared/settings.js";

/** Structural subset of KeyboardEvent — tests (node env, no jsdom) pass plain objects; real events match structurally. */
export interface KeyStroke {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ActionId =
  | "palette.toggle"
  | "palette.sessions"
  | "session.new"
  | "terminal.toggle"
  | "settings.open"
  | "sidebar.toggle"
  | "sidebar.search"
  | "tab.activate"
  | "mode.focus"
  | "turn.interrupt";

export interface KeyBinding {
  action: ActionId;
  /** Lowercase KeyboardEvent.key ("k", ",", "escape"). Digits are NOT in the table (matcher special-case on code, ruling J). */
  key: string;
  /** Requires the platform-primary modifier. */
  mod: boolean;
  shift: boolean;
  /** Listed for palette hints, never returned by matchKeymap — another owner handles the keystroke (Esc → R3). */
  docOnly?: boolean;
}

/** Declaration order = documentation order. ⌘P and ⌘G are two rows, one action. */
export const KEYMAP: readonly KeyBinding[] = [
  { action: "palette.toggle", key: "k", mod: true, shift: false },
  { action: "palette.sessions", key: "p", mod: true, shift: false },
  { action: "palette.sessions", key: "g", mod: true, shift: false },
  { action: "session.new", key: "n", mod: true, shift: false },
  { action: "terminal.toggle", key: "j", mod: true, shift: false },
  { action: "settings.open", key: ",", mod: true, shift: false },
  { action: "sidebar.toggle", key: "b", mod: true, shift: false },
  { action: "sidebar.search", key: "f", mod: true, shift: false },
  { action: "mode.focus", key: "m", mod: true, shift: true },
  { action: "turn.interrupt", key: "escape", mod: false, shift: false, docOnly: true },
];

/** Display + policy metadata for one action, page order = declaration order (§1.4). */
export interface ActionMeta {
  action: ActionId;
  /** Short human label for the shortcuts page row. */
  name: string;
  /** One-line description of what the action does. */
  description: string;
  /**
   * True when the chord is user-rebindable. `tab.activate` (⌘1–⌘9, matched on
   * `event.code`) and `turn.interrupt` (Esc, owned elsewhere → docOnly) are
   * structural special-cases the page shows read-only.
   */
  editable: boolean;
}

/**
 * Full action catalog in page order (mirrors the ActionId union order, which is
 * also KEYMAP declaration order). The shortcuts page renders one row per entry;
 * `resolveKeymap`/`chordOwner` consult `editable` to decide what an override may
 * touch. Kept in lockstep with the ActionId union and KEYMAP by unit tests.
 */
export const ACTION_CATALOG: readonly ActionMeta[] = [
  { action: "palette.toggle", name: "Command palette", description: "Open the command palette.", editable: true },
  { action: "palette.sessions", name: "Switch task", description: "Open the task switcher.", editable: true },
  { action: "session.new", name: "New Task", description: "Start a new task.", editable: true },
  { action: "terminal.toggle", name: "Toggle terminal", description: "Show or hide the integrated terminal.", editable: true },
  { action: "settings.open", name: "Open settings", description: "Open the settings page.", editable: true },
  { action: "sidebar.toggle", name: "Toggle sidebar", description: "Show or hide the sidebar.", editable: true },
  { action: "sidebar.search", name: "Search sidebar", description: "Focus the sidebar search field.", editable: true },
  { action: "tab.activate", name: "Activate tab by number", description: "Jump to the nth open tab (⌘1–⌘9).", editable: false },
  { action: "mode.focus", name: "Focus mode selector", description: "Focus the composer mode selector.", editable: true },
  { action: "turn.interrupt", name: "Interrupt turn", description: "Stop the current agent turn (Esc).", editable: false },
];

export interface KeymapMatch {
  action: ActionId;
  /** 0-based tab index; present iff action === "tab.activate". */
  tabIndex?: number;
}

/**
 * Resolves a keystroke to an action, or null when no binding matches. The
 * platform-primary modifier must be down, the other primary modifier and
 * `altKey` must be up (exact-chord law). Digits (⌘1..⌘9) are matched on the
 * layout-independent `event.code` (`Digit1`–`Digit9`, ruling J), everything
 * else on the lowercased `key`. docOnly rows (Esc → R3) are never returned.
 */
export function matchKeymap(
  stroke: KeyStroke,
  platform: DesktopPlatform,
  table: readonly KeyBinding[] = KEYMAP,
): KeymapMatch | null {
  const primary = platform === "darwin" ? stroke.metaKey : stroke.ctrlKey;
  const secondary = platform === "darwin" ? stroke.ctrlKey : stroke.metaKey;
  if (!primary || secondary || stroke.altKey) {
    return null;
  }
  if (/^Digit[1-9]$/.test(stroke.code) && !stroke.shiftKey) {
    return { action: "tab.activate", tabIndex: Number(stroke.code.slice(5)) - 1 };
  }
  const k = stroke.key.toLowerCase();
  const hit = table.find((b) => !b.docOnly && b.mod && b.key === k && b.shift === stroke.shiftKey);
  return hit ? { action: hit.action } : null;
}

/** First declared binding for an action — palette hint lookup. */
export function bindingFor(action: ActionId, table: readonly KeyBinding[] = KEYMAP): KeyBinding | undefined {
  return table.find((b) => b.action === action);
}

/** "⌘K" / "⇧⌘M" / "esc" on darwin; "Ctrl+K" / "Ctrl+Shift+M" / "Esc" elsewhere. */
export function formatBinding(binding: KeyBinding, platform: DesktopPlatform): string {
  if (platform === "darwin") {
    const glyph = binding.key === "escape" ? "esc" : binding.key.toUpperCase();
    return `${binding.shift ? "⇧" : ""}${binding.mod ? "⌘" : ""}${glyph}`;
  }
  const glyph = binding.key === "escape" ? "Esc" : binding.key.toUpperCase();
  const parts: string[] = [];
  if (binding.mod) {
    parts.push("Ctrl");
  }
  if (binding.shift) {
    parts.push("Shift");
  }
  parts.push(glyph);
  return parts.join("+");
}

/** "⌘3" / "Ctrl+3" — hint for the nth open tab (n is 1-based, callers pass ≤ 9). */
export function formatTabHint(n: number, platform: DesktopPlatform): string {
  return platform === "darwin" ? `⌘${n}` : `Ctrl+${n}`;
}

// ── override overlay (F20, slice-P7.24-cut.md §1.4/§2/§3) ──────────────────────
//
// A persisted override stores chords in a canonical, platform-NEUTRAL grammar so
// the same settings.json means the same thing on every OS: the primary modifier
// is spelled `mod` (⌘ on darwin, Ctrl elsewhere), never a literal glyph.
//
//   grammar:  "mod" ["+" "shift"] "+" <key>
//     - `mod` is REQUIRED (bare keys and alt-chords are not persistable)
//     - `shift` is the only optional secondary modifier
//     - exactly ONE lowercase terminal key (a single logical KeyboardEvent.key)
//
// Parsing is total and fail-soft: any non-canonical/garbage string yields null,
// never a throw.

/** A parsed chord — always `mod: true` under the canonical grammar. */
export interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
}

const CHORD_MODIFIER_WORDS = new Set(["mod", "shift", "alt", "ctrl", "meta", "cmd", "command", "control", "option"]);

/**
 * Parse a canonical chord string into its parts, or null on any deviation from
 * the grammar (missing `mod`, an `alt`, a bare key, an uppercase key, a
 * multi-stroke sequence, empty/garbage input). Round-trips with serializeChord.
 */
export function parseChord(s: string): Chord | null {
  if (typeof s !== "string") return null;
  const parts = s.split("+");
  if (parts[0] !== "mod") return null;
  let idx = 1;
  let shift = false;
  if (parts[idx] === "shift") {
    shift = true;
    idx += 1;
  }
  // Exactly one token must remain after mod[+shift] — it is the terminal key.
  if (idx !== parts.length - 1) return null;
  const key = parts[idx];
  if (!key) return null;
  // Terminal key must be a single lowercase key, never a modifier word.
  if (key !== key.toLowerCase()) return null;
  if (CHORD_MODIFIER_WORDS.has(key)) return null;
  return { key, mod: true, shift };
}

/** Serialize a chord back to its canonical string. serializeChord(parseChord(s)) === s for valid s. */
export function serializeChord(c: Chord): string {
  return `mod${c.shift ? "+shift" : ""}+${c.key}`;
}

/** Reserved darwin role-menu keys (⌘Q/W/C/V/X/A/Z) — never rebindable to an app action. */
const RESERVED_ROLE_KEYS = ["q", "w", "c", "v", "x", "a", "z"] as const;

/** Canonical chord strings reserved by the darwin role menu (⌘Q/W/… → RESERVED_ROLE_KEYS). */
export const RESERVED_CHORDS: readonly string[] = RESERVED_ROLE_KEYS.map((k) => `mod+${k}`);

/** ActionIds a user may rebind — everything in the catalog flagged `editable`. */
const EDITABLE_ACTIONS: ReadonlySet<ActionId> = new Set(
  ACTION_CATALOG.filter((m) => m.editable).map((m) => m.action),
);

/** The built-in (KEYMAP) chords for an action, in declaration order (docOnly excluded). */
function defaultChordsFor(action: ActionId): Chord[] {
  return KEYMAP.filter((b) => b.action === action && !b.docOnly).map((b) => ({
    key: b.key,
    mod: b.mod,
    shift: b.shift,
  }));
}

/** One action's collapsed override intent: its valid chords + whether the raw entry was a literal `[]` (intentional Unassigned). */
interface CollapsedEntry {
  chords: Chord[];
  /** True iff the raw `bindings` array was literally empty (intentional Unassigned, keep as empty). */
  unassign: boolean;
}

/**
 * Collapse a raw (possibly hand-edited / corrupt) override list to one canonical
 * intent per action. TOTAL and fail-soft — NEVER throws on adversarial input:
 *  - an entry that is not an object, whose `action` is not a known EDITABLE
 *    ActionId, or whose `bindings` is not an array, is dropped (F1);
 *  - a chord that is not a string, or does not parse, is dropped (F1);
 *  - duplicate chords within one entry collapse to the first occurrence (F5);
 *  - duplicate entries for the SAME action collapse LAST-MEANINGFUL-ENTRY-WINS —
 *    a later meaningful entry replaces an earlier one, a trailing all-garbage
 *    entry never clobbers a good one (F3);
 *  - a NON-empty entry that yields ZERO valid chords is corruption → dropped so
 *    the action falls back to its default; only a literal `bindings: []` is an
 *    intentional Unassigned, kept as empty (F2).
 */
function collapseOverrides(overrides?: readonly KeybindingOverride[]): Map<ActionId, CollapsedEntry> {
  const byAction = new Map<ActionId, CollapsedEntry>();
  if (!Array.isArray(overrides)) return byAction;
  for (const ov of overrides) {
    if (!ov || typeof ov !== "object") continue;
    const action = (ov as { action?: unknown }).action as ActionId;
    if (typeof action !== "string" || !EDITABLE_ACTIONS.has(action)) continue;
    const bindings = (ov as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) continue; // e.g. bindings: null — never iterated
    const chords: Chord[] = [];
    const seen = new Set<string>();
    for (const raw of bindings) {
      if (typeof raw !== "string") continue;
      const c = parseChord(raw);
      if (!c) continue;
      const s = serializeChord(c);
      if (seen.has(s)) continue; // dedup within the entry
      seen.add(s);
      chords.push(c);
    }
    const isEmptyRaw = bindings.length === 0;
    // A non-empty entry that produced no valid chords is corruption: fall back to
    // the default (F2). Only a literal [] intentionally unassigns.
    if (!isEmptyRaw && chords.length === 0) continue;
    byAction.set(action, { chords, unassign: isEmptyRaw }); // last meaningful entry wins
  }
  return byAction;
}

/**
 * The single canonicalization authority (F3/F4/F5): compute each editable
 * action's EFFECTIVE chords after resolving cross-action chord collisions, plus
 * the set of actions that carry an override. Actions are visited in
 * ACTION_CATALOG order and each chord is claimed by the FIRST action to want it
 * (an override or a default); every later claimant drops that chord, so the
 * compiled table can never carry an ambiguous duplicate-chord row and the pane's
 * displayed binding for an action always equals what dispatch fires.
 */
function computeEffective(overrides?: readonly KeybindingOverride[]): {
  effective: Map<ActionId, Chord[]>;
  overridden: Set<ActionId>;
} {
  const collapsed = collapseOverrides(overrides);
  const effective = new Map<ActionId, Chord[]>();
  const overridden = new Set<ActionId>(collapsed.keys());
  const claimed = new Set<string>();
  for (const meta of ACTION_CATALOG) {
    if (!EDITABLE_ACTIONS.has(meta.action)) continue;
    const ov = collapsed.get(meta.action);
    const candidate = ov ? ov.chords : defaultChordsFor(meta.action);
    const kept: Chord[] = [];
    for (const c of candidate) {
      const s = serializeChord(c);
      if (claimed.has(s)) continue; // an earlier action already owns this chord
      claimed.add(s);
      kept.push(c);
    }
    effective.set(meta.action, kept);
  }
  return { effective, overridden };
}

/**
 * Canonical, persistable override array (F3/F4/F5) — the SINGLE source the
 * Settings pane displays, edits, and persists from, so a corrupt/hand-edited
 * settings.json self-heals on the first edit and slot indices always map. Returns
 * one entry per overridden action in ACTION_CATALOG order, chords deduped and
 * collision-resolved; an intentionally-Unassigned action keeps `bindings: []`.
 * Undefined / empty input is a cheap no-op returning `[]`.
 */
export function normalizeOverrides(overrides?: readonly KeybindingOverride[]): KeybindingOverride[] {
  if (!overrides || overrides.length === 0) return [];
  const { effective, overridden } = computeEffective(overrides);
  const out: KeybindingOverride[] = [];
  for (const meta of ACTION_CATALOG) {
    if (!overridden.has(meta.action)) continue;
    out.push({ action: meta.action, bindings: (effective.get(meta.action) ?? []).map(serializeChord) });
  }
  return out;
}

/**
 * Resolve the effective keymap from the built-in KEYMAP plus persisted overrides
 * (§2), compiled from the SAME canonical view (`computeEffective`) the pane
 * displays from. For each editable action its default rows are dropped and its
 * effective chords are emitted in place at the action's first declared position;
 * an Unassigned or collision-emptied action emits no rows. docOnly rows (Esc) and
 * the non-editable actions are never touched.
 *
 * TOTAL and fail-soft on every axis (F1): a corrupt blob (unknown action,
 * non-array/`null` bindings, non-string or unparsable chord) can only ever
 * degrade to defaults, never throw. No overrides — or none that apply — returns
 * the KEYMAP reference itself (identity fast-path).
 */
export function resolveKeymap(overrides?: readonly KeybindingOverride[]): readonly KeyBinding[] {
  if (!overrides || overrides.length === 0) return KEYMAP;
  const { effective, overridden } = computeEffective(overrides);
  if (overridden.size === 0) return KEYMAP; // nothing applied → identity

  const out: KeyBinding[] = [];
  const emitted = new Set<ActionId>();
  for (const row of KEYMAP) {
    if (row.docOnly || !EDITABLE_ACTIONS.has(row.action)) {
      out.push(row); // docOnly / non-editable rows pass through untouched
      continue;
    }
    if (emitted.has(row.action)) continue; // action already emitted at its first position
    emitted.add(row.action);
    for (const c of effective.get(row.action) ?? []) {
      out.push({ action: row.action, key: c.key, mod: c.mod, shift: c.shift });
    }
  }
  return out;
}

/**
 * Who owns a chord in the effective table (§3): the ActionId already bound to it,
 * `"reserved"` for a system-reserved chord (⌘1–⌘9 tab activation, any Escape, or a
 * darwin role-menu chord), or null when the chord is free. Callers comparing a
 * proposed rebind ignore a self-match (owner === the action being edited).
 */
export function chordOwner(chord: Chord, overrides?: readonly KeybindingOverride[]): ActionId | "reserved" | null {
  if (chord.key === "escape") return "reserved";
  if (chord.mod && !chord.shift) {
    if (/^[1-9]$/.test(chord.key)) return "reserved";
    if ((RESERVED_ROLE_KEYS as readonly string[]).includes(chord.key)) return "reserved";
  }
  const table = resolveKeymap(overrides);
  const hit = table.find(
    (b) => !b.docOnly && b.mod === chord.mod && b.shift === chord.shift && b.key === chord.key,
  );
  return hit ? hit.action : null;
}

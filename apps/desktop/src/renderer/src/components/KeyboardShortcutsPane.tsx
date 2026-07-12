/**
 * Keyboard shortcuts Settings pane (F20, slice-P7.24-cut.md §1.4/§4, wave 3).
 * Lists every catalog action (`ACTION_CATALOG`, ../keymap.ts) as a row with
 * its current binding badge(s), and lets the user re-record, remove, or reset
 * a chord — persisted wholesale via `store.getState().setPatch({keybindings:
 * {overrides}})`, the same "arrays replace wholesale" contract every other
 * Settings mutation in this package already follows (PermissionsEditor.tsx
 * is the structural template: store injected as a prop defaulting to the
 * real store, every decision pushed into pure/exported/unit-tested helpers,
 * DOM code kept thin).
 *
 * Two catalog rows are structurally non-editable and render read-only
 * ("Built-in" pill, no pencil/trash): `tab.activate` (⌘1–⌘9, matched on
 * `event.code` — no single canonical chord exists for it) and
 * `turn.interrupt` (Esc, owned elsewhere per keymap.ts's own docOnly note).
 *
 * RECORD MODE (§4): a capture-phase `keydown` listener (so App.tsx's bubble-
 * phase shortcut dispatcher never sees the keystroke mid-record) classifies
 * every stroke via `classifyRecordedStroke` — a bare modifier keydown is
 * ignored (stays recording), a chord with no primary modifier or with Alt
 * down shows "Use ⌘/Ctrl + key" (stays recording), a chord already owned by
 * a DIFFERENT action or reserved by the OS shows an inline refusal (stays
 * recording so the user can try again), and a valid chord commits
 * immediately through `applyRecord` + `setPatch`. Escape or a window blur
 * cancels with no write. Exactly one recorder is active at a time (`recording`
 * state); the listener is attached/removed by the recording-keyed effect, so
 * there is never a leaked handler.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { DesktopPlatform } from "../../../shared/window.js";
import type { KeybindingOverride } from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import {
  ACTION_CATALOG,
  KEYMAP,
  bindingFor,
  chordOwner,
  formatBinding,
  normalizeOverrides,
  resolveKeymap,
  serializeChord,
  type ActionId,
  type Chord,
  type KeyStroke,
} from "../keymap.js";
import { Pencil, Search, Trash, X } from "./icons.js";

// ── binding-string helpers (canonical "mod[+shift]+<key>" grammar, keymap.ts §grammar) ──

/** The action's built-in chords, in KEYMAP declaration order, as canonical serialized strings. */
function defaultBindingsFor(action: ActionId): string[] {
  return KEYMAP.filter((b) => b.action === action && !b.docOnly).map((b) =>
    serializeChord({ key: b.key, mod: b.mod, shift: b.shift }),
  );
}

/** The action's EFFECTIVE canonical bindings: the override's full set if one exists, else the built-in defaults. */
function currentBindingsFor(overrides: readonly KeybindingOverride[] | undefined, action: ActionId): string[] {
  const found = overrides?.find((o) => o.action === action);
  return found ? found.bindings : defaultBindingsFor(action);
}

function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Replaces `action`'s override entry with `bindings`, self-cleaning: when the
 * new set is IDENTICAL to the built-in defaults (same chords, same order) the
 * override entry is dropped entirely rather than persisting a no-op — an
 * action re-recorded back to its default settles into a clean "not
 * overridden" state instead of an inert override that happens to match.
 */
function commitBindings(
  overrides: readonly KeybindingOverride[] | undefined,
  action: ActionId,
  bindings: string[],
): KeybindingOverride[] {
  const rest = (overrides ?? []).filter((o) => o.action !== action);
  if (sameBindings(bindings, defaultBindingsFor(action))) {
    return rest;
  }
  return [...rest, { action, bindings }];
}

// ── row model (exported/tested) ──

export interface ShortcutRow {
  action: ActionId;
  name: string;
  description: string;
  editable: boolean;
  /** Display-ready badge text, in badge order (already run through formatBinding — never a raw chord string). */
  bindings: string[];
  /** True iff a persisted override entry exists for this action (drives the "Reset" affordance). */
  overridden: boolean;
  /** True iff an editable action currently has zero bindings. Always false for non-editable rows. */
  unassigned: boolean;
}

/**
 * Builds one row per `ACTION_CATALOG` entry, in catalog (= page) order. Editable
 * rows derive their badges from the EFFECTIVE dispatch table (`resolveKeymap`),
 * so a displayed binding is exactly what dispatch fires (F3/F5): duplicate
 * entries, duplicate chords, and cross-action collisions are already resolved by
 * the shared canonicalization authority. `overridden` reflects the normalized
 * override set, so a corrupt entry that collapses away no longer shows Reset.
 */
export function shortcutRows(overrides: readonly KeybindingOverride[] | undefined, platform: DesktopPlatform): ShortcutRow[] {
  const overriddenSet = new Set(normalizeOverrides(overrides).map((o) => o.action));
  const table = resolveKeymap(overrides);
  return ACTION_CATALOG.map((meta): ShortcutRow => {
    if (meta.action === "tab.activate") {
      return {
        action: meta.action,
        name: meta.name,
        description: meta.description,
        editable: false,
        bindings: [platform === "darwin" ? "⌘1–⌘9" : "Ctrl+1–Ctrl+9"],
        overridden: false,
        unassigned: false,
      };
    }
    if (!meta.editable) {
      const builtin = bindingFor(meta.action, KEYMAP);
      return {
        action: meta.action,
        name: meta.name,
        description: meta.description,
        editable: false,
        bindings: builtin ? [formatBinding(builtin, platform)] : [],
        overridden: false,
        unassigned: false,
      };
    }
    const bindings = table.filter((b) => b.action === meta.action && !b.docOnly).map((b) => formatBinding(b, platform));
    return {
      action: meta.action,
      name: meta.name,
      description: meta.description,
      editable: true,
      bindings,
      overridden: overriddenSet.has(meta.action),
      unassigned: bindings.length === 0,
    };
  });
}

/** Case-insensitive substring over name + description + each row's formatted badge text. Blank query returns every row, unfiltered order. */
export function filterShortcutRows(rows: readonly ShortcutRow[], query: string): ShortcutRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter((row) => {
    if (row.name.toLowerCase().includes(needle)) {
      return true;
    }
    if (row.description.toLowerCase().includes(needle)) {
      return true;
    }
    return row.bindings.some((b) => b.toLowerCase().includes(needle));
  });
}

/** Records `chord` at `slotIndex` (appended past the current end) and persists via `commitBindings`'s self-cleaning rule. */
export function applyRecord(
  overrides: readonly KeybindingOverride[] | undefined,
  action: ActionId,
  slotIndex: number,
  chord: Chord,
): KeybindingOverride[] {
  const next = [...currentBindingsFor(overrides, action)];
  const serialized = serializeChord(chord);
  if (slotIndex >= next.length) {
    next.push(serialized);
  } else {
    next[slotIndex] = serialized;
  }
  return commitBindings(overrides, action, next);
}

/** Removes the binding at `slotIndex`. An empty result commits as an explicit `bindings: []` override — Unassigned. */
export function removeBinding(
  overrides: readonly KeybindingOverride[] | undefined,
  action: ActionId,
  slotIndex: number,
): KeybindingOverride[] {
  const next = currentBindingsFor(overrides, action).filter((_, i) => i !== slotIndex);
  return commitBindings(overrides, action, next);
}

/** Row-trash: clears every binding for `action` (Unassigned). */
export function clearAllBindings(overrides: readonly KeybindingOverride[] | undefined, action: ActionId): KeybindingOverride[] {
  return commitBindings(overrides, action, []);
}

/** Drops `action`'s override entry entirely — reverts to built-in defaults. */
export function resetAction(overrides: readonly KeybindingOverride[] | undefined, action: ActionId): KeybindingOverride[] {
  return (overrides ?? []).filter((o) => o.action !== action);
}

// ── record-mode stroke classification (pure — DOM code below just calls this) ──

const MODIFIER_ONLY_KEYS = new Set(["shift", "meta", "control", "alt", "os"]);

/** True for a keydown of a bare modifier key (Shift/Meta/Control/Alt alone) — the record listener stays open and does nothing. */
export function isModifierOnlyStroke(stroke: KeyStroke): boolean {
  return MODIFIER_ONLY_KEYS.has(stroke.key.toLowerCase());
}

export type RecordOutcome =
  | { kind: "ignored" }
  | { kind: "needs-mod" }
  | { kind: "reserved" }
  | { kind: "conflict"; ownerAction: ActionId }
  | { kind: "accept"; chord: Chord };

/**
 * Classifies one recorded keystroke against the primary-modifier requirement,
 * OS/keymap reservations, and cross-action conflicts (§4). Re-recording an
 * action's own current chord onto itself is a self-match — `chordOwner`
 * returns the action being edited, which falls through to `accept`.
 */
export function classifyRecordedStroke(
  stroke: KeyStroke,
  platform: DesktopPlatform,
  action: ActionId,
  overrides: readonly KeybindingOverride[] | undefined,
): RecordOutcome {
  if (isModifierOnlyStroke(stroke)) {
    return { kind: "ignored" };
  }
  const primary = platform === "darwin" ? stroke.metaKey : stroke.ctrlKey;
  const secondary = platform === "darwin" ? stroke.ctrlKey : stroke.metaKey;
  const key = stroke.key.toLowerCase();
  // Exact-chord law (F6): only the primary modifier plus optional Shift may be
  // held. The OTHER primary modifier (darwin Ctrl+Cmd / non-darwin Meta+Ctrl) or
  // Alt would record a chord `matchKeymap` can never match — reject so the
  // recorded chord always round-trips to exactly what dispatch compares.
  if (!primary || secondary || stroke.altKey || !key) {
    return { kind: "needs-mod" };
  }
  // Mirrors matchKeymap's ⌘1–⌘9 tab-activate special-case, which matches the
  // layout-independent physical `code` (not `key`). On a non-QWERTY layout
  // (e.g. AZERTY) mod+physical-Digit1 produces key "&", so a key-based
  // reservation check alone would miss it and record a chord that
  // `matchKeymap` can never reach — dispatch always routes that physical
  // stroke to tab.activate first.
  if (/^Digit[1-9]$/.test(stroke.code) && !stroke.shiftKey) {
    return { kind: "reserved" };
  }
  const chord: Chord = { key, mod: true, shift: stroke.shiftKey };
  const owner = chordOwner(chord, overrides);
  if (owner === "reserved") {
    return { kind: "reserved" };
  }
  if (owner !== null && owner !== action) {
    return { kind: "conflict", ownerAction: owner };
  }
  return { kind: "accept", chord };
}

/** Inline error text for a refused `RecordOutcome`; null for `ignored`/`accept` (nothing to show). */
export function recordErrorMessage(outcome: RecordOutcome): string | null {
  switch (outcome.kind) {
    case "needs-mod":
      return "Use ⌘/Ctrl + key";
    case "reserved":
      return "Reserved shortcut";
    case "conflict": {
      const owner = ACTION_CATALOG.find((m) => m.action === outcome.ownerAction);
      return `Already used by "${owner?.name ?? outcome.ownerAction}"`;
    }
    case "ignored":
    case "accept":
      return null;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// ── component ──

export interface KeyboardShortcutsPaneProps {
  store?: SettingsStoreApi;
}

interface RecordingSlot {
  action: ActionId;
  slotIndex: number;
}

export function KeyboardShortcutsPane({ store = useSettingsStore }: KeyboardShortcutsPaneProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingSlot | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  const platform: DesktopPlatform = window.anycode?.platform ?? "darwin";
  // Work off the NORMALIZED overrides (F4): display, edit, remove, and persist all
  // use the SAME canonical array, so a corrupt/hand-edited settings.json self-heals
  // on the first edit and rendered slot indices always map to the stored slot.
  // Memoised on the raw array so the record-listener effect below is not re-run per
  // render (a fresh array identity each render would churn the keydown handler).
  const rawOverrides = snapshot?.settings.keybindings?.overrides;
  const overrides = useMemo(() => normalizeOverrides(rawOverrides), [rawOverrides]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    function cancel(): void {
      setRecording(null);
      setRecordError(null);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        cancel();
        return;
      }
      const stroke: KeyStroke = {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      };
      const outcome = classifyRecordedStroke(stroke, platform, recording!.action, overrides);
      if (outcome.kind === "ignored") {
        return;
      }
      if (outcome.kind === "accept") {
        const next = applyRecord(overrides, recording!.action, recording!.slotIndex, outcome.chord);
        cancel();
        void store.getState().setPatch({ keybindings: { overrides: next } });
        return;
      }
      setRecordError(recordErrorMessage(outcome));
    }
    // Capture phase: runs BEFORE App.tsx's bubble-phase shortcut dispatcher, so no shell action fires mid-record.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides, platform, store]);

  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;
  const rows = filterShortcutRows(shortcutRows(overrides, platform), query);

  function startRecording(action: ActionId, slotIndex: number): void {
    setRecording({ action, slotIndex });
    setRecordError(null);
  }

  async function handleRemove(action: ActionId, slotIndex: number): Promise<void> {
    await store.getState().setPatch({ keybindings: { overrides: removeBinding(overrides, action, slotIndex) } });
  }

  async function handleClearAll(action: ActionId): Promise<void> {
    await store.getState().setPatch({ keybindings: { overrides: clearAllBindings(overrides, action) } });
  }

  async function handleReset(action: ActionId): Promise<void> {
    await store.getState().setPatch({ keybindings: { overrides: resetAction(overrides, action) } });
  }

  return (
    <section className="settings-section shortcuts-pane">
      <label className="settings-search shortcuts-pane-search">
        <Search className="settings-search-icon" />
        <input
          type="text"
          className="settings-search-input"
          placeholder="Search shortcuts…"
          aria-label="Search shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {rows.length === 0 && <div className="settings-mcp-empty">No matching shortcuts.</div>}

      <div className="shortcuts-list">
        {rows.map((row) => (
          <div key={row.action} className="shortcuts-row" data-shortcut-action={row.action}>
            <div className="shortcuts-row-main">
              <span className="shortcuts-row-name">{row.name}</span>
              <span className="shortcuts-row-description">{row.description}</span>
            </div>
            <div className="shortcuts-row-controls">
              {row.editable ? (
                <>
                  {row.unassigned && recording?.action !== row.action && (
                    <span className="shortcuts-unassigned">Unassigned</span>
                  )}
                  {row.bindings.map((binding, index) =>
                    recording?.action === row.action && recording.slotIndex === index ? (
                      <RecordingChip key={index} error={recordError} />
                    ) : (
                      <span className="shortcuts-badge" key={index}>
                        <span className="shortcuts-badge-chord">{binding}</span>
                        <button
                          type="button"
                          className="shortcuts-badge-edit"
                          aria-label={`Edit ${row.name} shortcut ${binding}`}
                          disabled={readOnly}
                          onClick={() => startRecording(row.action, index)}
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          className="shortcuts-badge-remove"
                          aria-label={`Remove ${row.name} shortcut ${binding}`}
                          disabled={readOnly}
                          onClick={() => void handleRemove(row.action, index)}
                        >
                          <X />
                        </button>
                      </span>
                    ),
                  )}
                  {recording?.action === row.action && recording.slotIndex === row.bindings.length && (
                    <RecordingChip error={recordError} />
                  )}
                  <button
                    type="button"
                    className="settings-button shortcuts-add-button"
                    disabled={readOnly}
                    onClick={() => startRecording(row.action, row.bindings.length)}
                  >
                    + Add
                  </button>
                  {row.overridden && (
                    <button
                      type="button"
                      className="settings-button shortcuts-reset-button"
                      disabled={readOnly}
                      onClick={() => void handleReset(row.action)}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    className="mcp-icon-button mcp-icon-button-danger shortcuts-row-trash"
                    aria-label={`Clear all shortcuts for ${row.name}`}
                    disabled={readOnly}
                    onClick={() => void handleClearAll(row.action)}
                  >
                    <Trash />
                  </button>
                </>
              ) : (
                <>
                  {row.bindings.map((binding, index) => (
                    <span className="shortcuts-badge shortcuts-badge-builtin" key={index}>
                      <span className="shortcuts-badge-chord">{binding}</span>
                    </span>
                  ))}
                  <span className="shortcuts-builtin-pill">Built-in</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecordingChip({ error }: { error: string | null }) {
  return (
    <span className="shortcuts-badge shortcuts-badge-recording" role="status" aria-live="polite">
      <span className="shortcuts-badge-chord">{error ?? "Press shortcut…"}</span>
    </span>
  );
}

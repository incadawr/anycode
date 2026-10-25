/**
 * ModeMenu (design ui-redesign-direction.md §1.1/§1.2/§2.4) — the signature
 * element: the escalation-graded permission-mode chip + its popover. The chip's
 * tint walks the ramp `plan → build → edit → auto → yolo` (inert → working →
 * writing → loose → unleashed) via dedicated `.mode-chip-<mode>` classes reading
 * the semantic tokens, so the current level of autonomy is readable at a glance.
 *
 * Extracted from Composer's old 5-radio `.composer-modes` row (UI-5). The parent
 * owns the wire traffic: `onChange` is Composer's `handleModeChange`, which keeps
 * the `set_mode` send + the `modeChangeDisabled(turn.status, ready) || next ===
 * mode` guard. `disabled` mirrors a not-`ready` connection (TASK.37: a running
 * turn no longer gates mode changes); a disabled chip can't open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PermissionMode } from "@anycode/core";
import type { TurnState } from "../store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Check, Chevron } from "./icons.js";
// Reuse, not re-derive (R1 anti-clip lesson, same fix ModelPill's own popover
// already applies — see ModelPill.tsx's import comment): the chip lives in
// `.composer-footer-left`, which carries `overflow:hidden` (P7.13 narrow-width
// containment). A plain `position:absolute; bottom:100%` popover (this file's
// old convention) is clipped by that ancestor regardless of z-index — the
// owner-reported "Build popover opens but is invisible" bug. `position:fixed`
// escapes it because its containing block is the viewport, not the footer.
import { clampMenuLeft } from "./Sidebar.js";

/**
 * Mirrors core's PERMISSION_MODES literal list. Deliberately duplicated (not
 * imported as a value) because renderer code may only ever `import type` from
 * @anycode/core (design §2/§6: no Node code may leak into the web bundle) —
 * importing the const array here would pull a real value import of @anycode/core
 * into renderer runtime code. Keep in sync if core ever adds/removes a
 * permission mode. (Moved here from Composer.tsx in UI-5.)
 */
const PERMISSION_MODE_OPTIONS: readonly PermissionMode[] = ["plan", "build", "edit", "auto", "yolo"];

/** Nominal popover width (px) used only for left-edge clamping before the popover measures itself — mirrors ModelPill's `MODEL_PILL_POPOVER_WIDTH` (matches `.mode-menu-popover`'s CSS `min-width: 15rem` at the standard 16px root). */
const MODE_MENU_POPOVER_WIDTH = 240;

/**
 * One-line description per mode, aligned to the permission engine's semantics
 * (packages/core/src/permissions/engine.ts): plan denies all writes; build
 * asks before every side-effecting tool; edit allows Write/Edit inside the
 * workspace without asking and asks for everything else side-effecting
 * (TASK.32); auto asks only on high-risk tools; yolo never asks.
 */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  plan: "Read-only planning",
  build: "Ask before edits",
  edit: "Edit files in this project without asking",
  auto: "Ask only for risky actions",
  yolo: "Never ask",
};

/**
 * Pure roving-focus step for the popover: advances `current` by `delta`
 * (+1 = ArrowDown, -1 = ArrowUp), wrapping within `[0, count)`. Returns 0 for a
 * non-positive count (empty menu is unreachable in practice, but keeps the
 * reducer total). Exported for unit testing.
 */
export function nextRovingIndex(current: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return (current + delta + count) % count;
}

/**
 * R7 focus seam (slice-R7-cut §3): the window event App's ⇧⌘M runner
 * broadcasts. ModeMenu subscribes below; exactly one instance is ever mounted
 * (background tabs are never mounted — App.tsx header), so the broadcast has
 * exactly one listener. Replaces R5 ruling D's `.mode-chip` DOM query.
 */
export const FOCUS_MODE_MENU_EVENT = "anycode:focus-mode-menu";

/**
 * Digit-selection index for the open popover (ui-roadmap §4-R7(e)): maps a
 * layout-independent KeyboardEvent.code "Digit1".."Digit9" to a 0-based option
 * index, null when the code is not a digit or the index is ≥ count (digits
 * past the option list are ignored, not clamped). Modifier guards are the
 * caller's job — this function is total over (code, count). Exported for unit
 * testing.
 */
export function modeIndexForDigit(code: string, count: number): number | null {
  const match = /^Digit([1-9])$/.exec(code);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < count ? index : null;
}

/**
 * Mode-change availability (TASK.37): gated on connection readiness ONLY. The
 * signature deliberately still takes the turn status and ignores it — the mode
 * is policy for the NEXT permission decision, so a running turn no longer
 * disables the chip, the keyboard summon, or the slash toggle (contrast
 * modelPickDisabled, which keeps its between-turns busy gate: model switching
 * remains turn-boundary-only per TASK.37's own scope). Host stays the source
 * of truth; not-ready has no host to send to. Exported for unit testing.
 */
export function modeChangeDisabled(_turnStatus: TurnState["status"], ready: boolean): boolean {
  return !ready;
}

/**
 * Taskana 4704 §3.7 (part B): the Orchestrate row's description, exported for
 * ModeMenu.test.ts's copy pin. Kept next to MODE_DESCRIPTIONS so the two
 * description tables stay physically together.
 */
export const ORCHESTRATE_ROW_DESCRIPTION = "Delegate work to child agents";

export interface ModeMenuProps {
  mode: PermissionMode;
  disabled: boolean;
  onChange(next: PermissionMode): void;
  /**
   * Taskana 4704 §3.7 (part B): tab-scoped orchestrate flag (the store's
   * `orchestrateActive`, kept from the host's `orchestrate_changed` acks).
   * Absent/undefined hides the Orchestrate row entirely (a legacy host that
   * never acks — the same honest-hide posture as the slash row below), the
   * same way `supportsCorePermissions` hides the whole chip.
   */
  orchestrateActive?: boolean;
  /**
   * The Orchestrate row's commit path — deliberately NOT `onChange`: that
   * callback takes a PermissionMode and drives `set_mode`; orchestrate is a
   * TAB-level flag with its own `set_orchestrate` wire message (§2.2: NOT a
   * 7th PermissionMode). Undefined hides the row too (a caller passing state
   * without a handler would render a dead row — "no dead actions").
   */
  onToggleOrchestrate?: (next: boolean) => void;
}

export function ModeMenu({ mode, disabled, onChange, orchestrateActive = false, onToggleOrchestrate }: ModeMenuProps) {
  const [open, setOpen] = useState(false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // composer dropdown is up.
  useOverlayFlag(open);
  const [focusIndex, setFocusIndex] = useState(0);
  // Fixed-position anchor for the popover (viewport `left`/`bottom` px),
  // computed from the chip's real screen position on open — null before the
  // first open (or once closed; a stale value is harmless since the popover
  // unmounts with `open`). Mirrors ModelPill.tsx's identical `anchor` state,
  // needed for the same reason: the popover escapes `.composer-footer-left`'s
  // `overflow:hidden` via `position:fixed`, whose containing block is the
  // viewport rather than `.mode-menu`.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      chipRef.current?.focus();
    }
  }, []);

  // Compute the fixed-position anchor once, at the moment the popover opens
  // (mirrors ModelPill's identical effect). `bottom` is measured from the
  // viewport's bottom edge up to the chip's top edge (the popover opens
  // ABOVE the chip, unchanged from the old `bottom: 100%` convention) plus
  // an 8px gap matching `--sp-2`'s base value. `left` is clamped so the
  // popover never overflows either viewport edge.
  useEffect(() => {
    if (!open) {
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setAnchor({
      left: clampMenuLeft(rect.left, MODE_MENU_POPOVER_WIDTH, window.innerWidth),
      bottom: window.innerHeight - rect.top + 8,
    });
  }, [open]);

  // Outside mousedown closes (same pattern as the old NewTabMenu listener); no
  // focus return — the click has already moved focus/intent elsewhere.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // On open, seed roving focus at the current mode. `Math.max(0, …)` keeps
  // the impossible `mode === null` fallback ("plan") at index 0.
  useEffect(() => {
    if (open) {
      setFocusIndex(Math.max(0, PERMISSION_MODE_OPTIONS.indexOf(mode)));
    }
  }, [open, mode]);

  // Taskana 4704 §3.7 (part B): the Orchestrate row renders after the five
  // modes iff BOTH the state and the handler were passed. Keyboard math below
  // reads this count, never `PERMISSION_MODE_OPTIONS.length` directly.
  const showOrchestrateRow = orchestrateActive !== undefined && onToggleOrchestrate !== undefined;
  const itemCount = PERMISSION_MODE_OPTIONS.length + (showOrchestrateRow ? 1 : 0);

  // If the chip becomes disabled while the popover is open (e.g. host_exited
  // drops connection off "ready" mid-menu), close it — it must not float over
  // the now-greyed chip.
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // R7 focus seam: summon semantics — focus the chip and open. Idempotent (a
  // second ⇧⌘M keeps the menu open; the old .focus()+.click() toggled it — a
  // deliberate, flagged behavior change: "focus mode menu" summons, it does not
  // dismiss). A disabled chip ignores the request, matching the old silent
  // no-op of .focus()/.click() on a disabled button. Re-subscribes on disabled
  // flips; cleanup prevents listener leaks on unmount.
  useEffect(() => {
    function onFocusRequest(): void {
      if (disabled) {
        return;
      }
      chipRef.current?.focus();
      setOpen(true);
    }
    window.addEventListener(FOCUS_MODE_MENU_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_MODE_MENU_EVENT, onFocusRequest);
  }, [disabled]);

  // Move DOM focus to the roving item whenever the index changes while open.
  useEffect(() => {
    if (open) {
      itemRefs.current[focusIndex]?.focus();
    }
  }, [open, focusIndex]);

  function select(next: PermissionMode): void {
    onChange(next);
    close(true);
  }

  /**
   * Taskana 4704 §3.7 (part B): the Orchestrate row's commit — toggles the
   * tab-level flag through the dedicated handler (set_orchestrate), never
   * through `onChange`/`set_mode` (§2.2: orchestrate is not a permission
   * mode; enabling it MOVES the session to plan host-side, §3.7).
   */
  function toggleOrchestrate(): void {
    onToggleOrchestrate?.(!orchestrateActive);
    close(true);
  }

  function onChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Open and drop focus into the menu; Enter/Space fall through to the
      // native button click, which toggles open below.
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, 1, itemCount));
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, -1, itemCount));
        break;
      case "Home":
        event.preventDefault();
        setFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setFocusIndex(itemCount - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        // Taskana 4704 §3.7 (part B): the last row (when the Orchestrate row
        // renders) toggles orchestrate instead of selecting a mode.
        if (showOrchestrateRow && focusIndex === PERMISSION_MODE_OPTIONS.length) {
          toggleOrchestrate();
          break;
        }
        select(PERMISSION_MODE_OPTIONS[focusIndex]!);
        break;
      }
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        // Let focus leave naturally; just drop the popover without stealing it back.
        setOpen(false);
        break;
      default: {
        // Digits select and commit (like Enter) — bare digits only. Modified
        // digits fall through so the global keymap's ⌘1..9 tab.activate is never
        // shadowed (the popover is not a <dialog>, so window combos still fire);
        // Shift is excluded to match keymap.ts's digit convention. Digits past
        // the option count are silently ignored, no preventDefault.
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
          break;
        }
        // Taskana 4704 §3.7 (part B): digit selection stays over the FIVE
        // permission modes only (`modeIndexForDigit(code, 5)`) — the
        // Orchestrate row is a separator-below toggle, not mode #6, so Digit6
        // never reaches it. This is the "does not enter
        // PERMISSION_MODE_OPTIONS" pin's keyboard half.
        const index = modeIndexForDigit(event.code, PERMISSION_MODE_OPTIONS.length);
        if (index !== null) {
          event.preventDefault();
          select(PERMISSION_MODE_OPTIONS[index]!);
        }
        break;
      }
    }
  }

  return (
    <div className="mode-menu" ref={rootRef}>
      <button
        ref={chipRef}
        type="button"
        className={`mode-chip mode-chip-${mode}${showOrchestrateRow && orchestrateActive ? " mode-chip-orchestrate" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={showOrchestrateRow ? orchestrateActive : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onChipKeyDown}
      >
        <span className="mode-chip-label">{mode}</span>
        <Chevron className="mode-chip-chevron" />
      </button>

      {open && (
        <div
          className="mode-menu-popover"
          role="menu"
          aria-label="Permission mode"
          onKeyDown={onMenuKeyDown}
          style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
        >
          {PERMISSION_MODE_OPTIONS.map((option, index) => {
            const current = option === mode;
            return (
              <button
                key={option}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                tabIndex={index === focusIndex ? 0 : -1}
                className={`mode-menu-item${current ? " mode-menu-item-current" : ""}`}
                onClick={() => select(option)}
              >
                <span className="mode-menu-item-check" aria-hidden="true">
                  {current ? <Check /> : null}
                </span>
                <span className="mode-menu-item-body">
                  <span className="mode-menu-item-name">{option}</span>
                  <span className="mode-menu-item-desc">{MODE_DESCRIPTIONS[option]}</span>
                </span>
              </button>
            );
          })}
          {/* Taskana 4704 §3.7 (part B): the Orchestrate toggle sits AFTER the
              five permission modes, behind a divider — it is a tab-level state,
              not a 6th mode (§2.2). `aria-checked` on a `menuitemcheckbox`
              mirrors the active row's Check glyph; the click goes through
              `onToggleOrchestrate` (set_orchestrate), never `onChange`. */}
          {showOrchestrateRow && (
            <>
              <div className="mode-menu-divider" role="separator" />
              <button
                ref={(el) => {
                  itemRefs.current[PERMISSION_MODE_OPTIONS.length] = el;
                }}
                type="button"
                role="menuitemcheckbox"
                aria-checked={orchestrateActive}
                tabIndex={focusIndex === PERMISSION_MODE_OPTIONS.length ? 0 : -1}
                className={`mode-menu-item${orchestrateActive ? " mode-menu-item-current" : ""}`}
                data-testid="mode-menu-orchestrate"
                onClick={toggleOrchestrate}
              >
                <span className="mode-menu-item-check" aria-hidden="true">
                  {orchestrateActive ? <Check /> : null}
                </span>
                <span className="mode-menu-item-body">
                  <span className="mode-menu-item-name">Orchestrate</span>
                  <span className="mode-menu-item-desc">{ORCHESTRATE_ROW_DESCRIPTION}</span>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

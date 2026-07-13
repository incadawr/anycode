/**
 * Native model + permission-preset controls for a non-core engine session
 * (Codex today — TASK.39, cut §3.1/§3.3/§5.3). Chip+popover mechanics mirror
 * ModeMenu.tsx/ModelPill.tsx byte-for-byte (roving focus via the shared
 * `nextRovingIndex`, outside-mousedown close, Esc close, fixed-position
 * anchor via the shared `clampMenuLeft` — the same `.composer-footer-left`
 * `overflow:hidden` escape those two already need). The CSS classes
 * (`.model-pill*`) are reused as-is rather than duplicated: nothing about
 * that visual language is core-specific.
 *
 * Deliberately NOT ModelPill: the catalog rendered here is always the
 * engine's OWN `EnginePresentation.model.available` / `.permissions.presets`
 * (live doctor / app-server data) — never AnyCode's provider catalog
 * (`settings-store`). Selecting a row only ever sends a bare `presetId` or a
 * model id drawn from that catalog — never a free-text value or a config
 * object (host validates membership again anyway, cut §2(d)/§2(j)).
 *
 * Pending vs. applied (cut §2(k).3): the app-server itself has no settings-
 * updated ack channel, so host/session.ts answers in two phases on
 * `engine_settings_changed` — `state:"pending"` the instant it validates the
 * choice, then a separate `state:"applied"` once a `turn/start` carrying it
 * was actually accepted by the server. `pendingModel`/`pendingPresetId`
 * (sourced from store.ts's
 * `pendingEngineChange`, computed by its reducer, never by this file) are
 * defined only while a change has been accepted but not yet folded into the
 * active `model`/`activePresetId` — the chip keeps showing the ACTIVE value
 * first and appends the queued target with an explicit "next turn" marker,
 * so a pending change can never be mistaken for an already-active one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { DesktopState, TurnState } from "../store.js";
import { Check, Chevron } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";
import { clampMenuLeft } from "./Sidebar.js";
// Reuse, not re-derive (ModelPill.tsx precedent: it imports this same
// function from Composer.tsx) — the identical F15 "truly idle" guard that
// decides whether a pick is safe to offer.
import { shouldEnqueue } from "./Composer.js";

const ENGINE_MENU_POPOVER_WIDTH = 240;

/**
 * Client-side mirror of the host's between-turns guard (same posture as
 * ModelPill's `modelPickDisabled`): a pick is offered only while the tab is
 * truly idle AND connected — the host's own busy-check is the real
 * backstop, this only keeps the UI from offering a pick it knows would be
 * silently dropped. Exported for unit testing.
 */
export function engineControlDisabled(
  turnStatus: TurnState["status"],
  queueInFlight: DesktopState["queueInFlight"],
  ready: boolean,
): boolean {
  return shouldEnqueue(turnStatus, queueInFlight) || !ready;
}

/** Display label for one catalog model: its own `label`, else the raw id. Exported for unit testing. */
export function engineModelDisplayName(modelId: string, available: readonly EngineModelChoice[]): string {
  return available.find((m) => m.id === modelId)?.label ?? modelId;
}

/**
 * The model popover's flat list: the engine's own catalog, plus the current
 * model appended if it is somehow not already in it (defensive — mirrors
 * ModelPill's `modelMenuItems`, same "never lose the active value" rule).
 * Exported for unit testing.
 */
export function engineModelItems(
  current: string,
  available: readonly EngineModelChoice[],
): { id: string; label: string }[] {
  const items = available.map((m) => ({ id: m.id, label: m.label ?? m.id }));
  if (!items.some((m) => m.id === current)) {
    items.push({ id: current, label: current });
  }
  return items;
}

/**
 * Chip label: the ACTIVE value's display name, with the pending target (if
 * any) appended as an explicit "-> X (next turn)" suffix — the active value
 * always reads first, so a queued-but-not-yet-applied change can never look
 * like it is already in effect (cut §2(k).3, TASK.39 DoD "pending must not
 * look active"). Exported for unit testing.
 */
export function engineChipLabel(activeLabel: string, pendingLabel: string | undefined): string {
  return pendingLabel === undefined ? activeLabel : `${activeLabel} → ${pendingLabel} (next turn)`;
}

/**
 * The active preset in the engine's own catalog, by id. `undefined` only for
 * a malformed/stale presentation (a persisted-but-removed preset id) — the
 * chip falls back to the raw id in that case. Exported for unit testing.
 */
export function activeEnginePreset(
  presets: readonly EnginePermissionPreset[],
  activePresetId: string,
): EnginePermissionPreset | undefined {
  return presets.find((p) => p.id === activePresetId);
}

/**
 * Tooltip text for the preset chip: the ACTIVE preset's own host-provided
 * plain-language boundary description (never a hardcoded/renderer-invented
 * one — TASK.39 item 2's "engine-specific tooltip"), with a queued-change
 * sentence appended while a different preset is pending. Exported for unit
 * testing.
 */
export function enginePresetTooltip(
  activeLabel: string,
  activeDescription: string | undefined,
  pendingLabel: string | undefined,
): string {
  const base = activeDescription ?? activeLabel;
  return pendingLabel === undefined
    ? base
    : `${base} Switching to "${pendingLabel}" — applies from the next turn.`;
}

interface EngineMenuChipProps {
  label: string;
  tooltip: string;
  ariaLabel: string;
  disabled: boolean;
  open: boolean;
  chipRef: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}

function EngineMenuChip({ label, tooltip, ariaLabel, disabled, open, chipRef, onToggle, onKeyDown }: EngineMenuChipProps) {
  return (
    <button
      ref={chipRef}
      type="button"
      className="model-pill-chip"
      aria-haspopup="menu"
      aria-label={ariaLabel}
      aria-expanded={open}
      disabled={disabled}
      title={tooltip}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <span className="model-pill-label">{label}</span>
      <Chevron className="model-pill-chevron" />
    </button>
  );
}

/**
 * Shared open/anchor/roving-focus/outside-click state machine behind both
 * popovers below — extracted once rather than duplicated a second time
 * (ModeMenu.tsx and ModelPill.tsx each hand-roll this because they predate
 * each other; this file does not repeat that a third time).
 */
function useEngineMenuState(itemCount: number, currentIndex: number, disabled: boolean) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
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

  useEffect(() => {
    if (!open) {
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setAnchor({
      left: clampMenuLeft(rect.left, ENGINE_MENU_POPOVER_WIDTH, window.innerWidth),
      bottom: window.innerHeight - rect.top + 8,
    });
  }, [open]);

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

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (open) {
      setFocusIndex(Math.max(0, currentIndex));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on
    // an open transition (ModeMenu/ModelPill precedent) — recomputing on
    // every store tick would fight the user's roving-arrow input.
  }, [open]);

  useEffect(() => {
    if (open) {
      itemRefs.current[focusIndex]?.focus();
    }
  }, [open, focusIndex]);

  function onChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>, onPick: (index: number) => void): void {
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
      case " ":
        event.preventDefault();
        onPick(focusIndex);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return { open, setOpen, focusIndex, anchor, rootRef, chipRef, itemRefs, close, onChipKeyDown, onMenuKeyDown };
}

export interface EngineModelMenuProps {
  model: { current: string; available: readonly EngineModelChoice[] };
  pendingModel: string | undefined;
  disabled: boolean;
  onPick(modelId: string): void;
}

/** Active-session model chip for a non-core engine (Composer.tsx). */
export function EngineModelMenu({ model, pendingModel, disabled, onPick }: EngineModelMenuProps) {
  const items = engineModelItems(model.current, model.available);
  const activeLabel = engineModelDisplayName(model.current, model.available);
  const pendingLabel = pendingModel !== undefined ? engineModelDisplayName(pendingModel, model.available) : undefined;
  const chipLabel = engineChipLabel(activeLabel, pendingLabel);

  const menu = useEngineMenuState(
    items.length,
    items.findIndex((item) => item.id === model.current),
    disabled,
  );

  function pick(id: string): void {
    if (disabled) {
      return;
    }
    if (id !== model.current) {
      onPick(id);
    }
    menu.close(true);
  }

  return (
    <div className="model-pill" ref={menu.rootRef}>
      <EngineMenuChip
        label={chipLabel}
        tooltip={pendingLabel === undefined ? activeLabel : `${chipLabel}`}
        ariaLabel="Codex model"
        disabled={disabled}
        open={menu.open}
        chipRef={menu.chipRef}
        onToggle={() => menu.setOpen((o) => !o)}
        onKeyDown={menu.onChipKeyDown}
      />
      {menu.open && (
        <div
          className="model-pill-popover"
          role="menu"
          aria-label="Codex model"
          onKeyDown={(event) => menu.onMenuKeyDown(event, (index) => {
            const item = items[index];
            if (item) pick(item.id);
          })}
          style={menu.anchor ? { left: menu.anchor.left, bottom: menu.anchor.bottom } : undefined}
        >
          {items.map((item, index) => {
            const current = item.id === model.current;
            const queued = item.id === pendingModel;
            return (
              <button
                key={item.id}
                ref={(el) => {
                  menu.itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                tabIndex={index === menu.focusIndex ? 0 : -1}
                className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
                onClick={() => pick(item.id)}
              >
                <span className="model-pill-item-check" aria-hidden="true">
                  {current ? <Check /> : null}
                </span>
                <span className="model-pill-item-name">{item.label}</span>
                {queued && <span className="engine-menu-item-pending">next turn</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface EnginePresetMenuProps {
  permissions: { presets: readonly EnginePermissionPreset[]; activePresetId: string };
  pendingPresetId: string | undefined;
  disabled: boolean;
  onPick(presetId: string): void;
}

/** Active-session permission-preset chip for a non-core engine (Composer.tsx). */
export function EnginePresetMenu({ permissions, pendingPresetId, disabled, onPick }: EnginePresetMenuProps) {
  const { presets, activePresetId } = permissions;
  const active = activeEnginePreset(presets, activePresetId);
  const activeLabel = active?.label ?? activePresetId;
  const pending = pendingPresetId !== undefined ? activeEnginePreset(presets, pendingPresetId) : undefined;
  const pendingLabel = pendingPresetId !== undefined ? (pending?.label ?? pendingPresetId) : undefined;
  const chipLabel = engineChipLabel(activeLabel, pendingLabel);
  const tooltip = enginePresetTooltip(activeLabel, active?.description, pendingLabel);

  const menu = useEngineMenuState(
    presets.length,
    presets.findIndex((p) => p.id === activePresetId),
    disabled,
  );

  function pick(id: string): void {
    if (disabled) {
      return;
    }
    if (id !== activePresetId) {
      onPick(id);
    }
    menu.close(true);
  }

  return (
    <div className="model-pill" ref={menu.rootRef}>
      <EngineMenuChip
        label={chipLabel}
        tooltip={tooltip}
        ariaLabel="Codex permission preset"
        disabled={disabled}
        open={menu.open}
        chipRef={menu.chipRef}
        onToggle={() => menu.setOpen((o) => !o)}
        onKeyDown={menu.onChipKeyDown}
      />
      {menu.open && (
        <div
          className="model-pill-popover"
          role="menu"
          aria-label="Codex permission preset"
          onKeyDown={(event) => menu.onMenuKeyDown(event, (index) => {
            const item = presets[index];
            if (item) pick(item.id);
          })}
          style={menu.anchor ? { left: menu.anchor.left, bottom: menu.anchor.bottom } : undefined}
        >
          {presets.map((preset, index) => {
            const current = preset.id === activePresetId;
            const queued = preset.id === pendingPresetId;
            return (
              <button
                key={preset.id}
                ref={(el) => {
                  menu.itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                title={preset.description}
                tabIndex={index === menu.focusIndex ? 0 : -1}
                className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
                onClick={() => pick(preset.id)}
              >
                <span className="model-pill-item-check" aria-hidden="true">
                  {current ? <Check /> : null}
                </span>
                <span className="engine-menu-item-body">
                  <span className="model-pill-item-name">{preset.label}</span>
                  <span className="engine-menu-item-desc">{preset.description}</span>
                </span>
                {queued && <span className="engine-menu-item-pending">next turn</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

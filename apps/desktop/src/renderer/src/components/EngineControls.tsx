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
 * The native menu's effort vocabulary for the model that is actually selected:
 * the pending model when a switch is queued, otherwise the current one. PURE
 * and derived from `model.available` ONLY — a native engine's own catalog,
 * never AnyCode's provider catalog and never core's closed effort union. A
 * model absent from the catalog advertises nothing (`[]`), which is the honest
 * answer: the menu must not offer levels nobody can validate downstream.
 * Exported for unit testing (and reused by the automation facade).
 */
export function engineEffortOptions(
  model: EngineModelMenuProps["model"],
  pendingModel?: string,
): readonly string[] {
  const id = pendingModel ?? model.current;
  return model.available.find((item) => item.id === id)?.efforts ?? [];
}

/**
 * Applied / next-turn effort state of the SELECTED native model. Every field is
 * optional on purpose: an unknown value is honest, never defaulted.
 */
export interface EngineEffortState {
  current?: string;
  selected?: string;
  pending?: string;
}

/**
 * The effort row's value text. `current` is the APPLIED effort of the selected
 * model (absent when the session has not reported one — shown as `Default`,
 * never as an invented level); `pending` is the chosen-but-not-yet-applied
 * level and is marked as applying on the next turn, so it can never read as
 * already active. Exported for unit testing.
 */
export function engineEffortSummary(effort?: EngineEffortState): string {
  if (effort === undefined) {
    return "Default";
  }
  const current = effort.current ?? "Default";
  return effort.pending !== undefined ? `${current} → ${effort.pending} (next turn)` : current;
}

/**
 * The model a native pick must be compared against: the NEXT-TURN choice. A
 * queued pick is the selection in force from the next turn on, so choosing the
 * applied model to CANCEL it is a change and must still be sent.
 * Exported for unit testing.
 */
export function engineSelectedModel(model: EngineModelMenuProps["model"], pendingModel: string | undefined): string {
  return pendingModel ?? model.current;
}

/**
 * The effort a native pick must be compared against: the effort OF THE SELECTED
 * MODEL for the next turn, and NOTHING when it is unknown. Comparing against
 * the applied model's effort instead swallowed a pick right after a model
 * switch (A applied `medium`, B queued with no known effort: picking `medium`
 * for B matched A's applied value, the menu closed, and the next turn ran with
 * whatever B defaulted to). An unknown value is unequal to every level, so
 * every pick is sent. Exported for unit testing.
 */
export function engineSelectedEffort(effort?: EngineEffortState): string | undefined {
  return effort?.selected;
}

/**
 * The effort control's state for the model that is actually SELECTED:
 *
 * - `current`  the applied effort — only when the applied model IS the selected
 *              one; a queued switch says nothing about the new model's effort,
 *              so it is absent there rather than borrowing the old model's.
 * - `selected` the next-turn effort for the selected model: its queued choice,
 *              else the applied value, else absent (unknown).
 * - `pending`  the queued choice, marked as applying on the next turn.
 *
 * `undefined` when the selected model advertises no levels — capability is the
 * vocabulary, never the presence of a value. Exported for unit testing (and
 * shared with the automation facade so its label matches the rendered chip).
 */
export function engineEffortControlState(
  model: EngineModelMenuProps["model"] & { readonly effort?: string },
  pendingModel: string | undefined,
  pendingEffort: string | undefined,
): EngineEffortState | undefined {
  if (engineEffortOptions(model, pendingModel).length === 0) {
    return undefined;
  }
  const current = pendingModel === undefined || pendingModel === model.current ? model.effort : undefined;
  const selected = pendingEffort ?? current;
  return {
    ...(current !== undefined ? { current } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(pendingEffort !== undefined && pendingEffort !== current ? { pending: pendingEffort } : {}),
  };
}

/**
 * The effort control Composer hands to `EngineModelMenu` — present whenever the
 * SELECTED model advertises levels, and absent otherwise (see
 * {@link engineEffortControlState} for the applied/selected split).
 * Exported for unit testing (the mounted DOM test builds its props with it).
 */
export function nativeEffortControl(
  model: { readonly current: string; readonly available: readonly EngineModelChoice[]; readonly effort?: string },
  pendingModel: string | undefined,
  pendingEffort: string | undefined,
  onPick: (effort: string) => void,
): EngineModelMenuProps["effort"] {
  const state = engineEffortControlState(model, pendingModel, pendingEffort);
  return state === undefined ? undefined : { ...state, onPick };
}

/**
 * The native chip's full label: the model half keeps ALL of `engineChipLabel`'s
 * pending-model semantics (active first, queued target marked), and the effort
 * half is the same applied-then-queued summary the effort row shows — appended
 * rather than replacing it, so adding effort must not suppress a pending model
 * (and a queued effort must not read as applied).
 * Exported for unit testing.
 */
export function engineMenuChipLabel(
  model: EngineModelMenuProps["model"],
  pendingModel: string | undefined,
  effort?: EngineEffortState,
): string {
  const base = engineChipLabel(
    engineModelDisplayName(model.current, model.available),
    pendingModel !== undefined ? engineModelDisplayName(pendingModel, model.available) : undefined,
  );
  return effort === undefined ? base : `${base} · ${engineEffortSummary(effort)}`;
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
  /**
   * The effort control. `current` is OPTIONAL on purpose: an
   * unknown current effort means "this session has not reported one yet", not
   * "this model has no effort capability" — capability is `model.available`
   * alone, so the row must appear as soon as the vocabulary is nonempty.
   * `selected` is the NEXT-TURN effort of the selected model and may also be
   * unknown; a pick is compared against IT, never against the applied model's
   * effort (see `engineSelectedEffort`).
   */
  effort?: EngineEffortState & { onPick(effort: string): void };
}

/**
 * Unified native-engine model control. It deliberately mirrors ModelPill's
 * two-level Model/Effort popover instead of growing a second composer chip.
 * Effort remains a string because Codex models advertise their own vocabulary.
 */
export function EngineModelMenu({ model, pendingModel, disabled, onPick, effort }: EngineModelMenuProps) {
  const items = engineModelItems(model.current, model.available);
  const activeLabel = engineModelDisplayName(model.current, model.available);
  const pendingLabel = pendingModel !== undefined ? engineModelDisplayName(pendingModel, model.available) : undefined;
  // Capability comes from the engine's own advertised vocabulary for the
  // SELECTED (possibly pending) model — never from the existence of a current
  // effort value, and never from AnyCode's provider catalog.
  const efforts = engineEffortOptions(model, pendingModel);
  const showEffort = efforts.length > 0;
  const [page, setPage] = useState<"root" | "model" | "effort">("root");
  const itemCount = page === "root" ? (showEffort ? 2 : 1) : page === "model" ? items.length : efforts.length;
  const currentIndex = page === "model" ? Math.max(0, items.findIndex((item) => item.id === model.current)) : page === "effort" ? Math.max(0, efforts.indexOf(effort?.current ?? "")) : 0;

  const menu = useEngineMenuState(itemCount, currentIndex, disabled);
  const chipLabel = engineMenuChipLabel(model, pendingModel, effort);
  const effortSummary = engineEffortSummary(effort);
  useEffect(() => {
    if (!menu.open) setPage("root");
  }, [menu.open]);

  function pick(id: string): void {
    if (disabled) {
      return;
    }
    // Compared against the NEXT-TURN choice: picking the applied model while
    // another switch is queued is what CANCELS that switch, so it must be sent.
    if (id !== engineSelectedModel(model, pendingModel)) {
      onPick(id);
    }
    menu.close(true);
  }

  function pickEffort(value: string): void {
    // Same rule as `pick`: cancelling a queued effort by re-picking the applied
    // one is a real change to the next turn and must reach the host.
    if (!disabled && effort !== undefined && value !== engineSelectedEffort(effort)) effort.onPick(value);
    menu.close(true);
  }

  return (
    <div className="model-pill" ref={menu.rootRef}>
      <EngineMenuChip
        label={chipLabel}
        tooltip={chipLabel}
        ariaLabel="Engine model and effort"
        disabled={disabled}
        open={menu.open}
        chipRef={menu.chipRef}
        onToggle={() => menu.setOpen((o) => !o)}
        onKeyDown={menu.onChipKeyDown}
      />
      {menu.open && page === "root" && (
        <div
          className="model-pill-popover"
          role="menu"
          aria-label="Engine model and effort"
          data-model-pill-page="root"
          onKeyDown={(event) => menu.onMenuKeyDown(event, (index) => {
            if (index === 0) setPage("model");
            else if (showEffort) setPage("effort");
          })}
          style={menu.anchor ? { left: menu.anchor.left, bottom: menu.anchor.bottom } : undefined}
        >
          <button ref={(el) => { menu.itemRefs.current[0] = el; }} type="button" role="menuitem" tabIndex={menu.focusIndex === 0 ? 0 : -1} className="model-pill-row" onClick={() => setPage("model")}><span className="model-pill-row-name">Model</span><span className="model-pill-row-value">{engineChipLabel(activeLabel, pendingLabel)}</span><Chevron className="model-pill-row-chevron" /></button>
          {showEffort && <button ref={(el) => { menu.itemRefs.current[1] = el; }} type="button" role="menuitem" tabIndex={menu.focusIndex === 1 ? 0 : -1} className="model-pill-row" onClick={() => setPage("effort")}><span className="model-pill-row-name">Effort</span><span className="model-pill-row-value">{effortSummary}</span><Chevron className="model-pill-row-chevron" /></button>}
        </div>
      )}
      {menu.open && page !== "root" && <div className="model-pill-popover" role="menu" aria-label={page === "model" ? "Engine model" : "Engine reasoning effort"} data-model-pill-page={page} onKeyDown={(event) => menu.onMenuKeyDown(event, (index) => { if (page === "model") { const item = items[index]; if (item) pick(item.id); } else { const value = efforts[index]; if (value) pickEffort(value); } })} style={menu.anchor ? { left: menu.anchor.left, bottom: menu.anchor.bottom } : undefined}>
        <button type="button" className="model-pill-back" onClick={() => setPage("root")}><Chevron className="model-pill-back-chevron" />{page === "model" ? "Model" : "Effort"}</button>
        {(page === "model" ? items : efforts.map((value) => ({ id: value, label: value }))).map((item, index) => {
          const current = page === "model" ? item.id === model.current : item.id === (effort?.current ?? null);
          const queued = page === "model" ? item.id === pendingModel : item.id === effort?.pending;
          return (
            <button
              key={item.id}
              ref={(el) => { menu.itemRefs.current[index] = el; }}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              tabIndex={index === menu.focusIndex ? 0 : -1}
              className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
              // Stable identity stamps for the automation facade: raw attribute
              // values, never a position derived from a catalog that may disagree
              // with what is rendered.
              {...(page === "model" ? { "data-model-id": item.id } : { "data-effort": item.id })}
              onClick={() => page === "model" ? pick(item.id) : pickEffort(item.id)}
            >
              <span className="model-pill-item-check" aria-hidden="true">{current ? <Check /> : null}</span>
              <span className="model-pill-item-name">{item.label}</span>
              {queued && <span className="engine-menu-item-pending">next turn</span>}
            </button>
          );
        })}
      </div>}
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

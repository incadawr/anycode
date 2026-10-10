/**
 * TASK.106 cut-2 §D4 (DoD 6) — the drill-down model popover, as ONE component
 * both pickers render.
 *
 * The form is TASK.131's (owner decision 17.08): a root level with three
 * popular picks, one row per connection GROUP and — for a model that declares
 * an effort vocabulary — an effort row; a group opens as a level of its own;
 * effort opens as a level of its own. This file is the MARKUP of that form,
 * lifted verbatim out of `StartScreen.tsx` so the running session's chip
 * (`ModelPill.tsx`) can show the same picker instead of a second one that
 * drifts. The `.start-model-*` class names come with it unchanged — the CSS,
 * and the automation probes that key off `data-level` / `data-connection-id` /
 * `data-model-id`, keep working against either host.
 *
 * Presentational only, by construction: no store access, no effects, no
 * measurement. Which rows exist, which level is on screen, where the popover
 * hangs and how tall it may grow are all decided by the pure layers
 * (`start-model-picker.ts`, `model-drill-rows.ts`) and arrive as props, which
 * is what keeps every rule of this picker unit-testable in a `node`
 * environment that renders nothing.
 */
import { Fragment } from "react";
import type { CSSProperties, KeyboardEvent, MutableRefObject, ReactElement } from "react";
import { Check, Chevron } from "./icons.js";
import { modelDrillEffortLabel, type ModelDrillPage, type ModelDrillRow } from "./model-drill-rows.js";

export interface ModelDrillMenuProps {
  /** The rows of the level currently on screen — a flat list, one roving-focus index across all of them. */
  rows: readonly ModelDrillRow[];
  /** Which level those rows belong to; also the popover's `data-level` attribute. */
  page: ModelDrillPage;
  /** Measured placement: whether the popover hangs above its chip, and the room it may grow into. `null` before the first measurement (the CSS fallback caps it). */
  placement: { flipUp: boolean; maxHeightPx: number } | null;
  /** The back button's caption — the open group's label, or "Effort"; `null` on the root level, where there is no back button at all. */
  backLabel: string | null;
  /** Index of the roving-focus row (the only one with `tabIndex={0}`). */
  focusIndex: number;
  /** What an empty level says instead of showing a blank box. */
  emptyText: string;
  /** The owner's row-button registry, filled by index so the owner can move DOM focus with the roving index. */
  itemRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onActivateRow(row: ModelDrillRow): void;
  onBack(): void;
  /**
   * Taskana 4237: the action behind the empty-root level's "Add connection"
   * button. Rendered ONLY when the root level has no rows at all (the
   * no-connected-provider state) — never alongside populated rows, and never
   * on an empty non-root level (a group with no models is not a place to add
   * a connection).
   */
  onAddConnection(): void;
  /**
   * Whether a row's connection is the one already in use — the start screen
   * answers with the draft's pin, a running session with the tab's. Only a
   * popular pick that would SWITCH connection is annotated with its group
   * label; repeating today's connection on every row is pure noise.
   */
  isCurrentConnection(connectionId: string): boolean;
}

export function ModelDrillMenu(props: ModelDrillMenuProps): ReactElement {
  const { rows, page, placement, backLabel, focusIndex, emptyText, itemRefs } = props;

  /**
   * One row of whatever level is on screen. Two shapes only: a PICK
   * (`.start-model-item` — check gutter, name, muted trailing detail) and a
   * DRILL-IN (`.start-model-row` — name, value, chevron), the same two shapes
   * ModelPill's own popover has always used.
   */
  function renderRow(row: ModelDrillRow, index: number): ReactElement {
    const attach = (el: HTMLButtonElement | null): void => {
      itemRefs.current[index] = el;
    };
    const tabIndex = index === focusIndex ? 0 : -1;
    if (row.kind === "group") {
      return (
        <button
          ref={attach}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          tabIndex={tabIndex}
          className="start-model-row start-model-group"
          data-connection-id={row.connectionId}
          data-model-count={row.count}
          onClick={() => props.onActivateRow(row)}
        >
          <span className="start-model-row-name">{row.label}</span>
          {/* TASK.131 D2: the baseUrl host, shown only when two connections' auto-labels collide. */}
          {row.subtitle !== undefined && <span className="start-model-row-sub">{row.subtitle}</span>}
          <span className="start-model-row-value">{row.count}</span>
          <Chevron className="start-model-row-chevron" />
        </button>
      );
    }
    if (row.kind === "effort-open") {
      return (
        <button
          ref={attach}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          tabIndex={tabIndex}
          className="start-model-row start-model-effort-row"
          data-effort={row.value}
          onClick={() => props.onActivateRow(row)}
        >
          <span className="start-model-row-name">Effort</span>
          <span className="start-model-row-value">{modelDrillEffortLabel(row.value)}</span>
          <Chevron className="start-model-row-chevron" />
        </button>
      );
    }
    const current = row.current;
    return (
      <button
        ref={attach}
        type="button"
        role="menuitemradio"
        aria-checked={current}
        tabIndex={tabIndex}
        className={`start-model-item${current ? " start-model-item-current" : ""}`}
        {...(row.kind === "effort"
          ? { "data-effort": row.value }
          : { "data-connection-id": row.connectionId, "data-model-id": row.modelId })}
        onClick={() => props.onActivateRow(row)}
      >
        <span className="start-model-item-check" aria-hidden="true">
          {current ? <Check /> : null}
        </span>
        <span className="start-model-item-name">
          {row.kind === "effort" ? modelDrillEffortLabel(row.value) : row.name}
        </span>
        {/* A popular pick that would SWITCH connection says which one it
            means; one from the connection already in use needs no annotation. */}
        {row.kind === "popular" && !props.isCurrentConnection(row.connectionId) && (
          <span className="start-model-item-sub">{row.groupLabel}</span>
        )}
      </button>
    );
  }

  return (
    <div
      className={`start-model-menu${placement?.flipUp ? " start-model-menu-flipped" : ""}`}
      role="menu"
      aria-label="Model"
      data-level={page.kind}
      onKeyDown={props.onKeyDown}
      style={placement ? ({ maxHeight: `${placement.maxHeightPx}px` } as CSSProperties) : undefined}
    >
      {/* The popover carries no fixed height — only the max the room around
          the chip allows — so a level shorter than that renders with no
          scrollbar at all (the owner's standing requirement). */}
      {page.kind !== "root" && (
        <button type="button" className="start-model-back" onClick={props.onBack}>
          <Chevron className="start-model-back-chevron" />
          {backLabel ?? "Models"}
        </button>
      )}
      {/* Reachable only with no connected provider at all (the current
          connection always keeps a group, even an empty one). An empty box
          would read as a broken popover. */}
      {rows.length === 0 && <div className="start-model-empty">{emptyText}</div>}
      {/* Taskana 4237: the empty root level's escape hatch — a real, enabled
          action (existing row styling, Tab-reachable like any button) that
          opens Settings on the Add-connection drawer. Only on an empty ROOT:
          an empty group is no place to add a connection, and populated levels
          do not need it.

          It also joins the owner's roving-focus registry at index 0 — with no
          rows, that slot is free and is exactly the index both hosts seed on
          open, so ArrowDown/ArrowUp (count 0 → index 0) and the open-seeding
          effect keep the caret on this, the level's only action.

          Enter/Space are handled HERE, not by the host's menu handler: that
          handler `preventDefault()`s and then finds no row to activate, which
          would silently swallow the keystroke (and, in ModelPill, run twice
          through nested handlers). Consuming the key explicitly keeps native
          button activation from being cancelled — and `stopPropagation` keeps
          the host handler out of it. Escape is deliberately NOT touched, so it
          still bubbles to the host and closes/backs out as before. */}
      {rows.length === 0 && page.kind === "root" && (
        <button
          type="button"
          role="menuitem"
          className="start-model-item"
          ref={(el) => {
            itemRefs.current[0] = el;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            props.onAddConnection();
          }}
          onClick={props.onAddConnection}
        >
          <span className="start-model-item-check" aria-hidden="true" />
          <span className="start-model-item-name">Add connection</span>
        </button>
      )}
      {rows.map((row, index) => {
        // The root's three sections are separated by hairlines; the levels
        // below it are a single uninterrupted list.
        const previous = rows[index - 1];
        const dividerBefore = (row.kind === "group" && previous?.kind === "popular") || row.kind === "effort-open";
        const key =
          row.kind === "group"
            ? `group:${row.connectionId}`
            : row.kind === "effort" || row.kind === "effort-open"
              ? `effort:${row.value}`
              : `${row.kind}:${row.connectionId}:${row.modelId}`;
        return (
          <Fragment key={key}>
            {dividerBefore && <div className="start-model-divider" />}
            {renderRow(row, index)}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The "info" affordance of a menu row: a small focusable button that carries
 * the row's long explanation.
 *
 * The explanation is NOT an HTML `title`: the button points at it with
 * `aria-describedby`, so assistive tech reads it as the button's description.
 * The tooltip is visible on pointer hover OR keyboard focus, and Escape
 * dismisses only the tooltip — it does not close the menu that owns the row
 * (the keydown stops there, so the menu's own Escape handling never runs).
 *
 * The tooltip holds no focusable content, so it cannot trap the tab order: the
 * only stop is the button itself.
 */
import { useId, useRef, useState } from "react";
import { Info } from "./icons.js";

export interface RowHelpProps {
  /** The full explanation. It stays in the DOM so `aria-describedby` always resolves. */
  text: string;
  /** Accessible name of the button (the explanation is its description). */
  label?: string;
}

export function RowHelp({ text, label = "More information" }: RowHelpProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);

  function show(): void {
    openRef.current = true;
    setOpen(true);
  }

  function hide(): void {
    openRef.current = false;
    setOpen(false);
  }

  return (
    <span className="row-help" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="row-help-button"
        aria-label={label}
        aria-describedby={tooltipId}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // The tooltip is already closed: let the Escape reach the menu.
          if (!openRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          hide();
        }}
      >
        <Info />
      </button>
      <span id={tooltipId} role="tooltip" className="row-help-tooltip" data-open={open ? "true" : "false"}>
        {text}
      </span>
    </span>
  );
}

/**
 * The "info" affordance of a menu row: a small focusable button that carries
 * the row's long explanation.
 *
 * The explanation is NOT an HTML `title`: the button points at it with
 * `aria-describedby`, so assistive tech reads it as the button's description.
 * The tooltip is visible on pointer hover OR keyboard focus, and Escape
 * dismisses only the tooltip — it does not close the menu that owns the row
 * (the keydown is caught on the capture phase, before the menu's own Escape
 * handling sees it).
 *
 * The tooltip holds no focusable content, so it cannot trap the tab order: the
 * only stop is the button itself.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Info } from "./icons.js";

export interface RowHelpProps {
  /** The full explanation. It stays in the DOM so `aria-describedby` always resolves. */
  text: string;
  /** Accessible name of the button (the explanation is its description). */
  label?: string;
  /**
   * Id of the tooltip element. Defaults to a generated one; pass a known id
   * when another control in the same row should be described by the same
   * explanation (for example the row's input field).
   */
  tooltipId?: string;
}

export function RowHelp({ text, label = "More information", tooltipId: givenTooltipId }: RowHelpProps) {
  const generatedId = useId();
  const tooltipId = givenTooltipId ?? generatedId;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes the tooltip only. It is caught on the capture phase, before
  // the menu's own Escape handling (which closes the menu) can see it — but
  // only when the key belongs to this affordance, so Escape elsewhere in the
  // menu still closes the menu.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      const button = buttonRef.current;
      const target = event.target as Node | null;
      if (!button) return;
      if (target !== button && !button.contains(target) && document.activeElement !== button) return;
      event.stopPropagation();
      setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <span
      className="row-help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="row-help-button"
        aria-label={label}
        aria-describedby={tooltipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info />
      </button>
      <span id={tooltipId} role="tooltip" className="row-help-tooltip" data-open={open ? "true" : "false"}>
        {text}
      </span>
    </span>
  );
}

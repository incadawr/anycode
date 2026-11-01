import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

export interface PopoverPosition { x: number; y: number }
export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  position: PopoverPosition;
  heading?: string;
  children: ReactNode;
  className?: string;
  triggerRef?: RefObject<HTMLElement | null>;
}
// Menu rows use tabindex=-1 for roving focus, so gather them independently of tab order.
const rowsIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".ak-popover__row")]
  .filter(el => !el.disabled && !el.closest("[hidden],[inert]") && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
function focusRow(root: HTMLElement, row: HTMLElement | undefined) {
  for (const item of rowsIn(root)) item.tabIndex = item === row ? 0 : -1;
  row?.focus();
}

/** Fixed-position menu with roving focus, trigger restoration and viewport clamping. */
export function Popover({ open, onClose, position, heading, children, className, triggerRef }: PopoverProps): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const active = document.activeElement;
    trigger.current = triggerRef?.current ?? (active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null);
    focusRow(ref.current, rowsIn(ref.current)[0]);
    return () => { if (trigger.current?.isConnected) trigger.current.focus(); };
  }, [open, triggerRef]);
  useLayoutEffect(() => {
    if (!open) return;
    const clamp = () => {
      const root = ref.current; if (!root) return;
      const rect = root.getBoundingClientRect();
      root.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8))}px`;
      root.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))}px`;
    };
    clamp(); window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open, position.x, position.y, children]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!ref.current?.contains(node) && !trigger.current?.contains(node)) onClose();
    };
    // Escape has one owner, including when focus was moved outside the menu.
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("mousedown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", pointer); document.removeEventListener("keydown", key); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={["ak-popover", className].filter(Boolean).join(" ")} role="menu" aria-label={heading}
    onFocus={event => { for (const row of rowsIn(event.currentTarget)) row.tabIndex = row === (event.target as Element) ? 0 : -1; }}
    onKeyDown={event => {
      const rows = rowsIn(event.currentTarget); if (!rows.length) return;
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      switch (event.key) {
        case "Home": next = 0; break;
        case "End": next = rows.length - 1; break;
        case "ArrowDown": next = (index + 1) % rows.length; break;
        case "ArrowUp": next = (index - 1 + rows.length) % rows.length; break;
        case "Tab": next = (index + (event.shiftKey ? -1 : 1) + rows.length) % rows.length; break;
        default: return;
      }
      event.preventDefault(); focusRow(event.currentTarget, rows[next]);
    }}>
    {heading && <div className="ak-popover__head">{heading}</div>}{children}
  </div>;
}
export interface MenuItemProps {
  label: string;
  description?: string;
  selected?: boolean;
  checkable?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: ReactNode;
}
export function MenuItem({ label, description, selected = false, checkable = false, disabled = false, onSelect, children }: MenuItemProps): React.ReactElement {
  return <button type="button" role={checkable ? "menuitemcheckbox" : "menuitem"} aria-checked={checkable ? selected : undefined}
    aria-disabled={disabled || undefined} disabled={disabled} tabIndex={-1}
    className={["ak-popover__row", selected ? "is-on" : ""].filter(Boolean).join(" ")} onClick={onSelect}>
    {children}<span>{label}</span>{description && <span className="ak-popover__desc">{description}</span>}
  </button>;
}
export function MenuSeparator(): React.ReactElement { return <div className="ak-popover__sep" role="separator" />; }

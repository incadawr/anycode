import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MenuCloseContext, Popover } from "./Popover.js";

export interface MenuProps {
  /** Trigger label (the button that opens the menu). */
  label: string;
  /** Menu content: MenuItem / MenuSeparator. */
  children?: ReactNode;
  /** Divider heading in the menu header. */
  heading?: string;
  /** Icon in the trigger (aria-hidden). */
  icon?: ReactNode;
  /** Trigger is disabled. */
  disabled?: boolean;
  /** Menu is open from outside (controlled mode). */
  open?: boolean;
  /** Called when the state toggles (uncontrolled mode). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
}

/**
 * Menu — a trigger button with a dropdown menu (`role="menu"`).
 *
 * Trigger: `aria-haspopup="menu"`, `aria-expanded`, Enter/Space/ArrowDown
 * open it, Escape closes it and returns focus to the trigger. Items are MenuItem
 * (role menuitem / menuitemcheckbox), arrow-key and Home/End navigation.
 */
export function Menu({
  label,
  children,
  heading,
  icon,
  disabled = false,
  open,
  onOpenChange,
  className,
  triggerClassName,
}: MenuProps): React.ReactElement {
  const controlled = open !== undefined;
  const [uncontrolled, setUncontrolled] = useState(false);
  const isOpen = controlled ? open : uncontrolled;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setUncontrolled(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ x: rect.left, y: rect.bottom + 4 });
  }, [isOpen]);

  const openMenu = useCallback(() => setOpen(true), [setOpen]);

  return (
    <div className={["ak-menu", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        ref={triggerRef}
        className={["ak-btn", "ak-btn--secondary", "ak-btn--sm", "ak-menu__trigger", triggerClassName].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => { if (isOpen) setOpen(false); else openMenu(); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!isOpen) openMenu();
          }
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
      {isOpen ? (
        <MenuCloseContext.Provider value={() => { setOpen(false); triggerRef.current?.focus(); }}>
        <Popover
          open
          onClose={() => { setOpen(false); triggerRef.current?.focus(); }}
          position={position}
          heading={heading}
          triggerRef={triggerRef}
        >
          {children}
        </Popover>
        </MenuCloseContext.Provider>
      ) : null}
    </div>
  );
}

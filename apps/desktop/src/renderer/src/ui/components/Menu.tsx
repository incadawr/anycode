import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MenuCloseContext, Popover } from "./Popover.js";

export interface MenuProps {
  /** Подпись триггера (кнопка, открывающая меню). */
  label: string;
  /** Содержимое меню: MenuItem / MenuSeparator. */
  children?: ReactNode;
  /** Заголовок-разделитель в шапке меню. */
  heading?: string;
  /** Иконка в триггере (aria-hidden). */
  icon?: ReactNode;
  /** Триггер отключён. */
  disabled?: boolean;
  /** Меню открыто извне (контролируемый режим). */
  open?: boolean;
  /** Вызывается при переключении состояния (неконтролируемый режим). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
}

/**
 * Menu — кнопка-триггер с выпадающим меню (`role="menu"`).
 *
 * Триггер: `aria-haspopup="menu"`, `aria-expanded`, Enter/Space/ArrowDown
 * открывают, Escape закрывает и возвращает фокус на триггер. Пункты — MenuItem
 * (role menuitem / menuitemcheckbox), навигация стрелками, Home/End.
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

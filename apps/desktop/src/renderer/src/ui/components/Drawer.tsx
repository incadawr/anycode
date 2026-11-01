import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";
import { focusable } from "./focus.js";
import { useOverlayFocus } from "./useOverlayFocus.js";
import { IconClose } from "./icons.js";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Закрывать по клику по подложке. */
  closeOnScrimClick?: boolean;
  className?: string;
}

/**
 * Drawer — боковая панель поверх приложения.
 * Esc закрывает, фокус запирается внутри, по закрытию фокус возвращается на триггер.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  closeOnScrimClick = true,
  className,
}: DrawerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayFocus(panelRef, { open, bodySelector: ".ak-drawer__body" });

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusable(panel);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  const classes = ["ak-drawer", className ?? ""].filter(Boolean).join(" ");

  return (
    <>
      <div
        className="ak-drawer__scrim"
        onClick={closeOnScrimClick ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="ak-drawer__header">
          <h2 className="ak-drawer__title">{title}</h2>
          <span style={{ flex: 1 }} />
          <IconButton label="Close" icon={<IconClose size={14} />} onClick={onClose} />
        </div>
        <div className="ak-drawer__body">{children}</div>
        {footer ? <div className="ak-drawer__footer">{footer}</div> : null}
      </div>
    </>
  );
}

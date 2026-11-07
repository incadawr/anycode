import { useCallback, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "./IconButton.js";
import { focusable } from "./focus.js";
import { useOverlayFocus } from "./useOverlayFocus.js";
import { IconClose } from "./icons.js";

/** Drawer size: width comes from the `--drawer-w` token. */
export type DrawerSize = "md" | "lg";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Subtitle in the header (header slot). */
  subtitle?: string;
  /** Extra header content — header slot. */
  headerExtra?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Close on click on the backdrop. */
  closeOnScrimClick?: boolean;
  /** Drawer size: md | lg. */
  size?: DrawerSize;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Drawer — a side panel over the app (replaces `connection-drawer`).
 *
 * Slots: header (sticky title + subtitle + headerExtra + close button),
 * body (scrollable), footer (sticky). Esc closes, focus is trapped
 * inside and returns to the trigger on close. Accessible name is
 * `aria-labelledby` on the title. Backdrop uses the `--bg-scrim` token.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  children,
  footer,
  closeOnScrimClick = true,
  size = "md",
  className,
  initialFocusRef,
}: DrawerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId(), descriptionId = useId();
  useOverlayFocus(panelRef, { open, bodySelector: ".ak-drawer__body", initialFocusRef });

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

  const classes = ["ak-drawer", size !== "md" ? `ak-drawer--${size}` : "", className ?? ""].filter(Boolean).join(" ");

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
        aria-labelledby={headingId}
        aria-describedby={subtitle ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="ak-drawer__header">
          <div className="ak-drawer__heading">
            <h2 className="ak-drawer__title" id={headingId}>{title}</h2>
            {subtitle ? <p className="ak-drawer__subtitle" id={descriptionId}>{subtitle}</p> : null}
          </div>
          {headerExtra}
          <IconButton label="Close" icon={<IconClose size={14} />} onClick={onClose} />
        </div>
        <div className="ak-drawer__body">{children}</div>
        {footer ? <div className="ak-drawer__footer">{footer}</div> : null}
      </div>
    </>
  );
}

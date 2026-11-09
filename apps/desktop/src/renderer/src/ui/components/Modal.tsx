import { useCallback, useId, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "./IconButton.js";
import { IconClose } from "./icons.js";
import { focusable } from "./focus.js";
import { useOverlayFocus } from "./useOverlayFocus.js";

/** Dialog size: width comes from the `--dialog-w*` tokens. */
export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Tooltip for the subtitle when the visible text is a shortened form of it. */
  subtitleTitle?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Extra header content (buttons, counters) — header slot. */
  headerExtra?: ReactNode;
  closeOnScrimClick?: boolean;
  /** Deprecated alias for `size="lg"`, kept for compatibility. */
  wide?: boolean;
  /** Dialog size: sm | md | lg. */
  size?: ModalSize;
  /** Additional classes on the dialog surface. */
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Native top-layer dialog with a layout-independent keyboard fallback.
 *
 * Slots: header (title/subtitle/headerExtra + close button), body (children,
 * scrollable), footer (footer). Sizes: sm | md | lg (`wide` = lg).
 * Focus is trapped inside, returns to the trigger on close, Esc closes.
 * Accessible name — `aria-labelledby` on the title, description — `aria-describedby`.
 * Backdrop uses the `--bg-scrim` token.
 */
export function Modal({ open, onClose, title, subtitle, subtitleTitle, children, footer, headerExtra,
  closeOnScrimClick = true, wide = false, size, className, initialFocusRef }: ModalProps): React.ReactElement | null {
  const ref = useRef<HTMLDialogElement>(null);
  const closeHandled = useRef(false);
  const headingId = useId(), descriptionId = useId();
  const effectiveSize: ModalSize = size ?? (wide ? "lg" : "md");
  const activate = useCallback((dialog: HTMLDialogElement) => {
    closeHandled.current = false;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  const deactivate = useCallback((dialog: HTMLDialogElement) => {
    closeHandled.current = true;
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }, []);
  useOverlayFocus(ref, { open, bodySelector: ".ak-modal__body", initialFocusRef, onOpen: activate, onCleanup: deactivate });
  if (!open) return null;
  return <dialog ref={ref} tabIndex={-1} className={["ak-modal", `ak-modal--${effectiveSize}`,
    effectiveSize === "lg" ? "ak-modal--wide" : "", className].filter(Boolean).join(" ")}
    aria-labelledby={headingId} aria-describedby={subtitle ? descriptionId : undefined} aria-modal="true"
    onClose={event => {
      if (event.target !== event.currentTarget || event.currentTarget.open || closeHandled.current) return;
      closeHandled.current = true;
      onClose();
    }}
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const items = focusable(event.currentTarget), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onClick={event => { if (closeOnScrimClick && event.target === event.currentTarget) onClose(); }}>
    <div className="ak-modal__head">
      <div className="ak-modal__heading">
        <h2 className="ak-modal__title" id={headingId}>{title}</h2>
        {subtitle && <p className="ak-modal__subtitle" id={descriptionId} title={subtitleTitle}>{subtitle}</p>}
      </div>
      {headerExtra}
      <IconButton label="Close" icon={<IconClose size={14} />} onClick={onClose} />
    </div>
    <div className="ak-modal__body">{children}</div>
    {footer && <div className="ak-modal__foot"><span className="ak-modal__spacer" />{footer}</div>}
  </dialog>;
}

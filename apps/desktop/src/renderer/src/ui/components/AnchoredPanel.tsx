import { createPortal } from "react-dom";
import { useCallback, useId, useLayoutEffect, useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "./IconButton.js";
import { useOverlayFocus } from "./useOverlayFocus.js";
import { IconClose } from "./icons.js";

export type AnchoredPanelSide = "bottom" | "top";
export type AnchoredPanelAlign = "start" | "end";

export interface AnchoredPanelProps {
  open: boolean;
  onClose: () => void;
  /** Trigger element the panel is anchored to. Clicks on it are not "outside" clicks. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name (aria-labelledby) and header text. */
  title: string;
  /** Preferred side; flips to the other one when it does not fit. */
  side?: AnchoredPanelSide;
  /** Edge of the anchor the panel is aligned to. */
  align?: AnchoredPanelAlign;
  /** Extra header actions, placed before the close button. */
  headerActions?: ReactNode;
  children?: ReactNode;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const GAP = 6, MARGIN = 8;

/**
 * AnchoredPanel — a small non-modal floating detail window attached to a trigger
 * (not a menu: role="dialog"). Fixed position computed from the anchor rect, flips
 * above/below and is clamped to the viewport. Header (title + actions + close),
 * scrollable body with max-height. Escape, outside click and the close button
 * close it; focus returns to the trigger.
 */
export function AnchoredPanel({
  open, onClose, anchorRef, title, side = "bottom", align = "start", headerActions, children, className, initialFocusRef,
}: AnchoredPanelProps): React.ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  useOverlayFocus(ref, { open, bodySelector: ".ak-anchored__body", initialFocusRef });

  const place = useCallback(() => {
    const root = ref.current, anchor = anchorRef.current;
    if (!root || !anchor) return;
    const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const below = vh - a.bottom - GAP - MARGIN, above = a.top - GAP - MARGIN;
    let useSide = side;
    if (side === "bottom" && r.height > below && above > below) useSide = "top";
    else if (side === "top" && r.height > above && below > above) useSide = "bottom";
    const room = useSide === "bottom" ? below : above;
    root.style.maxHeight = `${Math.max(0, room)}px`;
    const height = Math.min(r.height, Math.max(0, room));
    const left = align === "end" ? a.right - r.width : a.left;
    const top = useSide === "bottom" ? a.bottom + GAP : a.top - GAP - height;
    root.style.left = `${Math.max(MARGIN, Math.min(left, vw - r.width - MARGIN))}px`;
    root.style.top = `${Math.max(MARGIN, Math.min(top, vh - height - MARGIN))}px`;
    root.dataset.side = useSide;
  }, [anchorRef, side, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, place, children]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!ref.current?.contains(node) && !anchorRef.current?.contains(node)) onClose();
    };
    document.addEventListener("mousedown", pointer);
    return () => document.removeEventListener("mousedown", pointer);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  // Portaled to <body>: an ancestor with containment (container-type, transform, filter) would otherwise
  // become the containing block of this fixed element and offset the viewport coordinates computed in place().
  return createPortal(
    <div
      ref={ref}
      className={["ak-anchored", className].filter(Boolean).join(" ")}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}
    >
      <div className="ak-anchored__header">
        <h2 className="ak-anchored__title" id={headingId}>{title}</h2>
        {headerActions}
        <IconButton label="Close" icon={<IconClose size={14} />} onClick={onClose} />
      </div>
      <div className="ak-anchored__body">{children}</div>
    </div>,
    document.body,
  );
}

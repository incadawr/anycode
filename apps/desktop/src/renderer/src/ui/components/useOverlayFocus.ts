import { useEffect, type RefObject } from "react";
import { focusable } from "./focus.js";

/** Shared initial-focus priority and trigger restoration for overlay lifetimes. */
export function useOverlayFocus<T extends HTMLElement>(ref: RefObject<T | null>, {
  open, bodySelector, initialFocusRef, onOpen, onCleanup,
}: {
  open: boolean;
  bodySelector: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onOpen?: (root: T) => void;
  onCleanup?: (root: T) => void;
}): void {
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpen?.(root);
    const body = root.querySelector<HTMLElement>(bodySelector);
    const preferred = initialFocusRef?.current ?? root.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? (body && focusable(body)[0]) ?? focusable(root)[0] ?? root).focus();
    return () => {
      onCleanup?.(root);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open, ref, bodySelector, initialFocusRef, onOpen, onCleanup]);
}

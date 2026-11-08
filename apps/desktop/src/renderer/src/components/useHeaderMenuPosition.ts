import { useLayoutEffect, type RefObject } from "react";

/** Keep an absolutely positioned header menu within the current viewport. */
export function placeHeaderMenu(menu: HTMLElement): void {
  const anchor = menu.parentElement;
  if (!anchor) return;
  menu.style.left = "0px";
  const bounds = menu.getBoundingClientRect();
  const spacing = getComputedStyle(menu).getPropertyValue("--sp-4").trim();
  const size = Number.parseFloat(spacing) || 0;
  const gutter = spacing.endsWith("rem") ? size * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) : size;
  const shift = Math.max(gutter, Math.min(bounds.left, window.innerWidth - gutter - bounds.width)) - bounds.left;
  menu.style.left = `${shift}px`;
}

export function useHeaderMenuPosition(open: boolean, menuRef: RefObject<HTMLElement | null>, enabled = true): void {
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    if (!open || !enabled || !menu || !anchor) return;
    const place = () => placeHeaderMenu(menu);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(menu);
    observer?.observe(anchor);
    const header = anchor.closest(".session-header");
    if (header) {
      observer?.observe(header);
      for (const child of header.children) observer?.observe(child);
    }
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
      menu.style.removeProperty("left");
    };
  }, [open, enabled, menuRef]);
}

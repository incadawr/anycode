import { useCallback, useState } from "react";

export interface RovingOptions {
  /** Number of items in the group. */
  count: number;
  /** Navigation direction: horizontal — left/right arrows only. */
  orientation?: "horizontal" | "vertical" | "both";
  /** Index of the item that receives focus (usually the selected one). */
  activeIndex?: number;
  /** Called when the active item changes via the keyboard. */
  onActiveIndexChange?: (index: number) => void;
  /** Item is disabled — keyboard navigation skips it. */
  isDisabled?: (index: number) => boolean;
}

export interface RovingTabindex {
  /** Active (focusable) index of the group. */
  activeIndex: number;
  /** tabIndex for the item at an index: 0 for the active one, -1 for the rest. */
  tabIndexFor: (index: number) => 0 | -1;
  /** Keyboard handler for the item at an index. */
  onKeyDown: (index: number) => (event: React.KeyboardEvent) => void;
  /** Set the active index manually (e.g. on click). */
  setActiveIndex: (index: number) => void;
}

/**
 * Shared roving tabindex mechanism: only one item in the group is in the tab order
 * (tabIndex=0), the rest are -1. Arrow keys (and Home/End) move the active
 * item; movement wraps around. Used by the kit's RadioGroup; the same
 * helper also drives the accent picker and RolePickerDialog.
 */
export function useRovingTabindex({
  count,
  orientation = "vertical",
  activeIndex: controlledIndex,
  onActiveIndexChange,
  isDisabled,
}: RovingOptions): RovingTabindex {
  const [uncontrolled, setUncontrolled] = useState(0);
  const controlled = controlledIndex !== undefined;
  const requestedIndex = controlled ? controlledIndex : uncontrolled;
  const activeIndex = requestedIndex >= 0 && requestedIndex < count && !isDisabled?.(requestedIndex)
    ? requestedIndex
    : Array.from({ length: count }, (_, index) => index).find(index => !isDisabled?.(index)) ?? -1;

  const setActiveIndex = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(count - 1, index));
      if (!controlled) setUncontrolled(next);
      onActiveIndexChange?.(next);
    },
    [controlled, count, onActiveIndexChange],
  );

  const tabIndexFor = useCallback(
    (index: number): 0 | -1 => (index === activeIndex ? 0 : -1),
    [activeIndex],
  );

  const skipDisabled = useCallback(
    (from: number, step: number) => {
      let next = from;
      for (let i = 0; i < count; i += 1) {
        next = (next + step + count) % count;
        if (!isDisabled?.(next)) return next;
      }
      return from;
    },
    [count, isDisabled],
  );

  const onKeyDown = useCallback(
    (index: number) => (event: React.KeyboardEvent) => {
      const back = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
      const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const keys: string[] =
        orientation === "both"
          ? ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
          : [back, forward];
      let next: number | undefined;
      if (keys.includes(event.key)) {
        const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        next = skipDisabled(index, step);
      }
      else if (event.key === "Home") next = skipDisabled(count - 1, 1);
      else if (event.key === "End") next = skipDisabled(0, -1);
      if (next === undefined || count === 0 || isDisabled?.(next)) return;
      event.preventDefault();
      setActiveIndex(next);
    },
    [count, orientation, setActiveIndex, skipDisabled, isDisabled],
  );

  return { activeIndex, tabIndexFor, onKeyDown, setActiveIndex };
}

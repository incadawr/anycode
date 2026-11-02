import { useCallback, useState } from "react";

export interface RovingOptions {
  /** Количество элементов в группе. */
  count: number;
  /** Направление навигации: horizontal — только стрелки влево/вправо. */
  orientation?: "horizontal" | "vertical" | "both";
  /** Индекс элемента, который получает фокус (обычно выбранный). */
  activeIndex?: number;
  /** Вызывается при смене активного элемента клавишами. */
  onActiveIndexChange?: (index: number) => void;
  /** Элемент заблокирован — клавиатурная навигация его пропускает. */
  isDisabled?: (index: number) => boolean;
}

export interface RovingTabindex {
  /** Активный (focusable) индекс группы. */
  activeIndex: number;
  /** tabIndex для элемента по индексу: 0 у активного, -1 у остальных. */
  tabIndexFor: (index: number) => 0 | -1;
  /** Обработчик клавиатуры для элемента по индексу. */
  onKeyDown: (index: number) => (event: React.KeyboardEvent) => void;
  /** Задать активный индекс вручную (например, по клику). */
  setActiveIndex: (index: number) => void;
}

/**
 * Общий механизм roving tabindex: в группе в табуляции только один элемент
 * (tabIndex=0), остальные — -1. Стрелки (и Home/End) перемещают активный
 * элемент; перемещение циклическое. Используется RadioGroup кита; тот же
 * ходок переводит на себя пикер акцента и RolePickerDialog.
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

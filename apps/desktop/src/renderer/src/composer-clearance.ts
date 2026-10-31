/**
 * How far the toast stack has to sit above the window's bottom edge so it never
 * covers the composer (UI audit v0.0.49 §C2).
 *
 * The stack is pinned to the window corner (`position: fixed`), while the
 * composer is a flex child of the conversation column whose height changes with
 * the draft — the textarea grows, paste pills appear, the footer rewraps. The
 * two therefore intersect at the moment a toast matters most: a refusal
 * ("Cannot compact while this session is busy…") lands on top of Stop, the send
 * arrow and the context meter exactly while the user is reaching for them.
 *
 * CSS cannot measure a sibling's box, so the composer PUBLISHES its own
 * clearance as a custom property and the stylesheet consumes it:
 *
 *   bottom: var(--composer-clearance, var(--sp-4));
 *
 * The value is the distance from the viewport's bottom edge to the stack's
 * lower edge — i.e. everything from the composer's top edge downward, plus a
 * breathing gap. There is no formula to fall out of sync: every live card is
 * measured from its own rect whenever it (or the window) resizes.
 *
 * More than one card can be on screen at once: the split layout shows a live
 * child pane, with its own composer, beside the master's. The stack is anchored
 * to the right edge, so it is the child's card it would cover there, while the
 * master's may stand taller. The published value is therefore the LARGEST
 * clearance of every live card — clear of all of them, whichever is nearest.
 *
 * The property lives on `:root` because the stack is a window-level overlay,
 * not a descendant of the conversation column. The last card unmounting removes
 * it, so a screen without a composer (start, welcome, empty) falls back to the
 * plain corner inset.
 */
import { useEffect, type RefObject } from "react";

/** Custom property the composer publishes; consumed by `.notice-stack`. */
export const COMPOSER_CLEARANCE_VAR = "--composer-clearance";

/** Air between the composer's top edge and the lowest toast. */
export const COMPOSER_CLEARANCE_GAP_PX = 12;

/**
 * Distance from the viewport's bottom edge to the toast stack's lower edge.
 * `composerTopPx` is the composer card's `getBoundingClientRect().top`.
 * A composer that somehow sits at or below the bottom edge (mid-animation,
 * zero-height layout) yields 0, never a negative `bottom`.
 */
export function composerClearancePx(composerTopPx: number, viewportHeightPx: number): number {
  const clearance = viewportHeightPx - composerTopPx + COMPOSER_CLEARANCE_GAP_PX;
  return Number.isFinite(clearance) && clearance > 0 ? Math.round(clearance) : 0;
}

/** Cards currently on screen; one per mounted composer (the split layout has two). */
const liveComposers = new Set<HTMLElement>();

/**
 * Republish `--composer-clearance` from every live card: the largest clearance
 * wins, so the stack clears the tallest and the rightmost alike.
 */
export function publishComposerClearance(): void {
  const root = document.documentElement;
  let clearance = 0;
  let measured = false;
  for (const element of liveComposers) {
    const rect = element.getBoundingClientRect();
    // A card with no height is not laid out (a display:none pane, a pre-layout
    // frame): nothing can be covered there, and its zero rect must not inflate
    // the value into "put the stack at the very top".
    if (rect.height <= 0) {
      continue;
    }
    clearance = Math.max(clearance, composerClearancePx(rect.top, window.innerHeight));
    measured = true;
  }
  if (!measured) {
    root.style.removeProperty(COMPOSER_CLEARANCE_VAR);
    return;
  }
  root.style.setProperty(COMPOSER_CLEARANCE_VAR, `${clearance}px`);
}

/**
 * Registers a composer card with the shared measurement and returns the
 * unregister function (which republishes without it). Exported as the seam the
 * hook uses, so the multi-card rule is testable without mounting React.
 */
export function trackComposer(element: HTMLElement): () => void {
  liveComposers.add(element);
  publishComposerClearance();
  return () => {
    liveComposers.delete(element);
    publishComposerClearance();
  };
}

/**
 * Publishes the card's clearance for as long as it is mounted. Attach the ref
 * to the composer CARD (the `.composer` element): its top edge is what the
 * stack must clear, and its size is what changes when the draft does.
 */
export function useComposerClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const untrack = trackComposer(element);
    // Size is the only thing that moves the card's TOP edge while the window
    // stays the same size (the column is bottom-anchored), so observing the
    // card itself covers a growing textarea, added pills and footer wrapping.
    // Its COLUMN is observed too: opening a docked panel below it shrinks the
    // column and moves the card up without resizing the card. The window
    // listener covers a viewport resize, which moves it as well.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publishComposerClearance) : null;
    observer?.observe(element);
    const column = element.parentElement;
    if (column !== null) {
      observer?.observe(column);
    }
    window.addEventListener("resize", publishComposerClearance);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publishComposerClearance);
      untrack();
    };
  }, [ref]);
}

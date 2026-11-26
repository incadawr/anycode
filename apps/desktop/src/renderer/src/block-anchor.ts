/** Leaf module (no React, no store): locating a transcript block's laid-out element by `data-block-id`. */

export function escapeSelector(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
}

/**
 * Minimal structural view of a block element — enough to measure it.
 * Structural (not `HTMLElement`) so the anchor helpers can be unit-tested
 * with plain stubs: the node test env has no DOM.
 */
export interface AnchorElementLike {
  getBoundingClientRect(): { top: number; bottom: number; width: number; height: number };
  getClientRects(): ArrayLike<unknown>;
  getAttribute(name: string): string | null;
}

/**
 * Is this element really laid out? A collapsed tool-call stack renders its
 * anchor with `display:none` — no boxes, an all-zero rect — so it must
 * never be used as a scroll anchor (it would pin the list to the wrong
 * place on restore).
 */
export function isLaidOut(el: AnchorElementLike): boolean {
  if (el.getClientRects().length === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * The laid-out element for a saved block id: the first match that actually
 * has boxes, or — when every match is hidden (a collapsed stack's
 * `display:none` anchor shares its id with the visible member card) — the
 * nearest laid-out block ancestor of it.
 */
export function findLaidOutAnchor(container: HTMLElement, id: string): HTMLElement | null {
  const matches = container.querySelectorAll<HTMLElement>(`[data-block-id="${escapeSelector(id)}"]`);
  for (const match of matches) {
    if (isLaidOut(match)) {
      return match;
    }
  }
  const first = matches[0];
  if (!first) {
    return null;
  }
  let node: HTMLElement | null = first.parentElement;
  while (node) {
    const candidate = node.closest<HTMLElement>("[data-block-id]");
    if (candidate && isLaidOut(candidate)) {
      return candidate;
    }
    node = candidate ? candidate.parentElement : null;
  }
  return null;
}

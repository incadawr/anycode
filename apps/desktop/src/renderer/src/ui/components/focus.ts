/** Works for fixed-position controls and environments without layout metrics. */
export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
    .filter(el => {
      if (el.matches(':disabled') || el.tabIndex < 0) return false;
      for (let ancestor: HTMLElement | null = el; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.hasAttribute("inert")) return false;
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    });
}

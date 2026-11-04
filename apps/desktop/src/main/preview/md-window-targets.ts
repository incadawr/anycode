/**
 * Registry binding each live detached Markdown popout's webContents to the
 * EXACT preview it was created for ({ tabId, previewId }). This is the
 * main-side half of the popout's narrowing: the IPC guard's channel
 * allow-list says WHICH channels the popout may call; these helpers say
 * WHICH preview each call may target, so a compromised popout renderer
 * cannot read or steer another tab's preview (and a stale popout — one whose
 * preview has since been transferred elsewhere — cannot act on it at all).
 *
 * Only the popout is ever registered here. An UNKNOWN sender (the main
 * window's renderer above all) is unrestricted by these helpers — the main
 * window drives every preview from its panel, exactly as before; a popout's
 * sender, on the other hand, must match its own registration. Registration
 * and removal both key on the captured webContents identity
 * (preview/md-window-adapter.ts), so the entry dies with the window.
 */

export interface MdWindowTarget {
  tabId: string;
  previewId: string;
}

const targets = new Map<unknown, MdWindowTarget>();

/** Registers the popout's webContents as the owner of exactly this preview. */
export function registerMdWindowTarget(webContents: unknown, target: MdWindowTarget): void {
  targets.set(webContents, { tabId: target.tabId, previewId: target.previewId });
}

/** Drops the popout's registration (its creator does this on close). */
export function unregisterMdWindowTarget(webContents: unknown): void {
  targets.delete(webContents);
}

/** The preview a popout's webContents was created for, or undefined for any other sender. */
export function mdWindowTargetOf(sender: unknown): MdWindowTarget | undefined {
  return targets.get(sender);
}

/**
 * md-doc policy: an unknown sender is unrestricted (the main window reads and
 * navigates every panel preview); a registered popout may only target its OWN
 * (tabId, previewId) pair.
 */
export function mdWindowMayUsePreview(sender: unknown, tabId: string, previewId: string): boolean {
  const target = targets.get(sender);
  if (target === undefined) return true;
  return target.tabId === tabId && target.previewId === previewId;
}

/**
 * panel/artifacts policy: an unknown sender is unrestricted; a registered
 * popout may only act on its OWN tab. `undefined` (a payload without a
 * usable tabId) never matches a popout — the caller's own validation turns
 * that into its usual safe negative.
 */
export function mdWindowMayUseTab(sender: unknown, tabId: string | undefined): boolean {
  const target = targets.get(sender);
  if (target === undefined) return true;
  return tabId === target.tabId;
}

/** Clears the registry so tests start from an empty baseline. */
export function resetMdWindowTargetsForTests(): void {
  targets.clear();
}

/**
 * Pure geometry + tab-set algebra for the right-side dock (Taskana 4703,
 * docs/development/dock.md). One tabbed column replaces the old stacked
 * fixed-width columns (git / preview / subagents), so the conversation keeps
 * a real floor and there is exactly ONE persisted width.
 *
 * Module law (App.test.ts header precedent): pure, no React, no DOM types
 * below the `readDockWidth` storage shim — `available` widths arrive as
 * numbers from the store/caller, never measured here. Unit-tested directly
 * in a node env (dock-layout.test.ts).
 */
import type { PreviewPanelInfo } from "../../../shared/preview-panel.js";

export const DOCK_WIDTH_STORAGE_KEY = "anycode.dock.width";
export const DOCK_WIDTH_DEFAULT = 640;
export const DOCK_WIDTH_MIN = 320;
export const DOCK_WIDTH_MAX = 960;
/** Taskana 4703 requirement: the conversation column keeps ~420px minimum. */
export const CONVERSATION_MIN_PX = 420;
export const DOCK_HANDLE_PX = 8;

/** Legacy preview-panel width (App.tsx's retired PREVIEW_WIDTH_* block) — read ONCE as the dock seed. */
const LEGACY_PREVIEW_WIDTH_KEY = "anycode.preview.width";

export type DockMode = "column" | "drawer";
export type DockTabKind = "preview" | "subagents" | "git";
export interface DockTab {
  id: string;
  kind: DockTabKind;
  title: string;
}

/**
 * Minimal storage seam so tests run jsdom-free (App.test.ts header
 * precedent: this package's vitest env has no DOM). The real binding in
 * dock-store.ts reads `window.localStorage`.
 */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseFinite(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The persisted dock width: `anycode.dock.width` clamped to
 * [DOCK_WIDTH_MIN, DOCK_WIDTH_MAX] with DOCK_WIDTH_DEFAULT fallback. When the
 * dock key is ABSENT, a legacy `anycode.preview.width` that parses in the
 * dock's own range seeds the value once (one-time migration — the old key is
 * left in storage, never read again after the first dock persist).
 */
export function readDockWidth(storage: DockStorage): number {
  const stored = parseFinite(storage.getItem(DOCK_WIDTH_STORAGE_KEY));
  if (stored !== null) {
    // In-range persisted value, clamped for safety (§4.1: 9999→960, 10→320).
    return Math.max(DOCK_WIDTH_MIN, Math.min(DOCK_WIDTH_MAX, stored));
  }
  // The dock key is absent/unparseable → one-time legacy seed: the retired
  // `anycode.preview.width`, accepted only when it parses INSIDE the dock's
  // own range (its old max was 1280, the dock's is 960 — a wider legacy
  // value would immediately violate the new cap, so it seeds nothing).
  const legacy = parseFinite(storage.getItem(LEGACY_PREVIEW_WIDTH_KEY));
  if (legacy !== null && legacy >= DOCK_WIDTH_MIN && legacy <= DOCK_WIDTH_MAX) {
    return legacy;
  }
  return DOCK_WIDTH_DEFAULT;
}

/**
 * Live clamp against the available session-content width: the dock may never
 * push the conversation below its floor, but never collapses under its own
 * min either (a too-narrow window flips to drawer mode instead —
 * `computeDockMode`).
 */
export function clampDockWidth(width: number, available: number): number {
  return Math.max(DOCK_WIDTH_MIN, Math.min(DOCK_WIDTH_MAX, Math.min(width, available - CONVERSATION_MIN_PX - DOCK_HANDLE_PX)));
}

/**
 * Drawer mode iff a minimum dock column no longer leaves the conversation
 * its floor: `available - DOCK_HANDLE_PX - DOCK_WIDTH_MIN <
 * CONVERSATION_MIN_PX` (below 748px available). In drawer mode the dock is
 * an absolute overlay and `.session-content` gets no grid columns at all.
 */
export function computeDockMode(available: number): DockMode {
  return available - DOCK_HANDLE_PX - DOCK_WIDTH_MIN < CONVERSATION_MIN_PX ? "drawer" : "column";
}

/**
 * Panel-container previews → dock tabs (`preview:<previewId>`), title from
 * the same fallback chain the old picker used (`title ?? sourcePath ?? url`).
 * Window-container previews have no tab (they live in their own window).
 */
export function derivePreviewTabs(previews: readonly PreviewPanelInfo[]): DockTab[] {
  return previews
    .filter((preview) => preview.container === "panel")
    .map((preview) => ({
      id: `preview:${preview.previewId}`,
      kind: "preview" as const,
      title: preview.title ?? preview.sourcePath ?? preview.url,
    }));
}

/**
 * Open-for-open semantics: a NEW tab is appended and focused; an
 * already-open tab is kept in place but STILL focused (the requirement's
 * "opening an already-open item focuses its tab").
 */
export function openTab(tabs: readonly DockTab[], tab: DockTab): { tabs: DockTab[]; activeTabId: string } {
  const existing = tabs.some((candidate) => candidate.id === tab.id);
  return {
    tabs: existing ? [...tabs] : [...tabs, tab],
    activeTabId: tab.id,
  };
}

/**
 * Close semantics: remove the tab; if the closed one was active, focus its
 * nearest RIGHT neighbor, else the nearest LEFT neighbor; an emptied strip
 * has no active tab. Closing an inactive tab never moves focus.
 */
export function closeTab(
  tabs: readonly DockTab[],
  activeTabId: string | null,
  id: string,
): { tabs: DockTab[]; activeTabId: string | null } {
  const index = tabs.findIndex((candidate) => candidate.id === id);
  if (index === -1) {
    return { tabs: [...tabs], activeTabId };
  }
  const next = tabs.filter((candidate) => candidate.id !== id);
  if (activeTabId !== id) {
    return { tabs: next, activeTabId };
  }
  // Nearest right neighbor, else nearest left neighbor (which is `index - 1`
  // in the ORIGINAL array — the tab that now sits at `index - 1` after
  // removal, or the last one when the closed tab was the rightmost).
  const neighbor = next[index] ?? next[index - 1] ?? null;
  return { tabs: next, activeTabId: neighbor ? neighbor.id : null };
}

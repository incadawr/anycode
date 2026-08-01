/**
 * Renderer-side mirror of main's preview-panel authority (working-docs/
 * panel-track/CUT.md §2.4): module-level zustand store (tabs-store.ts
 * precedent), fed exclusively by `previewPanel.onChanged` pushes +
 * `previewPanel.list` hydration reads — this store is a passive projection,
 * never a write path (every mutation — select/close — goes straight to main
 * via the preload invoke wrappers and comes back around through the SAME
 * `onChanged` push every renderer gets, including the caller's own).
 *
 * `applyChangedPayload` is the pure reducer core (exported for the unit
 * gate); `computePreviewPanelOpen` is the pure D12 gating predicate
 * ActiveTabBody uses to decide whether `<PreviewPanel>` mounts at all.
 */
import { create } from "zustand";
import type { PreviewChangedPayload, PreviewPanelInfo } from "../../../shared/preview-panel.js";

export interface PreviewTabState {
  previews: PreviewPanelInfo[];
  visiblePanelPreviewId: string | null;
}

export interface PreviewByTabState {
  byTab: Record<string, PreviewTabState>;
}

/**
 * Replace-tab semantics (CUT.md §3 96-P2 test list): a fresh payload for a
 * tab REPLACES that tab's whole previews array + visible-id (never merges
 * item-by-item — main's payload is always the tab's COMPLETE preview list);
 * an unknown tabId is simply added. Every other tab's entry is untouched.
 */
export function applyChangedPayload(state: PreviewByTabState, payload: PreviewChangedPayload): PreviewByTabState {
  return {
    byTab: {
      ...state.byTab,
      [payload.tabId]: {
        previews: payload.previews,
        visiblePanelPreviewId: payload.visiblePanelPreviewId,
      },
    },
  };
}

/** D12 gate: the panel region mounts iff the tab has >=1 panel-container preview. */
export function computePreviewPanelOpen(previews: readonly PreviewPanelInfo[]): boolean {
  return previews.some((preview) => preview.container === "panel");
}

export interface PreviewStoreState extends PreviewByTabState {
  /**
   * Visible panel width + handle, else 0 (D11) — App.tsx writes this from
   * its own panel-geometry state (previewWidth + the 8px resize-handle
   * column, git-panel precedent); NoticeStack reads it to offset the toast
   * stack so a transfer's own state-loss toast is never hidden under the view.
   */
  panelInsetPx: number;
  applyChanged(payload: PreviewChangedPayload): void;
  setPanelInsetPx(px: number): void;
}

/** Builds a preview-store instance; the factory exists so tests get an isolated store (tabs-store.ts precedent). */
export function createPreviewStore() {
  return create<PreviewStoreState>()((set) => ({
    byTab: {},
    panelInsetPx: 0,

    applyChanged(payload): void {
      set((state) => applyChangedPayload(state, payload));
    },

    setPanelInsetPx(px): void {
      set({ panelInsetPx: px });
    },
  }));
}

export type PreviewStoreApi = ReturnType<typeof createPreviewStore>;

export const usePreviewStore = createPreviewStore();

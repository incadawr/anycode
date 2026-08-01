/**
 * Preview-panel contract between main and renderer (working-docs/panel-track/
 * CUT.md §2.1, TASK.96 stages 2+3: right-side preview panel). Same value-only
 * shape as shared/window.ts / shared/tabs.ts: channel-name constants + wire
 * types only, ZERO runtime imports, so it is safe to import from preload
 * (sandboxed CJS), the renderer web bundle, AND main alike without dragging
 * any Electron runtime into a bundle that cannot afford it.
 *
 * Six channels total: SET_STATE (invoke, low-frequency panel-gating state,
 * D7), SET_BOUNDS (a deliberate ONE-WAY `ipcRenderer.send`, not invoke — D9's
 * rAF-coalesced high-frequency bounds updates need no reply), SELECT, CLOSE,
 * LIST (all invoke), SET_CONTAINER (invoke; the constant is exported here so
 * both P1 and P2 can reference it, but the handler itself lands in 96-P3 —
 * see CUT.md §2.2/§3), and CHANGED (main -> renderer push on every
 * record-set mutation). Unlike window.ts's zero-argument channels, several
 * of these carry renderer-supplied `tabId`/`previewId`/bounds — main
 * validates every payload with zod before it ever touches host state
 * (CUT.md §3, main/preview/panel-ipc.ts).
 */

// invoke (renderer→main), low-frequency: panel gating state (D7).
export const PREVIEW_PANEL_SET_STATE_CHANNEL = "anycode:preview-panel-set-state";
export interface PreviewPanelStatePayload {
  activeTabId: string | null; // renderer's active tab; null = no tab surface (start/welcome/empty)
  panelMounted: boolean; // the panel region is mounted in the DOM
  overlayOpen: boolean; // any overlay from D8's list is open
}

// one-way send (renderer→main), high-frequency, rAF-coalesced (D9): panel body rect in CSS px.
export const PREVIEW_PANEL_SET_BOUNDS_CHANNEL = "anycode:preview-panel-set-bounds";
export interface PreviewPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// invoke (renderer→main): make a PANEL-container preview the visible slot occupant (P1).
export const PREVIEW_PANEL_SELECT_CHANNEL = "anycode:preview-panel-select";
// payload: { tabId: string; previewId: string }  → { ok: boolean; error?: string }

// invoke (renderer→main): destroy one preview (panel header ×) (P1).
export const PREVIEW_CLOSE_CHANNEL = "anycode:preview-close";
// payload: { tabId: string; previewId: string }  → { ok: boolean; error?: string }

// invoke (renderer→main): hydration read (P1).
export const PREVIEW_LIST_CHANNEL = "anycode:preview-list";
// payload: { tabId: string }  → PreviewChangedPayload

// invoke (renderer→main): transfer container (P3 registers the handler; P1 exports the constant).
export const PREVIEW_SET_CONTAINER_CHANNEL = "anycode:preview-set-container";
export type PreviewContainerKind = "panel" | "window";
// payload: { tabId: string; previewId: string; container: PreviewContainerKind }
export type PreviewSetContainerResult =
  | { ok: true; reloaded: boolean } // reloaded=false for a same-container select no-op
  | { ok: false; error: string };

// push (main→renderer), per affected tab, on every record-set mutation (open-settle, status
// change, select, close, transfer, tab close):
export const PREVIEW_CHANGED_CHANNEL = "anycode:preview-changed";
export interface PreviewPanelInfo {
  previewId: string;
  tabId: string;
  url: string;
  title?: string;
  sourcePath?: string;
  status: "loading" | "ready" | "failed" | "crashed";
  container: PreviewContainerKind;
}
export interface PreviewChangedPayload {
  tabId: string;
  previews: PreviewPanelInfo[]; // ALL of the tab's previews, both containers
  visiblePanelPreviewId: string | null;
}

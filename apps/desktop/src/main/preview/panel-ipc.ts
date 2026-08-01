/**
 * Panel-side preview IPC (panel-track CUT.md §3 96-P1, item 4): the
 * renderer's low-frequency invoke channels (SET_STATE/SELECT/CLOSE/LIST)
 * plus the ONE high-frequency fire-and-forget channel, SET_BOUNDS (D9's
 * deliberate `ipcMain.on` deviation from the invoke convention — a
 * rAF-coalesced measure needs no reply). zod validates every
 * renderer-supplied payload before it ever reaches `PreviewHostHandle` (same
 * trust-boundary posture as tab-ipc.ts) — main never trusts a shape/range a
 * compromised renderer could have sent.
 *
 * `PREVIEW_SET_CONTAINER_CHANNEL`'s handler is deliberately NOT registered
 * here — the constant is exported from shared/preview-panel.ts for both P1
 * and P2 to reference, but the transfer implementation (and this module's
 * one additional `ipcMain.handle` call) lands in 96-P3 (CUT.md §0/§3).
 */
import { ipcMain } from "electron";
import { z } from "zod";
import {
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_LIST_CHANNEL,
  PREVIEW_PANEL_SELECT_CHANNEL,
  PREVIEW_PANEL_SET_BOUNDS_CHANNEL,
  PREVIEW_PANEL_SET_STATE_CHANNEL,
  type PreviewChangedPayload,
  type PreviewPanelBounds,
} from "../../shared/preview-panel.js";
import { clampPanelBounds, type PreviewHostHandle } from "./preview-host.js";

export interface PreviewPanelIpcDeps {
  host: PreviewHostHandle;
}

const setStateSchema = z.object({
  activeTabId: z.string().min(1).nullable(),
  panelMounted: z.boolean(),
  overlayOpen: z.boolean(),
});

/** Bounds carry finite numbers only — `clampPanelBounds` (preview-host.ts) does the actual round/clamp (D9), shared verbatim with the direct-call path so both are provably identical. */
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const tabPreviewSchema = z.object({
  tabId: z.string().min(1),
  previewId: z.string().min(1),
});

const listSchema = z.object({ tabId: z.string().min(1) });

function emptyChangedPayload(tabId: string): PreviewChangedPayload {
  return { tabId, previews: [], visiblePanelPreviewId: null };
}

/**
 * Registers the panel-gating/select/close/list handlers (CUT.md §3 96-P1
 * item 4). Matches the non-idempotent registration convention of
 * registerTabIpc/registerWindowIpc (called once at boot).
 */
export function registerPreviewPanelIpc(deps: PreviewPanelIpcDeps): void {
  ipcMain.handle(PREVIEW_PANEL_SET_STATE_CHANNEL, (_event, raw: unknown): void => {
    const parsed = setStateSchema.safeParse(raw);
    if (!parsed.success) {
      // A state publish main cannot understand is dropped — the renderer's
      // next (well-formed) publish self-corrects; there is nothing to reply.
      return;
    }
    deps.host.setPanelState(parsed.data);
  });

  // D9 deliberate deviation: one-way `ipcMain.on`, no reply — a malformed
  // payload is silently dropped, the next valid rAF measure self-corrects.
  ipcMain.on(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, (_event, raw: unknown) => {
    const parsed = boundsSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const bounds: PreviewPanelBounds = parsed.data;
    deps.host.setPanelBounds(clampPanelBounds(bounds));
  });

  ipcMain.handle(PREVIEW_PANEL_SELECT_CHANNEL, (_event, raw: unknown): { ok: boolean; error?: string } => {
    const parsed = tabPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid request" };
    }
    return deps.host.selectPanelPreview(parsed.data.tabId, parsed.data.previewId);
  });

  ipcMain.handle(PREVIEW_CLOSE_CHANNEL, (_event, raw: unknown): { ok: boolean; error?: string } => {
    const parsed = tabPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid request" };
    }
    return deps.host.closePreview(parsed.data.tabId, parsed.data.previewId);
  });

  ipcMain.handle(PREVIEW_LIST_CHANNEL, (_event, raw: unknown): PreviewChangedPayload => {
    const parsed = listSchema.safeParse(raw);
    if (!parsed.success) {
      return emptyChangedPayload("");
    }
    return deps.host.listForPanel(parsed.data.tabId);
  });
}

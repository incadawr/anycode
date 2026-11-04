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
 * `PREVIEW_SET_CONTAINER_CHANNEL`'s handler (96-P3, CUT.md §0/§3): the one
 * additional `ipcMain.handle` call this module's P1 header used to defer —
 * zod-validated the same way as SELECT/CLOSE (`tabId`/`previewId`, plus the
 * container-kind enum), forwarding verbatim to `PreviewHostHandle.setContainer`.
 */
import { guardedIpcHandle, guardedIpcOn } from "../ipc-guard.js";
import { z } from "zod";
import {
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_LIST_CHANNEL,
  PREVIEW_PANEL_SELECT_CHANNEL,
  PREVIEW_PANEL_SET_BOUNDS_CHANNEL,
  PREVIEW_PANEL_SET_STATE_CHANNEL,
  PREVIEW_SET_CONTAINER_CHANNEL,
  type PreviewChangedPayload,
  type PreviewPanelBounds,
  type PreviewSetContainerResult,
} from "../../shared/preview-panel.js";
import { mdWindowMayUsePreview, mdWindowMayUseTab } from "./md-window-targets.js";
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

const setContainerSchema = z.object({
  tabId: z.string().min(1),
  previewId: z.string().min(1),
  container: z.enum(["panel", "window"]),
});

function emptyChangedPayload(tabId: string): PreviewChangedPayload {
  return { tabId, previews: [], visiblePanelPreviewId: null };
}

/**
 * Registers the panel-gating/select/close/list handlers (CUT.md §3 96-P1
 * item 4). Matches the non-idempotent registration convention of
 * registerTabIpc/registerWindowIpc (called once at boot).
 */
export function registerPreviewPanelIpc(deps: PreviewPanelIpcDeps): void {
  guardedIpcHandle(PREVIEW_PANEL_SET_STATE_CHANNEL, (_event, raw: unknown): void => {
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
  guardedIpcOn(PREVIEW_PANEL_SET_BOUNDS_CHANNEL, (_event, raw: unknown) => {
    const parsed = boundsSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const bounds: PreviewPanelBounds = parsed.data;
    deps.host.setPanelBounds(clampPanelBounds(bounds));
  });

  guardedIpcHandle(PREVIEW_PANEL_SELECT_CHANNEL, (_event, raw: unknown): { ok: boolean; error?: string } => {
    const parsed = tabPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid request" };
    }
    return deps.host.selectPanelPreview(parsed.data.tabId, parsed.data.previewId);
  });

  guardedIpcHandle(PREVIEW_CLOSE_CHANNEL, (_event, raw: unknown): { ok: boolean; error?: string } => {
    const parsed = tabPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid request" };
    }
    return deps.host.closePreview(parsed.data.tabId, parsed.data.previewId);
  });

  guardedIpcHandle(PREVIEW_LIST_CHANNEL, (event, raw: unknown): PreviewChangedPayload => {
    const parsed = listSchema.safeParse(raw);
    if (!parsed.success) {
      return emptyChangedPayload("");
    }
    // The detached md popout may list only its OWN tab (it reads the list to
    // resolve its sourcePath) — a foreign tab lists as empty rather than
    // leaking another tab's preview roster (md-window-targets.ts).
    if (!mdWindowMayUseTab(event.sender, parsed.data.tabId)) {
      return emptyChangedPayload(parsed.data.tabId);
    }
    return deps.host.listForPanel(parsed.data.tabId);
  });

  // 96-P3: the transfer handler — P1/P2 only ever exported/exposed the
  // constant (CUT.md §0/§3); this is the module's one additional registration.
  guardedIpcHandle(PREVIEW_SET_CONTAINER_CHANNEL, (event, raw: unknown): Promise<PreviewSetContainerResult> => {
    const parsed = setContainerSchema.safeParse(raw);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, error: "invalid request" });
    }
    // The popout may transfer only ITSELF back to the panel; the main
    // window's panel is unrestricted (md-window-targets.ts).
    if (!mdWindowMayUsePreview(event.sender, parsed.data.tabId, parsed.data.previewId)) {
      return Promise.resolve({ ok: false, error: "invalid request" });
    }
    return deps.host.setContainer(parsed.data.tabId, parsed.data.previewId, parsed.data.container);
  });
}

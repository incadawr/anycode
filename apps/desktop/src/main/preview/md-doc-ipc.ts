/**
 * Native DOM markdown-preview IPC (CUT.md CONTRACTS — M1 READ, M2
 * NAVIGATE). Mirrors panel-ipc.ts's structure exactly (PREVIEW_SET_CONTAINER
 * convention: shared constant -> preload method -> zod -> `ipcMain.handle`):
 * zod validates the renderer-supplied payload before it ever reaches
 * `md-doc.ts`'s pure `readMdDoc`/`navigateMdDoc`, neither of which ever sees
 * an `unknown` — main never trusts a shape/range a compromised renderer
 * could have sent.
 */
import { guardedIpcHandle } from "../ipc-guard.js";
import { z } from "zod";
import { MD_PREVIEW_NAVIGATE_CHANNEL, MD_PREVIEW_READ_CHANNEL, type MdDocReadResult } from "../../shared/md-preview.js";
import { mdWindowMayUsePreview } from "./md-window-targets.js";
import { navigateMdDoc, readMdDoc, type MdDocDeps } from "./md-doc.js";

const readSchema = z.object({
  tabId: z.string().min(1),
  previewId: z.string().min(1),
});

const navigateSchema = z.object({
  tabId: z.string().min(1),
  previewId: z.string().min(1),
  href: z.string().min(1).max(4096),
});

/**
 * Registers the MD_PREVIEW_READ + MD_PREVIEW_NAVIGATE handlers (CUT.md
 * CONTRACTS). Matches the non-idempotent registration convention of
 * registerPreviewPanelIpc/registerTabIpc (called once at boot).
 */
export function registerMdDocIpc(deps: MdDocDeps): void {
  guardedIpcHandle(MD_PREVIEW_READ_CHANNEL, (event, raw: unknown): Promise<MdDocReadResult> => {
    const parsed = readSchema.safeParse(raw);
    if (!parsed.success) {
      // No `invalid` reason exists on this frozen result type (CUT.md
      // CONTRACTS) — a malformed payload is bucketed under "no_preview"
      // (there is no identifiable preview to read without a valid
      // tabId/previewId), same "bucket under the closest honest reason"
      // precedent as artifacts-ipc.ts's `handleArtifactAllow`.
      return Promise.resolve({ ok: false, reason: "no_preview" });
    }
    // The detached md popout may only read ITS OWN preview (md-window-targets.ts);
    // the main window's panel is unrestricted. Same refusal shape as above —
    // from the asking window's perspective there is no such preview.
    if (!mdWindowMayUsePreview(event.sender, parsed.data.tabId, parsed.data.previewId)) {
      return Promise.resolve({ ok: false, reason: "no_preview" });
    }
    return readMdDoc(deps, parsed.data.tabId, parsed.data.previewId);
  });

  guardedIpcHandle(MD_PREVIEW_NAVIGATE_CHANNEL, (event, raw: unknown): Promise<MdDocReadResult> => {
    const parsed = navigateSchema.safeParse(raw);
    if (!parsed.success) {
      // Same "bucket under the closest honest reason" precedent as READ
      // above — a malformed payload (missing/oversized href included) has
      // no identifiable preview/target to navigate.
      return Promise.resolve({ ok: false, reason: "no_preview" });
    }
    // Same own-preview binding as READ: a popout may not steer another
    // preview's document (its own navigate mutates the SAME previewId).
    if (!mdWindowMayUsePreview(event.sender, parsed.data.tabId, parsed.data.previewId)) {
      return Promise.resolve({ ok: false, reason: "no_preview" });
    }
    return navigateMdDoc(deps, parsed.data.tabId, parsed.data.previewId, parsed.data.href);
  });
}

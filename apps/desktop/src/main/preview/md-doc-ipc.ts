/**
 * Native DOM markdown-preview IPC (TASK.99 CUT.md CONTRACTS, M1: READ only).
 * Mirrors panel-ipc.ts's structure exactly (PREVIEW_SET_CONTAINER
 * convention: shared constant -> preload method -> zod -> `ipcMain.handle`):
 * zod validates the renderer-supplied payload before it ever reaches
 * `md-doc.ts`'s pure `readMdDoc`, which never sees an `unknown` — main never
 * trusts a shape/range a compromised renderer could have sent.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import { MD_PREVIEW_READ_CHANNEL, type MdDocReadResult } from "../../shared/md-preview.js";
import { readMdDoc, type MdDocDeps } from "./md-doc.js";

const readSchema = z.object({
  tabId: z.string().min(1),
  previewId: z.string().min(1),
});

/**
 * Registers the MD_PREVIEW_READ handler (CUT.md CONTRACTS, M1). Matches the
 * non-idempotent registration convention of registerPreviewPanelIpc/
 * registerTabIpc (called once at boot).
 */
export function registerMdDocIpc(deps: MdDocDeps): void {
  ipcMain.handle(MD_PREVIEW_READ_CHANNEL, (_event, raw: unknown): Promise<MdDocReadResult> => {
    const parsed = readSchema.safeParse(raw);
    if (!parsed.success) {
      // No `invalid` reason exists on this frozen result type (CUT.md
      // CONTRACTS) — a malformed payload is bucketed under "no_preview"
      // (there is no identifiable preview to read without a valid
      // tabId/previewId), same "bucket under the closest honest reason"
      // precedent as artifacts-ipc.ts's `handleArtifactAllow`.
      return Promise.resolve({ ok: false, reason: "no_preview" });
    }
    return readMdDoc(deps, parsed.data.tabId, parsed.data.previewId);
  });
}

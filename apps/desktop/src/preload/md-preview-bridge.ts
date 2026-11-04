/**
 * The detached Markdown popout's NARROW document bridge
 * (preview-ipc-risk F2 hardening). The popout loads the app's own renderer
 * bundle, but it is still the ONE non-main window with a preload bridge — so
 * it must not get the full app surface. main/md-window-adapter.ts stamps
 * `MD_PREVIEW_WINDOW_ARGV_FLAG` into this window's webPreferences
 * additionalArguments; the shared preload (index.ts) checks the flag and
 * calls `exposeMdPreviewBridge()` here INSTEAD of exposing the full
 * `window.anycode`. What this window gets — and all it needs to drive
 * MdPreviewWindowApp + MarkdownPreviewView + Markdown's artifact UI:
 *
 *   - `platform` (the pre-React chrome stamp in main.tsx; a constant, no IPC);
 *   - `mdPreview.read` / `mdPreview.navigate` (read/reload + local .md links);
 *   - `previewPanel.list` / `previewPanel.setContainer` (sourcePath lookup +
 *     the "Move to panel" transfer — close is plain `window.close()`, no IPC);
 *   - the `artifacts.*` family (doc-relative images, open/reveal, the
 *     click-to-open preview transfer, the previewable probe).
 *
 * NO settings/plugins/trust/secret/tab/proxy/window method exists here: the
 * renderer cannot even name those channels from this window. Main-side the
 * surface is narrowed twice more — the IPC guard allow-lists exactly these
 * channels for this window, and md-window-targets.ts binds each call to the
 * concrete (tabId, previewId) the window was created for.
 *
 * Outside the app's own renderer URL the bridge is absent entirely: index.ts
 * only reaches this expose behind the same `isRendererUrl` gate as the full
 * bridge, so a document that navigates away (refused main-side, but even if
 * one ever landed) has no `window.anycode` at all.
 *
 * Channel literals + result shapes below follow the SAME "duplicated on
 * purpose" convention as index.ts: main/artifacts-ipc.ts holds the
 * byte-identical source of truth for the artifact channels; shared/** holds
 * the md/preview-panel ones (imported directly — they are value-only files
 * a sandboxed CJS bundle can afford).
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  MD_PREVIEW_NAVIGATE_CHANNEL,
  MD_PREVIEW_READ_CHANNEL,
  type MdDocReadResult,
} from "../shared/md-preview.js";
import {
  PREVIEW_LIST_CHANNEL,
  PREVIEW_SET_CONTAINER_CHANNEL,
  type PreviewChangedPayload,
  type PreviewContainerKind,
  type PreviewSetContainerResult,
} from "../shared/preview-panel.js";
import type { PreviewOpenSuccess, PreviewResult } from "../shared/preview.js";
import type { DesktopPlatform } from "../shared/window.js";
// Result shapes reused from the full preload's own duplicates of
// main/artifacts-ipc.ts's wire types (type-only import — erased before the
// CJS bundle is emitted, so nothing from index.ts's runtime side is pulled in).
import type { ArtifactActionResult, ArtifactAllowResult, ArtifactPreviewableResult, ArtifactReadImageResult } from "./index.js";

// main/artifacts-ipc.ts holds the byte-identical source of truth — same
// duplicated-literal convention as every channel in index.ts (the main
// module itself must never be imported into a sandboxed preload bundle).
const ARTIFACT_READ_IMAGE_CHANNEL = "anycode:artifact-read-image";
const ARTIFACT_OPEN_CHANNEL = "anycode:artifact-open";
const ARTIFACT_REVEAL_CHANNEL = "anycode:artifact-reveal";
/** per-tab, per-path consent grant for a previously-blocked path. */
const ARTIFACT_ALLOW_CHANNEL = "anycode:artifact-allow";
/** user click on a local .html/.htm/.md artifact link opens/reopens it in PreviewHost. */
const ARTIFACT_PREVIEW_CHANNEL = "anycode:artifact-preview";
/** batched existence/containment probe for path candidates. */
const ARTIFACT_PREVIEWABLE_CHANNEL = "anycode:artifact-previewable";

/** The narrow `window.anycode` the detached md popout gets — see the module doc for the boundary. */
export function exposeMdPreviewBridge(): void {
  contextBridge.exposeInMainWorld("anycode", {
    platform: (["darwin", "win32", "linux"].includes(process.platform)
      ? process.platform
      : "linux") as DesktopPlatform,
    mdPreview: {
      read: (tabId: string, previewId: string): Promise<MdDocReadResult> =>
        ipcRenderer.invoke(MD_PREVIEW_READ_CHANNEL, { tabId, previewId }) as Promise<MdDocReadResult>,
      navigate: (tabId: string, previewId: string, href: string): Promise<MdDocReadResult> =>
        ipcRenderer.invoke(MD_PREVIEW_NAVIGATE_CHANNEL, { tabId, previewId, href }) as Promise<MdDocReadResult>,
    },
    previewPanel: {
      list: (tabId: string): Promise<PreviewChangedPayload> =>
        ipcRenderer.invoke(PREVIEW_LIST_CHANNEL, { tabId }) as Promise<PreviewChangedPayload>,
      setContainer: (
        tabId: string,
        previewId: string,
        container: PreviewContainerKind,
      ): Promise<PreviewSetContainerResult> =>
        ipcRenderer.invoke(PREVIEW_SET_CONTAINER_CHANNEL, { tabId, previewId, container }) as Promise<PreviewSetContainerResult>,
    },
    artifacts: {
      readImage: (tabId: string, path: string): Promise<ArtifactReadImageResult> =>
        ipcRenderer.invoke(ARTIFACT_READ_IMAGE_CHANNEL, { tabId, path }) as Promise<ArtifactReadImageResult>,
      open: (tabId: string, path: string): Promise<ArtifactActionResult> =>
        ipcRenderer.invoke(ARTIFACT_OPEN_CHANNEL, { tabId, path }) as Promise<ArtifactActionResult>,
      reveal: (tabId: string, path: string): Promise<ArtifactActionResult> =>
        ipcRenderer.invoke(ARTIFACT_REVEAL_CHANNEL, { tabId, path }) as Promise<ArtifactActionResult>,
      allow: (tabId: string, path: string): Promise<ArtifactAllowResult> =>
        ipcRenderer.invoke(ARTIFACT_ALLOW_CHANNEL, { tabId, path }) as Promise<ArtifactAllowResult>,
      preview: (tabId: string, path: string): Promise<PreviewResult<PreviewOpenSuccess>> =>
        ipcRenderer.invoke(ARTIFACT_PREVIEW_CHANNEL, { tabId, path }) as Promise<PreviewResult<PreviewOpenSuccess>>,
      previewable: (tabId: string, paths: string[]): Promise<ArtifactPreviewableResult> =>
        ipcRenderer.invoke(ARTIFACT_PREVIEWABLE_CHANNEL, { tabId, paths }) as Promise<ArtifactPreviewableResult>,
    },
  });
}

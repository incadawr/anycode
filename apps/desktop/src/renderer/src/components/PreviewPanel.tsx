/**
 * Preview panel region (working-docs/panel-track/CUT.md §2.4/D12):
 * self-connecting like GitPanel.tsx/LspPanel.tsx (own tabId off TabContext),
 * mounted in ActiveTabBody ONLY while the active tab has >=1 panel-container
 * preview (App.tsx's `computePreviewPanelOpen` gate, D12) — never before, and
 * never for a background tab. Slim REAL React header (title, a preview
 * picker when there is more than one, close x) sits above the measured body
 * div the main-side WebContentsView is positioned over (D9's rAF-coalesced
 * bounds publisher lives here, fed through panel-bridge.ts's
 * `reportPanelBounds`); the body shows a neutral placeholder while the view
 * itself is actually hidden (any overlay open, D6) or before any preview has
 * settled. "Open in window" (96-P3, D14) calls `previewPanel.setContainer`
 * and, on `{ok:true, reloaded:true}`, raises the state-loss toast through
 * the caller-supplied `onToast` — App.tsx's existing onToast/toasts.ts
 * pipeline, threaded down the same way `ActiveTabBody` already threads it
 * to `TabNoticeCapture`.
 *
 * Owner smoke-test fix (two-header defect): the header row above is drawn
 * here ONLY for a web (WebContentsView-backed) visible preview, exactly as
 * before. A `dom-md` visible preview instead folds its title text and the
 * preview-picker `<select>` DOWN into `MarkdownPreviewView`'s own single
 * unified header (title/picker/`Rendered | Source`/Reload/Reveal/transfer/
 * close, all in one row) — this component keeps owning `selectPreview`/
 * `panelPreviews` (the picker is built here, just rendered there) and the
 * `closePreview`/`openInWindow` handlers, only the JSX for the row itself
 * moves. See MarkdownPreviewView.tsx's own doc comment for the full seam.
 */
import { useContext, useEffect, useRef } from "react";
import { TabContext } from "../tab-context.js";
import { reportPanelBounds } from "../preview/panel-bridge.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { useOverlayOpenSnapshot } from "../preview/overlay-flag.js";
import { PREVIEW_TRANSFERRED_TEXT, type ToastKind } from "../toasts.js";
import { X } from "./icons.js";
// TASK.99 M1: the native DOM markdown preview view — rendered inside this
// panel's body slot when the visible preview's viewKind is "dom-md" (CUT.md
// CONTRACTS); bounds publisher below stays untouched, main just never
// positions a WebContentsView for that record.
import { MarkdownPreviewView } from "./MarkdownPreviewView.js";

const EMPTY_PREVIEWS: never[] = [];

export interface PreviewPanelProps {
  /** P3 D14: raises the transfer state-loss toast (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

export function PreviewPanel({ onToast }: PreviewPanelProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("PreviewPanel must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;

  const previews = usePreviewStore((state) => state.byTab[tabId]?.previews ?? EMPTY_PREVIEWS);
  const visiblePanelPreviewId = usePreviewStore((state) => state.byTab[tabId]?.visiblePanelPreviewId ?? null);
  const overlayOpen = useOverlayOpenSnapshot();
  const bodyRef = useRef<HTMLDivElement>(null);

  const panelPreviews = previews.filter((preview) => preview.container === "panel");
  const visible = panelPreviews.find((preview) => preview.previewId === visiblePanelPreviewId) ?? panelPreviews[0] ?? null;

  // D9 bounds publisher: measures the BODY div (CSS px == DIP) on every
  // trigger — a body resize (drag/terminal open-close), a conversation-column
  // resize (git panel toggle/resize, sidebar collapse, window resize — the
  // conversation column absorbs every intra-grid x-shift), and a raw window
  // resize as belt. Each trigger only ever schedules the SAME rAF-coalesced
  // report (panel-bridge.ts owns the coalescing/dedup).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }

    function measure(): void {
      const rect = body!.getBoundingClientRect();
      reportPanelBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }

    measure();
    const bodyObserver = new ResizeObserver(measure);
    bodyObserver.observe(body);

    const conversation = document.querySelector(".session-conversation");
    const conversationObserver = conversation ? new ResizeObserver(measure) : null;
    if (conversation && conversationObserver) {
      conversationObserver.observe(conversation);
    }

    window.addEventListener("resize", measure);
    return () => {
      bodyObserver.disconnect();
      conversationObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  function selectPreview(previewId: string): void {
    window.anycode.previewPanel.select(tabId, previewId).catch((error: unknown) => {
      console.warn("[PreviewPanel] select failed", error);
    });
  }

  function closePreview(previewId: string): void {
    window.anycode.previewPanel.close(tabId, previewId).catch((error: unknown) => {
      console.warn("[PreviewPanel] close failed", error);
    });
  }

  // D14 (96-P3): transfer the visible panel preview out into a window.
  // `reloaded:false` (a same-container no-op) never reaches here because the
  // button only ever requests "window" from an already-panel preview.
  function openInWindow(previewId: string): void {
    window.anycode.previewPanel
      .setContainer(tabId, previewId, "window")
      .then((result) => {
        if (!result.ok) {
          // M1 interim (TASK.99 CUT.md Gap 3): a dom-md preview's "Open in
          // window" honestly refuses until M3 wires the second renderer
          // window — surfaced here (not just console) so the refusal is not
          // silent to the user.
          console.warn("[PreviewPanel] setContainer failed", result.error);
          onToast("shell_error", result.error);
          return;
        }
        if (result.reloaded) {
          onToast("preview_transferred", PREVIEW_TRANSFERRED_TEXT);
        }
      })
      .catch((error: unknown) => {
        console.warn("[PreviewPanel] setContainer failed", error);
      });
  }

  const isMdPreview = visible?.viewKind === "dom-md";
  const title = visible?.title ?? visible?.sourcePath ?? visible?.url ?? "Preview";
  // Owner smoke-test fix: built once, handed to MarkdownPreviewView's own
  // header for a dom-md visible preview (below) instead of this component's
  // now dom-md-skipped `.preview-panel-header` — `selectPreview`/
  // `panelPreviews` stay owned here either way.
  const picker =
    panelPreviews.length > 1 ? (
      <select
        className="preview-panel-picker"
        aria-label="Select preview"
        value={visible?.previewId ?? ""}
        onChange={(event) => selectPreview(event.target.value)}
      >
        {panelPreviews.map((preview) => (
          <option key={preview.previewId} value={preview.previewId}>
            {preview.title ?? preview.sourcePath ?? preview.url}
          </option>
        ))}
      </select>
    ) : undefined;

  return (
    <div className="preview-panel">
      {/* Owner smoke-test fix (two-header defect): a dom-md visible preview
          gets its title/picker/close/transfer folded into
          MarkdownPreviewView's own unified header below instead — web
          previews keep exactly this header, unchanged. */}
      {!isMdPreview && (
        <div className="preview-panel-header">
          <span className="preview-panel-title">{title}</span>
          {picker}
          {visible && (
            <button
              type="button"
              className="preview-panel-open-window"
              aria-label="Open in window"
              title="Open this preview in a separate window"
              onClick={() => openInWindow(visible.previewId)}
            >
              Open in window
            </button>
          )}
          {visible && (
            <button
              type="button"
              className="preview-panel-close"
              aria-label="Close preview"
              onClick={() => closePreview(visible.previewId)}
            >
              <X />
            </button>
          )}
        </div>
      )}
      <div ref={bodyRef} className="preview-panel-body">
        {overlayOpen ? (
          <div className="preview-panel-empty">Preview hidden</div>
        ) : !visible ? (
          <div className="preview-panel-empty">No preview open.</div>
        ) : visible.viewKind === "dom-md" ? (
          <MarkdownPreviewView
            tabId={tabId}
            previewId={visible.previewId}
            container={visible.container}
            sourcePath={visible.sourcePath ?? ""}
            docVersion={visible.docVersion ?? 0}
            onClose={() => closePreview(visible.previewId)}
            onTransfer={() => openInWindow(visible.previewId)}
            title={title}
            picker={picker}
          />
        ) : null}
      </div>
    </div>
  );
}

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
 * settled. "Open in window" lands in 96-P3 — this header does NOT call
 * `setContainer` (P2 rule: the main handler for it doesn't exist yet).
 */
import { useContext, useEffect, useRef } from "react";
import { TabContext } from "../tab-context.js";
import { reportPanelBounds } from "../preview/panel-bridge.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { useOverlayOpenSnapshot } from "../preview/overlay-flag.js";
import { X } from "./icons.js";

const EMPTY_PREVIEWS: never[] = [];

export function PreviewPanel() {
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

  return (
    <div className="preview-panel">
      <div className="preview-panel-header">
        <span className="preview-panel-title">{visible?.title ?? visible?.sourcePath ?? visible?.url ?? "Preview"}</span>
        {panelPreviews.length > 1 && (
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
      <div ref={bodyRef} className="preview-panel-body">
        {overlayOpen ? (
          <div className="preview-panel-empty">Preview hidden</div>
        ) : !visible ? (
          <div className="preview-panel-empty">No preview open.</div>
        ) : null}
      </div>
    </div>
  );
}

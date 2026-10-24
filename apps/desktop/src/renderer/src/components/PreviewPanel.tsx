/**
 * ONE preview's body region inside the dock (Taskana 4703, was the panel-
 * track CUT.md §2.4/D12 single visible-slot column): the dock tab strip is
 * the picker now, so this component renders exactly the preview its
 * `previewId` prop names — resolved from `usePreviewStore`, no visible-slot
 * fallback, no `<select>`. Everything the main-side contract needs is kept
 * byte-identical: the D9 rAF-coalesced bounds publisher over
 * `.preview-panel-body`, `MarkdownPreviewView`'s unified header (TASK.99
 * owner smoke-test fix), the web header's "Open in window" (D14) and close,
 * and the `onToast` threading. A preview that vanishes from the store
 * renders the neutral empty state — the App.tsx tab-derivation effect is
 * what actually closes the tab.
 */
import { useContext, useEffect, useRef } from "react";
import { TabContext } from "../tab-context.js";
import { reportPanelBounds } from "../preview/panel-bridge.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { useOverlayOpenSnapshot } from "../preview/overlay-flag.js";
import { PREVIEW_TRANSFERRED_TEXT, type ToastKind } from "../toasts.js";
import { X } from "./icons.js";
// TASK.99 M1: the native DOM markdown preview view — rendered inside this
// panel's body slot when the preview's viewKind is "dom-md" (CUT.md
// CONTRACTS); bounds publisher below stays untouched, main just never
// positions a WebContentsView for that record.
import { MarkdownPreviewView } from "./MarkdownPreviewView.js";

const EMPTY_PREVIEWS: never[] = [];

export interface PreviewPanelProps {
  /** The dock tab's id (`preview:<previewId>`) — carried for context/debug, the store lookup uses previewId. */
  tabId: string;
  /** The one preview this dock tab renders (the tab strip is the picker). */
  previewId: string;
  /** P3 D14: raises the transfer state-loss toast (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

export function PreviewPanel({ tabId: _dockTabId, previewId, onToast }: PreviewPanelProps) {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("PreviewPanel must be used within a <TabContext.Provider>");
  }
  const { tabId } = ctx;

  const previews = usePreviewStore((state) => state.byTab[tabId]?.previews ?? EMPTY_PREVIEWS);
  const overlayOpen = useOverlayOpenSnapshot();
  const bodyRef = useRef<HTMLDivElement>(null);

  // The named preview only — the dock tab strip owns WHICH preview shows.
  const visible = previews.find((preview) => preview.previewId === previewId) ?? null;

  // D9 bounds publisher: measures the BODY div (CSS px == DIP) on every
  // trigger — a body resize (drag/terminal open-close), a conversation-column
  // resize (dock toggle/resize, sidebar collapse, window resize — the
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

  function closePreview(target: string): void {
    window.anycode.previewPanel.close(tabId, target).catch((error: unknown) => {
      console.warn("[PreviewPanel] close failed", error);
    });
  }

  // D14 (96-P3): transfer this panel preview out into a window.
  // `reloaded:false` (a same-container no-op) never reaches here because the
  // button only ever requests "window" from an already-panel preview.
  function openInWindow(target: string): void {
    window.anycode.previewPanel
      .setContainer(tabId, target, "window")
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

  return (
    <div className="preview-panel">
      {/* Owner smoke-test fix (two-header defect): a dom-md preview gets its
          title/close/transfer folded into MarkdownPreviewView's own unified
          header below instead — web previews keep exactly this header. */}
      {!isMdPreview && (
        <div className="preview-panel-header">
          <span className="preview-panel-title">{title}</span>
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
          />
        ) : null}
      </div>
    </div>
  );
}

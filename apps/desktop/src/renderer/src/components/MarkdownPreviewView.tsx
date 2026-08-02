/**
 * Native DOM markdown preview view (TASK.99 CUT.md CONTRACTS, M1) — a THIN,
 * logic-free shell: every stateful decision (phase/mode transitions, failure
 * copy) lives in the pure `md-view-state.ts` reducer (RISK REGISTER §5 —
 * vitest collects only `*.test.ts`, node env, no jsdom, so this component
 * itself is untested and MUST stay simple enough not to need it). Reuses the
 * chat `Markdown` component byte-identically (plain chat behavior for
 * now — `MdDocContext` doc-relative image/link parameterization is M2;
 * relative images 404ing here in M1 is expected, not a bug).
 *
 * Rendered inside PreviewPanel.tsx's `preview-panel-body` slot when the
 * visible preview has `viewKind === "dom-md"` — the panel's own outer header
 * (title/picker/close) stays untouched; this component owns its OWN header
 * for markdown-specific actions (Rendered/Source, Reload, Reveal, Open in
 * window) that the generic panel chrome has no room for.
 */
import { useEffect, useReducer } from "react";
import { Markdown } from "./Markdown.js";
import { X } from "./icons.js";
import { eventForReadResult, initialMdViewState, mdViewReducer } from "../preview/md-view-state.js";

export interface MarkdownPreviewViewProps {
  tabId: string;
  previewId: string;
  container: "panel" | "window";
  sourcePath: string;
  /** M1: bumps only in M2 (navigate) — included now so the effect's refetch key is already wired for it. */
  docVersion: number;
  onClose(): void;
  /** "Open in window" — the PARENT owns the actual `previewPanel.setContainer` call and any resulting toast (mirrors the existing web-preview "Open in window" button). */
  onTransfer(): void;
}

export function MarkdownPreviewView({ tabId, previewId, container, sourcePath, docVersion, onClose, onTransfer }: MarkdownPreviewViewProps) {
  const [state, dispatch] = useReducer(mdViewReducer, initialMdViewState);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "RELOAD" });
    window.anycode.mdPreview
      .read(tabId, previewId)
      .then((result) => {
        if (!cancelled) {
          dispatch(eventForReadResult(result));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({ type: "FETCH_FAIL", error: `Failed to read the file: ${String(error)}` });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tabId, previewId, docVersion]);

  function reload(): void {
    dispatch({ type: "RELOAD" });
    window.anycode.mdPreview
      .read(tabId, previewId)
      .then((result) => dispatch(eventForReadResult(result)))
      .catch((error: unknown) => {
        dispatch({ type: "FETCH_FAIL", error: `Failed to read the file: ${String(error)}` });
      });
  }

  function reveal(): void {
    window.anycode.artifacts.reveal(tabId, sourcePath).catch((error: unknown) => {
      console.warn("[MarkdownPreviewView] reveal failed", error);
    });
  }

  return (
    <div className="md-preview-view">
      <div className="md-preview-view-header">
        <div className="md-preview-view-mode-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={state.mode === "rendered" ? "md-preview-mode-btn active" : "md-preview-mode-btn"}
            aria-pressed={state.mode === "rendered"}
            onClick={() => dispatch({ type: "TOGGLE" })}
          >
            Rendered
          </button>
          <button
            type="button"
            className={state.mode === "source" ? "md-preview-mode-btn active" : "md-preview-mode-btn"}
            aria-pressed={state.mode === "source"}
            onClick={() => dispatch({ type: "TOGGLE" })}
          >
            Source
          </button>
        </div>
        <button type="button" className="md-preview-action-btn" onClick={reload}>
          Reload
        </button>
        <button type="button" className="md-preview-action-btn" onClick={reveal}>
          Reveal in folder
        </button>
        {container === "panel" && (
          <button type="button" className="md-preview-action-btn" onClick={onTransfer}>
            Open in window
          </button>
        )}
        <button type="button" className="md-preview-view-close" aria-label="Close preview" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="md-preview-view-body">
        {state.doc === null ? (
          <div className={state.phase === "error" ? "md-preview-view-empty md-preview-view-error" : "md-preview-view-empty"}>
            {state.phase === "error" ? (state.error ?? "Failed to load.") : "Loading…"}
          </div>
        ) : (
          <>
            {state.phase === "error" && state.error !== null && (
              <div className="md-preview-view-error-banner">{state.error}</div>
            )}
            {state.mode === "rendered" ? (
              <div className="md-preview-view-rendered">
                <Markdown text={state.doc.sourceText} />
              </div>
            ) : (
              <pre className="md-preview-view-source">{state.doc.sourceText}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

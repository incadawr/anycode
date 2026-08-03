/**
 * Native DOM markdown preview view (TASK.99 CUT.md CONTRACTS — M1 shipped
 * READ/panel chrome, M2 adds md->md link navigation + doc-relative images,
 * M3 adds the window container) — a THIN, logic-free shell: every stateful
 * decision (phase/mode transitions, failure copy, docVersion reconciliation)
 * lives in the pure `md-view-state.ts` reducer/helpers (RISK REGISTER §5 —
 * vitest collects only `*.test.ts`, node env, no jsdom, so this component
 * itself is untested and MUST stay simple enough not to need it). Reuses the
 * chat `Markdown` component without a fork: `MdDocContext` is provided ONLY
 * around the rendered doc below, docDir-scoped to the CURRENT doc — chat call
 * sites (ToolCallCard.tsx, PermissionModal.tsx, MessageList.tsx) never see
 * it, so their rendering stays byte-identical (risk register #6).
 *
 * ONE implementation, container-independent (CUT.md GAP 1's stated UX
 * constraint): rendered inside PreviewPanel.tsx's `preview-panel-body` slot
 * when the visible panel preview has `viewKind === "dom-md"`, AND as the
 * whole content of the md-preview WINDOW (MdPreviewWindowApp.tsx, M3) — this
 * component owns its OWN header for markdown-specific actions (Rendered/
 * Source, Reload, Reveal, Open in window / Move to panel) that the panel's
 * generic outer chrome (title/picker/close) has no room for, and the window
 * has none of at all.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { Markdown, MdDocContext } from "./Markdown.js";
import { X } from "./icons.js";
import {
  eventForNavigateResult,
  eventForReadResult,
  initialMdViewState,
  mdViewReducer,
  shouldRefetchOnDocVersionChange,
} from "../preview/md-view-state.js";

export interface MarkdownPreviewViewProps {
  tabId: string;
  previewId: string;
  container: "panel" | "window";
  sourcePath: string;
  /** M1: the READ refetch key. M2: also bumps on a `commitMdNavigate` push — reconciled against the LOCAL doc's own `docVersion` below (see the effect's doc comment) so our own just-applied NAVIGATE_OK is never redundantly re-fetched. */
  docVersion: number;
  onClose(): void;
  /** "Open in window" — the PARENT owns the actual `previewPanel.setContainer` call and any resulting toast (mirrors the existing web-preview "Open in window" button). */
  onTransfer(): void;
}

export function MarkdownPreviewView({ tabId, previewId, container, sourcePath, docVersion, onClose, onTransfer }: MarkdownPreviewViewProps) {
  const [state, dispatch] = useReducer(mdViewReducer, initialMdViewState);

  useEffect(() => {
    // TASK.99 M2: a NAVIGATE_OK (dispatched directly from `onOpenMdLink`
    // below, outside this effect) already updated `state.doc` with the
    // fresh doc BEFORE main's `pushChanged` republishes the SAME bumped
    // `docVersion` through this prop moments later — re-running the fetch
    // for our OWN just-applied change would be a redundant round trip, not
    // a correctness fix. Skip it; still fetch on mount (`state.doc === null`)
    // and on any genuinely external advance (`shouldRefetchOnDocVersionChange`
    // — see md-view-state.ts).
    if (state.doc !== null && !shouldRefetchOnDocVersionChange(state.doc.docVersion, docVersion)) {
      return;
    }
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

  // TASK.99 M2: a local `.md` link click inside the rendered doc REPLACES
  // this preview's content via MD_PREVIEW_NAVIGATE (CUT.md CONTRACTS —
  // "replace semantics, no history stack", the SAME `previewId`). A refusal
  // surfaces on the SAME inline error banner a failed read/reload already
  // uses — no separate toast was introduced for this path (consistent with
  // the M1 read/reload refusal surface).
  const onOpenMdLink = useCallback(
    (href: string): void => {
      window.anycode.mdPreview
        .navigate(tabId, previewId, href)
        .then((result) => dispatch(eventForNavigateResult(result)))
        .catch((error: unknown) => {
          dispatch({ type: "FETCH_FAIL", error: `Failed to open the link: ${String(error)}` });
        });
    },
    [tabId, previewId],
  );

  // Memoized so `Markdown`'s own `React.memo` (keyed on `text`) is not
  // defeated by a fresh context-value object on every unrelated re-render
  // (Reload spinner, mode toggle, etc.) - React re-renders context consumers
  // on ANY new Provider value even when an ancestor bails out via memo.
  const mdDocContextValue = useMemo(
    () => (state.doc !== null ? { docDir: state.doc.docDir, onOpenMdLink } : null),
    [state.doc?.docDir, onOpenMdLink],
  );

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
        {container === "panel" ? (
          <button type="button" className="md-preview-action-btn" onClick={onTransfer}>
            Open in window
          </button>
        ) : (
          // TASK.99 M3 (CUT.md CONTRACTS): the window-container mirror of
          // "Open in window" above — same `onTransfer` prop, the PARENT
          // (MdPreviewWindowApp) owns the actual `previewPanel.setContainer`
          // call, target "panel" this time.
          <button type="button" className="md-preview-action-btn" onClick={onTransfer}>
            Move to panel
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
                <MdDocContext.Provider value={mdDocContextValue}>
                  <Markdown text={state.doc.sourceText} />
                </MdDocContext.Provider>
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

/**
 * Native DOM markdown preview view (TASK.99 CUT.md CONTRACTS — M1 shipped
 * READ/panel chrome, M2 adds md->md link navigation + doc-relative images,
 * M3 adds the window container) — a THIN, logic-free shell: every stateful
 * decision (phase/mode transitions, failure copy, docVersion reconciliation,
 * the container-dependent transfer control) lives in the pure
 * `md-view-state.ts` reducer/helpers (RISK REGISTER §5 — vitest collects
 * only `*.test.ts`, node env, no jsdom, so this component itself is untested
 * and MUST stay simple enough not to need it). Reuses the chat `Markdown`
 * component without a fork: `MdDocContext` is provided ONLY around the
 * rendered doc below, docDir-scoped to the CURRENT doc — chat call sites
 * (ToolCallCard.tsx, PermissionModal.tsx, MessageList.tsx) never see it, so
 * their rendering stays byte-identical (risk register #6).
 *
 * ONE implementation, container-independent (CUT.md GAP 1's stated UX
 * constraint): rendered inside PreviewPanel.tsx's `preview-panel-body` slot
 * when the visible panel preview has `viewKind === "dom-md"`, AND as the
 * whole content of the md-preview WINDOW (MdPreviewWindowApp.tsx, M3).
 *
 * Owner smoke-test fix (two-header defect): this component now owns the
 * ONE AND ONLY header row for BOTH containers — PreviewPanel.tsx no longer
 * renders its own `.preview-panel-header` for a `dom-md` visible preview
 * (it still does for a web preview, unchanged). The panel folds its title
 * text and preview-picker `<select>` (still built/owned by PreviewPanel —
 * `selectPreview`/`panelPreviews` never move here) down through the
 * optional `title`/`picker` props below; the window computes its own
 * `title` from `sourcePath` (`mdWindowTitle`, md-view-state.ts) and has no
 * picker (a window is always exactly one preview). Every action — Reload,
 * Reveal in folder, the transfer action, Close — renders as an icon button
 * (`title`+`aria-label` carry the same wording the old text buttons used, so
 * nothing becomes undiscoverable); `automation.ts` was grepped for all four
 * labels and the transfer copy and has no probe keyed on any of them, so
 * none needed updating.
 *
 * Owner smoke-test follow-up (mode toggle -> icons): the `Rendered | Source`
 * pair was the last piece of button TEXT left in this row — it is now an
 * icon pair too (`FileIcon`/`Code`), still rendered as one segmented
 * `role="group"` control (`.md-preview-view-mode-toggle`) with the active
 * half carrying `.active` + `aria-pressed`, exactly as the text version did;
 * only the button CONTENT changed, not the "two modes, one grouped control"
 * structure. `title`/`aria-label` on each half carry the word its icon
 * replaces (`mdViewModeLabel`, md-view-state.ts) so the meaning stays
 * reachable on hover and to assistive tech. `automation.ts` has no probe
 * keyed on the "Rendered"/"Source" button text or on
 * `.md-preview-mode-btn`/`.md-preview-view-mode-toggle` (grepped), so
 * nothing there needed updating either.
 *
 * Owner smoke-test fix: the Rendered branch below runs the doc's source text
 * through `stripLeadingFrontmatter` (md-view-state.ts) before handing it to
 * `Markdown` — a leading YAML frontmatter block (Marp/Jekyll `---`...`---`)
 * has no CommonMark meaning and would otherwise render as literal paragraph
 * text. Source mode intentionally does NOT strip it — it shows
 * `state.doc.sourceText` completely raw, unedited file content.
 */
import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { Markdown, MdDocContext } from "./Markdown.js";
import { Code, FileIcon, Folder, Maximize, Refresh, Restore, X } from "./icons.js";
import {
  eventForNavigateResult,
  eventForReadResult,
  initialMdViewState,
  mdViewModeLabel,
  mdViewReducer,
  shouldRefetchOnDocVersionChange,
  stripLeadingFrontmatter,
  transferControlForContainer,
} from "../preview/md-view-state.js";

export interface MarkdownPreviewViewProps {
  tabId: string;
  previewId: string;
  container: "panel" | "window";
  sourcePath: string;
  /** M1: the READ refetch key. M2: also bumps on a `commitMdNavigate` push — reconciled against the LOCAL doc's own `docVersion` below (see the effect's doc comment) so our own just-applied NAVIGATE_OK is never redundantly re-fetched. */
  docVersion: number;
  onClose(): void;
  /** "Open in window" / "Move to panel" — the PARENT owns the actual `previewPanel.setContainer` call and any resulting toast (mirrors the existing web-preview "Open in window" button). */
  onTransfer(): void;
  /** Owner smoke-test fix: the title this component's unified header shows — PreviewPanel.tsx's own preview title in the panel container, `mdWindowTitle(sourcePath)` in the window container (MdPreviewWindowApp.tsx). Always provided by both callers; there is no untitled state. */
  title: string;
  /** Owner smoke-test fix, PANEL ONLY: the preview picker `<select>` PreviewPanel.tsx renders when the tab has more than one panel preview — passed through pre-built so `selectPreview`/`panelPreviews` stay owned there. `undefined` with a single panel preview, or in the window container (a window is always exactly one preview, never offers a picker). */
  picker?: ReactNode;
}

export function MarkdownPreviewView({ tabId, previewId, container, sourcePath, docVersion, onClose, onTransfer, title, picker }: MarkdownPreviewViewProps) {
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

  // Owner smoke-test fix: the ONLY control whose icon/label genuinely
  // depends on which container this view is mounted in — derived by the
  // pure `transferControlForContainer` (md-view-state.ts) so this component
  // stays a thin shell (it just picks an icon off `.target`).
  const transferControl = transferControlForContainer(container);

  return (
    <div className="md-preview-view">
      <div className="md-preview-view-header">
        <span className="md-preview-view-title" title={title}>
          {title}
        </span>
        {picker}
        <div className="md-preview-view-mode-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={state.mode === "rendered" ? "md-preview-mode-btn active" : "md-preview-mode-btn"}
            aria-pressed={state.mode === "rendered"}
            title={mdViewModeLabel("rendered")}
            aria-label={mdViewModeLabel("rendered")}
            onClick={() => dispatch({ type: "TOGGLE" })}
          >
            <FileIcon />
          </button>
          <button
            type="button"
            className={state.mode === "source" ? "md-preview-mode-btn active" : "md-preview-mode-btn"}
            aria-pressed={state.mode === "source"}
            title={mdViewModeLabel("source")}
            aria-label={mdViewModeLabel("source")}
            onClick={() => dispatch({ type: "TOGGLE" })}
          >
            <Code />
          </button>
        </div>
        <button type="button" className="md-preview-icon-btn" title="Reload" aria-label="Reload" onClick={reload}>
          <Refresh />
        </button>
        <button type="button" className="md-preview-icon-btn" title="Reveal in folder" aria-label="Reveal in folder" onClick={reveal}>
          <Folder />
        </button>
        <button
          type="button"
          className="md-preview-icon-btn"
          title={transferControl.label}
          aria-label={transferControl.label}
          onClick={onTransfer}
        >
          {transferControl.target === "window" ? <Maximize /> : <Restore />}
        </button>
        <button type="button" className="md-preview-icon-btn" title="Close preview" aria-label="Close preview" onClick={onClose}>
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
                  <Markdown text={stripLeadingFrontmatter(state.doc.sourceText)} />
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

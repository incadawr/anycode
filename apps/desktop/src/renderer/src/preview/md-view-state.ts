/**
 * Pure state machine for MarkdownPreviewView (TASK.99 CUT.md CONTRACTS — M1
 * shipped READ, M2 adds NAVIGATE) — ALL view logic lives here (RISK
 * REGISTER §5: vitest collects only `*.test.ts`, node env, no jsdom, so a
 * React component must stay a logic-free shell). Mirrors overlay-flag.ts /
 * panel-bridge.ts's own "pure module, `.test.ts` only" pattern.
 *
 * Two independent axes: `phase` (loading/ready/error — has a fetch settled,
 * and how) and `mode` (rendered/source — a pure UI toggle, orthogonal to
 * phase and never reset by a fetch). `NAVIGATE_OK` (M2) joins `FETCH_OK` as
 * a second "we have a fresh doc" event for md->md link following: it mirrors
 * `FETCH_OK` exactly (mode is preserved — the SAME orthogonal-axis rule, not
 * a special case) so a reader browsing the previous document in Source mode
 * keeps that same mode after following a link, now showing the NEW
 * document's source.
 */
import type { MdDocPayload, MdDocReadResult } from "../../../shared/md-preview.js";

export type MdViewPhase = "loading" | "ready" | "error";
export type MdViewMode = "rendered" | "source";

export interface MdViewState {
  phase: MdViewPhase;
  mode: MdViewMode;
  /** Last successfully fetched doc — kept across a failed reload (RELOAD -> FETCH_FAIL) so the view can still show stale content behind an error note, rather than blanking to nothing. */
  doc: MdDocPayload | null;
  /** Human-readable failure text, present only while `phase === "error"`. */
  error: string | null;
}

export type MdViewEvent =
  | { type: "FETCH_OK"; doc: MdDocPayload }
  | { type: "FETCH_FAIL"; error: string }
  | { type: "RELOAD" }
  | { type: "TOGGLE" }
  | { type: "NAVIGATE_OK"; doc: MdDocPayload };

export const initialMdViewState: MdViewState = {
  phase: "loading",
  mode: "rendered",
  doc: null,
  error: null,
};

export function mdViewReducer(state: MdViewState, event: MdViewEvent): MdViewState {
  switch (event.type) {
    case "FETCH_OK":
      return { ...state, phase: "ready", doc: event.doc, error: null };
    case "FETCH_FAIL":
      return { ...state, phase: "error", error: event.error };
    case "RELOAD":
      // Keeps the previous `doc` (and `mode`) visible while a fetch is in
      // flight — only `phase` flips, so the view can render "refreshing"
      // chrome over the last-known content instead of a blank loading state.
      return { ...state, phase: "loading", error: null };
    case "TOGGLE":
      return { ...state, mode: state.mode === "rendered" ? "source" : "rendered" };
    case "NAVIGATE_OK":
      // Mirrors FETCH_OK exactly (see module doc): `mode` is the orthogonal
      // UI-toggle axis and is never reset by a fetch/navigate event.
      return { ...state, phase: "ready", doc: event.doc, error: null };
  }
}

/** Friendly copy for an honest `MdDocReadResult` refusal (CUT.md CONTRACTS) — the ONLY place this mapping lives. */
export function mdReadFailureMessage(reason: Extract<MdDocReadResult, { ok: false }>["reason"]): string {
  switch (reason) {
    case "no_preview":
      return "This preview is no longer available.";
    case "not_md":
      return "This file is not a markdown document.";
    case "not_found":
      return "The file could not be found — it may have moved or been deleted.";
    case "outside_roots":
      return "This file is outside the allowed workspace.";
    case "too_large":
      return "This file is too large to preview.";
    case "io_error":
      return "Failed to read the file.";
  }
}

/** Pure projection of an IPC result onto the reducer's own event shape — the component dispatches whatever this returns, never branches on `MdDocReadResult` itself. */
export function eventForReadResult(result: MdDocReadResult): MdViewEvent {
  return result.ok ? { type: "FETCH_OK", doc: result.doc } : { type: "FETCH_FAIL", error: mdReadFailureMessage(result.reason) };
}

/**
 * TASK.99 M3 (CUT.md GAP 1/CONTRACTS): the md-preview WINDOW's own bootstrap
 * target — `location.search` carries `tabId`/`previewId` (main's
 * `loadMdPreviewWindow` query, main/index.ts), never the whole record (the
 * window fetches its own doc via `mdPreview.read`, custody-preserving).
 * Pulled out as a pure function (not inlined in MdPreviewWindowApp.tsx) so
 * the "logic-free shell" invariant (RISK REGISTER §5) holds for that
 * component too, mirroring MarkdownPreviewView's own split with this module.
 * `null` for a missing/empty tabId or previewId — an honest "nothing to
 * render" the component turns into its own empty-state copy.
 */
export function parseMdWindowTarget(search: string): { tabId: string; previewId: string } | null {
  const params = new URLSearchParams(search);
  const tabId = params.get("tabId") ?? "";
  const previewId = params.get("previewId") ?? "";
  return tabId !== "" && previewId !== "" ? { tabId, previewId } : null;
}

/**
 * TASK.99 M3: the md-preview window has no reactive `preview-store` feed (no
 * `PREVIEW_CHANGED` push reaches a second `BrowserWindow` — see
 * MdPreviewWindowApp.tsx's own doc comment) — it hydrates `sourcePath` ONCE
 * from a `previewPanel.list` snapshot at mount, the same boot-time-read
 * posture as the doc fetch itself. Pure lookup so the component stays a thin
 * shell: find this window's own `previewId` in the tab's preview list, or
 * `""` if it isn't there (yet, or anymore) — `MarkdownPreviewView`'s `reveal()`
 * already tolerates an empty `sourcePath` as a plain refusal, never a crash.
 */
export function findPreviewSourcePath(previews: readonly { previewId: string; sourcePath?: string }[], previewId: string): string {
  return previews.find((preview) => preview.previewId === previewId)?.sourcePath ?? "";
}

/**
 * Same projection as `eventForReadResult`, for a NAVIGATE result (M2): a
 * refusal reuses the identical `mdReadFailureMessage` mapping and surfaces
 * on the SAME inline error banner a failed read/reload already uses — no
 * separate toast/error surface was introduced for navigate.
 */
export function eventForNavigateResult(result: MdDocReadResult): MdViewEvent {
  return result.ok ? { type: "NAVIGATE_OK", doc: result.doc } : { type: "FETCH_FAIL", error: mdReadFailureMessage(result.reason) };
}

/**
 * M2 docVersion reconciliation: a NAVIGATE_OK dispatch already updates
 * `state.doc` with the fresh doc (and its NEW docVersion) directly from the
 * navigate call's own return value. Main's subsequent `pushChanged` (after
 * `commitMdNavigate`) republishes that SAME docVersion moments later through
 * `PreviewPanelInfo.docVersion` — refetching on receipt of our OWN
 * just-applied bump would be redundant (an extra round trip, not a
 * correctness bug). Refetch only when the PUSHED version is a genuine
 * ADVANCE over what the view already has: an external mutation this view
 * did not itself just apply (e.g. an agent's `BrowserOpen` reusing this same
 * `previewId` while the view is open) still needs a fetch.
 */
export function shouldRefetchOnDocVersionChange(localDocVersion: number, pushedDocVersion: number): boolean {
  return pushedDocVersion > localDocVersion;
}

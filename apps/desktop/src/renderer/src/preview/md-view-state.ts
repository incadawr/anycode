/**
 * Pure state machine for MarkdownPreviewView (TASK.99 CUT.md CONTRACTS, M1) —
 * ALL view logic lives here (RISK REGISTER §5: vitest collects only
 * `*.test.ts`, node env, no jsdom, so a React component must stay a
 * logic-free shell). Mirrors overlay-flag.ts / panel-bridge.ts's own
 * "pure module, `.test.ts` only" pattern.
 *
 * Two independent axes: `phase` (loading/ready/error — has a fetch settled,
 * and how) and `mode` (rendered/source — a pure UI toggle, orthogonal to
 * phase and never reset by a fetch). `NAVIGATE_OK` (M2) will join
 * `FETCH_OK` as a second "we have a fresh doc" event once md->md link
 * following lands; M1 ships only FETCH_OK/FETCH_FAIL/RELOAD/TOGGLE.
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
  | { type: "TOGGLE" };

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

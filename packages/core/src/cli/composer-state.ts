import { slashCompletions, type SlashCompletion } from "./completions.js";

/**
 * Input-model events for the TUI composer (Taskana 4082).
 * Pure data — no terminal or React concepts here.
 *
 * Cursor semantics (slice rework, defect 4): the composer keeps a text cursor
 * (UTF-16 code-unit offset into `input`, 0..input.length). `insert`/`newline`
 * insert at the cursor, `backspace` deletes the code unit before it, `delete`
 * the one after it, `cursor-*` move it. Events that replace the input
 * wholesale (`text`, `submit`, `clear`, `popup-commit`, history navigation)
 * park the cursor at the end of the new input.
 */
export type ComposerEvent =
  | { readonly type: "submit" }
  | { readonly type: "clear" } // Esc: wipe input, close popup
  | { readonly type: "history-prev" } // ArrowUp when the popup is closed
  | { readonly type: "history-next" } // ArrowDown when the popup is closed
  | { readonly type: "popup-up" } // ArrowUp while the popup is open
  | { readonly type: "popup-down" } // ArrowDown while the popup is open
  | { readonly type: "popup-commit" } // Tab / Right / Enter with the popup open
  | { readonly type: "text"; readonly value: string } // controlled input change (cursor -> end)
  | { readonly type: "insert"; readonly value: string } // insert `value` at the cursor
  | { readonly type: "newline" } // insert "\n" at the cursor (multiline input)
  | { readonly type: "cursor-left" }
  | { readonly type: "cursor-right" }
  | { readonly type: "cursor-home" }
  | { readonly type: "cursor-end" }
  | { readonly type: "backspace" } // delete the code unit before the cursor
  | { readonly type: "delete" }; // delete the code unit at the cursor

/** Pure composer state: input text, cursor, popup visibility, selection, history. */
export interface ComposerState {
  readonly input: string;
  /** Cursor offset in UTF-16 code units; always 0..input.length. */
  readonly cursor: number;
  readonly popupOpen: boolean;
  readonly selected: number; // index into visible completions
  readonly history: readonly string[]; // newest last
}

export const EMPTY_COMPOSER: ComposerState = {
  input: "",
  cursor: 0,
  popupOpen: false,
  selected: 0,
  history: [],
};

/** Popup rows are capped so the popup never floods small terminals. */
export const MAX_VISIBLE_COMPLETIONS = 8;

/**
 * Same-event navigation cursor into `history` (newest last): `-1` means "not
 * navigating" (next prev starts from the newest entry); otherwise the index of
 * the entry the input currently shows. Internal to the reducer.
 */
export interface ComposerInternalState extends ComposerState {
  readonly historyIndex: number; // -1 = not navigating
}

/**
 * Enter-key continuation rule (slice rework, defect 4): an input whose last
 * character is a backslash continues onto a new line instead of submitting —
 * the readline convention. Pure input->outcome; the TUI applies the newline by
 * replacing the trailing backslash. Deliberately unescaped (a line ending in
 * two backslashes still continues) — good enough for a composer, documented.
 */
export function isContinuation(input: string): boolean {
  return input.length > 0 && input.endsWith("\\");
}

/**
 * Computes popup visibility after an event: the input must be a single-line
 * slash query (starting with `/`, no embedded newline) that still matches at
 * least one completion. The `clear` event forces the popup closed even if the
 * (now empty) input would match — with the default completion list an empty
 * input matches nothing anyway, but the rule stays explicit.
 */
function popupVisibleAfter(input: string, completions: readonly SlashCompletion[], event: ComposerEvent): boolean {
  if (event.type === "clear") {
    return false;
  }
  return slashMatches(input, completions) > 0;
}

/**
 * Number of completions matching the input as a prefix (slash-only rule).
 * Multiline input never qualifies: autocomplete is a slash-command affordance,
 * and a prompt body spanning lines is not a slash query.
 */
function slashMatches(input: string, completions: readonly SlashCompletion[]): number {
  if (!input.startsWith("/") || input.includes("\n")) {
    return 0;
  }
  let count = 0;
  for (const completion of completions) {
    if (completion.command.startsWith(input)) {
      count += 1;
    }
  }
  return count;
}

/** Inserts `value` at `cursor`, returning the new input + cursor. */
function insertAt(input: string, cursor: number, value: string): { input: string; cursor: number } {
  if (value.length === 0) {
    return { input, cursor };
  }
  return {
    input: input.slice(0, cursor) + value + input.slice(cursor),
    cursor: cursor + value.length,
  };
}

/**
 * Pure reducer for the composer. See composer-state.test.ts for the frozen
 * semantics; highlights:
 * - `submit`: non-empty input is pushed onto history (deduping consecutive
 *   repeats), input clears, cursor parks at 0, popup closes. History is never
 *   cleared. The CALLER decides whether a submit is a submit or a line
 *   continuation (isContinuation) — the reducer only performs it.
 * - `insert`/`newline`: insert at the cursor (cursor advances past the insert).
 * - `backspace`/`delete`: delete before/at the cursor when one exists there.
 * - `cursor-left`/`right`/`home`/`end`: move the cursor, clamped to bounds.
 * - `popup-commit`: input becomes `completions[selected].command + " "`.
 * - `popup-up`/`popup-down`: move `selected` with wraparound; ignored when the
 *   popup shows <= 1 items.
 * - `history-prev`/`history-next`: navigate history (popup must be closed);
 *   prev at the oldest entry stays; any text edit resets navigation. The
 *   recalled entry parks the cursor at its end.
 * - `clear`: wipes input and closes the popup, keeps history.
 * - After every event the popup visibility is recomputed: open iff the input
 *   is a single-line slash prefix matching >= 1 completion (and the event was
 *   not `clear`). A commit that narrows the query to <= 1 matches therefore
 *   closes the popup.
 * - `selected` is clamped into the visible range and `cursor` into
 *   0..input.length on every state change.
 */
export function reduceComposer(
  state: ComposerState,
  event: ComposerEvent,
  completions: readonly SlashCompletion[],
): ComposerState {
  const impl: ComposerInternalState = { ...state, historyIndex: navigationIndexOf(state) };

  let next: ComposerInternalState;
  switch (event.type) {
    case "text": {
      next = { ...impl, input: event.value, cursor: event.value.length, historyIndex: -1 };
      break;
    }
    case "insert": {
      const inserted = insertAt(impl.input, impl.cursor, event.value);
      next = { ...impl, ...inserted, historyIndex: -1 };
      break;
    }
    case "newline": {
      const inserted = insertAt(impl.input, impl.cursor, "\n");
      next = { ...impl, ...inserted, historyIndex: -1 };
      break;
    }
    case "cursor-left": {
      next = { ...impl, cursor: Math.max(0, impl.cursor - 1) };
      break;
    }
    case "cursor-right": {
      next = { ...impl, cursor: Math.min(impl.input.length, impl.cursor + 1) };
      break;
    }
    case "cursor-home": {
      next = { ...impl, cursor: 0 };
      break;
    }
    case "cursor-end": {
      next = { ...impl, cursor: impl.input.length };
      break;
    }
    case "backspace": {
      if (impl.cursor === 0) {
        next = impl;
        break;
      }
      next = {
        ...impl,
        input: impl.input.slice(0, impl.cursor - 1) + impl.input.slice(impl.cursor),
        cursor: impl.cursor - 1,
        historyIndex: -1,
      };
      break;
    }
    case "delete": {
      if (impl.cursor >= impl.input.length) {
        next = impl;
        break;
      }
      next = {
        ...impl,
        input: impl.input.slice(0, impl.cursor) + impl.input.slice(impl.cursor + 1),
        historyIndex: -1,
      };
      break;
    }
    case "submit": {
      const value = impl.input;
      const history =
        value === ""
          ? impl.history
          : impl.history.length > 0 && impl.history[impl.history.length - 1] === value
            ? impl.history
            : [...impl.history, value];
      next = { ...impl, input: "", cursor: 0, popupOpen: false, selected: 0, history, historyIndex: -1 };
      break;
    }
    case "clear": {
      next = { ...impl, input: "", cursor: 0, popupOpen: false, selected: 0, historyIndex: -1 };
      break;
    }
    case "history-prev": {
      if (impl.popupOpen || impl.history.length === 0) {
        next = impl;
        break;
      }
      const cursor = impl.historyIndex === -1 ? impl.history.length - 1 : Math.max(0, impl.historyIndex - 1);
      const input = impl.history[cursor] ?? "";
      next = { ...impl, input, cursor: input.length, historyIndex: cursor };
      break;
    }
    case "history-next": {
      if (impl.popupOpen || impl.historyIndex === -1 || impl.history.length === 0) {
        next = impl;
        break;
      }
      const cursor = impl.historyIndex + 1;
      if (cursor >= impl.history.length) {
        // At (past) the newest entry: stay on it (do not clear the input).
        const input = impl.history[impl.history.length - 1] ?? "";
        next = { ...impl, input, cursor: input.length, historyIndex: impl.history.length - 1 };
        break;
      }
      const input = impl.history[cursor] ?? "";
      next = { ...impl, input, cursor: input.length, historyIndex: cursor };
      break;
    }
    case "popup-up":
    case "popup-down": {
      if (!impl.popupOpen) {
        next = impl;
        break;
      }
      const size = Math.min(slashMatches(impl.input, completions), MAX_VISIBLE_COMPLETIONS);
      if (size <= 1) {
        next = impl;
        break;
      }
      const delta = event.type === "popup-up" ? -1 : 1;
      next = { ...impl, selected: (impl.selected + delta + size) % size };
      break;
    }
    case "popup-commit": {
      if (!impl.popupOpen) {
        next = impl;
        break;
      }
      const matches = visibleCompletions(impl, completions);
      const chosen = matches[impl.selected] ?? matches[0];
      if (!chosen) {
        next = { ...impl, popupOpen: false, selected: 0 };
        break;
      }
      const input = `${chosen.command} `;
      next = { ...impl, input, cursor: input.length, historyIndex: -1 };
      break;
    }
  }

  // Recompute popup visibility + clamp cursor/selection for the new input.
  const popupOpen = popupVisibleAfter(next.input, completions, event);
  const visibleCount = Math.min(slashMatches(next.input, completions), MAX_VISIBLE_COMPLETIONS);
  const selected = visibleCount > 0 ? Math.min(next.selected, visibleCount - 1) : 0;
  const cursor = Math.min(Math.max(0, next.cursor), next.input.length);

  const result: ComposerState = {
    input: next.input,
    cursor,
    popupOpen,
    selected,
    history: next.history,
  };
  (result as ComposerState & { historyIndex?: number }).historyIndex = next.historyIndex;
  return result;
}

/**
 * The historyIndex cursor (−1 = not navigating) is internal to the reducer; it
 * rides along inside the state object but is not part of the documented public
 * surface. navigationIndexOf recovers it, defaulting to −1.
 */
function navigationIndexOf(state: ComposerState): number {
  const candidate = (state as ComposerState & { historyIndex?: number }).historyIndex;
  return typeof candidate === "number" && candidate >= -1 ? candidate : -1;
}

/**
 * Completions visible in the popup for the given state: filtered by the input
 * prefix (§2.2 rule), capped at MAX_VISIBLE_COMPLETIONS rows. `selected` is
 * clamped into range by the reducer; this function trusts it.
 */
export function visibleCompletions(
  state: ComposerState,
  completions: readonly SlashCompletion[],
): SlashCompletion[] {
  if (!state.input.startsWith("/")) {
    return [];
  }
  return completions
    .filter((completion) => completion.command.startsWith(state.input))
    .slice(0, MAX_VISIBLE_COMPLETIONS);
}

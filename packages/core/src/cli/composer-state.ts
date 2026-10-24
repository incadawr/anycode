import { slashCompletions, type SlashCompletion } from "./completions.js";

/**
 * Input-model events for the TUI composer (Taskana 4082, slice 1).
 * Pure data — no terminal or React concepts here.
 */
export type ComposerEvent =
  | { readonly type: "submit" }
  | { readonly type: "clear" } // Esc: wipe input, close popup
  | { readonly type: "history-prev" } // ArrowUp when the popup is closed
  | { readonly type: "history-next" } // ArrowDown when the popup is closed
  | { readonly type: "popup-up" } // ArrowUp while the popup is open
  | { readonly type: "popup-down" } // ArrowDown while the popup is open
  | { readonly type: "popup-commit" } // Tab / Right / Enter with the popup open
  | { readonly type: "text"; readonly value: string }; // controlled input change

/** Pure composer state: input text, popup visibility, selection, history. */
export interface ComposerState {
  readonly input: string;
  readonly popupOpen: boolean;
  readonly selected: number; // index into visible completions
  readonly history: readonly string[]; // newest last
}

export const EMPTY_COMPOSER: ComposerState = {
  input: "",
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
 * Computes popup visibility after an event: the input must be a slash query
 * (starting with `/`) that still matches at least one completion. The `clear`
 * event forces the popup closed even if the (now empty) input would match —
 * with the default completion list an empty input matches nothing anyway, but
 * the rule stays explicit.
 */
function popupVisibleAfter(input: string, completions: readonly SlashCompletion[], event: ComposerEvent): boolean {
  if (event.type === "clear") {
    return false;
  }
  return slashMatches(input, completions) > 0;
}

/** Number of completions matching the input as a prefix (slash-only rule). */
function slashMatches(input: string, completions: readonly SlashCompletion[]): number {
  if (!input.startsWith("/")) {
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

/**
 * Pure reducer for the composer. See composer-state.test.ts for the frozen
 * semantics; highlights:
 * - `submit`: non-empty input is pushed onto history (deduping consecutive
 *   repeats), input clears, popup closes. History is never cleared.
 * - `popup-commit`: input becomes `completions[selected].command + " "`.
 * - `popup-up`/`popup-down`: move `selected` with wraparound; ignored when the
 *   popup shows <= 1 items.
 * - `history-prev`/`history-next`: navigate history (popup must be closed);
 *   prev at the oldest entry stays; any `text` edit resets navigation.
 * - `clear`: wipes input and closes the popup, keeps history.
 * - After every event the popup visibility is recomputed: open iff the input
 *   is a slash prefix matching >= 1 completion (and the event was not `clear`).
 *   A commit that narrows the query to <= 1 matches therefore closes the popup.
 * - `selected` is clamped into the visible range on every state change.
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
      next = { ...impl, input: event.value, historyIndex: -1 };
      break;
    }
    case "submit": {
      const trimmed = impl.input;
      const history =
        trimmed === ""
          ? impl.history
          : impl.history.length > 0 && impl.history[impl.history.length - 1] === trimmed
            ? impl.history
            : [...impl.history, trimmed];
      next = { ...impl, input: "", popupOpen: false, selected: 0, history, historyIndex: -1 };
      break;
    }
    case "clear": {
      next = { ...impl, input: "", popupOpen: false, selected: 0, historyIndex: -1 };
      break;
    }
    case "history-prev": {
      if (impl.popupOpen || impl.history.length === 0) {
        next = impl;
        break;
      }
      const cursor = impl.historyIndex === -1 ? impl.history.length - 1 : Math.max(0, impl.historyIndex - 1);
      next = { ...impl, input: impl.history[cursor] ?? "", historyIndex: cursor };
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
        next = { ...impl, input: impl.history[impl.history.length - 1] ?? "", historyIndex: impl.history.length - 1 };
        break;
      }
      next = { ...impl, input: impl.history[cursor] ?? "", historyIndex: cursor };
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
      next = { ...impl, input: `${chosen.command} `, selected: 0, historyIndex: -1 };
      break;
    }
  }

  // Recompute popup visibility + clamp selection for the new input.
  const popupOpen = popupVisibleAfter(next.input, completions, event);
  const visibleCount = Math.min(slashMatches(next.input, completions), MAX_VISIBLE_COMPLETIONS);
  const selected = visibleCount > 0 ? Math.min(next.selected, visibleCount - 1) : 0;

  const result: ComposerState = {
    input: next.input,
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

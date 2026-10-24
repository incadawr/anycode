import { describe, expect, it } from "vitest";

import { COMMAND_HELP, KNOWN_SLASH_COMMANDS } from "./commands.js";
import { EMPTY_COMPOSER, reduceComposer, visibleCompletions, type ComposerEvent } from "./composer-state.js";
import { slashCompletions } from "./completions.js";

/** The full completion list, as the composer will be driven in production. */
const COMPLETIONS = slashCompletions("/");

function drive(state = EMPTY_COMPOSER, ...events: ComposerEvent[]) {
  return events.reduce((s, event) => reduceComposer(s, event, COMPLETIONS), state);
}

function visibleCommands(state: ReturnType<typeof drive>): string[] {
  return visibleCompletions(state, COMPLETIONS).map((c) => c.command);
}

describe("reduceComposer (Taskana 4082)", () => {
  it("1. text '/c' opens the popup with input '/c', selected 0 and 3 visible items", () => {
    const state = drive(undefined, { type: "text", value: "/c" });
    expect(state.input).toBe("/c");
    expect(state.popupOpen).toBe(true);
    expect(state.selected).toBe(0);
    expect(visibleCommands(state)).toEqual(["/compact", "/commit", "/context"]);
  });

  it("2. popup-down wraps: 0 -> 1 -> 2 -> 0; popup-up at 0 wraps to 2", () => {
    const base = drive(undefined, { type: "text", value: "/c" });
    const down = drive(base, { type: "popup-down" }, { type: "popup-down" });
    expect(down.selected).toBe(2);
    const wrapped = drive(down, { type: "popup-down" });
    expect(wrapped.selected).toBe(0);
    const up = drive(base, { type: "popup-up" });
    expect(up.selected).toBe(2);
  });

  it("3. popup-commit inserts '/compact ' and closes the popup (single match after commit)", () => {
    const state = drive(undefined, { type: "text", value: "/c" }, { type: "popup-commit" });
    expect(state.input).toBe("/compact ");
    // Documented rule: popup stays open only when the post-commit query still
    // matches > 1 completions; '/compact ' matches only itself -> closed.
    expect(state.popupOpen).toBe(false);
    expect(state.selected).toBe(0);
  });

  it("3b. popup-commit keeps the popup open when the post-commit query still matches > 1", () => {
    // '/commit' + ' ' — the input '/commit ' still prefix-matches only /commit…
    // but a query like '/c' committed to '/compact ' narrows to 1. Use a
    // synthetic completion list to exercise the >1 branch: two commands that
    // share the committed token as a prefix-with-space is impossible with the
    // real list, so assert the branch via a custom list where it holds.
    const custom = [
      { command: "/compact", summary: "s" },
      { command: "/compact extra", summary: "s" },
    ];
    const state = reduceComposer(
      reduceComposer(EMPTY_COMPOSER, { type: "text", value: "/compact" }, custom),
      { type: "popup-commit" },
      custom,
    );
    expect(state.input).toBe("/compact ");
    expect(state.popupOpen).toBe(true);
    expect(state.selected).toBe(0);
  });

  it("4. plain text keeps the popup closed; submit clears input and records history", () => {
    const state = drive(undefined, { type: "text", value: "hello" }, { type: "submit" });
    expect(state.popupOpen).toBe(false);
    expect(state.input).toBe("");
    expect(state.history).toEqual(["hello"]);
  });

  it("5. submit with empty input is a no-op (no empty history entries)", () => {
    const state = drive(undefined, { type: "submit" });
    expect(state.input).toBe("");
    expect(state.popupOpen).toBe(false);
    expect(state.history).toEqual([]);
  });

  it("6. history navigation: prev walks b -> a, next walks back; next at newest stays at newest", () => {
    const state = drive(
      undefined,
      { type: "text", value: "a" },
      { type: "submit" },
      { type: "text", value: "b" },
      { type: "submit" },
    );
    expect(state.history).toEqual(["a", "b"]);
    const prev1 = drive(state, { type: "history-prev" });
    expect(prev1.input).toBe("b");
    const prev2 = drive(prev1, { type: "history-prev" });
    expect(prev2.input).toBe("a");
    const next1 = drive(prev2, { type: "history-next" });
    expect(next1.input).toBe("b");
    // Documented choice: at the newest entry, next stays at newest (no clear).
    const next2 = drive(next1, { type: "history-next" });
    expect(next2.input).toBe("b");
    // prev at the oldest entry stays.
    const prev3 = drive(prev2, { type: "history-prev" });
    expect(prev3.input).toBe("a");
  });

  it("7. a text edit after history-prev resets navigation (next prev starts from newest)", () => {
    const state = drive(
      undefined,
      { type: "text", value: "a" },
      { type: "submit" },
      { type: "text", value: "b" },
      { type: "submit" },
    );
    const prev1 = drive(state, { type: "history-prev" }); // "b"
    const prev2 = drive(prev1, { type: "history-prev" }); // "a"
    expect(prev2.input).toBe("a");
    const edited = drive(prev2, { type: "text", value: "a!" });
    const prev3 = drive(edited, { type: "history-prev" });
    expect(prev3.input).toBe("b"); // restarted from newest, not from "a"
  });

  it("8. clear wipes input and closes the popup but preserves history", () => {
    const state = drive(
      undefined,
      { type: "text", value: "hello" },
      { type: "submit" },
      { type: "text", value: "/c" },
    );
    expect(state.popupOpen).toBe(true);
    const cleared = drive(state, { type: "clear" });
    expect(cleared.input).toBe("");
    expect(cleared.popupOpen).toBe(false);
    expect(cleared.history).toEqual(["hello"]);
  });

  it("9. duplicate consecutive submit of the same text records one history entry", () => {
    const state = drive(
      undefined,
      { type: "text", value: "same" },
      { type: "submit" },
      { type: "text", value: "same" },
      { type: "submit" },
    );
    expect(state.history).toEqual(["same"]);
  });

  it("9b. resubmitting an older entry after a different one records it again", () => {
    const state = drive(
      undefined,
      { type: "text", value: "a" },
      { type: "submit" },
      { type: "text", value: "b" },
      { type: "submit" },
      { type: "text", value: "a" },
      { type: "submit" },
    );
    expect(state.history).toEqual(["a", "b", "a"]);
  });

  it("10. visibleCompletions clamps selected as the query narrows", () => {
    const base = drive(undefined, { type: "text", value: "/c" });
    const selected2 = drive(base, { type: "popup-down" }, { type: "popup-down" });
    expect(selected2.selected).toBe(2);
    const narrowed = drive(selected2, { type: "text", value: "/co" });
    expect(narrowed.selected).toBe(2);
    expect(visibleCommands(narrowed)).toEqual(["/compact", "/commit", "/context"]);
    const narrowed2 = drive(narrowed, { type: "text", value: "/con" });
    expect(visibleCommands(narrowed2)).toEqual(["/context"]);
    expect(narrowed2.selected).toBe(0); // clamped
  });

  it("11. popup caps at 8 visible rows though more commands match (23 today)", () => {
    const state = drive(undefined, { type: "text", value: "/" });
    expect(state.popupOpen).toBe(true);
    expect(visibleCompletions(state, COMPLETIONS)).toHaveLength(8);
    // The brief said 22; the live dispatcher has 23 commands. Assert the real
    // invariant instead of a hardcoded count: more commands match than the cap.
    expect(COMMAND_HELP.length).toBeGreaterThan(8);
    expect(COMMAND_HELP).toHaveLength(KNOWN_SLASH_COMMANDS.length);
  });
});

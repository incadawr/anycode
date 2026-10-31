/**
 * Pure-logic tests for ModeMenu's roving-focus reducer (design §2.4). Like the
 * other renderer tests this is `.test.ts` under a node (no-jsdom) vitest env:
 * `nextRovingIndex` carries the ArrowUp/ArrowDown wrap logic and is covered
 * directly rather than DOM-rendering the popover.
 */
import { describe, expect, it } from "vitest";
import {
  modeChangeDisabled,
  modeChipLabel,
  modeIndexForDigit,
  MODE_DESCRIPTIONS,
  nextRovingIndex,
  ORCHESTRATE_ROW_DESCRIPTION,
} from "./ModeMenu.js";

describe("nextRovingIndex", () => {
  it("advances by +1 (ArrowDown)", () => {
    expect(nextRovingIndex(0, 1, 5)).toBe(1);
    expect(nextRovingIndex(3, 1, 5)).toBe(4);
  });

  it("wraps forward past the last item to the first", () => {
    expect(nextRovingIndex(4, 1, 5)).toBe(0);
  });

  it("retreats by -1 (ArrowUp)", () => {
    expect(nextRovingIndex(4, -1, 5)).toBe(3);
    expect(nextRovingIndex(1, -1, 5)).toBe(0);
  });

  it("wraps backward past the first item to the last", () => {
    expect(nextRovingIndex(0, -1, 5)).toBe(4);
  });

  it("returns 0 for a non-positive count", () => {
    expect(nextRovingIndex(0, 1, 0)).toBe(0);
    expect(nextRovingIndex(2, -1, 0)).toBe(0);
  });
});

describe("modeIndexForDigit", () => {
  it("maps Digit1..Digit5 to a 0-based index", () => {
    expect(modeIndexForDigit("Digit1", 5)).toBe(0);
    expect(modeIndexForDigit("Digit5", 5)).toBe(4);
  });

  it("returns null for a digit past the option count", () => {
    expect(modeIndexForDigit("Digit6", 5)).toBeNull();
    expect(modeIndexForDigit("Digit9", 5)).toBeNull();
  });

  it("returns null for non-digit-row codes", () => {
    expect(modeIndexForDigit("Digit0", 5)).toBeNull();
    expect(modeIndexForDigit("KeyA", 5)).toBeNull();
    expect(modeIndexForDigit("Numpad1", 5)).toBeNull();
  });

  it("is total over an empty option list", () => {
    expect(modeIndexForDigit("Digit1", 0)).toBeNull();
  });
});

/**
 * TASK.32 honest Edit mode: the copy string pin (D-S1-11). Only the `edit`
 * entry changes; the other four modes' strings are byte-exact pins of today.
 */
describe("MODE_DESCRIPTIONS", () => {
  it("M1t: edit copy is the TASK.32 string", () => {
    expect(MODE_DESCRIPTIONS.edit).toBe("Edit files in this project without asking");
  });

  it("M2t: other four modes' copy unchanged", () => {
    expect(MODE_DESCRIPTIONS.plan).toBe("Read-only planning");
    expect(MODE_DESCRIPTIONS.build).toBe("Ask before edits");
    expect(MODE_DESCRIPTIONS.auto).toBe("Ask only for risky actions");
    expect(MODE_DESCRIPTIONS.yolo).toBe("Never ask");
  });
});

describe("modeChangeDisabled (TASK.37)", () => {
  it("MR1: a running turn no longer disables mode changes — THE task pin", () => {
    expect(modeChangeDisabled("running", true)).toBe(false);
  });

  it("MR2: not-ready still gates, running or idle", () => {
    expect(modeChangeDisabled("idle", false)).toBe(true);
    expect(modeChangeDisabled("running", false)).toBe(true);
  });

  it("MR3: idle + ready is enabled", () => {
    expect(modeChangeDisabled("idle", true)).toBe(false);
  });
});

/**
 * Taskana 4704 §3.7 (part B): the Orchestrate row pins. The row renders
 * AFTER the five modes behind a divider and toggles through
 * `onToggleOrchestrate` (set_orchestrate), never through
 * `onChange`/PERMISSION_MODE_OPTIONS — the digit-selection guard below is the
 * keyboard half of that pin (Digit6 must not reach the toggle), and the
 * description pin keeps the copy honest.
 */
describe("Orchestrate row (Taskana 4704)", () => {
  it("O1: digit selection stays over the five permission modes — Digit6+ never reach the Orchestrate row", () => {
    expect(modeIndexForDigit("Digit5", 5)).toBe(4);
    expect(modeIndexForDigit("Digit6", 5)).toBeNull();
    expect(modeIndexForDigit("Digit7", 5)).toBeNull();
  });

  it("O2: the Orchestrate description names delegation, not a permission level", () => {
    expect(ORCHESTRATE_ROW_DESCRIPTION).toBe("Delegate work to child agents");
  });

  it("O3: roving focus wraps over six items when the row is present (5 modes + Orchestrate)", () => {
    // The component computes itemCount = 5 + 1 when the row shows; the wrap
    // math itself is the same nextRovingIndex, pinned here so adding the row
    // cannot silently break the End->ArrowDown wrap onto the toggle.
    expect(nextRovingIndex(5, 1, 6)).toBe(0);
    expect(nextRovingIndex(0, -1, 6)).toBe(5);
  });

  it("O4: the chip reads Orchestrate while the flag is on — the tab's state is visible without opening the menu", () => {
    // Host-side truth: enabling orchestrate moves the session to plan, and
    // leaving plan turns it off, so the label never hides a different mode.
    expect(modeChipLabel("plan", false)).toBe("plan");
    expect(modeChipLabel("build", false)).toBe("build");
    expect(modeChipLabel("plan", true)).toBe("Orchestrate");
  });
});

/**
 * Pure-logic tests for ModeMenu's roving-focus reducer (design §2.4). Like the
 * other renderer tests this is `.test.ts` under a node (no-jsdom) vitest env:
 * `nextRovingIndex` carries the ArrowUp/ArrowDown wrap logic and is covered
 * directly rather than DOM-rendering the popover.
 */
import { describe, expect, it } from "vitest";
import { modeIndexForDigit, nextRovingIndex } from "./ModeMenu.js";

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

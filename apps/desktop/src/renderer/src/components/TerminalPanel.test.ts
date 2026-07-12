/**
 * Pure-logic tests for TerminalPanel's R18 drag-resize helpers (design
 * slice-R18-cut.md §6). Deliberately `.test.ts` (not `.test.tsx`), same
 * rationale as SettingsScreen.test.ts: this package's vitest config runs in
 * `environment: "node"` with no jsdom/@testing-library, so importing the
 * component module directly (its terminal-view/tab-registry singleton
 * imports already construct fine under plain Node, and the CSS imports are
 * vitest-stubbed) is the node-safe way to reach these two pure exports.
 */
import { describe, expect, it } from "vitest";
import { clampPanelHeight, readStoredPanelHeight } from "./TerminalPanel.js";

describe("clampPanelHeight", () => {
  const viewportHeight = 1000; // bounds: 8vh=80, 60vh=600

  it("passes an in-bounds value through, rounding to the nearest integer", () => {
    expect(clampPanelHeight(300, viewportHeight)).toBe(300);
    expect(clampPanelHeight(300.4, viewportHeight)).toBe(300);
    expect(clampPanelHeight(300.6, viewportHeight)).toBe(301);
  });

  it("clamps below the 8vh floor up to the min", () => {
    expect(clampPanelHeight(10, viewportHeight)).toBe(80);
    expect(clampPanelHeight(0, viewportHeight)).toBe(80);
  });

  it("clamps above the 60vh ceiling down to the max", () => {
    expect(clampPanelHeight(9000, viewportHeight)).toBe(600);
  });
});

describe("readStoredPanelHeight", () => {
  it("returns null for an absent value", () => {
    expect(readStoredPanelHeight(null)).toBeNull();
  });

  it("parses a valid integer string", () => {
    expect(readStoredPanelHeight("300")).toBe(300);
  });

  it("rounds a fractional string", () => {
    expect(readStoredPanelHeight("300.6")).toBe(301);
  });

  it("returns null for garbage/non-positive values", () => {
    expect(readStoredPanelHeight("")).toBeNull();
    expect(readStoredPanelHeight("abc")).toBeNull();
    expect(readStoredPanelHeight("-5")).toBeNull();
    expect(readStoredPanelHeight("0")).toBeNull();
    expect(readStoredPanelHeight("Infinity")).toBeNull();
  });
});

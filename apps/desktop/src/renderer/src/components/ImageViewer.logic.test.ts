/**
 * Taskana 4091 (TASK.84): pure-logic tests for the ImageViewer's wrap-around
 * navigation. Same node-env discipline as MessageList.test.ts — no jsdom, no
 * @testing-library: only the exported pure helper is pinned; the overlay
 * component itself (DOM, keydown capture, focus) is covered by the live smoke.
 */
import { describe, expect, it } from "vitest";
import { nextIndex } from "./ImageViewer.js";

describe("nextIndex (ImageViewer wrap-around navigation, Taskana 4091)", () => {
  it("steps forward, wrapping at the end", () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(1, 1, 3)).toBe(2);
    expect(nextIndex(2, 1, 3)).toBe(0);
  });

  it("steps backward, wrapping at the start", () => {
    expect(nextIndex(1, -1, 3)).toBe(0);
    expect(nextIndex(2, -1, 3)).toBe(1);
    expect(nextIndex(0, -1, 3)).toBe(2);
  });

  it("a single image never moves", () => {
    expect(nextIndex(0, 1, 1)).toBe(0);
    expect(nextIndex(0, -1, 1)).toBe(0);
  });

  it("degenerate guard: count 0 (and anything <= 1) stays at 0", () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(0, -1, 0)).toBe(0);
  });
});

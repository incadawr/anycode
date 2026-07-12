/**
 * Pure-logic tests for PromptQueue's exported helpers (design
 * slice-P7.14-cut.md §4). Same rationale as GitPill.test.ts/GitDiffPane.test.ts:
 * no jsdom in this package's vitest config, so the component's JSX rendering
 * is exercised only by the (owner) live-Electron smoke — this file covers the
 * pure functions the component's JSX calls into.
 */
import { describe, expect, it } from "vitest";
import { queueImageBadge, shouldShowPromptQueue } from "./PromptQueue.js";

describe("queueImageBadge", () => {
  it("returns null when there are no images", () => {
    expect(queueImageBadge(0)).toBeNull();
  });

  it("formats a singular/plural count badge", () => {
    expect(queueImageBadge(1)).toBe("1 img");
    expect(queueImageBadge(2)).toBe("2 img");
    expect(queueImageBadge(8)).toBe("8 img");
  });
});

describe("shouldShowPromptQueue", () => {
  it("hides when the queue is empty and not paused", () => {
    expect(shouldShowPromptQueue(0, false)).toBe(false);
  });

  it("shows when the queue has items", () => {
    expect(shouldShowPromptQueue(1, false)).toBe(true);
  });

  it("shows when paused even with an empty queue (e.g. the head was restored then cleared by the user)", () => {
    expect(shouldShowPromptQueue(0, true)).toBe(true);
  });

  it("shows when both paused and non-empty", () => {
    expect(shouldShowPromptQueue(2, true)).toBe(true);
  });
});

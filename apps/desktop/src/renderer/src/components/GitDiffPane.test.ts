/**
 * Pure-logic tests for GitDiffPane's exported helpers (design .../
 * slice-5.8-cut.md §2.6). Same rationale as DiffView.test.ts/ModeMenu.test.ts:
 * no jsdom in this package's vitest config, so the component's actual JSX
 * rendering is exercised only by the (owner) live-Electron smoke — this file
 * covers the pure functions the component's JSX calls into.
 */
import { describe, expect, it } from "vitest";
import type { GitFileDiff } from "../diff/parse-unified.js";
import { diffLineClassName, diffLineMarker, gitFileDiffLabel, truncatedDiffBanner } from "./GitDiffPane.js";

function file(overrides: Partial<GitFileDiff>): GitFileDiff {
  return { oldPath: "a.txt", newPath: "a.txt", binary: false, hunks: [], ...overrides };
}

describe("diffLineMarker", () => {
  it("maps add/del/context to +/-/space, mirroring DiffView's DiffLineRow", () => {
    expect(diffLineMarker("add")).toBe("+");
    expect(diffLineMarker("del")).toBe("-");
    expect(diffLineMarker("context")).toBe(" ");
  });
});

describe("diffLineClassName", () => {
  it("emits the diff-line diff-line-<kind> recipe DiffView's CSS already styles", () => {
    expect(diffLineClassName("add")).toBe("diff-line diff-line-add");
    expect(diffLineClassName("del")).toBe("diff-line diff-line-del");
    expect(diffLineClassName("context")).toBe("diff-line diff-line-context");
  });
});

describe("truncatedDiffBanner", () => {
  it("reports the exact character count being shown", () => {
    expect(truncatedDiffBanner(524_288)).toBe("Diff truncated — showing the first 524288 characters");
    expect(truncatedDiffBanner(0)).toBe("Diff truncated — showing the first 0 characters");
  });
});

describe("gitFileDiffLabel", () => {
  it("shows the current (new) path for an ordinary modified file", () => {
    expect(gitFileDiffLabel(file({ oldPath: "foo.txt", newPath: "foo.txt" }))).toBe("foo.txt");
  });

  it("shows 'old → new' for a resolved rename", () => {
    expect(gitFileDiffLabel(file({ oldPath: "old.txt", newPath: "new.txt", renamedFrom: "old.txt" }))).toBe(
      "old.txt → new.txt",
    );
  });

  it("shows just the new path for an added file (old side is /dev/null)", () => {
    expect(gitFileDiffLabel(file({ oldPath: "/dev/null", newPath: "created.txt" }))).toBe("created.txt");
  });

  it("shows just the old path for a deleted file (new side is /dev/null)", () => {
    expect(gitFileDiffLabel(file({ oldPath: "deleted.txt", newPath: "/dev/null" }))).toBe("deleted.txt");
  });

  it("falls back to the new path when renamedFrom equals newPath (degenerate/no-op rename)", () => {
    expect(gitFileDiffLabel(file({ oldPath: "same.txt", newPath: "same.txt", renamedFrom: "same.txt" }))).toBe(
      "same.txt",
    );
  });
});

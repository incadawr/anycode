/**
 * Pure-logic tests for GitConfirmDialog's exported `confirmDialogCopy` (design
 * .../slice-5.8-cut.md §2.6). Same rationale as GitDiffPane.test.ts/
 * GitPill.test.ts: no jsdom in this package's vitest config, so the dialog's
 * actual JSX/showModal wiring is exercised only by the (owner) live-Electron
 * smoke — this file covers the pure per-intent copy the component's JSX reads.
 */
import { describe, expect, it } from "vitest";
import type { GitDestructiveIntent } from "../store.js";
import { confirmDialogCopy } from "./GitConfirmDialog.js";

describe("confirmDialogCopy", () => {
  it("pluralizes discard copy for a single file", () => {
    const intent: GitDestructiveIntent = { op: "discard", paths: ["a.txt"] };
    const copy = confirmDialogCopy(intent);
    expect(copy.title).toBe("Discard changes");
    expect(copy.body).toBe("Discard changes to 1 file? This cannot be undone.");
    expect(copy.confirmLabel).toBe("Discard");
  });

  it("pluralizes discard copy for multiple files", () => {
    const intent: GitDestructiveIntent = { op: "discard", paths: ["a.txt", "b.txt", "c.txt"] };
    expect(confirmDialogCopy(intent).body).toBe("Discard changes to 3 files? This cannot be undone.");
  });

  it("mentions untracked files only when includeUntracked is set", () => {
    const withUntracked: GitDestructiveIntent = { op: "stash_push", includeUntracked: true };
    const withoutUntracked: GitDestructiveIntent = { op: "stash_push", includeUntracked: false };
    expect(confirmDialogCopy(withUntracked).body).toContain("including untracked files");
    expect(confirmDialogCopy(withoutUntracked).body).not.toContain("untracked");
    expect(confirmDialogCopy(withUntracked).confirmLabel).toBe("Stash");
  });

  it("describes stash pop as applying and removing the top stash entry", () => {
    const intent: GitDestructiveIntent = { op: "stash_pop" };
    const copy = confirmDialogCopy(intent);
    expect(copy.confirmLabel).toBe("Pop");
    expect(copy.body).toContain("Apply the most recent stash");
  });

  it("gives reset --hard the harshest wording of the whole set", () => {
    const intent: GitDestructiveIntent = { op: "reset", mode: "hard" };
    const copy = confirmDialogCopy(intent);
    expect(copy.title).toBe("Reset — hard");
    expect(copy.body).toContain("ALL staged and unstaged changes");
    expect(copy.body).toContain("cannot be undone");
    expect(copy.confirmLabel).toBe("Reset --hard");
  });

  it("describes reset --mixed as keeping working-tree files", () => {
    const intent: GitDestructiveIntent = { op: "reset", mode: "mixed" };
    const copy = confirmDialogCopy(intent);
    expect(copy.title).toBe("Reset — mixed");
    expect(copy.body).toContain("kept as-is");
    expect(copy.confirmLabel).toBe("Reset");
  });
});

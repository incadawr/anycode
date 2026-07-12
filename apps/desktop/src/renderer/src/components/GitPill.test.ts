/**
 * Pure-logic tests for GitPill's exported helpers (design .../
 * slice-5.8-cut.md §2.6). Same rationale as GitDiffPane.test.ts/ModeMenu.test.ts:
 * no jsdom in this package's vitest config, so the component's actual JSX
 * rendering is exercised only by the (owner) live-Electron smoke — this file
 * covers the pure functions the component's JSX calls into.
 */
import { describe, expect, it } from "vitest";
import type { GitHead } from "@anycode/core";
import type { WireGitStatus } from "../../../shared/protocol.js";
import { gitAheadBehindLabel, gitPillLabel } from "./GitPill.js";

function head(overrides: Partial<GitHead>): GitHead {
  return { branch: null, detached: false, sha: null, ahead: null, behind: null, ...overrides };
}

function status(overrides: Partial<WireGitStatus>): WireGitStatus {
  return {
    head: head({}),
    staged: [],
    unstaged: [],
    untracked: [],
    dirtyCount: 0,
    filesTruncated: false,
    ...overrides,
  };
}

describe("gitPillLabel", () => {
  it("shows the branch name on an ordinary checked-out branch", () => {
    expect(gitPillLabel(status({ head: head({ branch: "main", sha: "abc123" }) }))).toBe("main");
  });

  it("shows detached @sha7 for a detached HEAD", () => {
    expect(
      gitPillLabel(status({ head: head({ detached: true, branch: null, sha: "0123456789abcdef" }) })),
    ).toBe("detached @0123456");
  });

  it("falls back to the bare word for a detached HEAD with no sha (defensive)", () => {
    expect(gitPillLabel(status({ head: head({ detached: true, branch: null, sha: null }) }))).toBe("detached");
  });

  it("shows unborn for a HEAD with no commits yet, even when a branch name is already known", () => {
    expect(gitPillLabel(status({ head: head({ branch: "main", sha: null }) }))).toBe("unborn");
  });

  it("falls back to unborn if a non-detached HEAD somehow has neither sha nor branch", () => {
    expect(gitPillLabel(status({ head: head({ branch: null, sha: null }) }))).toBe("unborn");
  });
});

describe("gitAheadBehindLabel", () => {
  it("returns null when there is no upstream (ahead/behind both null)", () => {
    expect(gitAheadBehindLabel(head({ ahead: null, behind: null }))).toBeNull();
  });

  it("returns null when fully in sync (both zero)", () => {
    expect(gitAheadBehindLabel(head({ ahead: 0, behind: 0 }))).toBeNull();
  });

  it("shows only ahead when behind is zero", () => {
    expect(gitAheadBehindLabel(head({ ahead: 3, behind: 0 }))).toBe("↑3");
  });

  it("shows only behind when ahead is zero", () => {
    expect(gitAheadBehindLabel(head({ ahead: 0, behind: 2 }))).toBe("↓2");
  });

  it("shows both when the branch has diverged", () => {
    expect(gitAheadBehindLabel(head({ ahead: 3, behind: 2 }))).toBe("↑3 ↓2");
  });
});

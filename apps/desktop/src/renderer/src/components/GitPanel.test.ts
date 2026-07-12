/**
 * Pure-logic tests for GitPanel's exported helpers (design .../
 * slice-5.8-cut.md §2.6). Same rationale as GitDiffPane.test.ts/
 * GitPill.test.ts: no jsdom in this package's vitest config, so the panel's
 * actual JSX/tab wiring is exercised only by the (owner) live-Electron smoke
 * — this file covers the pure dispatch-shape builders the component's JSX
 * calls into, plus the guard that keeps destructive intent construction the

 */
import { describe, expect, it } from "vitest";
import type { WireGitStatus } from "../../../shared/protocol.js";
import { buildDiffRequest, buildUnstageAllRequest, discardAllIntent, stagedPaths, unstagedPaths } from "./GitPanel.js";

function status(overrides: Partial<WireGitStatus>): WireGitStatus {
  return {
    head: { branch: "main", detached: false, sha: "abc123", ahead: null, behind: null },
    staged: [],
    unstaged: [],
    untracked: [],
    dirtyCount: 0,
    filesTruncated: false,
    ...overrides,
  };
}

describe("stagedPaths / unstagedPaths", () => {
  it("returns [] for a null status", () => {
    expect(stagedPaths(null)).toEqual([]);
    expect(unstagedPaths(null)).toEqual([]);
  });

  it("extracts just the path from each file change", () => {
    const s = status({
      staged: [{ path: "a.ts", kind: "modified" }],
      unstaged: [{ path: "b.ts", kind: "added" }, { path: "c.ts", kind: "deleted" }],
    });
    expect(stagedPaths(s)).toEqual(["a.ts"]);
    expect(unstagedPaths(s)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("buildDiffRequest", () => {
  it("builds a diff command and a matching pending diff spec for a staged file", () => {
    const { command, pending } = buildDiffRequest("src/foo.ts", "staged");
    expect(command).toEqual({ op: "diff", target: "staged", path: "src/foo.ts" });
    expect(pending).toEqual({ kind: "diff", diff: { path: "src/foo.ts", target: "staged" }, label: "diff" });
  });

  it("builds a worktree-target request for an unstaged file", () => {
    const { command } = buildDiffRequest("src/bar.ts", "worktree");
    expect(command).toEqual({ op: "diff", target: "worktree", path: "src/bar.ts" });
  });
});

describe("buildUnstageAllRequest", () => {
  it("returns null when nothing is staged (would violate the wire schema's paths.min(1))", () => {
    expect(buildUnstageAllRequest(null)).toBeNull();
    expect(buildUnstageAllRequest(status({ staged: [] }))).toBeNull();
  });

  it("collects every staged path into one unstage command", () => {
    const s = status({ staged: [{ path: "a.ts", kind: "modified" }, { path: "b.ts", kind: "added" }] });
    const request = buildUnstageAllRequest(s);
    expect(request).toEqual({
      command: { op: "unstage", paths: ["a.ts", "b.ts"] },
      pending: { kind: "mutation", label: "unstage all" },
    });
  });
});

describe("discardAllIntent", () => {
  it("returns null when there is nothing unstaged to discard", () => {
    expect(discardAllIntent(null)).toBeNull();
    expect(discardAllIntent(status({ unstaged: [] }))).toBeNull();
  });

  it("stages a discard intent over every unstaged path (never a wire command directly, ruling R2)", () => {
    const s = status({ unstaged: [{ path: "a.ts", kind: "modified" }, { path: "b.ts", kind: "deleted" }] });
    expect(discardAllIntent(s)).toEqual({ op: "discard", paths: ["a.ts", "b.ts"] });
  });
});

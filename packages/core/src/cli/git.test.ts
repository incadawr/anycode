import { describe, expect, it } from "vitest";
import type { GitFileChange, GitStatusSummary } from "../ports/git.js";
import {
  GIT_DIFF_MAX_LINES,
  GIT_STATUS_MAX_FILES_PER_GROUP,
  parseCommitCommand,
  parseDiffCommand,
  renderCommitSummary,
  renderGitStatus,
  truncateDiff,
} from "./git.js";

/** Builds a minimal GitStatusSummary fixture; overrides merge shallowly per top-level key. */
function makeSummary(overrides: Partial<GitStatusSummary> = {}): GitStatusSummary {
  return {
    head: { branch: "main", detached: false, sha: "abc1234def", ahead: null, behind: null },
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  };
}

describe("parseCommitCommand", () => {
  const cases: Array<[string, string, ReturnType<typeof parseCommitCommand>]> = [
    ["empty rest", "", { kind: "invalid" }],
    ["whitespace-only rest", "   ", { kind: "invalid" }],
    ["bare message", "fix the bug", { kind: "commit", message: "fix the bug" }],
    ["double-quoted message", '"fix the bug"', { kind: "commit", message: "fix the bug" }],
    ["single-quoted message", "'fix the bug'", { kind: "commit", message: "fix the bug" }],
    ["quoted-empty message is invalid", '""', { kind: "invalid" }],
    ["quoted-empty single-quote message is invalid", "''", { kind: "invalid" }],
    [
      "surrounding whitespace trimmed before quote-strip",
      '   "fix the bug"   ',
      { kind: "commit", message: "fix the bug" },
    ],
    [
      "one layer of nested quotes: outer single, inner double survives",
      "'\"nested\"'",
      { kind: "commit", message: '"nested"' },
    ],
    [
      "mismatched quotes are not stripped (kept literal)",
      '"unterminated',
      { kind: "commit", message: '"unterminated' },
    ],
    [
      "internal whitespace inside quotes is preserved",
      '"  padded message  "',
      { kind: "commit", message: "  padded message  " },
    ],
  ];

  it.each(cases)("%s", (_label, rest, expected) => {
    expect(parseCommitCommand(rest)).toEqual(expected);
  });
});

describe("parseDiffCommand", () => {
  const cases: Array<[string, string, ReturnType<typeof parseDiffCommand>]> = [
    ["empty rest -> full diff", "", {}],
    ["whitespace-only rest -> full diff", "   ", {}],
    ["bare path", "src/foo.ts", { path: "src/foo.ts" }],
    ["path with surrounding whitespace trimmed", "  src/foo.ts  ", { path: "src/foo.ts" }],
    ["quoted path with spaces", '"some file.ts"', { path: "some file.ts" }],
    ["single-quoted path with spaces", "'some file.ts'", { path: "some file.ts" }],
    ["quoted-empty path collapses to empty-string path", '""', { path: "" }],
  ];

  it.each(cases)("%s", (_label, rest, expected) => {
    expect(parseDiffCommand(rest)).toEqual(expected);
  });
});

describe("renderGitStatus", () => {
  it("renders a clean repo as a single header line with zero counts", () => {
    const summary = makeSummary();
    expect(renderGitStatus(summary)).toBe("[git] on main (+0 ~0 ?0)\n");
  });

  it("renders detached HEAD using the first 7 chars of sha", () => {
    const summary = makeSummary({
      head: { branch: null, detached: true, sha: "abcdef1234567", ahead: null, behind: null },
    });
    expect(renderGitStatus(summary)).toBe("[git] on detached@abcdef1 (+0 ~0 ?0)\n");
  });

  it("appends ahead/behind only when both are non-null (upstream configured)", () => {
    const summary = makeSummary({
      head: { branch: "main", detached: false, sha: "abc1234", ahead: 2, behind: 1 },
    });
    expect(renderGitStatus(summary)).toBe("[git] on main (+0 ~0 ?0) ahead 2/behind 1\n");
  });

  it("omits ahead/behind when only one of the pair is non-null", () => {
    const summary = makeSummary({
      head: { branch: "main", detached: false, sha: "abc1234", ahead: 2, behind: null },
    });
    expect(renderGitStatus(summary)).toBe("[git] on main (+0 ~0 ?0)\n");
  });

  it("counts added kind as A and every other kind as M, across staged+unstaged", () => {
    const staged: GitFileChange[] = [
      { path: "new-file.ts", kind: "added" },
      { path: "changed.ts", kind: "modified" },
    ];
    const unstaged: GitFileChange[] = [
      { path: "gone.ts", kind: "deleted" },
      { path: "old.ts", kind: "renamed", renamedFrom: "older.ts" },
    ];
    const summary = makeSummary({ staged, unstaged, untracked: ["scratch.txt"] });
    const rendered = renderGitStatus(summary);
    expect(rendered.split("\n")[0]).toBe("[git] on main (+1 ~3 ?1)");
    expect(rendered).toContain("staged:\n  A new-file.ts\n  M changed.ts\n");
    expect(rendered).toContain("unstaged:\n  D gone.ts\n  R older.ts -> old.ts\n");
    expect(rendered).toContain("untracked:\n  ? scratch.txt\n");
  });

  it("omits empty groups entirely (no heading printed for zero-length lists)", () => {
    const summary = makeSummary({ staged: [{ path: "a.ts", kind: "modified" }] });
    const rendered = renderGitStatus(summary);
    expect(rendered).toContain("staged:");
    expect(rendered).not.toContain("unstaged:");
    expect(rendered).not.toContain("untracked:");
  });

  it("caps a group at GIT_STATUS_MAX_FILES_PER_GROUP with an honest '+N more' tail", () => {
    expect(GIT_STATUS_MAX_FILES_PER_GROUP).toBe(20);
    const staged: GitFileChange[] = Array.from({ length: 25 }, (_, i) => ({
      path: `file-${i}.ts`,
      kind: "modified" as const,
    }));
    const summary = makeSummary({ staged });
    const rendered = renderGitStatus(summary);
    const lines = rendered.split("\n");
    const stagedIdx = lines.indexOf("staged:");
    expect(stagedIdx).toBeGreaterThanOrEqual(0);
    // heading + 20 kept rows + 1 overflow row
    expect(lines[stagedIdx + 20 + 1]).toBe("  … +5 more");
    expect(rendered).not.toContain("file-24.ts");
  });

  it("does not cap a group with exactly GIT_STATUS_MAX_FILES_PER_GROUP entries", () => {
    const staged: GitFileChange[] = Array.from({ length: 20 }, (_, i) => ({
      path: `file-${i}.ts`,
      kind: "modified" as const,
    }));
    const summary = makeSummary({ staged });
    const rendered = renderGitStatus(summary);
    expect(rendered).not.toContain("more");
    expect(rendered).toContain("file-19.ts");
  });
});

describe("truncateDiff", () => {
  it("returns an empty diff unchanged", () => {
    expect(truncateDiff("")).toBe("");
  });

  it("returns a short diff unchanged (identity, no marker)", () => {
    const text = "line1\nline2\nline3\n";
    expect(truncateDiff(text)).toBe(text);
  });

  it("returns a diff of exactly GIT_DIFF_MAX_LINES lines unchanged (boundary is strict >, not >=)", () => {
    expect(GIT_DIFF_MAX_LINES).toBe(400);
    const text = Array.from({ length: GIT_DIFF_MAX_LINES }, (_, i) => `line${i}`).join("\n") + "\n";
    expect(truncateDiff(text)).toBe(text);
  });

  it("returns a diff of exactly GIT_DIFF_MAX_LINES lines unchanged even without a trailing newline", () => {
    const text = Array.from({ length: GIT_DIFF_MAX_LINES }, (_, i) => `line${i}`).join("\n");
    expect(truncateDiff(text)).toBe(text);
  });

  it("truncates a diff one line past the boundary, with an honest count and marker", () => {
    const text = Array.from({ length: GIT_DIFF_MAX_LINES + 1 }, (_, i) => `line${i}`).join("\n") + "\n";
    const result = truncateDiff(text);
    const expectedKept = Array.from({ length: GIT_DIFF_MAX_LINES }, (_, i) => `line${i}`).join("\n");
    expect(result).toBe(`${expectedKept}\n… diff truncated (1 more lines)\n`);
  });

  it("truncates a much longer diff and reports the exact hidden-line count", () => {
    const totalLines = GIT_DIFF_MAX_LINES + 137;
    const text = Array.from({ length: totalLines }, (_, i) => `line${i}`).join("\n") + "\n";
    const result = truncateDiff(text);
    expect(result).toContain("… diff truncated (137 more lines)\n");
    expect(result.split("\n").filter((l) => l.startsWith("line")).length).toBe(GIT_DIFF_MAX_LINES);
  });
});

describe("renderCommitSummary", () => {
  it("sums staged+unstaged+untracked and singularizes 'file' for a count of 1", () => {
    const summary = makeSummary({ staged: [{ path: "a.ts", kind: "modified" }] });
    expect(renderCommitSummary(summary)).toBe("commit 1 file on main?");
  });

  it("pluralizes 'files' for counts other than 1, including zero", () => {
    expect(renderCommitSummary(makeSummary())).toBe("commit 0 files on main?");
    const summary = makeSummary({
      staged: [{ path: "a.ts", kind: "modified" }],
      unstaged: [{ path: "b.ts", kind: "modified" }],
      untracked: ["c.txt"],
    });
    expect(renderCommitSummary(summary)).toBe("commit 3 files on main?");
  });

  it("uses the detached@sha7 label when HEAD is detached", () => {
    const summary = makeSummary({
      head: { branch: null, detached: true, sha: "0123456789abcdef", ahead: null, behind: null },
    });
    expect(renderCommitSummary(summary)).toBe("commit 0 files on detached@0123456?");
  });
});

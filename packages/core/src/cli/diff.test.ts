/**
 * cli/diff.ts unit tests (design slice-4.2-cut.md §5.2 item 1): line-LCS
 * accuracy, the quadratic-guard fallback, the Edit visible-line cap, the
 * replace_all suffix, and the no-color/color SGR invariants.
 */

import { describe, expect, it } from "vitest";
import { createCliTheme } from "./theme.js";
import {
  CLI_DIFF_MAX_INPUT_LINES,
  CLI_DIFF_MAX_LINES,
  computeLineDiff,
  formatEditDiff,
  formatWriteDiff,
} from "./diff.js";

const NOCOLOR = createCliTheme({ color: false });
const COLOR = createCliTheme({ color: true });

describe("computeLineDiff — LCS accuracy", () => {
  it("pure insertion: unchanged context around one added line", () => {
    const diff = computeLineDiff("a\nb", "a\nx\nb");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "x" },
      { kind: "context", text: "b" },
    ]);
  });

  it("pure deletion: unchanged context around one removed line", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nc");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });

  it("replacement: remove-before-add ordering inside the changed block", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "context", text: "c" },
    ]);
  });

  it("multi-line replacement still orders all removes before all adds", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nx\ny\nc");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
      { kind: "context", text: "c" },
    ]);
  });

  it("empty -> non-empty: removes the (single, empty) old line, adds the new one", () => {
    const diff = computeLineDiff("", "hello");
    expect(diff).toEqual([
      { kind: "remove", text: "" },
      { kind: "add", text: "hello" },
    ]);
  });

  it("non-empty -> empty: removes the old line, adds the (single, empty) new one", () => {
    const diff = computeLineDiff("hello", "");
    expect(diff).toEqual([
      { kind: "remove", text: "hello" },
      { kind: "add", text: "" },
    ]);
  });

  it("only-context: identical text produces zero ± lines and never throws", () => {
    const diff = computeLineDiff("a\nb", "a\nb");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
    ]);
    expect(diff.some((line) => line.kind !== "context")).toBe(false);
  });

  it("does not append a trailing-newline line that wasn't in the source", () => {
    // "a\n".split("\n") === ["a", ""] — split-as-is, no reconstruction (design §3.1).
    const diff = computeLineDiff("a\n", "a\n");
    expect(diff).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "" },
    ]);
  });

  it("falls back to a flat remove-all/add-all block when either side exceeds CLI_DIFF_MAX_INPUT_LINES", () => {
    const oldLines = Array.from({ length: CLI_DIFF_MAX_INPUT_LINES + 1 }, (_, i) => `old-${i}`);
    const newLines = ["only-new-line"];
    const diff = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(diff).toEqual([
      ...oldLines.map((text) => ({ kind: "remove", text })),
      ...newLines.map((text) => ({ kind: "add", text })),
    ]);
  });

  it("does not fall back when both sides are exactly at the guard boundary", () => {
    const oldLines = Array.from({ length: CLI_DIFF_MAX_INPUT_LINES }, (_, i) => `same-${i}`);
    const newLines = [...oldLines];
    newLines[0] = "changed";
    const diff = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
    // A real LCS diff keeps all the unchanged lines as context (only line 0 differs);
    // the flat fallback would instead emit every old line as a remove.
    expect(diff.filter((line) => line.kind === "context").length).toBe(CLI_DIFF_MAX_INPUT_LINES - 1);
  });
});

describe("formatEditDiff — header, cap, replace_all, color invariants", () => {
  it("renders an honest header with no suffix when replace_all is unset", () => {
    const text = formatEditDiff({ filePath: "/a.ts", oldString: "x", newString: "y" });
    expect(text.startsWith("\n[tool] Edit /a.ts\n")).toBe(true);
    expect(text).not.toContain("replace_all");
  });

  it("appends the (replace_all) suffix only when replaceAll is true", () => {
    const text = formatEditDiff({ filePath: "/a.ts", oldString: "x", newString: "y", replaceAll: true });
    expect(text.startsWith("\n[tool] Edit /a.ts (replace_all)\n")).toBe(true);
  });

  it("caps visible diff lines at CLI_DIFF_MAX_LINES with an exact overflow marker", () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old-${i}`);
    const newLines = Array.from({ length: 50 }, (_, i) => `new-${i}`);
    const full = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(full.length).toBe(100); // no shared lines ⇒ 50 removes + 50 adds
    const text = formatEditDiff({ filePath: "/a.ts", oldString: oldLines.join("\n"), newString: newLines.join("\n") });
    const hidden = full.length - CLI_DIFF_MAX_LINES;
    expect(text).toContain(`  … (+${hidden} more diff lines)`);
    const bodyLines = text.split("\n").filter((line) => line.startsWith("  + ") || line.startsWith("  - "));
    expect(bodyLines.length).toBe(CLI_DIFF_MAX_LINES);
  });

  it("does not add an overflow marker when at or under the cap", () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `old-${i}`);
    const newLines = Array.from({ length: 40 }, (_, i) => `new-${i}`);
    const text = formatEditDiff({ filePath: "/a.ts", oldString: oldLines.join("\n"), newString: newLines.join("\n") });
    expect(text).not.toContain("more diff lines");
  });

  it("no-color: zero SGR bytes anywhere, +/- prefixes still present as plain ASCII", () => {
    const text = formatEditDiff({
      filePath: "/a.ts",
      oldString: "old line",
      newString: "new line",
      theme: NOCOLOR,
    });
    expect(text).not.toContain("\x1b[");
    expect(text).toContain("  - old line");
    expect(text).toContain("  + new line");
  });

  it("color: diffAdd/diffRemove SGR pairs wrap only the ± lines; context is unpainted", () => {
    const text = formatEditDiff({
      filePath: "/a.ts",
      oldString: "same\nold line",
      newString: "same\nnew line",
      theme: COLOR,
    });
    expect(text).toContain("\x1b[31m  - old line\x1b[0m");
    expect(text).toContain("\x1b[32m  + new line\x1b[0m");
    expect(text).toContain("\n    same\n");
  });
});

describe("formatWriteDiff — collapse reuse, header, color invariants", () => {
  it("renders an honest header and every content line prefixed with +", () => {
    const text = formatWriteDiff({ filePath: "/new.ts", content: "line 1\nline 2" });
    expect(text).toBe("\n[tool] Write /new.ts\n  + line 1\n  + line 2\n");
  });

  it("never claims 'new file' anywhere in the block", () => {
    const text = formatWriteDiff({ filePath: "/new.ts", content: "x" });
    expect(text.toLowerCase()).not.toContain("new file");
  });

  it("collapses content longer than the collapse threshold via head/tail + exact marker", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const text = formatWriteDiff({ filePath: "/new.ts", content: lines.join("\n") });
    expect(text).toContain("  + line-0");
    expect(text).toContain("  + line-9");
    expect(text).not.toContain("  + line-10\n"); // hidden middle line
    expect(text).toContain("  + line-39"); // last tail line survives
    expect(text).toContain("  … (+25 more lines)"); // 40 - 10 head - 5 tail
  });

  it("no-color: zero SGR bytes anywhere", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const text = formatWriteDiff({ filePath: "/new.ts", content: lines.join("\n"), theme: NOCOLOR });
    expect(text).not.toContain("\x1b[");
  });

  it("color: every surviving content line is wrapped in diffAdd; the marker is dim, not diffAdd", () => {
    const text = formatWriteDiff({ filePath: "/new.ts", content: "only line", theme: COLOR });
    expect(text).toBe("\n[tool] \x1b[36mWrite\x1b[0m /new.ts\n\x1b[32m  + only line\x1b[0m\n");
  });
});

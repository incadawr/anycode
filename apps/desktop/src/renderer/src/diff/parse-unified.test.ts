/**
 * Pure-logic tests for diff/parse-unified.ts (design .../slice-5.8-cut.md
 * §2.6/§6#7). No React/DOM — this module has none. Fixtures are hand-built
 * `git diff`-shaped text rather than actual `git diff` invocations: the
 * parser's job is to be fail-safe over whatever text a wire message carries,
 * so the interesting cases are the text shapes, not spawning real git.
 */
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, trimTruncatedTail } from "./parse-unified.js";

describe("parseUnifiedDiff", () => {
  it("returns no files for empty text", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("returns no files for text with no 'diff --git' section", () => {
    expect(parseUnifiedDiff("not a diff\njust garbage\n")).toEqual([]);
  });

  it("parses a single modified file with correct line numbers", () => {
    const text = [
      "diff --git a/foo.txt b/foo.txt",
      "index 83db48f..bf269c4 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+lineTWO",
      " line3",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "foo.txt", newPath: "foo.txt", binary: false });
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "line1" },
      { kind: "del", oldLine: 2, newLine: null, text: "line2" },
      { kind: "add", oldLine: null, newLine: 2, text: "lineTWO" },
      { kind: "context", oldLine: 3, newLine: 3, text: "line3" },
    ]);
  });

  it("parses a multi-file diff into separate GitFileDiff entries, each with correct line numbers", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-gone",
      "+added",
      "diff --git a/b.txt b/b.txt",
      "index 333..444 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -5,2 +5,3 @@",
      " ctx5",
      "+new6",
      " ctx7",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(2);
    expect(files[0]?.newPath).toBe("a.txt");
    expect(files[1]?.newPath).toBe("b.txt");
    expect(files[1]?.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 });
    expect(files[1]?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 5, newLine: 5, text: "ctx5" },
      { kind: "add", oldLine: null, newLine: 6, text: "new6" },
      { kind: "context", oldLine: 6, newLine: 7, text: "ctx7" },
    ]);
  });

  it("computes correct line numbers across multiple hunks in the same file", () => {
    const text = [
      "diff --git a/multi.txt b/multi.txt",
      "index 111..222 100644",
      "--- a/multi.txt",
      "+++ b/multi.txt",
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      " ctx2",
      "@@ -10,2 +10,3 @@",
      " ctx10",
      "+new11",
      " ctx12",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, newLine: null, text: "old1" },
      { kind: "add", oldLine: null, newLine: 1, text: "new1" },
      { kind: "context", oldLine: 2, newLine: 2, text: "ctx2" },
    ]);
    expect(files[0]?.hunks[1]?.lines).toEqual([
      { kind: "context", oldLine: 10, newLine: 10, text: "ctx10" },
      { kind: "add", oldLine: null, newLine: 11, text: "new11" },
      { kind: "context", oldLine: 11, newLine: 12, text: "ctx12" },
    ]);
  });

  it("parses an add-only (new) file", () => {
    const text = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "/dev/null", newPath: "new.txt", binary: false });
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "add", oldLine: null, newLine: 1, text: "line1" },
      { kind: "add", oldLine: null, newLine: 2, text: "line2" },
    ]);
  });

  it("parses a delete-only file", () => {
    const text = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line1",
      "-line2",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "gone.txt", newPath: "/dev/null", binary: false });
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, newLine: null, text: "line1" },
      { kind: "del", oldLine: 2, newLine: null, text: "line2" },
    ]);
  });

  it("parses a pure rename (no content change) with renamedFrom set and no hunks", () => {
    const text = [
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 100%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      oldPath: "old-name.txt",
      newPath: "new-name.txt",
      renamedFrom: "old-name.txt",
      binary: false,
      hunks: [],
    });
  });

  it("parses a renamed AND modified file (rename lines + hunks both present)", () => {
    const text = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 80%",
      "rename from old.txt",
      "rename to new.txt",
      "index 111..222 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1,1 +1,1 @@",
      "-hello",
      "+goodbye",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files[0]).toMatchObject({ oldPath: "old.txt", newPath: "new.txt", renamedFrom: "old.txt" });
    expect(files[0]?.hunks).toHaveLength(1);
  });

  it("marks a binary file diff as binary with no hunks", () => {
    const text = [
      "diff --git a/image.png b/image.png",
      "index 1234567..89abcde 100644",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "image.png", newPath: "image.png", binary: true, hunks: [] });
  });

  it("swallows '\\ No newline at end of file' markers without emitting a DiffLine", () => {
    const text = [
      "diff --git a/nonewline.txt b/nonewline.txt",
      "index 111..222 100644",
      "--- a/nonewline.txt",
      "+++ b/nonewline.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 1, text: "new" },
    ]);
  });

  it("never throws on garbage lines inside a hunk body — they are skipped without disturbing counters", () => {
    const text = [
      "diff --git a/weird.txt b/weird.txt",
      "index 111..222 100644",
      "--- a/weird.txt",
      "+++ b/weird.txt",
      "@@ -1,2 +1,2 @@",
      " ctx1",
      "*** garbage line with no valid marker ***",
      " ctx2",
      "",
    ].join("\n");

    expect(() => parseUnifiedDiff(text)).not.toThrow();
    const files = parseUnifiedDiff(text);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "ctx1" },
      { kind: "context", oldLine: 2, newLine: 2, text: "ctx2" },
    ]);
  });

  it("never throws on entirely garbage/unrecognized input", () => {
    expect(() => parseUnifiedDiff("\x00random\ngarbage\x01bytes")).not.toThrow();
    expect(() => parseUnifiedDiff("diff --git\n@@ garbage @@\n+x")).not.toThrow();
  });

  it("handles a hunk header with omitted counts (implicit 1)", () => {
    const text = [
      "diff --git a/one.txt b/one.txt",
      "index 111..222 100644",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });
});

describe("trimTruncatedTail", () => {
  it("drops an incomplete final line (no trailing newline)", () => {
    expect(trimTruncatedTail("line1\nline2\nline3")).toBe("line1\nline2\n");
  });

  it("keeps a complete final line unchanged (text already ends with a newline)", () => {
    expect(trimTruncatedTail("line1\nline2\n")).toBe("line1\nline2\n");
  });

  it("returns an empty string for text with no newline at all (a single partial line)", () => {
    expect(trimTruncatedTail("partial line with no newline")).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(trimTruncatedTail("")).toBe("");
  });
});

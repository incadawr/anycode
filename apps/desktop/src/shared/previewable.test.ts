/**
 * TASK.112: the single document-extension gate every previewable-path
 * decision now shares. Before this module the same list was hand-copied in
 * six places and `.markdown` was in none of them — these tests pin both the
 * list and the extension math that reads it.
 */
import { describe, expect, it } from "vitest";
import {
  extensionOfPath,
  isMarkdownPath,
  isPreviewableDocPath,
  MARKDOWN_EXTENSIONS,
  PREVIEWABLE_DOC_EXTENSIONS,
} from "./previewable.js";

describe("extensionOfPath", () => {
  it("returns the lowercased extension including the dot", () => {
    expect(extensionOfPath("notes.md")).toBe(".md");
    expect(extensionOfPath("REPORT.HTML")).toBe(".html");
    expect(extensionOfPath("/a/b/c/plan.Markdown")).toBe(".markdown");
  });

  it("splits on BOTH separators, so a win32 path behaves like a POSIX one", () => {
    expect(extensionOfPath("C:\\Users\\me\\notes.md")).toBe(".md");
    expect(extensionOfPath("C:/Users/me/notes.md")).toBe(".md");
  });

  it("reads only the FINAL segment — a dot in a directory name is not the file's extension", () => {
    expect(extensionOfPath("/repo/v1.2/README")).toBe("");
    expect(extensionOfPath("/repo/v1.2/README.md")).toBe(".md");
  });

  it("treats a leading-dot name as extensionless (a bare `.md` entry is not a markdown document)", () => {
    expect(extensionOfPath(".md")).toBe("");
    expect(extensionOfPath("/a/b/.md")).toBe("");
    expect(extensionOfPath(".gitignore")).toBe("");
  });

  it("returns empty for a name with no dot at all", () => {
    expect(extensionOfPath("Makefile")).toBe("");
    expect(extensionOfPath("")).toBe("");
  });
});

describe("isMarkdownPath", () => {
  it("accepts `.markdown` alongside `.md` — the gap TASK.112 closes", () => {
    expect(isMarkdownPath("notes.md")).toBe(true);
    expect(isMarkdownPath("notes.markdown")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMarkdownPath("NOTES.MD")).toBe(true);
    expect(isMarkdownPath("NOTES.MarkDown")).toBe(true);
  });

  it("rejects HTML (a document, but not a markdown one) and every non-document extension", () => {
    expect(isMarkdownPath("page.html")).toBe(false);
    expect(isMarkdownPath("shot.png")).toBe(false);
    expect(isMarkdownPath("run.sh")).toBe(false);
  });

  it("rejects a near-miss extension that merely starts with md", () => {
    expect(isMarkdownPath("notes.mdx")).toBe(false);
    expect(isMarkdownPath("notes.mdown")).toBe(false);
  });
});

describe("isPreviewableDocPath", () => {
  it("accepts every extension PreviewHost renders", () => {
    for (const path of ["a.html", "a.htm", "a.md", "a.markdown"]) {
      expect(isPreviewableDocPath(path)).toBe(true);
    }
  });

  it("rejects raster images — those are a different custody chain (readImage/openPath), never a rendered doc", () => {
    for (const path of ["a.png", "a.jpg", "a.gif", "a.webp", "a.svg"]) {
      expect(isPreviewableDocPath(path)).toBe(false);
    }
  });

  it("rejects executables and anything unlisted", () => {
    for (const path of ["a.command", "a.app", "a.dmg", "a.txt", "Makefile"]) {
      expect(isPreviewableDocPath(path)).toBe(false);
    }
  });
});

describe("the sets themselves", () => {
  it("markdown is a strict subset of the previewable docs", () => {
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(PREVIEWABLE_DOC_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(PREVIEWABLE_DOC_EXTENSIONS.size).toBeGreaterThan(MARKDOWN_EXTENSIONS.size);
  });

  it("pins the exact membership — widening this list widens six gates at once", () => {
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual([".markdown", ".md"]);
    expect([...PREVIEWABLE_DOC_EXTENSIONS].sort()).toEqual([".htm", ".html", ".markdown", ".md"]);
  });
});

/**
 * Pure-logic tests for `findPathSpans` (TASK.112 slice 2) — the scan that
 * turns a path stated in plain prose or inline code ("saved it in
 * report.html") into a candidate for click-to-open verification, since only
 * a real markdown link token gets that affordance for free.
 */
import { describe, expect, it } from "vitest";
import { findPathSpans } from "./path-spans.js";

/** `text.slice(span.start, span.end) === span.path` is the contract every span must honor — checked once, reused by every case below. */
function assertSlicesMatch(text: string, spans: ReturnType<typeof findPathSpans>): void {
  for (const span of spans) {
    expect(text.slice(span.start, span.end)).toBe(span.path);
  }
}

describe("findPathSpans — accepted shapes", () => {
  it("absolute POSIX", () => {
    const text = "see /a/b.md here";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 4, end: 11, path: "/a/b.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("win32 drive path, backslash-separated", () => {
    const text = "open C:\\a\\b.md now";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 5, end: 14, path: "C:\\a\\b.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("win32 drive path, forward-slash-separated", () => {
    const text = "open C:/a/b.md now";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 5, end: 14, path: "C:/a/b.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("home-anchored", () => {
    const text = "read ~/a.md please";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 5, end: 11, path: "~/a.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("dot-relative, both . and ..", () => {
    const text = "go to ./a.md and ../b.md";
    const spans = findPathSpans(text);
    expect(spans).toEqual([
      { start: 6, end: 12, path: "./a.md" },
      { start: 17, end: 24, path: "../b.md" },
    ]);
    assertSlicesMatch(text, spans);
  });

  it("plain relative with separators", () => {
    const text = "see docs/plan.md thanks";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 4, end: 16, path: "docs/plan.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("bare filename", () => {
    const text = "saved plan.md ok";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 6, end: 13, path: "plan.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("accepts every previewable extension, case-insensitively", () => {
    const text = "a.MD b.Markdown c.HTML d.Htm";
    const spans = findPathSpans(text);
    expect(spans.map((s) => s.path)).toEqual(["a.MD", "b.Markdown", "c.HTML", "d.Htm"]);
  });

  it("a path embedded mid-sentence", () => {
    const text = "I saved it to notes.md for later review";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 14, end: 22, path: "notes.md" }]);
  });
});

describe("findPathSpans — URL rejection", () => {
  it("rejects an https:// URL entirely — no partial match on the tail path", () => {
    expect(findPathSpans("visit https://x.com/a.html now")).toEqual([]);
  });

  it("rejects a bare protocol-relative href", () => {
    expect(findPathSpans("see //host/a.md now")).toEqual([]);
  });

  it("does not fire on an unrelated http URL with no previewable-looking tail", () => {
    expect(findPathSpans("see http://example.com/page for details")).toEqual([]);
  });
});

describe("findPathSpans — email-adjacent rejection", () => {
  it("rejects the segment right after an @ ", () => {
    expect(findPathSpans("ping user@notes.md now")).toEqual([]);
  });
});

describe("findPathSpans — non-previewable extensions", () => {
  it("ignores .ts, .png, and .mdx", () => {
    expect(findPathSpans("see plan.ts and img.png and x.mdx")).toEqual([]);
  });

  it("ignores an extensionless name", () => {
    expect(findPathSpans("run the Makefile please")).toEqual([]);
  });
});

describe("findPathSpans — trailing punctuation stripped", () => {
  it("strips a trailing sentence-ending period", () => {
    const text = "see plan.md. thanks";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 4, end: 11, path: "plan.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("stops at a closing parenthesis (not a path character, nothing to strip)", () => {
    const text = "(plan.md) is here";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 1, end: 8, path: "plan.md" }]);
    assertSlicesMatch(text, spans);
  });

  it("strips multiple trailing dots", () => {
    const text = "see plan.md.. thanks";
    const spans = findPathSpans(text);
    expect(spans).toEqual([{ start: 4, end: 11, path: "plan.md" }]);
  });
});

describe("findPathSpans — cap and empty input", () => {
  it("returns [] for text with no candidates", () => {
    expect(findPathSpans("just plain prose here, nothing to see")).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(findPathSpans("")).toEqual([]);
  });

  it("caps output at 32 spans even when far more candidates are present", () => {
    const text = Array.from({ length: 50 }, (_, i) => `f${i}.md`).join(" ");
    const spans = findPathSpans(text);
    expect(spans).toHaveLength(32);
    assertSlicesMatch(text, spans);
    expect(spans[0]?.path).toBe("f0.md");
    expect(spans[31]?.path).toBe("f31.md");
  });
});

describe("findPathSpans — non-overlapping, source order", () => {
  it("returns spans in ascending start order with no overlap", () => {
    const text = "first a/b.md then c/d.html and finally e/f.markdown";
    const spans = findPathSpans(text);
    expect(spans.map((s) => s.path)).toEqual(["a/b.md", "c/d.html", "e/f.markdown"]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });
});

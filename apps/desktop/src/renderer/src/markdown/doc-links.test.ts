import { describe, expect, it } from "vitest";
import { isLocalMdHref, resolveDocRelative } from "./doc-links.js";

describe("resolveDocRelative", () => {
  it("joins a bare relative href onto docDir", () => {
    expect(resolveDocRelative("/workspace/docs", "img.png")).toBe("/workspace/docs/img.png");
  });

  it("joins a ./-prefixed relative href onto docDir", () => {
    expect(resolveDocRelative("/workspace/docs", "./img.png")).toBe("/workspace/docs/img.png");
  });

  it("joins a ../-prefixed relative href, walking up one segment", () => {
    expect(resolveDocRelative("/workspace/docs", "../img.png")).toBe("/workspace/img.png");
  });

  it("joins a nested relative href with a subdirectory", () => {
    expect(resolveDocRelative("/workspace/docs", "assets/img.png")).toBe("/workspace/docs/assets/img.png");
  });

  it("resolves .. and . together, matching path.resolve semantics", () => {
    expect(resolveDocRelative("/workspace/docs/sub", "../../assets/./img.png")).toBe("/workspace/assets/img.png");
  });

  it("clamps at the root instead of throwing when .. overshoots", () => {
    expect(resolveDocRelative("/workspace", "../../../../img.png")).toBe("/img.png");
  });

  it("passes an absolute POSIX path through unchanged", () => {
    expect(resolveDocRelative("/workspace/docs", "/elsewhere/img.png")).toBe("/elsewhere/img.png");
  });

  it("passes an absolute win32 drive path through unchanged", () => {
    expect(resolveDocRelative("/workspace/docs", "C:\\elsewhere\\img.png")).toBe("C:\\elsewhere\\img.png");
  });

  it("passes a win32 UNC path through unchanged", () => {
    expect(resolveDocRelative("/workspace/docs", "\\\\server\\share\\img.png")).toBe("\\\\server\\share\\img.png");
  });

  it("joins a relative href onto a win32 docDir using backslash separators", () => {
    expect(resolveDocRelative("C:\\Users\\me\\docs", "assets/img.png")).toBe("C:\\Users\\me\\docs\\assets\\img.png");
  });

  it("strips a trailing query string before joining", () => {
    expect(resolveDocRelative("/workspace/docs", "img.png?v=2")).toBe("/workspace/docs/img.png");
  });

  it("strips a trailing fragment before joining", () => {
    expect(resolveDocRelative("/workspace/docs", "img.png#thumb")).toBe("/workspace/docs/img.png");
  });

  it("strips query-then-fragment (query precedes fragment) before joining", () => {
    expect(resolveDocRelative("/workspace/docs", "img.png?v=2#thumb")).toBe("/workspace/docs/img.png");
  });

  it("returns null for a URI-scheme href", () => {
    expect(resolveDocRelative("/workspace/docs", "https://example.com/img.png")).toBeNull();
    expect(resolveDocRelative("/workspace/docs", "mailto:a@b.com")).toBeNull();
    expect(resolveDocRelative("/workspace/docs", "data:image/png;base64,abc")).toBeNull();
  });

  it("returns null for a protocol-relative href", () => {
    expect(resolveDocRelative("/workspace/docs", "//example.com/img.png")).toBeNull();
  });

  it("returns null for an empty href", () => {
    expect(resolveDocRelative("/workspace/docs", "")).toBeNull();
  });

  it("returns null when the href is nothing but a fragment/query", () => {
    expect(resolveDocRelative("/workspace/docs", "#top")).toBeNull();
    expect(resolveDocRelative("/workspace/docs", "?x=1")).toBeNull();
  });

  it("does not treat a win32 drive letter as a URI scheme", () => {
    expect(resolveDocRelative("/workspace/docs", "C:/elsewhere/img.png")).toBe("C:/elsewhere/img.png");
  });
});

describe("isLocalMdHref", () => {
  it("accepts `.markdown` alongside `.md`, fragment and query stripped first (TASK.112)", () => {
    expect(isLocalMdHref("other.markdown")).toBe(true);
    expect(isLocalMdHref("./sub/other.markdown")).toBe(true);
    expect(isLocalMdHref("/abs/other.markdown#heading")).toBe(true);
    expect(isLocalMdHref("other.markdown?v=2")).toBe(true);
  });

  it("still rejects a near-miss extension that merely starts with md", () => {
    expect(isLocalMdHref("other.mdx")).toBe(false);
    expect(isLocalMdHref("other.mdown")).toBe(false);
  });

  it("accepts a bare relative .md href", () => {
    expect(isLocalMdHref("other.md")).toBe(true);
  });

  it("accepts a ./-prefixed relative .md href", () => {
    expect(isLocalMdHref("./other.md")).toBe(true);
  });

  it("accepts a ../-prefixed relative .md href", () => {
    expect(isLocalMdHref("../other.md")).toBe(true);
  });

  it("accepts a nested relative .md href", () => {
    expect(isLocalMdHref("sub/other.md")).toBe(true);
  });

  it("accepts an absolute POSIX .md href", () => {
    expect(isLocalMdHref("/elsewhere/other.md")).toBe(true);
  });

  it("accepts an absolute win32 .md href", () => {
    expect(isLocalMdHref("C:\\elsewhere\\other.md")).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(isLocalMdHref("OTHER.MD")).toBe(true);
  });

  it("tolerates a trailing fragment", () => {
    expect(isLocalMdHref("other.md#section")).toBe(true);
  });

  it("tolerates a trailing query", () => {
    expect(isLocalMdHref("other.md?x=1")).toBe(true);
  });

  it("tolerates a trailing query and fragment together", () => {
    expect(isLocalMdHref("other.md?x=1#section")).toBe(true);
  });

  it("rejects a non-.md extension", () => {
    expect(isLocalMdHref("other.txt")).toBe(false);
  });

  it("rejects a filename that merely contains 'md' without the dot-extension", () => {
    expect(isLocalMdHref("notes.mdx")).toBe(false);
  });

  it("rejects an extensionless path", () => {
    expect(isLocalMdHref("docs/readme")).toBe(false);
  });

  it("rejects a bare in-page anchor", () => {
    expect(isLocalMdHref("#section")).toBe(false);
  });

  it("rejects a bare query with no path", () => {
    expect(isLocalMdHref("?x=1")).toBe(false);
  });

  it("rejects a URI-scheme href even when it ends in .md", () => {
    expect(isLocalMdHref("https://example.com/other.md")).toBe(false);
  });

  it("rejects mailto: and data: schemes", () => {
    expect(isLocalMdHref("mailto:a@b.com")).toBe(false);
    expect(isLocalMdHref("data:text/plain,hi")).toBe(false);
  });

  it("rejects a protocol-relative href even when it ends in .md", () => {
    expect(isLocalMdHref("//example.com/other.md")).toBe(false);
  });

  it("rejects an empty href", () => {
    expect(isLocalMdHref("")).toBe(false);
  });

  it("does not treat a win32 drive letter as a URI scheme", () => {
    expect(isLocalMdHref("C:/elsewhere/other.md")).toBe(true);
  });
});

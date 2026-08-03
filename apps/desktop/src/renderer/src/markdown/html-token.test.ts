import { describe, expect, it } from "vitest";
import { classifyHtmlToken } from "./html-token.js";

describe("classifyHtmlToken", () => {
  describe("comments -> hidden", () => {
    it("classifies a single-line comment as hidden", () => {
      expect(classifyHtmlToken("<!-- comment -->")).toEqual({ kind: "hidden" });
    });

    it("classifies a multi-line comment as hidden", () => {
      expect(classifyHtmlToken("<!--\nmulti\nline\ncomment\n-->")).toEqual({ kind: "hidden" });
    });

    it("classifies a Marp-style directive comment as hidden", () => {
      expect(classifyHtmlToken("<!-- _class: lead -->")).toEqual({ kind: "hidden" });
    });

    it("classifies an empty comment as hidden", () => {
      expect(classifyHtmlToken("<!---->")).toEqual({ kind: "hidden" });
    });

    it("tolerates surrounding whitespace around a comment", () => {
      expect(classifyHtmlToken("  <!-- comment -->  ")).toEqual({ kind: "hidden" });
    });
  });

  describe("allowlisted tags -> unwrap", () => {
    const tags = ["span", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "kbd", "code", "mark"];

    for (const tag of tags) {
      it(`unwraps an opening <${tag}> tag`, () => {
        expect(classifyHtmlToken(`<${tag}>`)).toEqual({ kind: "unwrap", tag });
      });

      it(`unwraps a closing </${tag}> tag`, () => {
        expect(classifyHtmlToken(`</${tag}>`)).toEqual({ kind: "unwrap", tag });
      });
    }

    it("unwraps <br>", () => {
      expect(classifyHtmlToken("<br>")).toEqual({ kind: "unwrap", tag: "br" });
    });
  });

  describe("self-closing forms", () => {
    it("unwraps <br/>", () => {
      expect(classifyHtmlToken("<br/>")).toEqual({ kind: "unwrap", tag: "br" });
    });

    it("unwraps <br />", () => {
      expect(classifyHtmlToken("<br />")).toEqual({ kind: "unwrap", tag: "br" });
    });

    it("unwraps a self-closing <span/> with no content", () => {
      expect(classifyHtmlToken("<span/>")).toEqual({ kind: "unwrap", tag: "span" });
    });
  });

  describe("case-insensitivity of tag names", () => {
    it("unwraps <SPAN> and returns the lowercased tag", () => {
      expect(classifyHtmlToken("<SPAN>")).toEqual({ kind: "unwrap", tag: "span" });
    });

    it("unwraps <Br/>", () => {
      expect(classifyHtmlToken("<Br/>")).toEqual({ kind: "unwrap", tag: "br" });
    });

    it("unwraps a mixed-case closing tag </Span>", () => {
      expect(classifyHtmlToken("</Span>")).toEqual({ kind: "unwrap", tag: "span" });
    });
  });

  describe("attributes are discarded but do not block unwrap", () => {
    it("unwraps <span class=\"accent\">, discarding the attribute", () => {
      expect(classifyHtmlToken('<span class="accent">')).toEqual({ kind: "unwrap", tag: "span" });
    });

    it("unwraps a tag with multiple attributes", () => {
      expect(classifyHtmlToken('<span class="accent" id="x" title="y">')).toEqual({ kind: "unwrap", tag: "span" });
    });
  });

  describe("event-handler attributes force literal", () => {
    it("forces literal on onclick", () => {
      expect(classifyHtmlToken('<span onclick="alert(1)">')).toEqual({ kind: "literal" });
    });

    it("forces literal on onerror regardless of spacing/case", () => {
      expect(classifyHtmlToken('<span OnError = "alert(1)">')).toEqual({ kind: "literal" });
    });

    it("forces literal on an event handler alongside other attributes", () => {
      expect(classifyHtmlToken('<span class="accent" onmouseover="x()">')).toEqual({ kind: "literal" });
    });
  });

  describe("non-allowlisted or dangerous tags -> literal", () => {
    it("classifies <script> as literal", () => {
      expect(classifyHtmlToken("<script>")).toEqual({ kind: "literal" });
    });

    it("classifies </script> as literal", () => {
      expect(classifyHtmlToken("</script>")).toEqual({ kind: "literal" });
    });

    it("classifies <iframe> as literal", () => {
      expect(classifyHtmlToken('<iframe src="https://evil.example">')).toEqual({ kind: "literal" });
    });

    it("classifies <style> as literal", () => {
      expect(classifyHtmlToken("<style>")).toEqual({ kind: "literal" });
    });

    it("classifies <div> as literal", () => {
      expect(classifyHtmlToken("<div>")).toEqual({ kind: "literal" });
    });

    it("classifies an <img> with an event-handler attribute as literal", () => {
      expect(classifyHtmlToken("<img src=x onerror=y>")).toEqual({ kind: "literal" });
    });
  });

  describe("malformed input never crashes and classifies as literal", () => {
    it("classifies an unterminated opening tag as literal", () => {
      expect(classifyHtmlToken("<span")).toEqual({ kind: "literal" });
    });

    it("classifies a bare < as literal", () => {
      expect(classifyHtmlToken("<")).toEqual({ kind: "literal" });
    });

    it("classifies <> as literal", () => {
      expect(classifyHtmlToken("<>")).toEqual({ kind: "literal" });
    });

    it("classifies a tag name separated from < by whitespace as literal", () => {
      expect(classifyHtmlToken("< span >")).toEqual({ kind: "literal" });
    });

    it("classifies an empty string as literal", () => {
      expect(classifyHtmlToken("")).toEqual({ kind: "literal" });
    });

    it("classifies a malformed closing tag with trailing junk as literal", () => {
      expect(classifyHtmlToken("</span foo>")).toEqual({ kind: "literal" });
    });

    it("classifies a block token bundling open+content+close as one opaque string as literal", () => {
      expect(classifyHtmlToken('<span class="accent">\nLine content.\n</span>')).toEqual({ kind: "literal" });
    });
  });
});

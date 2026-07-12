/**
 * Behavior pins for markdown/lex.ts (design
 * /working-docs/ui-track/design/slice-R1-cut.md §3.3). These double as pins on
 * marked@18.0.5's token shapes: if a future bump shifts the shapes assumed by
 * the Markdown component's token→element map, these fail loudly at that point
 * rather than silently mis-rendering. Node environment, no jsdom — same
 * rationale as ToolCallCard.test.ts; the component itself is covered by live
 * smoke, not DOM tests.
 */
import { describe, expect, it } from "vitest";
import type { Tokens } from "marked";
import { decodeMarkedText, fenceLabel, lexMarkdown } from "./lex.js";

describe("lexMarkdown", () => {
  it("emits heading tokens with depth 1–6 and inline tokens", () => {
    const tokens = lexMarkdown("# a\n## b\n### c\n#### d\n##### e\n###### f");
    expect(tokens.map((t) => t.type)).toEqual(["heading", "heading", "heading", "heading", "heading", "heading"]);
    expect(tokens.map((t) => (t as Tokens.Heading).depth)).toEqual([1, 2, 3, 4, 5, 6]);
    const first = tokens[0] as Tokens.Heading;
    expect(Array.isArray(first.tokens)).toBe(true);
    expect(first.tokens[0]?.type).toBe("text");
  });

  it("runs an unclosed fence to EOF as a single open code block (no raw-backtick flash by construction)", () => {
    const tokens = lexMarkdown("```ts\nconst x =");
    expect(tokens).toHaveLength(1);
    const code = tokens[0] as Tokens.Code;
    expect(code.type).toBe("code");
    expect(code.lang).toBe("ts");
    expect(code.text).toBe("const x =");
  });

  it("keeps the FULL fence info string on the code token; consumers take the first word", () => {
    const tokens = lexMarkdown("```ts title=x\ncode\n```");
    const code = tokens[0] as Tokens.Code;
    expect(code.lang).toBe("ts title=x");
    expect(fenceLabel(code.lang)).toBe("ts");
  });

  it("marks indented code with codeBlockStyle 'indented' and no lang", () => {
    const tokens = lexMarkdown("    indented");
    const code = tokens[0] as Tokens.Code;
    expect(code.type).toBe("code");
    expect(code.codeBlockStyle).toBe("indented");
    expect(code.lang).toBeUndefined();
  });

  it("codespan with angle brackets round-trips through decodeMarkedText", () => {
    const tokens = lexMarkdown("`a<b>`");
    const codespan = (tokens[0] as Tokens.Paragraph).tokens[0] as Tokens.Codespan;
    expect(codespan.type).toBe("codespan");
    expect(decodeMarkedText(codespan.text)).toBe("a<b>");
  });

  it("codespan preserves inner backticks", () => {
    const tokens = lexMarkdown("``a `b` c``");
    const codespan = (tokens[0] as Tokens.Paragraph).tokens[0] as Tokens.Codespan;
    expect(codespan.text).toBe("a `b` c");
  });

  it("nests an ordered list inside an unordered list (2 levels, tight)", () => {
    const tokens = lexMarkdown("- a\n  1. one\n  2. two\n- b");
    const outer = tokens[0] as Tokens.List;
    expect(outer.type).toBe("list");
    expect(outer.ordered).toBe(false);
    expect(outer.loose).toBe(false);
    const firstItem = outer.items[0] as Tokens.ListItem;
    const inner = firstItem.tokens.find((t) => t.type === "list") as Tokens.List;
    expect(inner.ordered).toBe(true);
    expect(inner.items).toHaveLength(2);
  });

  it("distinguishes loose from tight list items", () => {
    const tight = lexMarkdown("- a\n- b")[0] as Tokens.List;
    expect(tight.loose).toBe(false);
    // A tight item's tokens are a top-level `text` token (inline content).
    expect((tight.items[0] as Tokens.ListItem).tokens[0]?.type).toBe("text");

    const loose = lexMarkdown("- a\n\n- b")[0] as Tokens.List;
    expect(loose.loose).toBe(true);
    // A loose item's tokens are wrapped in a `paragraph`.
    expect((loose.items[0] as Tokens.ListItem).tokens[0]?.type).toBe("paragraph");
  });

  it("marks GFM task list items with task/checked", () => {
    const list = lexMarkdown("- [ ] todo\n- [x] done")[0] as Tokens.List;
    const [todo, done] = list.items as [Tokens.ListItem, Tokens.ListItem];
    expect(todo.task).toBe(true);
    expect(todo.checked).toBe(false);
    expect(done.task).toBe(true);
    expect(done.checked).toBe(true);
  });

  it("resolves inline and reference-style links (def token present in the stream)", () => {
    const inline = lexMarkdown("[t](https://e.com)");
    const inlineLink = (inline[0] as Tokens.Paragraph).tokens[0] as Tokens.Link;
    expect(inlineLink.type).toBe("link");
    expect(inlineLink.href).toBe("https://e.com");

    const ref = lexMarkdown("[t][id]\n\n[id]: https://e.com");
    const refLink = (ref[0] as Tokens.Paragraph).tokens[0] as Tokens.Link;
    expect(refLink.type).toBe("link");
    expect(refLink.href).toBe("https://e.com");
    const def = ref.find((t) => t.type === "def") as Tokens.Def;
    expect(def.tag).toBe("id");
    expect(def.href).toBe("https://e.com");
  });

  it("emits table header/rows/align arrays with per-column alignment", () => {
    const table = lexMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |")[0] as Tokens.Table;
    expect(table.type).toBe("table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header.map((c) => c.text)).toEqual(["a", "b"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.map((c) => c.text)).toEqual(["1", "2"]);
  });

  it("emits strong / em / del and escape tokens", () => {
    const inline = (lexMarkdown("**b** _i_ ~~d~~")[0] as Tokens.Paragraph).tokens;
    expect(inline.filter((t) => t.type === "strong")).toHaveLength(1);
    expect(inline.filter((t) => t.type === "em")).toHaveLength(1);
    expect(inline.filter((t) => t.type === "del")).toHaveLength(1);

    const escaped = (lexMarkdown("\\*not em\\*")[0] as Tokens.Paragraph).tokens;
    expect(escaped[0]?.type).toBe("escape");
    expect((escaped[0] as Tokens.Escape).text).toBe("*");
  });

  it("pins breaks:true — a single newline becomes a br token", () => {
    const paragraph = lexMarkdown("a\nb")[0] as Tokens.Paragraph;
    expect(paragraph.tokens.some((t) => t.type === "br")).toBe(true);
  });

  it("emits an inline html token for inline HTML (rendered as literal text)", () => {
    const inline = (lexMarkdown("x <span>y</span> z")[0] as Tokens.Paragraph).tokens;
    const html = inline.find((t) => t.type === "html") as Tokens.HTML;
    expect(html.type).toBe("html");
    expect(html.block).toBe(false);
  });

  it("emits an image token (alt text + href)", () => {
    const image = (lexMarkdown("![alt txt](https://e.com/i.png)")[0] as Tokens.Paragraph)
      .tokens[0] as Tokens.Image;
    expect(image.type).toBe("image");
    expect(image.href).toBe("https://e.com/i.png");
    expect(image.text).toBe("alt txt");
  });
});

describe("fenceLabel", () => {
  it("returns the lowercased first word for an info string", () => {
    expect(fenceLabel("ts")).toBe("ts");
    expect(fenceLabel("TypeScript")).toBe("typescript");
    expect(fenceLabel("ts title=x")).toBe("ts");
  });

  it("returns null for empty/undefined/whitespace-only info", () => {
    expect(fenceLabel(undefined)).toBeNull();
    expect(fenceLabel("")).toBeNull();
    expect(fenceLabel("   ")).toBeNull();
  });

  it("caps the label at 20 characters", () => {
    expect(fenceLabel("a".repeat(30))).toHaveLength(20);
  });
});

describe("decodeMarkedText", () => {
  it("decodes exactly the five entities marked escapes", () => {
    expect(decodeMarkedText("&lt;&gt;&quot;&#39;&amp;")).toBe("<>\"'&");
  });

  it("decodes &amp; last so &amp;lt; does not double-decode", () => {
    expect(decodeMarkedText("&amp;lt;")).toBe("&lt;");
  });

  it("is idempotent on plain text", () => {
    expect(decodeMarkedText("plain text, no entities")).toBe("plain text, no entities");
    expect(decodeMarkedText(decodeMarkedText("a &lt; b"))).toBe("a < b");
  });
});

// Token-shape pins for two token→element-map decisions in Markdown.tsx that
// live smoke exercises but no DOM test covers. If a future marked bump shifts
// either shape, these fail loudly instead of the component silently
// mis-rendering (the exact "untested and green" gap from the R1 review).
describe("token shapes the Markdown component depends on", () => {
  it("keeps inline-code content VERBATIM (codespan.text is not entity-escaped)", () => {
    // CommonMark: entity references are NOT processed inside inline code, so
    // Markdown.tsx renders `codespan.text` raw (no decodeMarkedText). This pins
    // that marked leaves the literal source in `.text` — decoding it would
    // wrongly collapse an author's literal `&lt;`/`&amp;` inside inline code.
    const [para] = lexMarkdown("`&lt;`") as [Tokens.Paragraph];
    const span = para.tokens?.[0] as Tokens.Codespan;
    expect(span.type).toBe("codespan");
    expect(span.text).toBe("&lt;");
    const [para2] = lexMarkdown("`&amp;`") as [Tokens.Paragraph];
    expect((para2.tokens?.[0] as Tokens.Codespan).text).toBe("&amp;");
  });

  it("nests the checkbox token inside a paragraph for LOOSE task items", () => {
    // A tight task item exposes the checkbox at block level (BlockTokens drops
    // it); a loose (blank-line-separated) item wraps content in a paragraph
    // whose inline tokens lead with the checkbox — so InlineTokens must ALSO
    // drop `checkbox` or a stray "[ ] " renders beside the native <input>.
    const [loose] = lexMarkdown("- [ ] todo\n\n- [x] done") as [Tokens.List];
    expect(loose.type).toBe("list");
    expect(loose.loose).toBe(true);
    const looseItem = loose.items[0] as Tokens.ListItem;
    expect(looseItem.task).toBe(true);
    expect(looseItem.checked).toBe(false);
    const para = looseItem.tokens[0] as Tokens.Paragraph;
    expect(para.type).toBe("paragraph");
    expect(para.tokens?.[0]?.type).toBe("checkbox");

    const [tight] = lexMarkdown("- [ ] a\n- [x] b") as [Tokens.List];
    expect(tight.loose).toBe(false);
    const tightItem = tight.items[0] as Tokens.ListItem;
    expect(tightItem.tokens[0]?.type).toBe("checkbox");
  });
});

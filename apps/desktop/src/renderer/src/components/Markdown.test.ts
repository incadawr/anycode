/**
 * Tests for the TASK.112 slice 2 prose/codespan path-linkification layer
 * grafted onto `Markdown.tsx`. Same `.test.ts`-only, jsdom-free rationale as
 * ToolCallCard.test.ts (this package's renderer tests are pure-logic +
 * `react-dom/server` SSR only): `collectPathCandidates` and
 * `splitTextByVerifiedPaths` are pure and covered directly, then
 * `BlockTokens`/`InlineTokens` are rendered via `renderToStaticMarkup` under
 * an explicit `<PathLinkContext.Provider>` — `Markdown`'s OWN
 * `PathLinkContext` value is effect-derived (the `artifacts.previewable`
 * probe), and effects never run during a static SSR render, so a verified
 * set can only reach a static render as an explicit prop/context like this,
 * exactly the same reasoning `AgentCardBody`/`ToolCallHeaderRow` document in
 * ToolCallCard.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tokens } from "marked";
import {
  BlockTokens,
  collectPathCandidates,
  InlineTokens,
  Markdown,
  MarkdownTabContext,
  PathLinkContext,
  splitTextByVerifiedPaths,
} from "./Markdown.js";
import { lexMarkdown } from "../markdown/lex.js";

describe("collectPathCandidates", () => {
  it("collects a path from a plain-text leaf", () => {
    const tokens = lexMarkdown("I saved it to notes.md for you");
    expect(collectPathCandidates(tokens)).toEqual(["notes.md"]);
  });

  it("collects a codespan candidate only on a WHOLE-content match", () => {
    const wholeMatch = lexMarkdown("open `plan.md` now");
    expect(collectPathCandidates(wholeMatch)).toEqual(["plan.md"]);

    const partialMatch = lexMarkdown("run `cd docs/plan.md` now");
    expect(collectPathCandidates(partialMatch)).toEqual([]);
  });

  it("never collects from inside a real link's own visible text", () => {
    const tokens = lexMarkdown("[see plan.md here](https://example.com)");
    expect(collectPathCandidates(tokens)).toEqual([]);
  });

  it("never collects from a fenced code block", () => {
    const tokens = lexMarkdown("```\nsee plan.md\n```");
    expect(collectPathCandidates(tokens)).toEqual([]);
  });

  it("collects from nested prose: heading, strong/em inside a paragraph, blockquote, list item, table cell", () => {
    const text = [
      "# see notes.md",
      "",
      "para with **bold report.html** and *em plan.md* text",
      "",
      "> quoted docs/spec.md",
      "",
      "- list item mentions readme.markdown",
      "",
      "| file |",
      "| --- |",
      "| cell.md |",
    ].join("\n");
    const found = collectPathCandidates(lexMarkdown(text));
    expect(found).toEqual(
      expect.arrayContaining(["notes.md", "report.html", "plan.md", "docs/spec.md", "readme.markdown", "cell.md"]),
    );
    expect(found).toHaveLength(6);
  });

  it("returns [] for prose with no candidates", () => {
    expect(collectPathCandidates(lexMarkdown("just plain prose, nothing to see"))).toEqual([]);
  });

  it("ignores a non-previewable extension", () => {
    expect(collectPathCandidates(lexMarkdown("see plan.ts and img.png"))).toEqual([]);
  });
});

describe("splitTextByVerifiedPaths", () => {
  it("returns a single plain-text segment, byte-identical, for an empty verified set", () => {
    const text = "I saved it to notes.md for you";
    expect(splitTextByVerifiedPaths(text, new Set())).toEqual([{ kind: "text", value: text }]);
  });

  it("returns a single plain-text segment when the text has candidates but none are verified", () => {
    const text = "I saved it to notes.md for you";
    expect(splitTextByVerifiedPaths(text, new Set(["other.md"]))).toEqual([{ kind: "text", value: text }]);
  });

  it("splits around one verified path into text/link/text", () => {
    const text = "I saved it to notes.md for you";
    expect(splitTextByVerifiedPaths(text, new Set(["notes.md"]))).toEqual([
      { kind: "text", value: "I saved it to " },
      { kind: "link", path: "notes.md" },
      { kind: "text", value: " for you" },
    ]);
  });

  it("omits an empty leading/trailing text segment when the path is at a boundary", () => {
    expect(splitTextByVerifiedPaths("notes.md", new Set(["notes.md"]))).toEqual([{ kind: "link", path: "notes.md" }]);
  });

  it("splits around two verified paths, each getting its own link segment", () => {
    const text = "see a/b.md then c/d.html";
    expect(splitTextByVerifiedPaths(text, new Set(["a/b.md", "c/d.html"]))).toEqual([
      { kind: "text", value: "see " },
      { kind: "link", path: "a/b.md" },
      { kind: "text", value: " then " },
      { kind: "link", path: "c/d.html" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SSR component renders — BlockTokens/InlineTokens directly under an
// explicit PathLinkContext.Provider (see file header for why).
// ─────────────────────────────────────────────────────────────────────────

function renderBlocks(text: string, verified: ReadonlySet<string> = new Set()): string {
  return renderToStaticMarkup(
    createElement(
      PathLinkContext.Provider,
      { value: verified },
      createElement(BlockTokens, { tokens: lexMarkdown(text) }),
    ),
  );
}

describe("Markdown SSR — prose path linkification", () => {
  it("a prose path with a verified set renders a real <a class=\"md-link\">", () => {
    const html = renderBlocks("I saved it to notes.md for you", new Set(["notes.md"]));
    expect(html).toContain('<a class="md-link"');
    expect(html).toContain('href="notes.md"');
    expect(html).toContain(">notes.md</a>");
  });

  it("the SAME prose path with an EMPTY verified set renders plain text, no anchor", () => {
    const html = renderBlocks("I saved it to notes.md for you", new Set());
    expect(html).not.toContain("<a ");
    expect(html).toContain("notes.md");
  });

  it("byte-identical to a bare render (no PathLinkContext at all) when the verified set is empty", () => {
    const bare = renderToStaticMarkup(createElement(BlockTokens, { tokens: lexMarkdown("I saved it to notes.md for you") }));
    const withEmptyProvider = renderBlocks("I saved it to notes.md for you", new Set());
    expect(withEmptyProvider).toBe(bare);
  });

  it("a codespan that is a verified path becomes clickable inside <code>", () => {
    const html = renderBlocks("open `plan.md` now", new Set(["plan.md"]));
    expect(html).toContain('<code class="md-code-inline">');
    expect(html).toContain('<a class="md-link" href="plan.md"');
    expect(html).toContain(">plan.md</a>");
  });

  it("a codespan that is a verified path renders the link NESTED inside the <code> element", () => {
    const html = renderBlocks("open `plan.md` now", new Set(["plan.md"]));
    const codeStart = html.indexOf('<code class="md-code-inline">');
    const linkStart = html.indexOf('<a class="md-link"');
    const codeEnd = html.indexOf("</code>");
    expect(codeStart).toBeGreaterThanOrEqual(0);
    expect(linkStart).toBeGreaterThan(codeStart);
    expect(linkStart).toBeLessThan(codeEnd);
  });

  it("an UNVERIFIED codespan stays plain <code> text, verbatim, no entity decoding", () => {
    const html = renderBlocks("run `cd docs &amp; plan.md` now", new Set(["docs/plan.md"]));
    expect(html).not.toContain('<a class="md-link"');
    // Verbatim (CommonMark codespan rule): the literal &amp; text survives unescaped-looking in source, HTML-escaped for DOM safety by React itself.
    expect(html).toContain("cd docs &amp;amp; plan.md");
  });

  it("a fenced code block containing a previewable-looking name is never linkified", () => {
    const html = renderBlocks("```\nsee plan.md\n```", new Set(["plan.md"]));
    expect(html).not.toContain("<a ");
    expect(html).toContain("plan.md");
    expect(html).toContain("md-codeblock");
  });

  it("a real markdown link whose visible text contains a path does not produce a nested anchor", () => {
    const html = renderBlocks("[see plan.md here](https://example.com)", new Set(["plan.md"]));
    const anchorCount = (html.match(/<a /g) ?? []).length;
    expect(anchorCount).toBe(1);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("see plan.md here</a>");
  });

  it("linkifies a path nested inside strong/em text (linkify propagates through inline recursion)", () => {
    const html = renderBlocks("see **the file notes.md** please", new Set(["notes.md"]));
    expect(html).toContain('<a class="md-link" href="notes.md"');
    expect(html).toContain("<strong>");
  });

  it("multiple verified candidates in one paragraph each get their own link", () => {
    const html = renderBlocks("see a/b.md then c/d.html", new Set(["a/b.md", "c/d.html"]));
    expect((html.match(/<a class="md-link"/g) ?? []).length).toBe(2);
    expect(html).toContain('href="a/b.md"');
    expect(html).toContain('href="c/d.html"');
  });
});

describe("Markdown SSR — full component, no TabContext (empty verified set end to end)", () => {
  it("renders a prose path as plain text with no anchor when mounted with no tab/preload bridge", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "I saved it to notes.md for you" }));
    expect(html).not.toContain("<a ");
    expect(html).toContain("notes.md");
  });
});

describe("InlineTokens — direct render, linkify=false suppresses even a verified candidate", () => {
  it("does not linkify a text leaf when linkify is explicitly false", () => {
    const paragraph = lexMarkdown("see notes.md now")[0] as Tokens.Paragraph;
    const html = renderToStaticMarkup(
      createElement(
        PathLinkContext.Provider,
        { value: new Set(["notes.md"]) },
        createElement(InlineTokens, { tokens: paragraph.tokens, linkify: false }),
      ),
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("notes.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MdLink adornments. A link's sibling row (copy button, "Reveal in folder",
// inline image preview) is gated on BOTH a tab id and the preload bridge, so
// reaching it from a static render needs `MarkdownTabContext` supplied by
// hand plus a stub `window.anycode.artifacts` — the click is never fired, the
// stub exists only to get past the `api !== undefined` guard.
//
// What these pin down: a link the model AUTHORED keeps its adornments, while
// a link MINTED from prose or inline code by the path scan renders bare. The
// distinction is the whole reason `adorned` exists — a "Reveal in folder"
// button injected between the words of a sentence (or, worse, inside a
// `<code>` element) wrecks the prose it is embedded in.
// ─────────────────────────────────────────────────────────────────────────

function withBridge<T>(body: () => T): T {
  const globals = globalThis as { window?: unknown };
  const had = "window" in globals;
  const previous = globals.window;
  globals.window = { anycode: { artifacts: {} } };
  try {
    return body();
  } finally {
    if (had) {
      globals.window = previous;
    } else {
      delete globals.window;
    }
  }
}

function renderInTab(text: string, verified: ReadonlySet<string>): string {
  return withBridge(() =>
    renderToStaticMarkup(
      createElement(
        MarkdownTabContext.Provider,
        { value: "tab-1" },
        createElement(
          PathLinkContext.Provider,
          { value: verified },
          createElement(BlockTokens, { tokens: lexMarkdown(text) }),
        ),
      ),
    ),
  );
}

describe("MdLink adornments", () => {
  it("an AUTHORED markdown link keeps its adornment row", () => {
    const html = renderInTab("see [the notes](notes.md) please", new Set());
    expect(html).toContain('<a class="md-link" href="notes.md"');
    expect(html).toContain("Reveal in folder");
    expect(html).toContain('class="md-link-copy"');
  });

  it("a link MINTED from prose renders bare — no reveal button, no copy button", () => {
    const html = renderInTab("I saved it to notes.md for you", new Set(["notes.md"]));
    expect(html).toContain('<a class="md-link" href="notes.md"');
    expect(html).not.toContain("Reveal in folder");
    expect(html).not.toContain('class="md-link-copy"');
  });

  it("a link minted from a codespan puts no <button> inside the <code> element", () => {
    const html = renderInTab("I saved it to `notes.md` for you", new Set(["notes.md"]));
    expect(html).toContain('<code class="md-code-inline"><a class="md-link" href="notes.md"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Reveal in folder");
  });

  it("adornments are suppressed per-link: an authored link and a minted one in the same paragraph", () => {
    const html = renderInTab("see [the notes](notes.md) and also plan.md", new Set(["plan.md"]));
    // Exactly one reveal button — the authored link's. The minted `plan.md`
    // link contributes none, which is what keeps the count at one.
    expect(html.split("Reveal in folder").length - 1).toBe(1);
    expect(html).toContain('<a class="md-link" href="plan.md"');
  });
});

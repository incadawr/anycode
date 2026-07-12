/**
 * Smoke test for diff/highlight.ts (design §10's MVP.5 test plan): a
 * TypeScript fixture produces real (colored) tokens through the Shiki JS
 * engine, an unknown extension falls back to plaintext, and line counts
 * follow the jsdiff trailing-newline convention documented in compute.ts.
 * Kept deliberately small/smoke-level per the task brief — this exercises
 * the real lazy highlighter singleton (JS regex engine, no WASM) rather than
 * mocking Shiki, so it also doubles as a "the whole lazy-init path actually
 * works under vitest's node environment" check.
 */
import { describe, expect, it } from "vitest";
import { highlightSource } from "./highlight.js";

describe("highlightSource", () => {
  it("tokenizes a TypeScript fixture with real color info (JS-engine singleton, lazy typescript grammar load)", async () => {
    const content = "const answer: number = 42;\nconsole.log(answer);\n";
    const result = await highlightSource(content, "src/example.ts");

    expect(result.highlighted).toBe(true);
    // Trailing "\n" terminates the last line (jsdiff convention, see
    // compute.ts's docstring) -> 2 lines, not 3.
    expect(result.lines).toHaveLength(2);
    const flatFirstLine = result.lines[0]?.map((token) => token.content).join("");
    expect(flatFirstLine).toBe("const answer: number = 42;");
    // At least one token on a real code line should carry a Shiki theme color.
    expect(result.lines[0]?.some((token) => typeof token.color === "string")).toBe(true);
  });

  it("falls back to plaintext for an unrecognized file extension", async () => {
    const content = "just\nsome\ntext\n";
    const result = await highlightSource(content, "notes.some-unknown-ext");

    expect(result.highlighted).toBe(false);
    expect(result.lines).toEqual([[{ content: "just" }], [{ content: "some" }], [{ content: "text" }]]);
  });

  it("falls back to plaintext for a path with no extension at all", async () => {
    const result = await highlightSource("hello\n", "README");
    expect(result.highlighted).toBe(false);
    expect(result.lines).toEqual([[{ content: "hello" }]]);
  });

  it("returns no lines for empty content regardless of extension", async () => {
    const result = await highlightSource("", "src/example.ts");
    expect(result).toEqual({ lines: [], highlighted: false });
  });

  it("reuses the lazy highlighter singleton across calls for the same language", async () => {
    // Second call for the same (already-loaded) language must not throw or
    // hang — exercises the loadedLangs cache-hit path.
    const first = await highlightSource("const a = 1;\n", "a.ts");
    const second = await highlightSource("const b = 2;\n", "b.ts");
    expect(first.highlighted).toBe(true);
    expect(second.highlighted).toBe(true);
  });
});

// ── R1 additive helpers (fence-lang resolver, fontStyle mapper, langId-null
// highlight path). New logic = new pure tests; the existing suite above is
// untouched (guardrail §6.7).
import { fontStyleToCss, highlightCode, langIdForFenceInfo } from "./highlight.js";

describe("langIdForFenceInfo", () => {
  it("maps common fence names to Shiki language ids (first word, case-insensitive)", () => {
    expect(langIdForFenceInfo("ts")).toBe("typescript");
    expect(langIdForFenceInfo("TypeScript")).toBe("typescript");
    expect(langIdForFenceInfo("c++")).toBe("cpp");
    expect(langIdForFenceInfo("sh")).toBe("shellscript");
    expect(langIdForFenceInfo("zsh")).toBe("shellscript");
    expect(langIdForFenceInfo("bash")).toBe("bash");
    expect(langIdForFenceInfo("ts title=x")).toBe("typescript");
  });

  it("returns null for empty/undefined/null and plaintext or unknown names", () => {
    expect(langIdForFenceInfo("")).toBeNull();
    expect(langIdForFenceInfo(undefined)).toBeNull();
    expect(langIdForFenceInfo(null)).toBeNull();
    expect(langIdForFenceInfo("text")).toBeNull();
    expect(langIdForFenceInfo("prisma")).toBeNull();
  });
});

describe("fontStyleToCss", () => {
  it("maps vscode-textmate fontStyle bit flags (1=italic, 2=bold, 4=underline)", () => {
    expect(fontStyleToCss(undefined)).toEqual({});
    expect(fontStyleToCss(0)).toEqual({});
    expect(fontStyleToCss(1)).toEqual({ fontStyle: "italic" });
    expect(fontStyleToCss(2)).toEqual({ fontWeight: "bold" });
    expect(fontStyleToCss(4)).toEqual({ textDecoration: "underline" });
    expect(fontStyleToCss(3)).toEqual({ fontStyle: "italic", fontWeight: "bold" });
    expect(fontStyleToCss(7)).toEqual({
      fontStyle: "italic",
      fontWeight: "bold",
      textDecoration: "underline",
    });
  });
});

describe("highlightCode", () => {
  it("returns plain lines for a null langId without touching the highlighter (hermetic)", async () => {
    const result = await highlightCode("just\nsome\ntext\n", null);
    expect(result.highlighted).toBe(false);
    expect(result.lines).toEqual([[{ content: "just" }], [{ content: "some" }], [{ content: "text" }]]);
  });

  it("returns no lines for empty content", async () => {
    expect(await highlightCode("", null)).toEqual({ lines: [], highlighted: false });
  });
});

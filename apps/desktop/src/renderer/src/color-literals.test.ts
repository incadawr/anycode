import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { maskComments } from "./source-comments.test-utils.js";

// Measured on the UI track after the accent slice and its review fixes.
// Reductions must update this map: never retain unused allowance.
const BASELINE: Record<string, number> = {
  "src/app.css": 6,
  "src/settings.css": 16,
  "src/components/icons.tsx": 6,
  "src/terminal-view.ts": 43,
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function literalLines(source: string, css = false): number[] {
  const clean = maskComments(source, css);
  const literals = /(?<![\w#-])(?:#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|(?:rgba?|hsla?)\s*\()/gi;
  return [...clean.matchAll(literals)].filter(match => {
    const before = clean.slice(0, match.index);
    // SVG fragment references name elements, not colors (including hex-shaped IDs).
    if (/url\(\s*["']?\s*$/i.test(before)) return false;
    if (match[0].startsWith("#") && /(?:\bhref\s*=\s*|\bquerySelector(?:All)?\(\s*)["']$/i.test(before)) return false;
    if (css) {
      // A CSS color belongs to a declaration value, never an ID selector.
      // A selector prelude ends at an opening brace, even with pseudo-classes.
      if (clean.slice(match.index).match(/[{};]/)?.[0] === "{") return false;
      if (before.lastIndexOf("{") < 0) return false;
      const statement = before.slice(Math.max(before.lastIndexOf("{"), before.lastIndexOf("}"), before.lastIndexOf(";")) + 1);
      if (!/(?:^|\s)[\w-]+\s*:[^{};]*$/.test(statement)) return false;
    }
    return true;
  }).map(match => clean.slice(0, match.index).split("\n").length);
}

it("recognizes bounded color literals and ignores comments, selectors and fragment references", () => {
  expect(literalLines(`/* #abc rgba( */\n// #def hsl(\nconst a = "#root"; const b = "#abcdedz"; const c = "url(#abc)";`)).toEqual([]);
  expect(literalLines(`<a href="#abc">anchor</a>; document.querySelectorAll("#fff");`)).toEqual([]);
  expect(literalLines(`#abc { color: #abc; background: url(#fff); }`, true)).toEqual([1]);
  expect(literalLines(`const colors = ["#abc", "#abcd", "#abcdef", "#abcdef12", "rgb(1,2,3)", "rgba(1,2,3,.5)", "hsl(0,0%,0%)", "hsla(0,0%,0%,.5)"];`)).toHaveLength(8);
  expect(literalLines(`const url = "https://example.test/#root";\nconst color = "#abc"; // #def`)).toEqual([2]);
});

it("counts CSS colors after unquoted URL schemes without treating them as JS comments", () => {
  expect(literalLines(".icon { background: url(https://x/a.svg); color:#abc; /* #def */ }", true)).toEqual([1]);
  expect(literalLines('const url = "https://x/a.svg"; const color = "#abc"; // #def')).toEqual([1]);
});
it("does not mistake pseudo-class selectors for declarations", () => {
  expect(literalLines("a:hover #abc { color: #def; }", true)).toEqual([1]);
  expect(literalLines("@media screen { a:hover #abc { color: #def; } }", true)).toEqual([1]);
});

it("preserves multiline template text and counts the actual terminal fallback literals", () => {
  const template = "const theme = `first line\n// preserved template text\nrgba(1, 2, 3, .5) #abc\n`; // #def";
  expect(maskComments(template)).toContain("// preserved template text");
  expect(literalLines(template)).toEqual([3, 3]);
  const terminal = readFileSync(new URL("./terminal-view.ts", import.meta.url), "utf8");
  // 42 hex fallbacks plus the rgba() template in withAccent = 43.
  expect(literalLines(terminal)).toHaveLength(43);
});

it("ratchets renderer color literals per file", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const actual = new Map(files(root)
    .filter(path => /\.(css|ts|tsx|html)$/.test(path) && !/\.test\./.test(path) && !/(?:^|\/)(?:tokens|accents)\.css$/.test(path))
    .map(path => [relative(root, path).replaceAll("\\", "/"), literalLines(readFileSync(path, "utf8"), path.endsWith(".css"))]));
  const errors: string[] = [];
  for (const path of new Set([...Object.keys(BASELINE), ...actual.keys()])) {
    const lines = actual.get(path) ?? [], baseline = BASELINE[path] ?? 0;
    if (lines.length > baseline) errors.push(`${path}: baseline ${baseline}, actual ${lines.length}; color literal lines: ${lines.join(", ")}`);
    if (lines.length < baseline) errors.push(`${path}: baseline ${baseline}, actual ${lines.length}; затяни храповик: обнови базу (tighten the ratchet: update BASELINE)`);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});

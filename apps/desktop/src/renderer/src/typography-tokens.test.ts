import { expect, it } from "vitest";
import ts from "typescript";
import {
  baselineDiff, contextName, createResolver, cssDeclarations, embeddedCss, parseSource, propertyKey, readBaselineJson, readRenderer, rendererFiles,
} from "./guard-utils.test-utils.js";

// Typography must come from the tokens in tokens.css (--fs-*, --lh-*). This guard
// covers, in every renderer file (the UI kit included):
//   - CSS: font-size, line-height and the font shorthand;
//   - CSS strings / <style> text embedded in .ts/.tsx;
//   - TS/TSX style objects (fontSize, lineHeight, font), in .ts and .tsx;
//   - redefinition of --fs-* / --lh-* outside tokens.css (it would change what a
//     "token" means); the cascade is not modeled, any such declaration counts.
//
// Legacy violations are named in typography-baseline.json as
// "file | selector-or-component | property | value" (no line numbers). New
// violations fail; entries that no longer occur also fail, so the baseline can
// only shrink. CI (scripts/check-ui-baselines.mjs) additionally verifies the
// baseline is a subset of the target branch's. Never add entries to admit new UI.
//
// Boundary: values built at runtime (non-literal expressions, props, function
// results) are violations; a same-file const that resolves to an allowed token
// string passes.

const CANONICAL = "tokens.css";

/** Typography tokens, read from tokens.css so the set cannot drift. */
const TOKENS = new Set(
  [...readRenderer(CANONICAL).matchAll(/(^|[;{\s])(--(?:fs|lh)-[a-z0-9]+)\s*:/gm)].map(match => match[2]!),
);

/** Keyword values that carry no size of their own. */
const KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "normal"]);

const BASELINE = readBaselineJson<string[]>("typography-baseline.json");

const PROPERTIES = new Set(["font-size", "line-height", "font"]);
const TOKEN_CALL = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i;
const WEIGHT_WORDS = /^(?:normal|italic|oblique|bold|bolder|lighter|small-caps)$/i;

function isToken(value: string, prefix: "fs" | "lh"): boolean {
  const match = TOKEN_CALL.exec(value.trim());
  return !!match && match[1]!.startsWith(`--${prefix}-`) && TOKENS.has(match[1]!);
}

/** Whitespace tokens at top level, with a top-level "/" as its own token. */
function shorthandParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = "";
  const push = (): void => { if (current) parts.push(current); current = ""; };
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(char)) push();
    else if (depth === 0 && char === "/") { push(); parts.push("/"); }
    else current += char;
  }
  push();
  return parts;
}

export function typographyValueAllowed(property: string, value: string): boolean {
  const v = value.trim();
  if (KEYWORDS.has(v.toLowerCase())) return true;
  if (property === "font-size") return isToken(v, "fs");
  if (property === "line-height") return isToken(v, "lh");
  if (property !== "font") return false;
  // font: [style/weight]* <--fs token> [/ <--lh token | normal>] <family...>
  const parts = shorthandParts(v);
  const size = parts.findIndex(part => isToken(part, "fs"));
  if (size < 0) return false;
  const prefixOk = parts.slice(0, size).every(part => WEIGHT_WORDS.test(part) || /^[1-9]00$/.test(part) || /^var\(\s*--w-[a-z0-9-]+\s*\)$/i.test(part));
  if (!prefixOk) return false;
  let next = size + 1;
  if (parts[next] === "/") {
    const height = parts[next + 1];
    if (height === undefined || !(isToken(height, "lh") || height.toLowerCase() === "normal")) return false;
    next += 2;
  }
  const family = parts.slice(next);
  // Family names only: no numeric sizes may hide here.
  return family.length > 0 && family.every(part => part !== "/" && !/^[+-]?[\d.]/.test(part) && !/^(?:calc|var\(\s*--(?:fs|lh)-)/i.test(part));
}

const isTypographyVariable = (property: string): boolean => /^--(?:fs|lh)-/.test(property);

export function cssEntries(path: string, source: string, prefix = ""): string[] {
  return cssDeclarations(source).flatMap(decl => {
    const name = `${path} | ${prefix}${decl.context} | ${decl.property} | ${decl.value}`;
    if (PROPERTIES.has(decl.property) && !typographyValueAllowed(decl.property, decl.value)) return [name];
    if (isTypographyVariable(decl.property) && path !== CANONICAL) return [name];
    return [];
  });
}

export function scriptEntries(path: string, source: string): string[] {
  const file = parseSource(path, source);
  const resolver = createResolver(file);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = propertyKey(node, resolver);
      const init = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const css = key === "fontSize" ? "font-size" : key === "lineHeight" ? "line-height" : key === "font" ? "font" : undefined;
      if (key !== undefined && (css || isTypographyVariable(key))) {
        const literal = resolver.string(init);
        const ok = css !== undefined && literal !== undefined && typographyValueAllowed(css, literal);
        if (!ok) out.push(`${path} | ${contextName(node)} | ${key} | ${literal ?? init.getText(file).replace(/\s+/g, " ")}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const { css, context } of embeddedCss(file)) out.push(...cssEntries(path, css, `css-string in ${context} :: `));
  return out;
}

export function collectEntries(): string[] {
  return [
    ...rendererFiles(/\.css$/).flatMap(path => cssEntries(path, readRenderer(path))),
    ...rendererFiles(/\.tsx?$/).flatMap(path => scriptEntries(path, readRenderer(path))),
  ].sort();
}

it("reads the typography token set from tokens.css", () => {
  expect([...TOKENS].sort()).toEqual(expect.arrayContaining(["--fs-sm", "--fs-md", "--lh-body", "--lh-tight"]));
  expect(TOKENS.has("--font-ui")).toBe(false);
});

it("accepts typography tokens and keywords and rejects everything else", () => {
  expect(typographyValueAllowed("font-size", "var(--fs-sm)")).toBe(true);
  expect(typographyValueAllowed("line-height", "var(--lh-body)")).toBe(true);
  expect(typographyValueAllowed("font-size", "inherit")).toBe(true);
  expect(typographyValueAllowed("line-height", "normal")).toBe(true);
  expect(typographyValueAllowed("font-size", "var(--anything)")).toBe(false);
  expect(typographyValueAllowed("font-size", "var(--lh-body)")).toBe(false);
  expect(typographyValueAllowed("font-size", "var(--bg)")).toBe(false);
  expect(typographyValueAllowed("font-size", "var(--fs-sm, 13px)")).toBe(false);
  expect(typographyValueAllowed("font-size", "13px")).toBe(false);
  expect(typographyValueAllowed("line-height", "1.4")).toBe(false);
  expect(typographyValueAllowed("font-size", "calc(var(--fs-sm) * 2)")).toBe(false);
});

it("parses font shorthand parts instead of stripping the slash", () => {
  expect(typographyValueAllowed("font", "12px/1.4 sans-serif")).toBe(false);
  expect(typographyValueAllowed("font", "var(--fs-sm) / var(--lh-tight) var(--font-ui)")).toBe(true);
  expect(typographyValueAllowed("font", "var(--fs-sm)/var(--lh-tight) var(--font-ui)")).toBe(true);
  expect(typographyValueAllowed("font", "600 var(--fs-sm) var(--font-mono)")).toBe(true);
  expect(typographyValueAllowed("font", "var(--w-normal) var(--fs-xs)/var(--lh-tight) var(--font-ui)")).toBe(true);
  expect(typographyValueAllowed("font", "inherit")).toBe(true);
  // Review bypass: a numeric line-height was mistaken for a font-weight.
  expect(typographyValueAllowed("font", "var(--fs-sm)/100 var(--font-ui)")).toBe(false);
  expect(typographyValueAllowed("font", "var(--fs-sm)/1.2 var(--font-ui)")).toBe(false);
  expect(typographyValueAllowed("font", "var(--fs-sm)/calc(1 + 1) var(--font-ui)")).toBe(false);
  expect(typographyValueAllowed("font", "var(--fs-sm) var(--font-ui) 90px")).toBe(false);
  expect(typographyValueAllowed("font", "var(--font-ui)")).toBe(false);
});

it("finds violations in CSS (nested at-rules included)", () => {
  expect(cssEntries("x.css", "@media (a) { .a { font-size: 12px; line-height: var(--lh-body) } } .b{font:12px x}")).toEqual([
    "x.css | @media (a) > .a | font-size | 12px",
    "x.css | .b | font | 12px x",
  ]);
});

it("flags redefinition of typography tokens outside tokens.css, whatever the cascade", () => {
  // Review bypass: .a { --fs-sm:90px; font-size:var(--fs-sm) } passed.
  expect(cssEntries("x.css", ".a { --fs-sm:90px; font-size:var(--fs-sm) }")).toEqual(["x.css | .a | --fs-sm | 90px"]);
  expect(cssEntries("tokens.css", ":root { --fs-sm: 0.8rem }")).toEqual([]);
  expect(scriptEntries("x.tsx", 'const C = () => <i style={{ "--lh-body": 9 }} />;')).toEqual(["x.tsx | C | --lh-body | 9"]);
});

it("survives escaped quotes and later declarations in CSS", () => {
  // Review bypass: content:"\"" desynchronised the quote tracking and hid the next rule.
  expect(cssEntries("x.css", '.a { content:"\\"" } .b{font-size:90px}')).toEqual(["x.css | .b | font-size | 90px"]);
  expect(cssEntries("x.css", ".a { font-size:90px !important } .a { font-size: inherit }")).toEqual(["x.css | .a | font-size | 90px"]);
  expect(cssEntries("x.css", "/* .a{font-size:1px} */ .b{background:url(a;b.png);font-size:2px}")).toEqual(["x.css | .b | font-size | 2px"]);
});

it("checks inline font and style objects in .ts as well as .tsx", () => {
  // Review bypasses: inline font was not checked; .ts files were skipped.
  expect(scriptEntries("x.tsx", 'const C = () => <i style={{font: "90px sans-serif"}} />;')).toEqual(["x.tsx | C | font | 90px sans-serif"]);
  expect(scriptEntries("x.ts", "export const style = { fontSize: 12, lineHeight: 1.5 };")).toEqual([
    "x.ts | style | fontSize | 12",
    "x.ts | style | lineHeight | 1.5",
  ]);
});

it("resolves same-file constants and still rejects dynamic values", () => {
  const source = 'const SIZE = "var(--fs-sm)"; const BAD = "9px"; const C = (p: { s: string }) => [{ fontSize: SIZE }, { fontSize: BAD }, { fontSize: p.s }, { lineHeight: SIZE }];';
  expect(scriptEntries("x.tsx", source)).toEqual([
    "x.tsx | C | fontSize | 9px",
    "x.tsx | C | fontSize | p.s",
    "x.tsx | C | lineHeight | var(--fs-sm)",
  ]);
});

it("does not resolve names declared more than once in a file (review bypass: shadowed const)", () => {
  const source = 'const size = "var(--fs-sm)"; function C() { const size = "90px"; return <div style={{ fontSize: size }} />; }';
  expect(scriptEntries("x.tsx", source)).toEqual(["x.tsx | C | fontSize | size"]);
});

it("handles static computed keys (review bypass)", () => {
  expect(scriptEntries("x.tsx", 'const C = () => <i style={{ ["fontSize"]: 90, ["lineHeight"]: "var(--lh-body)" }} />;')).toEqual(["x.tsx | C | fontSize | 90"]);
  expect(scriptEntries("x.tsx", 'const K = "font"; const C = () => <i style={{ [K]: "9px serif" }} />;')).toEqual(["x.tsx | C | font | 9px serif"]);
});

it("resolves static interpolations in CSS templates and flags unknown ones (review bypass)", () => {
  expect(scriptEntries("x.ts", 'const css = `.a{font-size:${"90px"}}`;')).toEqual(["x.ts | css-string in css :: .a | font-size | 90px"]);
  expect(scriptEntries("x.ts", 'const css = `.a{font-size:${"var(--fs-sm)"}}`;')).toEqual([]);
  expect(scriptEntries("x.ts", "const css = (n: number) => `.a{font-size:${n}px}`;")).toEqual(["x.ts | css-string in css :: .a | font-size | var(--dynamic-interpolation)px"]);
});

it("checks CSS embedded in strings and <style> text", () => {
  expect(scriptEntries("x.tsx", "const css = `.a { font-size: 13px }`; const D = () => <style>{`.b{line-height:2}`}</style>;")).toEqual([
    "x.tsx | css-string in css :: .a | font-size | 13px",
    "x.tsx | css-string in D :: .b | line-height | 2",
  ]);
});

// Parses the whole renderer tree: ~2 s alone, past the 5 s default on a loaded CI runner.
it("has no typography outside tokens beyond the named baseline, and no stale baseline entries", () => {
  const { added, stale } = baselineDiff(collectEntries(), BASELINE);
  expect({ added, stale }, [
    ...added.map(entry => `new violation (use a --fs-*/--lh-* token): ${entry}`),
    ...stale.map(entry => `stale baseline entry (fixed; remove it): ${entry}`),
  ].join("\n")).toEqual({ added: [], stale: [] });
}, 60_000);

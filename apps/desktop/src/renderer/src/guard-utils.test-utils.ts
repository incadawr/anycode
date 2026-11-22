import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const RENDERER_ROOT = fileURLToPath(new URL("./", import.meta.url));

/** Renderer source files (relative, posix paths), excluding tests and test utilities. */
export function rendererFiles(extensions: RegExp): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  return walk(RENDERER_ROOT)
    .map(path => relative(RENDERER_ROOT, path).replaceAll("\\", "/"))
    .filter(path => extensions.test(path) && !/\.test(?:-utils)?\.[cm]?[jt]sx?$/.test(path))
    .sort();
}

export function readRenderer(path: string): string {
  return readFileSync(join(RENDERER_ROOT, path), "utf8");
}

export function readBaselineJson<T>(name: string): T {
  return JSON.parse(readRenderer(name)) as T;
}

export interface CssDeclaration {
  /** At-rule path plus the full selector prelude, whitespace-normalized; no line numbers. */
  context: string;
  /** The enclosing at-rule path (empty at top level). */
  parent: string;
  /** Individual selectors of the innermost rule (the prelude split on top-level commas). */
  selectors: string[];
  property: string;
  value: string;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) { if (char === "\\") i++; else if (char === quote) quote = ""; continue; }
    if (char === "\\") { i++; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Flat declaration list of a stylesheet. A small tokenizer: comments are removed
 * outside strings, strings honor backslash escapes, escaped characters never act
 * as delimiters, and parentheses (url(), var(), calc()) shield `;{}`. Nested
 * at-rules (@media, @supports, @keyframes) are tracked in the context. The
 * cascade is NOT modeled: every declaration is reported, whatever overrides it.
 */
export function cssDeclarations(source: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  let paren = 0;
  let quote = "";
  const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
  const flush = (): void => {
    const text = norm(buffer);
    buffer = "";
    const colon = text.indexOf(":");
    if (!text || colon < 0 || stack.length === 0) return;
    const prelude = stack[stack.length - 1]!;
    out.push({
      context: stack.join(" > "),
      parent: stack.slice(0, -1).join(" > "),
      selectors: prelude.startsWith("@") ? [prelude] : splitTopLevel(prelude, ",").map(norm).filter(Boolean),
      property: text.slice(0, colon).trim().toLowerCase(),
      value: norm(text.slice(colon + 1)).replace(/\s*!\s*important$/i, ""),
    });
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      buffer += char;
      if (char === "\\" && i + 1 < source.length) buffer += source[++i]!;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\\") { buffer += char; if (i + 1 < source.length) buffer += source[++i]!; continue; }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      buffer += " ";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; buffer += char; continue; }
    if (char === "(") paren++;
    if (char === ")") paren = Math.max(0, paren - 1);
    if (paren === 0 && char === "{") { stack.push(norm(buffer)); buffer = ""; continue; }
    if (paren === 0 && char === ";") { flush(); continue; }
    if (paren === 0 && char === "}") { flush(); stack.pop(); continue; }
    buffer += char;
  }
  return out;
}

/** Multiset difference of two string lists, used by the named-baseline guards. */
export function baselineDiff(actual: string[], baseline: string[]): { added: string[]; stale: string[] } {
  const remaining = new Map<string, number>();
  for (const entry of baseline) remaining.set(entry, (remaining.get(entry) ?? 0) + 1);
  const added: string[] = [];
  for (const entry of actual) {
    const left = remaining.get(entry) ?? 0;
    if (left > 0) remaining.set(entry, left - 1);
    else added.push(entry);
  }
  const stale = [...remaining].flatMap(([entry, count]) => Array<string>(count).fill(entry));
  return { added: added.sort(), stale: stale.sort() };
}

// ---- TypeScript helpers shared by the guards -------------------------------

export function parseSource(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

export function contextName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
  }
  return "<module>";
}

export function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
  return cur;
}

export interface Resolver {
  /** A compile-time string for the expression, or undefined when it is dynamic. Same-file const literals are followed. */
  string(expr: ts.Expression): string | undefined;
  /** The object literal an expression denotes (inline or via a same-file const), if any. */
  object(expr: ts.Expression): ts.ObjectLiteralExpression | undefined;
}

export function createResolver(file: ts.SourceFile): Resolver {
  const consts = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && node.parent && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      // The first declaration wins; shadowing in other scopes is a known boundary.
      if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const str = (expr: ts.Expression, seen: Set<string>): string | undefined => {
    const e = unwrap(expr);
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = str(e.left, seen), right = str(e.right, seen);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isIdentifier(e) && consts.has(e.text) && !seen.has(e.text)) return str(consts.get(e.text)!, new Set([...seen, e.text]));
    return undefined;
  };
  const obj = (expr: ts.Expression, seen: Set<string>): ts.ObjectLiteralExpression | undefined => {
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isIdentifier(e) && consts.has(e.text) && !seen.has(e.text)) return obj(consts.get(e.text)!, new Set([...seen, e.text]));
    return undefined;
  };
  return { string: expr => str(expr, new Set()), object: expr => obj(expr, new Set()) };
}

export function propertyKey(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return undefined;
  const name = prop.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** Properties of an object literal with literal spreads (inline or same-file const) flattened. */
export function flattenObject(obj: ts.ObjectLiteralExpression, resolver: Resolver, depth = 0): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop) && depth < 5) {
      const inner = resolver.object(prop.expression);
      if (inner) for (const [k, v] of flattenObject(inner, resolver, depth + 1)) out.set(k, v);
    } else if (ts.isPropertyAssignment(prop)) {
      const key = propertyKey(prop);
      if (key !== undefined) out.set(key, prop.initializer);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      out.set(prop.name.text, prop.name);
    }
  }
  return out;
}

/** String-like snippets of a file that look like embedded CSS (css strings, templates, <style> text). */
export function embeddedCss(file: ts.SourceFile): { css: string; context: string }[] {
  const out: { css: string; context: string }[] = [];
  const looksLikeCss = (text: string): boolean => /\{[^{}]*[\w-]+\s*:[^{}]*\}/.test(text);
  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteralLike(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(span => "0" + span.literal.text).join("");
    else if (ts.isJsxText(node) && node.parent && ts.isJsxElement(node.parent) && ts.isIdentifier(node.parent.openingElement.tagName) && node.parent.openingElement.tagName.text === "style") text = node.text;
    if (text !== undefined && looksLikeCss(text)) out.push({ css: text, context: contextName(node) });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { maskComments } from "./source-comments.test-utils.js";

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

export interface CssDeclaration {
  /** At-rule path plus selector, whitespace-normalized; no line numbers. */
  context: string;
  property: string;
  value: string;
}

/** Flat declaration list of a stylesheet. Handles nested at-rules (@media, @supports, @keyframes) and comments. */
export function cssDeclarations(source: string): CssDeclaration[] {
  const clean = maskComments(source, true);
  const out: CssDeclaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  let paren = 0;
  let quote = "";
  const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
  const flushDeclaration = (): void => {
    const text = norm(buffer);
    buffer = "";
    const colon = text.indexOf(":");
    if (!text || colon < 0 || stack.length === 0) return;
    out.push({
      context: stack.join(" > "),
      property: text.slice(0, colon).trim().toLowerCase(),
      value: norm(text.slice(colon + 1)).replace(/\s*!important$/i, ""),
    });
  };
  for (const char of clean) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; buffer += char; continue; }
    if (char === "(") paren++;
    if (char === ")") paren = Math.max(0, paren - 1);
    if (paren === 0 && char === "{") { stack.push(norm(buffer)); buffer = ""; continue; }
    if (paren === 0 && char === ";") { flushDeclaration(); continue; }
    if (paren === 0 && char === "}") { flushDeclaration(); stack.pop(); continue; }
    buffer += char;
  }
  return out;
}

/** Multiset difference of two sorted-or-unsorted string lists, used by the named-baseline guards. */
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

/**
 * Cross-review D1 guard (Taskana 4070): renderer PRODUCTION code must never
 * VALUE-import the `@anycode/core` package ROOT — the root barrel re-exports
 * core's whole module graph (NodeExecutionAdapter, node:fs, node:child_process,
 * node:sqlite, …), and the renderer is a plain web target (electron.vite.config.ts:
 * "renderer: plain web target, zero Node"). A value import of the root pulls
 * all of that into the browser bundle and breaks `electron-vite build` with
 * `"dirname" is not exported by "__vite-browser-external"` — exactly the
 * break 6c7c346d shipped when PermissionModal.tsx switched from the
 * `@anycode/core/permissions/safe-command` subpath to the root barrel.
 *
 * This enforces, as a test, the invariant documented in subagent-card.ts
 * ("all renderer PRODUCTION code imports core type-only, never as a value")
 * so it can never silently regress again — vitest and tsc both pass on a
 * root value-import; only the bundler trips, which is far too late.
 *
 * Test files are exempt: they run in vitest's node environment and are never
 * bundled (same carve-out subagent-card.test.ts relies on for its parity
 * pins). Subpath imports (`@anycode/core/…`) are fine when their module
 * graph is browser-safe — safe-command and bash-risk-plaque are the two
 * sanctioned ones today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = join(import.meta.dirname, "src");

/** Recursively collect renderer source files, excluding `*.test.ts` test files. */
function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...productionFiles(path));
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/**
 * Extracts complete import statements (single- or multi-line) and dynamic
 * import/require calls from a TypeScript source, as flat strings. Statements
 * inside block comments are ignored — `/* import x from "y" *​/` in a doc
 * comment (like the one at the top of subagent-card.ts) is not code.
 */
function importStatementsOf(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const statements: string[] = [];
  // import … from "spec"; / import "spec"; / export … from "spec";
  const importRe = /(?:^|\n)\s*(?:import|export)\b[^;]*?;/g;
  for (const match of withoutComments.matchAll(importRe)) statements.push(match[0]);
  // dynamic import("spec") / require("spec")
  const callRe = /(?:import|require)\s*\(\s*["'][^"']+["']\s*\)/g;
  for (const match of withoutComments.matchAll(callRe)) statements.push(match[0]);
  return statements;
}

/** The VALUE-import statements of the core ROOT barrel, if any: a statement
 * whose module specifier is exactly `@anycode/core` (never a subpath) and
 * which is not `import type` / `export type` (erased at compile time, so
 * they never emit a module record the bundler must resolve). */
function rootValueImportOf(statement: string): string | null {
  for (const quote of ['"', "'"]) {
    const specifier = quote + "@anycode/core" + quote;
    const at = statement.indexOf(specifier);
    if (at === -1) continue;
    // A subpath (`@anycode/core/permissions/...`) is not the root barrel.
    if (statement.slice(at + specifier.length).startsWith("/")) continue;
    if (/\b(?:import|export)\s+type\b/.test(statement)) continue; // type-only: erased
    return statement.replace(/\s+/g, " ").trim();
  }
  return null;
}

describe("renderer production code never value-imports the @anycode/core root (D1)", () => {
  it("no non-test renderer file has a value import/require of \"@anycode/core\"", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(RENDERER_ROOT)) {
      const source = readFileSync(file, "utf8");
      const statements = importStatementsOf(source);
      for (const statement of statements) {
        const offender = rootValueImportOf(statement);
        if (offender !== null) offenders.push(`${file}: ${offender}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the detector itself works: it flags a root value import and spares type/subpath ones", () => {
    expect(rootValueImportOf('import { X } from "@anycode/core";')).toContain("@anycode/core");
    expect(rootValueImportOf('const core = require("@anycode/core");')).toContain("@anycode/core");
    expect(rootValueImportOf('const mod = await import("@anycode/core");')).toContain("@anycode/core");
    expect(rootValueImportOf('import type { RiskLevel } from "@anycode/core";')).toBeNull();
    expect(rootValueImportOf('import { x } from "@anycode/core/permissions/safe-command";')).toBeNull();
  });

  it("the extractor skips commented-out imports and stitches multi-line ones", () => {
    const source = [
      "/* doc: import { nope } from \"@anycode/core\"; still doc */",
      "// import { nope2 } from \"@anycode/core\";",
      "import type {",
      "  RiskLevel,",
      "} from \"@anycode/core\";",
      "import {",
      "  bashRiskPlaque,",
      "} from \"@anycode/core\";",
    ].join("\n");
    const offenders = importStatementsOf(source)
      .map((statement) => rootValueImportOf(statement))
      .filter((offender): offender is string => offender !== null);
    expect(offenders).toEqual(['import { bashRiskPlaque, } from "@anycode/core";']);
  });

  it("the guard actually sees files (sanity: renderer tree non-empty, PermissionModal present)", () => {
    const files = productionFiles(RENDERER_ROOT);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("PermissionModal.tsx"))).toBe(true);
  });
});

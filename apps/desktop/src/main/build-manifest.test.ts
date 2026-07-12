/**
 * Eternal guard for the packaged dependency manifest (design slice-2.6-cut.md

 * `out/main` chunk imports an external bare-specifier package that is NOT in
 * `apps/desktop/package.json#dependencies`, that package is missing at runtime in
 * the packaged app. This test scans the built main-process bundle for external
 * imports and asserts the set is a subset of `dependencies ∪ node-builtins ∪
 * {electron}` — catching a future "new external dep forgotten in package.json"
 * regression, and the specific fix this slice makes (`@vscode/ripgrep` moved to

 *
 * Runs only when `out/main` exists (i.e. after `pnpm --filter @anycode/desktop
 * build`). In the CI gate the test step runs before the build step, so it skips
 * cleanly there — the same skip-if-prerequisite-missing pattern as
 * node-pty-preflight.test.ts. It is exercised post-build locally and in 2.6.4.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..", "..");
const outMainDir = join(desktopRoot, "out", "main");
const HAS_BUILD = existsSync(outMainDir);

const WORD = /[A-Za-z0-9_$]/;
const VALUE_END = /[A-Za-z0-9_$)\]]/;

/**
 * Single-pass lexer returning module specifiers that appear in REAL import
 * positions (`from "x"`, side-effect `import "x"`, dynamic `import("x")`,
 * `require("x")`). Strings, comments and regex literals are tracked so
 * specifier-like text inside them is ignored — critically a JSDoc
 * `@param {import('selderee')}` type annotation (a bundled false positive noted
 * in spike-electron-builder.md) and a `"from"` string element are NOT counted.
 */
function extractSpecifiers(code: string): Set<string> {
  const specs = new Set<string>();
  const n = code.length;
  let i = 0;
  let prevWord = "";
  let lastSig = "";
  let callPending = false;

  while (i < n) {
    const c = code[i] ?? "";
    const d = i + 1 < n ? code[i + 1] : "";

    if (c === "/" && d === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "/" && !VALUE_END.test(lastSig)) {
      // regex literal (a `/` after a value-ending char would be division)
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = code[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { i += 1; break; }
        else if (rc === "\n") break;
        i += 1;
      }
      lastSig = "/";
      prevWord = "";
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      let body = "";
      while (i < n) {
        const sc = code[i];
        if (sc === "\\") { body += code[i + 1] ?? ""; i += 2; continue; }
        if (sc === quote) { i += 1; break; }
        body += sc;
        i += 1;
      }
      // A specifier must IMMEDIATELY follow the keyword (only whitespace/comments
      // between) — `prevWord` is cleared by any intervening operator, so a
      // variable named `from` in `typeof from === "object"` never matches.
      if (prevWord === "from" || prevWord === "import" || callPending) specs.add(body);
      callPending = false;
      lastSig = quote;
      prevWord = "";
      continue;
    }

    if (WORD.test(c)) {
      let word = "";
      while (i < n && WORD.test(code[i] ?? "")) { word += code[i] ?? ""; i += 1; }
      lastSig = word[word.length - 1] ?? "";
      let j = i;
      while (j < n && /\s/.test(code[j] ?? "")) j += 1;
      if ((word === "import" || word === "require") && code[j] === "(") callPending = true;
      prevWord = word;
      continue;
    }

    if (/\s/.test(c)) { i += 1; continue; }

    if (c === ")") callPending = false;
    lastSig = c;
    prevWord = "";
    i += 1;
  }
  return specs;
}

/** Package name of a bare specifier (`zod/v4` -> `zod`, `@scope/x/y` -> `@scope/x`). */
function packageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

function collectJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...collectJsFiles(p));
    else if (p.endsWith(".js")) files.push(p);
  }
  return files;
}

function externalPackageNames(): Set<string> {
  const builtins = new Set(builtinModules);
  const names = new Set<string>();
  for (const file of collectJsFiles(outMainDir)) {
    for (const spec of extractSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative/absolute
      if (spec.startsWith("node:")) continue; // node builtin
      const name = packageName(spec);
      if (builtins.has(name)) continue; // bare node builtin (path, fs, os, …)
      names.add(name);
    }
  }
  return names;
}

function declaredDependencies(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return new Set(Object.keys(pkg.dependencies ?? {}));
}

describe("built main bundle external-import manifest guard", () => {
  it.skipIf(!HAS_BUILD)(
    "imports only packages in dependencies ∪ builtins ∪ {electron}",
    () => {
      const externals = externalPackageNames();
      const allowed = declaredDependencies();
      allowed.add("electron"); // runtime-provided host, not an npm dependency

      const undeclared = [...externals].filter((name) => !allowed.has(name));
      expect(undeclared, `undeclared external imports in out/main: ${undeclared.join(", ")}`).toEqual([]);
    },
  );

  it.skipIf(!HAS_BUILD)(
    "resolves @vscode/ripgrep and node-pty as real external imports (rg-regression guard)",
    () => {
      // The whole point of the dep reclassification: @vscode/ripgrep is now an
      // external import (so the platform rg binary resolves) rather than inlined

      const externals = externalPackageNames();
      expect(externals.has("@vscode/ripgrep")).toBe(true);
      expect(externals.has("node-pty")).toBe(true);
    },
  );
});

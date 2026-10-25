/**
 * The preload runs sandboxed: it may require only "electron". A value import
 * from a shared module that itself imports a package (zod) bundles a
 * `require("zod")` into the preload, which then fails to load and the renderer
 * starts without `window.anycode` (v0.0.37 release self-check: blank window).
 * Every module the preload imports VALUES from must therefore have no value
 * imports of its own.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function valueImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^import\s+(?!type\b)([\s\S]*?)\s+from\s+"([^"]+)";/gm;
  for (const match of source.matchAll(re)) {
    const clause = match[1] ?? "";
    // `import { type A, type B }` carries no runtime value.
    const names = clause.replace(/[{}]/g, "").split(",").map((n) => n.trim()).filter(Boolean);
    if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    specs.push(match[2] ?? "");
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) specs.push(match[1] ?? "");
  return specs;
}

function packageImports(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const found: string[] = [];
  for (const spec of valueImports(readFileSync(file, "utf8"))) {
    if (spec === "electron") continue;
    if (spec.startsWith(".")) {
      for (const inner of packageImports(join(dirname(file), spec.replace(/\.js$/, ".ts")), seen)) found.push(inner);
    } else {
      found.push(`${file.slice(here.length - "preload".length)} -> ${spec}`);
    }
  }
  return found;
}

describe("preload sandbox imports", () => {
  it("pulls no package other than electron through any value import", () => {
    expect(packageImports(join(here, "index.ts"))).toEqual([]);
  });

  it("flags a shared module that pulls in a package (self-test)", () => {
    expect(valueImports('import { z } from "zod";\nimport type { A } from "./a.js";\nimport { type B } from "./b.js";')).toEqual(["zod"]);
  });
});

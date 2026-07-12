/**
 * End-to-end guard for the `@anycode/cli` binary (design slice-4.8-cut.md

 * real esbuild bundle in `beforeAll` and drives the committed shim as a black
 * box via `execFile` — the root gate therefore always exercises the actual
 * artifact, not just the sources (lesson 2.6.4: a boot-blocker invisible to a
 * green source-only gate).
 *
 * All paths are absolute, derived from `import.meta.url`: the root gate runs
 * with cwd = repo root (≠ apps/cli), so nothing may be resolved relative to cwd.
 * Spawns pass absolute paths, generous timeouts, and no TTY/network — the
 * process-spawn cases are the risk centre of the slice and must be deterministic.
 *
 * E4 duplicates the proven single-pass specifier lexer from the desktop bundle

 * exporting it would be an ugly cross-app import and hoisting it into core is
 * forbidden (L1). It recognises specifiers only in real import/require positions,
 * so bare-specifier mentions inside comments/strings never false-positive.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const buildScript = join(cliRoot, "scripts", "build.mjs");
const binShim = join(cliRoot, "bin", "anycode.js");
const bundlePath = join(cliRoot, "dist", "cli", "main.js");

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
}

const cliPkg = JSON.parse(
  readFileSync(join(cliRoot, "package.json"), "utf8"),
) as PackageManifest;

/** Shape of a promisified execFile rejection (non-zero exit carries stdio). */
interface ExecFailure {
  code?: number | string;
  stdout: string;
  stderr: string;
}

const USAGE_HEAD = "anycode — AI coding agent CLI";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const WORD = /[A-Za-z0-9_$]/;
const VALUE_END = /[A-Za-z0-9_$)\]]/;

/**
 * Single-pass lexer returning module specifiers that appear in REAL import
 * positions (`from "x"`, side-effect `import "x"`, dynamic `import("x")`,
 * `require("x")`). Strings, comments and regex literals are tracked so
 * specifier-like text inside them is ignored.
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

// ---------------------------------------------------------------------------

describe("apps/cli built-binary e2e (design §2.6 / §6-E)", () => {
  beforeAll(async () => {

    // failure surfaces esbuild's stderr and fails the whole suite red.
    try {
      await execFileAsync(process.execPath, [buildScript], { timeout: 60_000 });
    } catch (error) {
      const fail = error as ExecFailure;
      throw new Error(
        `cli bundle build failed (scripts/build.mjs):\n${fail.stderr || String(error)}`,
      );
    }
    expect(existsSync(bundlePath), `bundle emitted at ${bundlePath}`).toBe(true);
  }, 90_000);

  it(
    "E1 --help: exit 0, usage head + sentinel flags, usage printed exactly once",
    async () => {
      const { stdout } = await execFileAsync(process.execPath, [binShim, "--help"], {
        timeout: 15_000,
      });
      // Exit 0 is implicit: execFileAsync rejects on any non-zero code.
      expect(stdout.startsWith(USAGE_HEAD)).toBe(true);
      expect(stdout).toContain("--no-checkpoints");
      expect(stdout).toContain("--output-format");
      expect(stdout).toContain("ANYCODE_API_KEY");

      expect(countOccurrences(stdout, USAGE_HEAD)).toBe(1);
      // stderr deliberately not asserted — node:sqlite ExperimentalWarning is legit.
    },
    30_000,
  );

  it(
    "E2 --version: exit 0, stdout is exactly `anycode <cli version>\\n`",
    async () => {
      const { stdout } = await execFileAsync(process.execPath, [binShim, "--version"], {
        timeout: 15_000,
      });


      expect(stdout).toBe(`anycode ${cliPkg.version}\n`);
    },
    30_000,
  );

  it(
    "E3 keyless -p: exit 1, stderr names ANYCODE_API_KEY, stdout empty (fail-fast before DB)",
    async () => {
      // Scrub the environment to PATH-only: if the gate's own env carried a
      // provider key the CLI would open the DB and block waiting for a model.
      // process.execPath is absolute so node still launches with a bare env.
      let failure: ExecFailure | undefined;
      try {
        await execFileAsync(process.execPath, [binShim, "-p", "hi"], {
          timeout: 30_000,
          env: { PATH: process.env.PATH ?? "" },
        });
      } catch (error) {
        failure = error as ExecFailure;
      }
      expect(failure, "keyless -p must exit non-zero").toBeDefined();
      const err = failure as ExecFailure;
      expect(err.code).toBe(1);
      // A4: loadEnvConfig throws before any persistence is opened → shim catch →
      // console.error(error) to stderr → exit 1, with nothing written to stdout.
      expect(err.stderr).toContain("ANYCODE_API_KEY");
      expect(err.stdout).toBe("");
    },
    45_000,
  );

  it(
    "E4 bundle scan: bare specifiers ⊆ deps ∪ builtins, no @anycode/core, relatives resolve",
    () => {
      const code = readFileSync(bundlePath, "utf8");
      const specs = extractSpecifiers(code);

      const deps = new Set(Object.keys(cliPkg.dependencies ?? {}));
      const builtins = new Set(builtinModules);

      const undeclared: string[] = [];
      const unresolvedRelative: string[] = [];
      for (const spec of specs) {
        if (spec.startsWith("node:")) continue; // always allowed
        if (spec.startsWith(".") || spec.startsWith("/")) {
          // esbuild with a single outfile inlines everything; if it ever splits a
          // chunk, the relative specifier must resolve to a real file inside dist/.
          const resolved = spec.startsWith("/") ? spec : join(dirname(bundlePath), spec);
          if (!existsSync(resolved)) unresolvedRelative.push(spec);
          continue;
        }
        const name = packageName(spec);
        if (builtins.has(name)) continue; // bare node builtin (fs, path, …)
        if (deps.has(name)) continue; // declared runtime dependency
        undeclared.push(spec);
      }


      expect(
        undeclared,
        `undeclared bare specifiers in bundle: ${undeclared.join(", ")}`,
      ).toEqual([]);


      const coreSpecs = [...specs].filter((s) => packageName(s) === "@anycode/core");
      expect(coreSpecs, "@anycode/core leaked into the bundle as an import").toEqual([]);


      expect(
        unresolvedRelative,
        `relative specifiers not resolving inside dist: ${unresolvedRelative.join(", ")}`,
      ).toEqual([]);
    },
  );
});

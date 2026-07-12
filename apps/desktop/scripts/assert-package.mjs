/**

 *
 * electron-builder SILENTLY drops the platform ripgrep binary if the platform
 * optionalDependencies are missing (spike found no warning is emitted) — this
 * script is the only reliable tripwire for that class of regression. It verifies
 * the native binaries actually landed in `app.asar.unpacked` and are runnable:
 *   - rg (or rg.exe)   — @vscode/ripgrep platform package
 *   - pty.node         — node-pty native addon (dlopen'd, not exec'd)
 *   - spawn-helper     — node-pty unix helper, must be executable (+x)
 *
 * Usage:  node scripts/assert-package.mjs [<path-to-.app | dist dir | app.asar.unpacked>]
 * Default target: dist/mac-arm64/AnyCode.app (darwin-arm64 `package:dir` output).
 * Exits non-zero with a clear message on any missing/non-executable binary.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const DEFAULT_TARGET = join(desktopRoot, "dist", "mac-arm64", "AnyCode.app");

const IS_WINDOWS = platform === "win32";

/** Depth-limited search for a directory named `app.asar.unpacked` under `root`. */
function findUnpackedDir(root, depth = 6) {
  if (basename(root) === "app.asar.unpacked") return root;
  const direct = join(root, "Contents", "Resources", "app.asar.unpacked");
  if (existsSync(direct)) return direct;
  if (depth <= 0 || !existsSync(root) || !statSync(root).isDirectory()) return null;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry === "app.asar.unpacked") return p;
    const nested = findUnpackedDir(p, depth - 1);
    if (nested) return nested;
  }
  return null;
}

/** Collect every file path (recursively) under `dir`. */
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function fail(message) {
  console.error(`[assert-package] FAIL: ${message}`);
  process.exit(1);
}

function main() {
  const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TARGET;
  if (!existsSync(target)) {
    fail(`target not found: ${target}\n  Run \`pnpm run package:dir\` first, or pass an explicit path.`);
  }

  const unpacked = findUnpackedDir(target);
  if (!unpacked) {
    fail(`no app.asar.unpacked directory found under: ${target}`);
  }

  const files = walkFiles(unpacked);
  const byName = new Map();
  for (const f of files) {
    const name = basename(f);
    if (!byName.has(name)) byName.set(name, f);
  }

  const rg = byName.get("rg") ?? byName.get("rg.exe");
  const ptyNode = byName.get("pty.node");
  const spawnHelper = byName.get("spawn-helper");

  const problems = [];
  if (!rg) problems.push("ripgrep binary (rg) is missing — @vscode/ripgrep platform package not packed");
  if (!ptyNode) problems.push("node-pty native addon (pty.node) is missing");

  // spawn-helper is the unix pty helper; on Windows node-pty uses conpty instead.
  if (!IS_WINDOWS) {
    if (!spawnHelper) {
      problems.push("node-pty spawn-helper is missing");
    } else if ((statSync(spawnHelper).mode & 0o111) === 0) {
      problems.push(`spawn-helper is not executable (+x lost): ${spawnHelper}`);
    }
  }

  if (problems.length > 0) {
    fail(`packaged app is missing/broken native binaries under ${unpacked}:\n  - ${problems.join("\n  - ")}`);
  }

  console.log(`[assert-package] OK: ${unpacked}`);
  console.log(`  rg           ${rg}`);
  console.log(`  pty.node     ${ptyNode}`);
  if (!IS_WINDOWS) console.log(`  spawn-helper ${spawnHelper} (executable)`);
}

main();

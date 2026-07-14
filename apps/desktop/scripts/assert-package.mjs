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
 * TASK.47 defect 1: it ALSO asserts `app-update.yml` (electron-builder writes
 * this into the packaged resources dir whenever `publish:` is configured,
 * regardless of whether the build itself actually publishes — release.yml's
 * `--publish never` build still gets one) carries `releaseType: release`. A
 * `draft` value there makes electron-updater poll GitHub's draft-releases
 * endpoint, which is invisible without a token — i.e. no user's client EVER
 * finds an update, silently, with a fully green CI gate. This is the ONLY
 * tripwire for that regression: it lives in the built artifact, not in
 * source (a reverted `electron-builder.yml` line is invisible to every other
 * test in the repo).
 *
 * Usage:  node scripts/assert-package.mjs [<path-to-.app | dist dir | app.asar.unpacked>]
 * Default target: dist/mac-arm64/AnyCode.app (darwin-arm64 `package:dir` output).
 * Exits non-zero with a clear message on any missing/non-executable binary,
 * a missing app-update.yml, or a releaseType other than "release".
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * Depth-limited search for a FILE named `name` under `root` (same walk shape
 * as `findUnpackedDir` above, generalized past one hardcoded macOS shortcut —
 * `app-update.yml` lives directly in the resources dir on every platform:
 * `Contents/Resources/` on mac, `resources/` on win/linux-unpacked).
 */
function findFile(root, name, depth = 6) {
  if (!existsSync(root)) return null;
  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    return basename(root) === name ? root : null;
  }
  if (!rootStat.isDirectory() || depth <= 0) return null;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let entryStat;
    try {
      entryStat = statSync(p);
    } catch {
      continue;
    }
    if (entryStat.isFile()) {
      if (entry === name) return p;
      continue;
    }
    if (entryStat.isDirectory()) {
      const nested = findFile(p, name, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Minimal top-level `key: value` scalar reader for the flat YAML
 * electron-builder writes into `app-update.yml` (owner/repo/provider/
 * releaseType, no nesting) — reading one field doesn't earn a yaml
 * dependency. Strips a matching pair of quotes if the value carries any.
 */
function readYamlScalar(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return undefined;
  return match[1].replace(/^["']|["']$/g, "");
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

  // TASK.47 defect 1: app-update.yml lives beside app.asar (Resources/ on mac,
  // resources/ on win/linux), NOT inside app.asar.unpacked — search from
  // `target`, not from `unpacked` above.
  const updateYmlPath = findFile(target, "app-update.yml");
  let releaseType;
  if (!updateYmlPath) {
    problems.push(
      `app-update.yml not found under ${target} — electron-builder.yml's publish: block is missing, or this target wasn't built with it configured`,
    );
  } else {
    releaseType = readYamlScalar(readFileSync(updateYmlPath, "utf8"), "releaseType");
    if (releaseType !== "release") {
      problems.push(
        `app-update.yml at ${updateYmlPath} has releaseType=${JSON.stringify(releaseType ?? null)} (expected "release") — electron-updater will poll GitHub's DRAFT releases, invisible without a token, so no user's client will EVER find an update`,
      );
    }
  }

  if (problems.length > 0) {
    fail(`packaged app has broken native binaries and/or update feed under ${target}:\n  - ${problems.join("\n  - ")}`);
  }

  console.log(`[assert-package] OK: ${unpacked}`);
  console.log(`  rg           ${rg}`);
  console.log(`  pty.node     ${ptyNode}`);
  if (!IS_WINDOWS) console.log(`  spawn-helper ${spawnHelper} (executable)`);
  console.log(`  app-update.yml ${updateYmlPath} (releaseType: ${releaseType})`);
}

main();

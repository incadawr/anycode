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
 * TASK.47 defect 1 / W14-fix: it ALSO asserts `app-update.yml` (electron-builder
 * writes this into the packaged resources dir whenever `publish:` is configured,
 * regardless of whether the build itself actually publishes — release.yml's
 * `--publish never` build still gets one) carries `releaseType: release`. This is
 * NOT a client-behavior tripwire — electron-updater@6.8.9 never reads this field
 * (verified: zero occurrences of "releaseType" in the installed package), and
 * GitHub's feeds electron-updater actually polls never surface a draft release
 * regardless of this value; the human-reviewed draft gate is a completely
 * separate mechanism (`--draft` in .github/workflows/release.yml's `gh`
 * publisher). What this DOES catch: `releaseType` drifting away from
 * electron-builder.yml's configured "release" between source and the packaged
 * artifact — the only place that drift would ever be visible, since a reverted
 * `electron-builder.yml` line is invisible to every other test in the repo.
 * Kept as config-hygiene tripwire (see electron-builder.yml's own comment).
 *
 * W14-fix hardening: the app-update.yml lookup is a FIXED sibling path off the
 * located `app.asar.unpacked` (electron-builder always writes it directly into
 * the resources dir `app.asar.unpacked` lives in — `Contents/Resources/` on
 * mac, `resources/` on win/linux-unpacked), not a recursive directory search —
 * a recursive search over an arbitrary target risks picking up an unrelated or
 * nested app-update.yml (a stale prior build, a bundled sub-app) and reporting
 * a false green. The `releaseType` value itself is read with a fail-closed
 * full-line match, not a lenient scalar extractor: a malformed value must FAIL
 * the assert, never silently normalize to "release".
 *
 * Usage:  node scripts/assert-package.mjs [<path-to-.app | dist dir | app.asar.unpacked>]
 * Default target: dist/mac-arm64/AnyCode.app (darwin-arm64 `package:dir` output).
 * Exits non-zero with a clear message on any missing/non-executable binary,
 * a missing/malformed app-update.yml, or a releaseType other than "release".
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const DEFAULT_TARGET = join(desktopRoot, "dist", "mac-arm64", "AnyCode.app");

const IS_WINDOWS = platform === "win32";

/**
 * Depth-limited search for a directory named `app.asar.unpacked` under `root`.
 * Uses `lstatSync` (never follows a symlink) at every step, including the
 * macOS shortcut path: a symlinked `app.asar.unpacked` — or a symlinked
 * directory anywhere along the walk — is skipped rather than descended into
 * or accepted, so a crafted/stale symlink cannot redirect this assert at
 * another build's (or an attacker-controlled) unpacked tree.
 */
function findUnpackedDir(root, depth = 6) {
  if (basename(root) === "app.asar.unpacked" && isRealDir(root)) return root;
  const direct = join(root, "Contents", "Resources", "app.asar.unpacked");
  if (isRealDir(direct)) return direct;
  if (depth <= 0 || !isRealDir(root)) return null;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (!isRealDir(p)) continue;
    if (entry === "app.asar.unpacked") return p;
    const nested = findUnpackedDir(p, depth - 1);
    if (nested) return nested;
  }
  return null;
}

/** True iff `p` exists, is a real (non-symlink) directory. */
function isRealDir(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return false;
  }
  return st.isDirectory();
}

/**
 * Fail-closed full-line match against the flat `releaseType:` scalar
 * electron-builder writes into app-update.yml. Deliberately NOT a general
 * scalar reader: the prior implementation independently stripped a leading
 * AND a trailing quote character (not a matched pair), so a malformed value
 * like `releaseType: "release'` normalized to `release` and silently passed.
 * This either matches the exact expected line or the caller fails the build —
 * no yaml dependency justified for one flat key (avoids a lockfile edit).
 */
const RELEASE_TYPE_RELEASE_LINE = /^releaseType:\s*release\s*$/;

/** The raw `releaseType:...` line from `content`, or `undefined` if absent. */
function findReleaseTypeLine(content) {
  for (const line of content.split(/\r?\n/)) {
    if (/^releaseType:/.test(line)) return line;
  }
  return undefined;
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

  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  })(unpacked);

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

  // app-update.yml lives beside app.asar (Resources/ on mac, resources/ on
  // win/linux), i.e. as a SIBLING of app.asar.unpacked — never a descendant of
  // it — so this is a fixed path off `unpacked`'s parent, not a search.
  const updateYmlPath = join(dirname(unpacked), "app-update.yml");
  let releaseTypeLine;
  let updateYmlStat;
  try {
    updateYmlStat = lstatSync(updateYmlPath);
  } catch {
    updateYmlStat = null;
  }
  if (updateYmlStat === null || !updateYmlStat.isFile()) {
    problems.push(
      `app-update.yml not found at ${updateYmlPath} (expected as a sibling of app.asar.unpacked at ${unpacked}) — ` +
        `electron-builder.yml's publish: block is missing, or this target wasn't built with it configured`,
    );
  } else {
    releaseTypeLine = findReleaseTypeLine(readFileSync(updateYmlPath, "utf8"));
    if (releaseTypeLine === undefined) {
      problems.push(`app-update.yml at ${updateYmlPath} has no releaseType line at all (expected "releaseType: release")`);
    } else if (!RELEASE_TYPE_RELEASE_LINE.test(releaseTypeLine)) {
      problems.push(
        `app-update.yml at ${updateYmlPath} has ${JSON.stringify(releaseTypeLine)}, which does not exactly match ` +
          `"releaseType: release" — electron-builder.yml's publish.releaseType regressed`,
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
  console.log(`  app-update.yml ${updateYmlPath} (${releaseTypeLine})`);
}

main();

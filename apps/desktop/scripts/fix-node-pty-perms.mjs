/**

 * pnpm strips the executable bit from node-pty's `spawn-helper` binary when it
 * lays the package out in the `.pnpm` store, so `pty.spawn()` fails at runtime
 * with `posix_spawnp failed`. node-pty's own install script never chmods it, and
 * adding node-pty to `pnpm.onlyBuiltDependencies` does NOT fix this. This script
 * re-adds `+x` idempotently after every install.
 *
 * It resolves the real node-pty package directory through the pnpm symlink store
 * (createRequire + realpath) and chmods `spawn-helper` in BOTH resolution paths
 * node-pty checks at require time — `prebuilds/<platform>-<arch>/` (bundled) and
 * `build/Release/` (present only after an @electron/rebuild). It is a silent
 * no-op when node-pty is absent or a spawn-helper does not exist (e.g. on CI
 * before the package is installed, or on Windows where there is no unix helper),
 * so it never breaks an install.
 */

import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const EXEC_BITS = 0o111; // u+x,g+x,o+x — matches a `chmod +x`

/** Resolve the real (symlink-followed) node-pty package root, or null if absent. */
function findNodePtyRoot() {
  const require = createRequire(import.meta.url);
  let entry;
  try {
    // package.json is the most stable resolution target; fall back to the main
    // entry and walk up if node-pty ever restricts its `exports` field.
    entry = require.resolve("node-pty/package.json");
    return realpathSync(dirname(entry));
  } catch {
    // fall through to main-entry resolution
  }
  try {
    entry = require.resolve("node-pty");
  } catch {
    return null; // node-pty not installed — silent no-op
  }
  let dir = realpathSync(dirname(entry));
  // Walk up until a directory containing package.json (the package root).
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Candidate spawn-helper paths across the two resolution paths node-pty uses. */
function spawnHelperPaths(root) {
  const paths = [join(root, "build", "Release", "spawn-helper")];
  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) {
      paths.push(join(prebuilds, name, "spawn-helper"));
    }
  }
  return paths;
}

function main() {
  const root = findNodePtyRoot();
  if (!root) return; // no node-pty → nothing to do

  const fixed = [];
  for (const path of spawnHelperPaths(root)) {
    if (!existsSync(path)) continue;
    try {
      const mode = statSync(path).mode;
      const next = mode | EXEC_BITS;
      if (next !== mode) {
        chmodSync(path, next);
        fixed.push(path);
      }
    } catch (err) {
      // Surface the problem but never fail the install — the preflight test is
      // the real guard, and a broken chmod here should not block dev setup.
      console.warn(`[fix-node-pty-perms] could not chmod ${path}: ${err?.message ?? err}`);
    }
  }

  if (fixed.length > 0) {
    console.log(`[fix-node-pty-perms] restored +x on ${fixed.length} spawn-helper binary(ies)`);
  }
}

main();

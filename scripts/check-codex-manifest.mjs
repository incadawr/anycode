#!/usr/bin/env node
/**
 * Release gate for the Codex support policy: compares the newest stable
 * `@openai/codex` on npm against the range `codex-support.json` declares.
 *
 * Exit 0 — the newest stable Codex is inside the declared range.
 * Exit 1 — the range no longer covers it: users on a current Codex are refused
 *          by default and must click through a risk acceptance.
 * Exit 2 — the check could not run (no network, npm unreachable, bad JSON).
 *          Never confused with a stale manifest: an unknown answer is not a
 *          verdict.
 *
 * The comparator grammar mirrors the authoritative evaluator in
 * apps/desktop/src/main/codex-manifest.ts (`>= <= > < =` conjunctions only).
 * That module stays the single source of truth for runtime verdicts; this
 * script exists so a release does not depend on someone remembering to look.
 *
 * The logic lives in exported pure-ish functions so the scheduled watcher
 * (`check-codex-manifest-scheduled.mjs`) and unit tests can call `run()`
 * directly with an injected versions list — no network needed. `run()` never
 * prints and never exits; `main()` is the thin CLI shell around it and keeps
 * the original output wording and the 0/1/2 exit-code contract.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PKG = "@openai/codex";

export function parseVersion(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function satisfies(version, range) {
  const parts = range.trim().split(/\s+/);
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)(.+)$/.exec(part);
    if (!m) return false;
    const bound = parseVersion(m[2]);
    if (bound === null) return false;
    const c = compare(version, bound);
    const ok =
      (m[1] === ">=" && c >= 0) ||
      (m[1] === "<=" && c <= 0) ||
      (m[1] === ">" && c > 0) ||
      (m[1] === "<" && c < 0) ||
      (m[1] === "=" && c === 0);
    if (!ok) return false;
  }
  return true;
}

/** Reads and parses `<root>/codex-support.json`. Exit-2 result on failure. */
export function readManifest(root = ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "codex-support.json"), "utf8"));
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, exit: 2, message: `codex-support.json unreadable: ${String(err)}` };
  }
}

/**
 * Picks the newest stable (x.y.z) entry from an ALREADY-PARSED versions
 * array, so tests need no npm. Prerelease-suffixed entries are dropped by
 * `parseVersion`'s strict grammar. Exit-2 result when nothing stable remains.
 */
export function newestStableFromVersions(versionsJson) {
  const stable = versionsJson.filter((v) => parseVersion(v) !== null).map(parseVersion);
  if (stable.length === 0) {
    return {
      ok: false,
      exit: 2,
      message: `could not read ${PKG} versions from npm: no stable (x.y.z) versions in the list`,
    };
  }
  stable.sort(compare);
  return { ok: true, latest: stable.at(-1) };
}

/** Runs `npm view @openai/codex versions --json` and parses the array. */
export function collectVersions() {
  try {
    const versions = JSON.parse(
      execFileSync("npm", ["view", PKG, "versions", "--json"], { encoding: "utf8", timeout: 60_000 }),
    );
    return { ok: true, versions };
  } catch (err) {
    return { ok: false, exit: 2, message: `could not read ${PKG} versions from npm: ${String(err)}` };
  }
}

/**
 * The whole check as a pure function: no printing, no process.exit.
 *
 * `opts.versions`:
 *   - absent  → collect the list live from npm (network);
 *   - array   → use it as if npm had returned it (tests, scheduled dry runs);
 *   - null    → simulate a failed collection (exit 2, "could not run").
 *
 * Returns `{ exit: 0 | 1 | 2, stdout: string[], stderr: string[] }` with the
 * exact wording the original top-level script printed.
 */
export function run(opts = {}) {
  const manifestResult = readManifest(ROOT);
  if (!manifestResult.ok) {
    return { exit: manifestResult.exit, stdout: [], stderr: [manifestResult.message] };
  }
  const manifest = manifestResult.manifest;

  // `undefined` (key absent OR explicitly undefined) → collect from npm;
  // `null` → simulate a failed collection; array → use as npm's answer.
  const injected = opts.versions !== undefined;
  let versions;
  if (injected && opts.versions === null) {
    return {
      exit: 2,
      stdout: [],
      stderr: [`could not read ${PKG} versions from npm: collection failed`],
    };
  }
  if (injected) {
    versions = opts.versions;
  } else {
    const collected = collectVersions();
    if (!collected.ok) {
      return { exit: collected.exit, stdout: [], stderr: [collected.message] };
    }
    versions = collected.versions;
  }

  const newestResult = newestStableFromVersions(versions);
  if (!newestResult.ok) {
    return { exit: newestResult.exit, stdout: [], stderr: [newestResult.message] };
  }
  const latest = newestResult.latest;

  const latestText = latest.join(".");
  const ranges = manifest.supported.map((entry) => entry.range);
  const covered = ranges.some((range) => satisfies(latest, range));

  const stdout = [
    `newest stable ${PKG}: ${latestText}`,
    `declared supported: ${ranges.join(" || ")}`,
    `manifest updatedAt: ${manifest.updatedAt}`,
  ];

  if (covered) {
    stdout.push("OK — the newest stable Codex is inside the declared range.");
    return { exit: 0, stdout, stderr: [] };
  }

  return {
    exit: 1,
    stdout,
    stderr: [
      `STALE — ${latestText} is outside the declared range. Run the Codex live smoke against it, then update BOTH codex-support.json and BUNDLED_CODEX_MANIFEST (apps/desktop/src/shared/codex-support.ts) plus updatedAt.`,
    ],
  };
}

/** CLI shell: print `run()`'s lines and exit with its code. */
export function main() {
  const result = run();
  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  process.exit(result.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

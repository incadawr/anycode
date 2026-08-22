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
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@openai/codex";

function parseVersion(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function satisfies(version, range) {
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

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(ROOT, "codex-support.json"), "utf8"));
} catch (err) {
  console.error(`codex-support.json unreadable: ${String(err)}`);
  process.exit(2);
}

let latest;
try {
  const versions = JSON.parse(
    execFileSync("npm", ["view", PKG, "versions", "--json"], { encoding: "utf8", timeout: 60_000 }),
  );
  const stable = versions.filter((v) => parseVersion(v) !== null).map(parseVersion);
  stable.sort(compare);
  latest = stable.at(-1);
} catch (err) {
  console.error(`could not read ${PKG} versions from npm: ${String(err)}`);
  process.exit(2);
}

const latestText = latest.join(".");
const ranges = manifest.supported.map((entry) => entry.range);
const covered = ranges.some((range) => satisfies(latest, range));

console.log(`newest stable ${PKG}: ${latestText}`);
console.log(`declared supported: ${ranges.join(" || ")}`);
console.log(`manifest updatedAt: ${manifest.updatedAt}`);

if (covered) {
  console.log("OK — the newest stable Codex is inside the declared range.");
  process.exit(0);
}

console.error(
  `STALE — ${latestText} is outside the declared range. Run the Codex live smoke against it, then update BOTH codex-support.json and BUNDLED_CODEX_MANIFEST (apps/desktop/src/shared/codex-support.ts) plus updatedAt.`,
);
process.exit(1);

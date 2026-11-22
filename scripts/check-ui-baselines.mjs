#!/usr/bin/env node
// Shrink-only check for the UI guard baselines.
//
// typography-tokens.test.ts and overlay-boundary.test.ts keep named legacy
// baselines in JSON files next to them. Their tests stop a PR from adding a
// violation WITHOUT a baseline entry, but a PR could add the entry too. This
// script closes that gap: every baseline entry at HEAD (as a multiset) must
// already exist in the base revision, so a baseline can only shrink.
// The overlay layout exceptions are intentionally NOT compared: a justified
// extension is allowed and is reviewed in the PR diff.
//
// Usage: node scripts/check-ui-baselines.mjs --base <rev>   (e.g. origin/next, or a SHA in CI)
// If a baseline file does not exist at the base revision (the guard is being
// introduced), the file is reported as skipped.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const RENDERER = "apps/desktop/src/renderer/src/";
export const BASELINES = [
  { file: RENDERER + "typography-baseline.json", list: json => json },
  { file: RENDERER + "overlay-baseline.json", list: json => json.legacy },
];

/** Entries of `head` that exceed their count in `base` (multiset difference). */
export function multisetExcess(head, base) {
  const left = new Map();
  for (const entry of base) left.set(entry, (left.get(entry) ?? 0) + 1);
  const excess = [];
  for (const entry of head) {
    const n = left.get(entry) ?? 0;
    if (n > 0) left.set(entry, n - 1);
    else excess.push(entry);
  }
  return excess;
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** File text at `rev`, or undefined when the file is genuinely absent there. Any git failure throws. */
function show(root, rev, file) {
  if (git(root, ["ls-tree", "--name-only", rev, "--", file]).trim() === "") return undefined;
  return git(root, ["show", `${rev}:${file}`]);
}

export function check(root, base) {
  const problems = [];
  const notes = [];
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    return { problems: [`base revision "${base}" is not an existing commit; cannot compare baselines`], notes };
  }
  for (const { file, list } of BASELINES) {
    let baseText;
    try {
      baseText = show(root, base, file);
    } catch (error) {
      problems.push(`${file}: cannot read at ${base}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (baseText === undefined) { notes.push(`${file}: not present at ${base}; skipped (guard being introduced)`); continue; }
    const head = list(JSON.parse(readFileSync(root + "/" + file, "utf8")));
    const excess = multisetExcess(head, list(JSON.parse(baseText)));
    for (const entry of excess) problems.push(`${file}: entry not in ${base} (baselines may only shrink): ${entry}`);
    if (excess.length === 0) notes.push(`${file}: ok (${head.length} entries, base ${list(JSON.parse(baseText)).length})`);
  }
  return { problems, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--base");
  const base = at >= 0 ? process.argv[at + 1] : undefined;
  if (!base) { console.error("usage: node scripts/check-ui-baselines.mjs --base <rev>"); process.exit(2); }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { problems, notes } = check(fileURLToPath(pathToFileURL(root)), base);
  for (const note of notes) console.log(note);
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}

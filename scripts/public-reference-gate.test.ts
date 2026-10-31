/**
 * Public-tree gate: no tracker card references in shipped source, docs or CI.
 *
 * The pattern is assembled from fragments on purpose. If it were written out
 * literally this file would match itself the moment the gate started scanning
 * `scripts/`, and the only way to keep it green would be to allowlist its own
 * source — which would also hide a real reference planted here.
 *
 * The allowlist below is shape-based and documented, because the same shape
 * can be either a card reference or an ordinary identifier:
 *
 *  - `task-<n>` (lowercase, hyphen) is the id of an internal background task or
 *    of a throwaway worktree. It never names a card; cards are written with a
 *    separator and a capitalised marker.
 *  - `task<n>` glued to a word is a file, directory or session-name fragment
 *    (a smoke-script name, an evidence directory under the unpublished working
 *    tree). A card reference is never glued.
 *  - `<name><n>-` is a temp-directory prefix in a test.
 *  - `owner: <name>` is a data value inside a captured manifest fixture.
 *  - `task <major>.<minor>[.<patch>]` is plan/slice numbering carried by the
 *    prose (e.g. "slice-3.2"), not a card number.
 *  - the captured engine payloads are listed file by file: they record verbatim
 *    output, so their references were renamed, not deleted, and the copy is
 *    checked separately against a fixed substitution table.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** Tracker product name, split so this file cannot match itself. */
const PRODUCT = "tas" + "kana";
/** Short marker used by card numbers, split for the same reason. */
const MARK = "tas" + "k";

const AREAS = ["apps", "packages", "docs", "CHANGELOG.md", "scripts", "examples", ".github"];

/**
 * Card reference shapes:
 *   1. the product name, optionally followed by a card number with an optional
 *      letter suffix;
 *   2. dotted plan numbering after the marker;
 *   3. the marker with `.`/`-`/space and a number, optional letter suffix and
 *      optional sub-item such as `-F5`.
 * Case variants are spelled out rather than left to the `i` flag: with `i` the
 * `-[A-Z]` sub-item branch would swallow the first letter of a following word.
 */
const REF_SOURCE =
  "(?:" +
  "[Tt][Aa][Ss][Kk][Aa][Nn][Aa](?:[ ._:#-]*\\d+[a-z]?)?" +
  "|[Tt]ask\\s+\\d+(?:\\.\\d+)+" +
  "|[Tt][Aa][Ss][Kk][.\\- ]?\\d+[a-z]?(?:-[A-ZА-Я]\\d*|-[а-я]\\d+)?" +
  ")";

const newRef = () => new RegExp(REF_SOURCE, "g");

/** Temp-directory prefix built from a counter, e.g. in a test's `mkdtemp` call. */
const TEMP_PREFIX = new RegExp("^" + PRODUCT + "\\d+-?$");

/** Captured payloads: references were renamed there, never deleted. */
const FIXTURES = new Set([
  "apps/desktop/src/host/engines/claude/contract/pinned-contract.json",
  "apps/desktop/src/main/codex-rollout-fixtures/agent-message-inter-agent.jsonl",
  "apps/desktop/src/main/codex-rollout-fixtures/exec-pairs-and-apply-patch.jsonl",
  "apps/desktop/src/main/codex-rollout-fixtures/input-image.jsonl",
  "apps/desktop/src/main/codex-rollout-fixtures/reasoning-nonempty-summary.jsonl",
  "apps/desktop/src/main/codex-rollout-fixtures/tool-search-and-batched-exec.jsonl",
  "apps/desktop/src/main/codex-rollout-fixtures/unpaired-call-and-web-search.jsonl",
]);

/** Files whose own name is the identifier the dev scripts print in their logs. */
const NAME_ALLOW = new Set([
  `apps/desktop/scripts/${MARK}106-model-picker-smoke.mjs`,
  `apps/desktop/scripts/${MARK}145-detach-smoke.mjs`,
]);

/**
 * One title reached through a `.each` table: the AST gate that pins this
 * change compares `describe`/`it`/`test` first arguments, not the title of a
 * chained `.each(...)(title, fn)` call, so editing it is a code change there.
 */
const LINE_ALLOW = [
  { path: "apps/desktop/src/settings/schema.test.ts", marker: "reads back as absent without corrupting" },
];

type Match = { index: number; token: string };

function allowReason(path: string, line: string, m: Match): string | null {
  if (FIXTURES.has(path)) return "captured engine payload (explicit fixture list)";
  if (LINE_ALLOW.some((e) => e.path === path && line.includes(e.marker))) {
    return "title reached through a .each table (AST gate cannot see it)";
  }
  const token = m.token;
  if (/^task-\d+$/.test(token)) return "generic background-task / worktree id";
  if (/^task\d/.test(token)) return "file, session-name or identifier fragment";
  if (TEMP_PREFIX.test(token)) return "temp-directory prefix";
  if (token.toLowerCase() === PRODUCT && /owner"?\s*:\s*"?$/.test(line.slice(0, m.index))) {
    return "manifest data value";
  }
  if (/^task\s+\d+(?:\.\d+)+$/i.test(token)) return "plan / slice numbering in prose";
  return null;
}

function scanLine(path: string, line: string, hits: string[]): void {
  for (const m of line.matchAll(newRef())) {
    const match = { index: m.index ?? 0, token: m[0] };
    if (allowReason(path, line, match) === null) hits.push(`${path}: ${match.token}`);
  }
}

/** Scan a file body and its path; returns violations as `path: token`. */
export function scanText(path: string, text: string): string[] {
  const hits: string[] = [];
  const name = isAbsolute(path) ? path : path;
  for (const m of name.matchAll(newRef())) {
    if (allowReason(name, m[0], { index: m.index ?? 0, token: m[0] }) === null) {
      hits.push(`${name}: name carries ${m[0]}`);
    }
  }
  text.split("\n").forEach((line, i) => scanLine(path, line, hits));
  return hits;
}

function trackedFiles(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z", "--", ...AREAS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return raw
    .split("\0")
    .filter(Boolean)
    .filter((rel) => existsSync(join(ROOT, rel)))
    .filter((rel) => !NAME_ALLOW.has(rel));
}

describe("public tree carries no tracker card references", () => {
  it("finds none in tracked source, docs, examples or CI", () => {
    const violations: string[] = [];
    for (const rel of trackedFiles()) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      violations.push(...scanText(rel, text));
    }
    expect(violations).toEqual([]);
  });

  it("keeps identifiers that are not card references out of the report", () => {
    expect(scanText("sample.ts", `const id = "${MARK}-7";`)).toEqual([]);
    expect(scanText("sample.ts", `const dir = "${MARK}106-slice1";`)).toEqual([]);
    expect(scanText("sample.ts", `"owner": "${PRODUCT}"`)).toEqual([]);
    expect(scanText("sample.ts", `// see slice-2.1 (${MARK} 3.2.4)`)).toEqual([]);
  });

  it("catches a planted reference in a path or a body", () => {
    const planted = MARK.toUpperCase() + ".4242";
    expect(scanText("sample.ts", `// ${planted} follow-up`)).not.toEqual([]);
    expect(scanText(`src/${planted}.ts`, "clean body")).not.toEqual([]);
    expect(scanText("sample.ts", `// ${PRODUCT} 4242a shipped`)).not.toEqual([]);
  });
});

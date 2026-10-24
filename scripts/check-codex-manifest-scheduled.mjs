#!/usr/bin/env node
/**
 * BETWEEN-releases companion to `check-codex-manifest.mjs`.
 *
 * The release gate only fires on a tag push; this script is what the daily
 * scheduled workflow (`.github/workflows/codex-manifest-watch.yml`, 06:00 UTC)
 * runs so a stale range surfaces as ONE visible issue instead of a red badge
 * nobody watches. It defers the verdict itself to the gate's `run()` — same
 * comparator, same wording, same exit codes — and only decides what to DO
 * with the verdict:
 *
 *   run().exit 0 → fresh: nothing to signal.
 *   run().exit 1 → stale: open or refresh exactly ONE issue labeled
 *                  `codex-manifest-watch`, then exit 1. The issue widens the
 *                  range only by prompting a human — never the cron itself.
 *   run().exit 2 → could not run (no network, npm unreachable): print a SKIP
 *                  line and exit 0. An unknown answer is not a verdict, and
 *                  the watch must not page on a flaky registry.
 *
 * `--dry-run` (the default) prints the verdict lines and exits 0 without
 * touching GitHub — safe to run by hand anywhere, network included.
 * `--open-issue` is the ONLY way to leave dry-run; the scheduled workflow
 * passes it explicitly.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { run } from "./check-codex-manifest.mjs";
import { WATCHED_REPOS } from "./lib/collect-watched-repos.mjs";

const SCRIPT = "check-codex-manifest-scheduled.mjs";
const USAGE = `usage: node scripts/${SCRIPT} [--dry-run | --open-issue] [--repo <owner/name>]

  --dry-run          print the check's lines and exit 0 (default; never
                     touches GitHub)
  --open-issue       act on the verdict: a stale range opens/refreshes the
                     tracking issue (what the scheduled workflow runs)
  --repo <owner/name>  repository to open the tracking issue against
                     (default: ${WATCHED_REPOS[0]}); must be in the watched list

exit 0 — range fresh, or check could not run (SKIP), or dry run;
exit 1 — range stale (issue opened/refreshed unless --dry-run);
exit 2 — bad invocation.`;

const ISSUE_LABEL = "codex-manifest-watch";
const ISSUE_TITLE = "codex-support manifest is stale";

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

/**
 * Parses the CLI flags. `--dry-run` is the DEFAULT, so an accidental bare
 * invocation can never open an issue. The watch-list check on `--repo` is
 * deliberately NOT here — it belongs to the non-dry-run path only
 * (see `orchestrate`): a dry run never touches GitHub, so it may name any
 * repo. Exported for unit tests.
 */
export function parseArgs(argv) {
  const args = { dryRun: true, repo: WATCHED_REPOS[0] };
  let sawDryRun = false;
  let sawOpenIssue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      sawDryRun = true;
      args.dryRun = true;
    } else if (flag === "--open-issue") {
      sawOpenIssue = true;
      args.dryRun = false;
    } else if (flag === "--repo") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, exit: 2, message: `--repo requires a value (e.g. ${WATCHED_REPOS[0]})` };
      }
      args.repo = value;
      i += 1;
    } else {
      return { ok: false, exit: 2, message: `unknown flag: ${flag}` };
    }
  }
  if (sawDryRun && sawOpenIssue) {
    return { ok: false, exit: 2, message: "--dry-run and --open-issue are mutually exclusive" };
  }
  return { ok: true, args };
}

/**
 * The one `gh` spawn point. Tests inject a fake; production shells out to
 * the real `gh` with `GH_TOKEN` from the workflow environment.
 */
export function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function issueBody(runResult) {
  const lines = [
    "The daily codex-manifest watch found the declared range stale.",
    "",
    "```",
    ...runResult.stdout,
    ...runResult.stderr,
    "```",
    "",
    "Remediation: run the Codex live smoke against the new version, then",
    "update BOTH codex-support.json and BUNDLED_CODEX_MANIFEST",
    "(apps/desktop/src/shared/codex-support.ts) plus updatedAt — see",
    "docs/development/release.md step 4. The two copies must stay identical.",
    "",
    `Source: scheduled run of \`.github/workflows/codex-manifest-watch.yml\` (\`${SCRIPT}\`).`,
  ];
  return lines.join("\n");
}

/**
 * Opens or refreshes exactly ONE tracking issue labeled `codex-manifest-watch`:
 * an existing OPEN issue gets a fresh status comment; otherwise a new issue is
 * created (the label is created on demand, ignoring "already exists").
 * Builds only argv arrays around the injectable `gh` helper. Exported for
 * unit tests.
 */
export function openOrCommentIssue({ repo, runResult, gh: ghRun = gh }) {
  // The label may not exist yet on a fresh repo; "already exists" is fine.
  try {
    ghRun(["label", "create", ISSUE_LABEL, "--repo", repo, "--description", "scheduled codex-manifest range watch"]);
  } catch {
    // gh exits non-zero when the label already exists — ignore any failure
    // here; a missing label surfaces as a clearer error from issue create.
  }

  const listOutput = ghRun([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    ISSUE_LABEL,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  const open = JSON.parse(listOutput);

  if (Array.isArray(open) && open.length > 0) {
    ghRun([
      "issue",
      "comment",
      String(open[0].number),
      "--repo",
      repo,
      "--body",
      [`Still stale as of ${new Date().toISOString()}:`, "", ...runResult.stderr].join("\n"),
    ]);
    return { action: "commented", number: open[0].number };
  }

  const createOutput = ghRun([
    "issue",
    "create",
    "--repo",
    repo,
    "--label",
    ISSUE_LABEL,
    "--title",
    ISSUE_TITLE,
    "--body",
    issueBody(runResult),
  ]);
  const url = createOutput.trim();
  const number = /\/issues\/(\d+)$/.exec(url)?.[1];
  return { action: "created", number: number ? Number(number) : null, url };
}

/**
 * The scheduled behavior as a pure-ish function around the gate's `run()`:
 * returns `{ exit }` without printing or exiting. `opts.versions` is passed
 * through to `run()` (array = injected list, null = simulate collection
 * failure); `opts.gh` injects the GitHub helper for tests. Exported for unit
 * tests.
 */
export function orchestrate(opts = {}) {
  const { versions, dryRun = true, repo = WATCHED_REPOS[0], gh: ghRun = gh } = opts;

  if (!dryRun && !WATCHED_REPOS.includes(repo)) {
    return { exit: 2, message: `repo is not watched: ${repo}` };
  }

  const runResult = run({ versions });
  runResult.action = undefined;

  if (dryRun) {
    return { exit: 0, runResult };
  }

  if (runResult.exit === 2) {
    return {
      exit: 0,
      runResult,
      skip: "SKIP — check could not run (network); not opening an issue",
    };
  }

  if (runResult.exit === 1) {
    openOrCommentIssue({ repo, runResult, gh: ghRun });
    return { exit: 1, runResult };
  }

  return { exit: 0, runResult };
}

/** CLI shell. */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(USAGE);
    return 2;
  }
  const result = orchestrate(parsed.args);
  for (const line of result.runResult.stdout) console.log(line);
  for (const line of result.runResult.stderr) console.error(line);
  if (result.message) console.error(result.message);
  if (result.skip) console.log(result.skip);
  if (parsed.args.dryRun) console.log(`dry-run: ${result.runResult.exit}`);
  return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

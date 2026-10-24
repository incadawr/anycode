/**
 * Plain-fs sanity guard on the GitHub workflow files. The repo has no YAML
 * dependency and does not need one: these are structural invariants, so the
 * checks are hand-rolled line/regex assertions over the file text.
 *
 * The load-bearing split this file pins: the watch lives in its OWN workflow
 * file, and `release.yml` must never grow a `schedule:` trigger — a cron on
 * the release workflow would start building/publishing drafts on a timer,
 * which is precisely what the serial-publishing design forbids.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

const RELEASE_YML = readFileSync(resolve(WORKFLOWS_DIR, "release.yml"), "utf8");
const WATCH_YML = readFileSync(resolve(WORKFLOWS_DIR, "codex-manifest-watch.yml"), "utf8");

/** Counts `{{ … }}` interpolations and `${{ … }}` action-expressions; both must balance. */
function interpolationsBalanced(text) {
  const double = (text.match(/\$\{\{/g) ?? []).length - (text.match(/\}\}/g) ?? []).length;
  const single = (text.match(/(?<!\$\{)\{\{/g) ?? []).length - (text.match(/\}\}/g) ?? []).length;
  return double === 0 && single === 0;
}

describe("release.yml keeps its tag-push-only triggers", () => {
  it("has NO schedule: line — the watch lives in its own file", () => {
    expect(RELEASE_YML).not.toMatch(/^\s*schedule:/m);
  });

  it("still triggers on v* tag pushes and manual dispatch", () => {
    expect(RELEASE_YML).toMatch(/^\s*tags:\s*$/m);
    expect(RELEASE_YML).toMatch(/- "v\*"/);
    expect(RELEASE_YML).toMatch(/workflow_dispatch:\s*\{\}/);
  });

  it("interpolations are balanced", () => {
    expect(interpolationsBalanced(RELEASE_YML)).toBe(true);
  });
});

describe("codex-manifest-watch.yml", () => {
  it("exists and declares the daily 06:00 UTC cron (quoted, exactly once)", () => {
    const cronLines = WATCH_YML.match(/^\s*-?\s*cron:.*$/gm) ?? [];
    expect(cronLines).toHaveLength(1);
    expect(cronLines[0]).toContain('"0 6 * * *"');
  });

  it("has a workflow_dispatch trigger for manual dry runs", () => {
    expect(WATCH_YML).toMatch(/workflow_dispatch:\s*\{\}/);
  });

  it("grants issues: write AND contents: read (explicit permissions set)", () => {
    const permissionsBlock = /permissions:\n((?:\s{2}[^\n]+\n)+)/.exec(WATCH_YML)?.[1] ?? "";
    expect(permissionsBlock).toContain("issues: write");
    expect(permissionsBlock).toContain("contents: read");
  });

  it("runs the scheduled check script with the repo argument", () => {
    expect(WATCH_YML).toContain("scripts/check-codex-manifest-scheduled.mjs");
    expect(WATCH_YML).toMatch(/--repo \$\{\{ github\.repository \}\}/);
  });

  it("sets GH_TOKEN for the gh issue flow", () => {
    expect(WATCH_YML).toMatch(/GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });

  it("interpolations are balanced", () => {
    expect(interpolationsBalanced(WATCH_YML)).toBe(true);
  });
});

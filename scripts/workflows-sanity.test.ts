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
const ANNOUNCE_YML = readFileSync(resolve(WORKFLOWS_DIR, "announce.yml"), "utf8");

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
    // --open-issue: without it the script stays in its default dry-run and
    // the watch would never signal anything.
    expect(WATCH_YML).toMatch(/check-codex-manifest-scheduled\.mjs --open-issue --repo "\$REPO"/);
    expect(WATCH_YML).toMatch(/REPO:\s*\$\{\{ github\.repository \}\}/);
  });

  it("never interpolates an expression straight into a run: script", () => {
    const runLines = WATCH_YML.split("\n").filter((line) => /^\s*run:/.test(line));
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) expect(line).not.toContain("${{");
  });

  it("checkout does not persist the token (the job never pushes)", () => {
    expect(WATCH_YML).toMatch(/persist-credentials:\s*false/);
  });

  it("sets GH_TOKEN for the gh issue flow", () => {
    expect(WATCH_YML).toMatch(/GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });

  it("interpolations are balanced", () => {
    expect(interpolationsBalanced(WATCH_YML)).toBe(true);
  });
});

describe("announce.yml — the Publish-time Telegram announcement", () => {
  it("triggers on release published ONLY (no draft, no workflow_dispatch)", () => {
    expect(ANNOUNCE_YML).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
    // no other trigger key in the `on:` block (comments may mention dispatch)
    const onBlock = /^on:\n((?:[ \t]+[^\s#][^\n]*\n)+)\n/m.exec(ANNOUNCE_YML)?.[1] ?? "";
    expect(onBlock).toContain("release:");
    for (const key of ["workflow_dispatch", "push:", "pull_request", "schedule:"]) {
      expect(onBlock).not.toContain(key);
    }
  });

  it("grants only contents: read (checkout; no GitHub API use)", () => {
    const permissionsBlock = /permissions:\n((?:\s{2}[^\n]+\n)+)/.exec(ANNOUNCE_YML)?.[1] ?? "";
    expect(permissionsBlock).toContain("contents: read");
    expect(permissionsBlock).not.toContain("write");
  });

  it("checkout does not persist the token (the job never pushes)", () => {
    expect(ANNOUNCE_YML).toMatch(/persist-credentials:\s*false/);
  });

  it("gates the send on the secrets' presence and never fails the run", () => {
    expect(ANNOUNCE_YML).toMatch(/if:\s*steps\.gate\.outputs\.enabled == 'true'/);
    expect(ANNOUNCE_YML).toMatch(/continue-on-error:\s*true/);
    expect(ANNOUNCE_YML).toMatch(/::notice::/);
    expect(ANNOUNCE_YML).toMatch(/::warning::Telegram announcement failed/);
  });

  it("release event fields reach the shell ONLY through env:", () => {
    for (const field of ["tag_name", "name", "html_url", "body"]) {
      expect(ANNOUNCE_YML).toMatch(new RegExp(`RELEASE_[A-Z_]+:\\s*\\$\\{\\{ github\\.event\\.release\\.${field} \\}\\}`));
    }
    // and never as an inline expression inside a run: script
    const runLines = ANNOUNCE_YML.split("\n").filter((line) => /^\s*run:/.test(line));
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) expect(line).not.toContain("${{");
    // belt: no `${{ github.event` anywhere outside an env: mapping either
    const nonEnvLines = ANNOUNCE_YML.split("\n").filter((line) => !/^\s+[A-Z_]+:/.test(line));
    for (const line of nonEnvLines) expect(line).not.toContain("${{ github.event");
  });

  it("never leaks the token or the Telegram response into the log", () => {
    expect(ANNOUNCE_YML).not.toMatch(/^\s*set -x/m);
    // the curl response goes to a temp file, not stdout
    expect(ANNOUNCE_YML).toMatch(/-o "\$response_file"/);
    expect(ANNOUNCE_YML).toMatch(/--data-urlencode "text@\$\{?message_file\}?/);
  });

  it("sends via the message builder with the exact Telegram endpoint shape", () => {
    expect(ANNOUNCE_YML).toMatch(/node scripts\/release\/build-announcement\.mjs/);
    expect(ANNOUNCE_YML).toMatch(/api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/);
    expect(ANNOUNCE_YML).toMatch(/--data-urlencode "chat_id=\$\{TELEGRAM_CHAT_ID\}"/);
  });

  it("interpolations are balanced", () => {
    expect(interpolationsBalanced(ANNOUNCE_YML)).toBe(true);
  });
});

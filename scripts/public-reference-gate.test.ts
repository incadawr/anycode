/**
 * Public-tree gate: no tracker card references in any tracked file.
 *
 * What counts as a reference: the tracker product name (optionally with a card
 * number and a letter suffix), the card marker followed by `.`/`-`/space and a
 * number (optional letter suffix, optional `-F5`-style sub-item), and dotted
 * plan numbering written after the marker. Card numbers and the product name
 * are spelled out in fragments below so this file cannot match itself — the
 * gate scans `git ls-files`, which includes this file.
 *
 * The allowlist is deliberately not shape-based. A shape such as `task-<n>`
 * covers both an internal background-task id and a real card number, so every
 * exempted value is listed per file, and each entry carries the reason it is
 * not a reference. Values are stored as the suffix after the marker and
 * matched case-insensitively, which keeps this file free of literal references
 * and keeps each exemption tied to one verified value in one verified file.
 *
 * Scanning covers file names as well as bodies: a card number in a path is the
 * same leak as a card number in a comment.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** Tracker product name and card marker, split so this file cannot match itself. */
const PRODUCT = "tas" + "kana";
const MARK = "tas" + "k";

/**
 * Reference shapes:
 *   1. the product name, optionally followed by a card number (optional letter);
 *   2. dotted plan numbering after the marker;
 *   3. the marker with `.`/`-`/space and a number, optional letter suffix and
 *      optional sub-item such as `-F5`.
 * Case variants are spelled out instead of using the `i` flag: with `i` the
 * `-[A-Z]` sub-item branch would swallow the first letter of a following word.
 */
const REF_SOURCE =
  "(?:" +
  "[Tt][Aa][Ss][Kk][Aa][Nn][Aa](?:[ ._:#-]*\\d+[a-z]?)?" +
  "|[Tt]ask\\s+\\d+(?:\\.\\d+)+" +
  "|[Tt][Aa][Ss][Kk][.\\- ]?\\d+[a-z]?(?:-[A-ZА-Я]\\d*|-[а-я]\\d+)?" +
  ")";

const newRef = () => new RegExp(REF_SOURCE, "g");

type Entry = {
  /** Tracked path, exactly as `git ls-files` prints it. */
  path: string;
  /** Suffixes: the reference is MARK + suffix, compared case-insensitively. */
  values: string[];
  /** When set, the exemption only applies to lines containing this text. */
  line?: string;
};

/**
 * Every exemption, by file and by exact value. Add one only for a value that
 * has been read and confirmed not to name a card; never widen an entry to a
 * shape or to a whole file.
 */
const ALLOW: Entry[] = [
  // internal background-task / worktree ids used as test data (product ids, not card numbers)
  { path: "apps/desktop/src/host/index.ts", values: ["-1"] },
  { path: "apps/desktop/src/host/session.test.ts", values: ["-1", "-2", "-5"] },
  { path: "apps/desktop/src/host/tasks-wire.test.ts", values: ["-1", "-999"] },
  { path: "apps/desktop/src/main/boot-tree.test.ts", values: ["-5"] },
  { path: "apps/desktop/src/main/codex-rollout-fixtures/agent-message-inter-agent.jsonl", values: ["-5"] },
  { path: "apps/desktop/src/main/tab-ipc.test.ts", values: ["-5"] },
  { path: "apps/desktop/src/main/worktree-janitor.test.ts", values: ["-5"] },
  { path: "apps/desktop/src/renderer/src/components/BackgroundTasksPanel.test.ts", values: ["-1", "-2"] },
  { path: "apps/desktop/src/renderer/src/components/Sidebar.test.ts", values: ["-5"] },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.test.ts", values: ["-3"] },
  { path: "apps/desktop/src/renderer/src/store.test.ts", values: ["-1", "-2"] },
  { path: "apps/desktop/src/shared/protocol.test.ts", values: ["-1"] },
  { path: "apps/desktop/src/shared/tabs.ts", values: ["-2"] },
  { path: "apps/desktop/src/shared/terminal.ts", values: ["-2"] },
  { path: "docs/development/agent-communication.md", values: ["-42"] },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", values: ["-1", "-2", "-3", "-5"] },
  { path: "packages/core/src/cli/background-notice.test.ts", values: ["-1", "-2"] },
  { path: "packages/core/src/cli/commands.test.ts", values: ["-1", "-2", "-9"] },
  { path: "packages/core/src/cli/main.test.ts", values: ["-1"] },
  { path: "packages/core/src/dispatch/dispatcher.test.ts", values: ["-1"] },
  { path: "packages/core/src/dispatch/scheduler.test.ts", values: ["-5", "-9"] },
  { path: "packages/core/src/extensions/bootstrap.test.ts", values: ["-3"] },
  { path: "packages/core/src/loop/agent-loop.test.ts", values: ["-5"] },
  { path: "packages/core/src/tasks/manager.test.ts", values: ["-1", "-2", "-42", "-999"] },
  { path: "packages/core/src/tools/bash-background.test.ts", values: ["-1", "-7", "-9"] },
  { path: "packages/core/src/tools/bash-kill.test.ts", values: ["-1", "-404"] },
  { path: "packages/core/src/tools/bash-output.test.ts", values: ["-1", "-2", "-404"] },
  { path: "packages/core/src/tools/schemas.ts", values: ["-1"] },
  { path: "packages/core/src/tools/worktrees.test.ts", values: ["-5"] },

  // fragments of paths, evidence directories and session names under the unpublished working tree
  { path: "apps/desktop/scripts/child-session-engine-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/child-session-explicit-provider-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/child-session-permission-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/child-session-race-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/child-session-scenario-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/child-session-split-smoke.mjs", values: ["102"] },
  { path: "apps/desktop/scripts/detach-smoke.mjs", values: ["145"] },
  { path: "apps/desktop/scripts/model-picker-smoke.mjs", values: ["106"] },
  { path: "apps/desktop/src/host/index.test.ts", values: ["150", "198"] },
  { path: "apps/desktop/src/host/session.test.ts", values: ["56"] },
  { path: "apps/desktop/src/main/automation/README.md", values: ["56"] },
  { path: "apps/desktop/src/main/host-env.test.ts", values: ["150", "198"] },
  { path: "apps/desktop/src/main/host-env.ts", values: ["150", "198"] },
  { path: "apps/desktop/src/main/profile-stats-cache.ts", values: ["187"] },
  { path: "apps/desktop/src/renderer/src/App.test.ts", values: ["56"] },
  { path: "apps/desktop/src/renderer/src/App.tsx", values: ["56"] },
  { path: "apps/desktop/src/renderer/src/automation.test.ts", values: ["56"] },
  { path: "apps/desktop/src/renderer/src/automation.ts", values: ["187", "56"] },
  { path: "apps/desktop/src/renderer/src/components/SubagentsPane.test.ts", values: ["106"] },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.test.ts", values: ["191"] },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.tsx", values: ["191"] },
  { path: "apps/desktop/src/renderer/src/components/profile-loader.ts", values: ["187"] },
  { path: "apps/desktop/src/renderer/src/store.ts", values: ["56"] },
  { path: "apps/desktop/src/renderer/src/tab-registry.test.ts", values: ["198", "56"] },
  { path: "docs/superpowers/plans/2026-08-08-child-sessions-track.md", values: ["102"] },
  { path: "packages/core/src/telemetry/admin.ts", values: ["187"] },
  { path: "packages/core/src/telemetry/stats.test.ts", values: ["187"] },
  { path: "packages/core/src/telemetry/stats.ts", values: ["187"] },

  // plan / slice numbering carried by the prose (not card numbers)
  { path: ".github/workflows/release.yml", values: [" 2.6.3"] },
  { path: "apps/desktop/src/host/index.test.ts", values: [" 3.2.4", " 3.3.5", " 3.4.5", " 3.7.2"] },
  { path: "apps/desktop/src/host/index.ts", values: [" 1.9", " 3.1.4", " 3.2.4", " 3.3.5", " 3.4.5"] },
  { path: "apps/desktop/src/host/terminal.test.ts", values: [" 2.4.3"] },
  { path: "apps/desktop/src/main/codex-rollout-fixtures/reasoning-nonempty-summary.jsonl", values: [" 10", " 10.7"] },
  { path: "apps/desktop/src/main/tabs.ts", values: [" 2.4.3", " 2.4.4"] },
  { path: "apps/desktop/src/preload/index.ts", values: [" 2.4.4"] },
  { path: "apps/desktop/src/renderer/src/App.tsx", values: [" 2.1.2", " 2.1.6"] },
  { path: "apps/desktop/src/renderer/src/anycode-window.d.ts", values: [" 2.1.4", " 2.1.5", " 2.1.6"] },
  { path: "apps/desktop/src/renderer/src/app.css", values: [" 3.1.4"] },
  { path: "apps/desktop/src/renderer/src/components/SessionPicker.test.ts", values: [" 2.1.5"] },
  { path: "apps/desktop/src/renderer/src/components/SessionPicker.tsx", values: [" 2.1.6"] },
  { path: "apps/desktop/src/renderer/src/components/SettingsScreen.tsx", values: [" 3.2.4"] },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.tsx", values: [" 3.1.4", " 3.4.5"] },
  { path: "apps/desktop/src/renderer/src/port.ts", values: [" 2.4.1"] },
  { path: "apps/desktop/src/renderer/src/settings.css", values: [" 3.2.4"] },
  { path: "apps/desktop/src/renderer/src/store.test.ts", values: [" 1.9", " 2.1.5", " 2.1.6", " 3.1.4", " 3.2.4", " 3.4.5"] },
  { path: "apps/desktop/src/renderer/src/store.ts", values: [" 1.9", " 2.1.5", " 3.1.4", " 3.2.4", " 3.4.5"] },
  { path: "apps/desktop/src/renderer/src/tab-registry.test.ts", values: [" 2.1.4", " 2.4.4"] },
  { path: "apps/desktop/src/renderer/src/tabs-store.ts", values: [" 2.1.5"] },
  { path: "apps/desktop/src/renderer/src/terminal-view.test.ts", values: [" 2.4.4"] },
  { path: "apps/desktop/src/settings/files.ts", values: [" 2.2.2"] },
  { path: "apps/desktop/src/settings/schema.test.ts", values: ["ana 4118"] },
  { path: "apps/desktop/src/settings/schema.ts", values: [" 2.2.1"] },
  { path: "apps/desktop/src/shared/credentials.ts", values: [" 2.5.1"] },
  { path: "apps/desktop/src/shared/envelopes.ts", values: [" 2.1.1"] },
  { path: "apps/desktop/src/shared/protocol.test.ts", values: [" 3.2.4"] },
  { path: "apps/desktop/src/shared/protocol.ts", values: [" 2.1.1", " 3.2.4"] },
  { path: "apps/desktop/src/shared/settings.ts", values: [" 2.2.1"] },
  { path: "apps/desktop/src/shared/tabs.ts", values: [" 2.1.1", " 2.1.2", " 2.1.6"] },
  { path: "apps/desktop/src/shared/terminal.ts", values: [" 2.4.1"] },
  { path: "packages/core/src/adapters/node/sqlite-persistence.ts", values: [" 1.7", " 1.9"] },
  { path: "packages/core/src/cli/args.ts", values: [" 1.7", " 4.1.1", " 4.1.4"] },
  { path: "packages/core/src/cli/commands.test.ts", values: [" 4.1.1", " 4.1.4"] },
  { path: "packages/core/src/cli/commands.ts", values: [" 4.1.1", " 4.1.4"] },
  { path: "packages/core/src/cli/integration.test.ts", values: [" 4.1.5"] },
  { path: "packages/core/src/cli/main.test.ts", values: [" 3.1.3", " 3.2.3", " 3.3.5"] },
  { path: "packages/core/src/cli/main.ts", values: [" 0.2", " 1.7", " 4.1.1"] },
  { path: "packages/core/src/cli/render.ts", values: [" 3.1.3", " 3.2.3", " 3.4.2", " 4.1.1", " 4.1.3", " 4.2.2"] },
  { path: "packages/core/src/cli/status.ts", values: [" 4.2.1", " 4.2.3"] },
  { path: "packages/core/src/cli/terminal-broker.ts", values: [" 4.1.2"] },
  { path: "packages/core/src/cli/theme.test.ts", values: [" 4.1.1", " 4.1.3"] },
  { path: "packages/core/src/cli/theme.ts", values: [" 4.1.1", " 4.1.3"] },
  { path: "packages/core/src/context/budget.test.ts", values: [" 1.2"] },
  { path: "packages/core/src/context/history.test.ts", values: [" 1.1", " 1.2"] },
  { path: "packages/core/src/context/manager.test.ts", values: [" 1.2"] },
  { path: "packages/core/src/context/tokenizer.test.ts", values: [" 1.2"] },
  { path: "packages/core/src/context/tokenizer.ts", values: [" 1.2"] },
  { path: "packages/core/src/dispatch/hook-runner.ts", values: [" 0.4", " 1.4"] },
  { path: "packages/core/src/extensions/bootstrap.test.ts", values: [" 3.6.4", " 3.7.2"] },
  { path: "packages/core/src/index.ts", values: [" 1.1"] },
  { path: "packages/core/src/mcp/index.ts", values: [" 3.2.2"] },
  { path: "packages/core/src/mcp/tool-bridge.ts", values: [" 3.2.2"] },
  { path: "packages/core/src/mcp/transport-compat.ts", values: [" 3.2.2"] },
  { path: "packages/core/src/prompts/sections.ts", values: [" 3.6.1", " 3.6.2"] },
  { path: "packages/core/src/prompts/system.test.ts", values: [" 3.6.2"] },
  { path: "packages/core/src/skills/discovery.ts", values: [" 3.3.5"] },
  { path: "packages/core/src/skills/index.ts", values: [" 3.3.1", " 3.3.2"] },
  { path: "packages/core/src/tools/skill.ts", values: [" 3.3.2"] },
  { path: "packages/core/src/tools/todo-read.ts", values: [" 1.5"] },
  { path: "packages/core/src/tools/todo-write.ts", values: [" 1.5"] },
  { path: "packages/core/src/workflow/index.ts", values: [" 3.4.1", " 3.4.2", " 3.4.3"] },
  { path: "packages/core/src/workflow/template.ts", values: [" 3.4.1"] },
  { path: "references/claude-code-2.1.212/W0-FINDINGS.md", values: [".3"] },

  // skill metadata values and a temp-dir prefix, not card numbers
  { path: "apps/desktop/src/main/skills-ipc.test.ts", values: ["ana"], line: "owner: " },
  { path: "packages/core/src/dispatch/dispatcher.test.ts", values: ["ana4294"], line: "mkdtemp" },
  { path: "packages/core/src/skills/harness-skill-import.test.ts", values: ["ana"], line: "owner: " },
];

function allowed(path: string, line: string, token: string): boolean {
  const lower = token.toLowerCase();
  return ALLOW.some(
    (e) =>
      e.path === path &&
      (!e.line || line.includes(e.line)) &&
      e.values.some((suffix) => (MARK + suffix).toLowerCase() === lower),
  );
}

/** Reference matches in one line, minus the allowlisted ones. */
export function scanLine(path: string, line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(newRef())) {
    if (!allowed(path, line, m[0])) hits.push(`${path}: ${m[0]}`);
  }
  return hits;
}

/** Scan a body and the path itself; returns `path: token` for each violation. */
export function scanText(path: string, text: string): string[] {
  const hits = scanLine(path, path);
  for (const line of text.split("\n")) hits.push(...scanLine(path, line));
  return hits;
}

type Occurrence = { path: string; token: string };

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((rel) => existsSync(join(ROOT, rel)));
}

function occurrencesOf(files: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const line of [rel, ...text.split("\n")]) {
      for (const m of line.matchAll(newRef())) out.push({ path: rel, token: m[0] });
    }
  }
  return out;
}

describe("public tree carries no tracker card references", () => {
  it("finds none in any tracked file or file name", () => {
    const violations: string[] = [];
    for (const rel of tracked()) {
      violations.push(...scanText(rel, readFileSync(join(ROOT, rel), "utf8")));
    }
    expect(violations).toEqual([]);
  });

  it("keeps every allowlist entry in use, so the table cannot rot", () => {
    const seen = new Map<string, Set<string>>();
    for (const { path, token } of occurrencesOf(tracked())) {
      if (!seen.has(path)) seen.set(path, new Set());
      seen.get(path)!.add(token.toLowerCase());
    }
    const stale: string[] = [];
    for (const entry of ALLOW) {
      if (!existsSync(join(ROOT, entry.path))) {
        stale.push(`${entry.path}: file is gone`);
        continue;
      }
      for (const suffix of entry.values) {
        if (!seen.get(entry.path)?.has((MARK + suffix).toLowerCase())) {
          stale.push(`${entry.path}: ${MARK + suffix} no longer occurs`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("rejects each shape the gate exists for", () => {
    const card = MARK.toUpperCase() + ".123";
    expect(scanText("docs/x.md", `see ${PRODUCT} for details`)).not.toEqual([]);
    expect(scanText("docs/x.md", `moved to ${card} yesterday`)).not.toEqual([]);
    expect(scanText("docs/x.md", `${PRODUCT}-cli did it`)).not.toEqual([]);
    expect(scanText(".github/workflows/ci.yml", `pinned in ${PRODUCT} 4750a`)).not.toEqual([]);
    expect(scanText("sample.ts", `waiting on ${MARK}-123`)).not.toEqual([]);
    expect(scanText("AGENTS.md", `history lives in ${card}`)).not.toEqual([]);
    expect(scanText("sample.ts", `mkdtemp(join(tmp, "${PRODUCT}4294-"))`)).not.toEqual([]);
    expect(scanText(`src/${card}.ts`, "clean body")).not.toEqual([]);
  });

  it("accepts only a value that is listed for that exact file", () => {
    const entry = ALLOW[0];
    const token = MARK + entry.values[0];
    expect(scanText(entry.path, `// ${token} stays`)).toEqual([]);
    // the same value in another file is still a violation
    expect(scanText("docs/other.md", `// ${token} stays`)).not.toEqual([]);
  });
});

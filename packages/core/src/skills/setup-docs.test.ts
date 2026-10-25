/**
 * Taskana 4707 — "docs in bundle sync with repo" as a SOURCE test. A true
 * asar-level test needs a package build (CI-only), so drift is caught here
 * instead: the anycode-setup skill's topic table and the docs/user/ index are
 * asserted against the real tree in every checkout, the same tree that
 * electron-builder's `extraResources` copies into the packaged app. Since docs and
 * skill are always committed together, any real drift (a renamed/removed
 * topic file, an orphan page, a stale table row, a broken link) fails this
 * file first.
 *
 * The docs dir is resolved module-relative (skills → src → core → packages →
 * repo root). The packaged app does NOT use this path: it reads
 * process.resourcesPath/docs/user (host/anycode-setup-docs.ts).
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anycodeSetupSkill } from "./builtin.js";

/** Module-relative docs/user root (BUNDLED_WORKFLOWS_DIR resolution recipe). */
const DOCS_USER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/user",
);

const ANYCODE_SETUP_SKILL = anycodeSetupSkill({ kind: "local", dir: DOCS_USER_DIR });

function readTopic(name: string): string {
  const path = resolve(DOCS_USER_DIR, name);
  expect(existsSync(path), `${name} must exist under docs/user/`).toBe(true);
  const stat = statSync(path);
  expect(stat.isFile(), `${name} must be a file`).toBe(true);
  expect(stat.size, `${name} must be non-empty`).toBeGreaterThan(0);
  return readFileSync(path, "utf8");
}

/** Every `docs/user/<topic>.md` row of the skill's topic table. */
function topicTableRows(): string[] {
  const rows: string[] = [];
  const tableRe = /\|\s*docs\/user\/([A-Za-z0-9._-]+\.md)\s*\|/g;
  for (const match of ANYCODE_SETUP_SKILL.body.matchAll(tableRe)) {
    if (match[1] !== undefined) {
      rows.push(match[1]);
    }
  }
  expect(rows.length, "the skill body must carry its topic table").toBeGreaterThan(0);
  return rows;
}

describe("anycode-setup docs sync (Taskana 4707)", () => {
  it("every topic named in the skill's topic table exists under docs/user/ and is non-empty", () => {
    for (const topic of topicTableRows()) {
      readTopic(topic);
    }
  });

  it("the topic table names exactly the docs/user/*.md files (README is the index, not a topic)", () => {
    const listed = new Set(topicTableRows());
    const expected = [
      "configuration.md",
      "engines.md",
      "mcp.md",
      "orchestration.md",
      "permissions.md",
      "plugins.md",
      "proxy.md",
      "skills.md",
      "subagents.md",
      "troubleshooting.md",
    ];
    expect([...listed].sort()).toEqual([...expected].sort());
    // The expected set must equal the directory itself — no missing, no extra.
    const onDisk = readdirSafe(DOCS_USER_DIR)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();
    expect(onDisk).toEqual([...expected].sort());
  });

  it("every relative markdown link in docs/user/README.md resolves to an existing file", () => {
    const readme = readTopic("README.md");
    const linkRe = /\]\(([^)#\s]+\.md)\)/g;
    const links = [...readme.matchAll(linkRe)].map((m) => m[1]).filter((l): l is string => Boolean(l));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(DOCS_USER_DIR, link);
      expect(existsSync(target), `README link ${link} must resolve`).toBe(true);
    }
  });

  it("every docs/user/*.md file is reachable from the README index (no orphans)", () => {
    const readme = readTopic("README.md");
    const files = readdirSafe(DOCS_USER_DIR).filter((name) => name.endsWith(".md"));
    expect(files.length).toBeGreaterThan(1);
    for (const name of files) {
      if (name === "README.md") {
        continue;
      }
      expect(
        readme.includes(`(${name})`),
        `${name} must be linked from docs/user/README.md`,
      ).toBe(true);
    }
  });

  it("docs/user/README.md states the precedence contract and both config file paths", () => {
    const readme = readTopic("README.md");
    expect(readme).toMatch(/project `?\.anycode\/?`? beats the user `?~\/\.anycode\/?`?/i);
    expect(readme).toContain("~/.anycode/settings.json");
    expect(readme).toContain("~/.anycode/secrets.json");
    expect(readme).toContain(".anycode/config.json");
  });
});

/** readdir guarded so a missing docs/user/ reports as the assertion above, not a throw. */
function readdirSafe(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir);
}

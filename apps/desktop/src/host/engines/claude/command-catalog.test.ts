import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCommandCatalog, readClaudeCommandFrontmatter, scanClaudeCommandRoot } from "./command-catalog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(path.join(tmpdir(), "commands-")); roots.push(dir); return dir; }

describe("Claude command catalog", () => {
  it("parses bounded frontmatter without exposing body", () => {
    expect(readClaudeCommandFrontmatter('\uFEFF---\r\ndescription: "Inspect changes"\r\nargument-hint: [bad]\r\n---\r\nsecret')).toEqual({ description: "Custom command", hidden: false });
    expect(readClaudeCommandFrontmatter("---\r\ndescription: 'Inspect changes'\r\nargument-hint: target\r\n---\r\nsecret")).toEqual({ description: "Inspect changes", argumentHint: "target", hidden: false });
    expect(readClaudeCommandFrontmatter("---\nuser-invocable: false\n---\nsecret").hidden).toBe(true);
  });
  it("discovers nested markdown, skips hidden, links and SKILL.md", async () => {
    const dir = await root();
    await mkdir(path.join(dir, "ci"));
    await writeFile(path.join(dir, "ci", "inspect.md"), "---\ndescription: Inspect\n---\nsecret");
    await writeFile(path.join(dir, "ci", "SKILL.md"), "ignored");
    await writeFile(path.join(dir, "hidden.md"), "---\nuser-invocable: false\n---");
    await symlink(path.join(dir, "ci", "inspect.md"), path.join(dir, "link.md"));
    expect(await scanClaudeCommandRoot(dir, "project")).toEqual([{ name: "ci:inspect", scope: "project", description: "Inspect" }]);
  });
  it("prefers personal and caches until invalidated", async () => {
    const project = await root(), personal = await root();
    await writeFile(path.join(project, "a.md"), "project");
    await writeFile(path.join(personal, "a.md"), "personal");
    const catalog = createClaudeCommandCatalog({ project, personal });
    expect(await catalog.list()).toEqual([{ name: "a", scope: "personal", description: "Custom command" }]);
    await writeFile(path.join(personal, "b.md"), "new");
    expect(await catalog.list()).toHaveLength(1);
    catalog.invalidate();
    expect(await catalog.list()).toHaveLength(2);
  });
});

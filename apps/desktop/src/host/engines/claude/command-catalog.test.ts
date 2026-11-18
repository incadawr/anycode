import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCommandRoots, createClaudeCommandCatalog, readClaudeCommandFrontmatter, scanClaudeCommandRoot } from "./command-catalog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(path.join(tmpdir(), "commands-")); roots.push(dir); return dir; }

describe("Claude command catalog", () => {
  it("parses bounded frontmatter without exposing body", () => {
    expect(readClaudeCommandFrontmatter('\uFEFF---\r\ndescription: "Inspect changes"\r\nargument-hint: [bad]\r\n---\r\nsecret')).toEqual({ description: "Inspect changes", hidden: false });
    expect(readClaudeCommandFrontmatter("---\r\ndescription: 'Inspect changes'\r\nargument-hint: target\r\n---\r\nsecret")).toEqual({ description: "Inspect changes", argumentHint: "target", hidden: false });
    expect(readClaudeCommandFrontmatter("---\nuser-invocable: false\n---\nsecret").hidden).toBe(true);
  });
  it("keeps hidden commands hidden with multiline metadata in either order", async () => {
    const dir = await root();
    await writeFile(path.join(dir, "before.md"), "---\ndescription: |\n  private description\nuser-invocable: false\n---\nbody");
    await writeFile(path.join(dir, "after.md"), "---\nuser-invocable: false\ndescription: >\n  private description\n---\nbody");
    await writeFile(path.join(dir, "hint.md"), "---\nargument-hint: |\n  private hint\nuser-invocable: false\n---\nbody");
    await writeFile(path.join(dir, "visible.md"), "---\ndescription: |\n  multiline description\nargument-hint: target\n---\nbody");
    await writeFile(path.join(dir, "hint-visible.md"), "---\ndescription: Useful\nargument-hint: >\n  multiline hint\n---\nbody");
    expect(await scanClaudeCommandRoot(dir, "project")).toEqual([
      { name: "hint-visible", scope: "project", description: "Useful" },
      { name: "visible", scope: "project", description: "Custom command", argumentHint: "target" },
    ]);
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


describe("Claude command scan boundaries", () => {
  it("enables roots only when their setting source is present", async () => {
    const workspace = await root(), config = await root();
    const project = path.join(workspace, ".claude", "commands"), personal = path.join(config, "commands");
    await mkdir(project, { recursive: true }); await mkdir(personal);
    await writeFile(path.join(project, "project.md"), "project body");
    await writeFile(path.join(personal, "private.md"), "personal body");
    const trusted = claudeCommandRoots(workspace, config, "project,local");
    expect(trusted).toEqual({ project });
    expect((await createClaudeCommandCatalog(trusted).list()).map(row => row.name)).toEqual(["project"]);
    const untrusted = claudeCommandRoots(workspace, config, "user");
    expect(untrusted).toEqual({ personal });
    expect((await createClaudeCommandCatalog(untrusted).list()).map(row => row.name)).toEqual(["private"]);
  });
  it("accepts only valid single-line metadata, bounds it, and hides false", () => {
    const meta = readClaudeCommandFrontmatter(`---\ndescription: ${"a".repeat(400)}\nargument-hint: ${"b".repeat(150)}\n---\nsecret`);
    expect(meta.description).toHaveLength(320);
    expect(meta.argumentHint).toHaveLength(120);
    expect(readClaudeCommandFrontmatter("---\ndescription: 'broken\n---").description).toBe("Custom command");
    expect(readClaudeCommandFrontmatter("---\ndescription: ignored\nuser-invocable: false\n---").hidden).toBe(true);
    expect(readClaudeCommandFrontmatter("plain markdown\nsecret")).toEqual({ description: "Custom command", hidden: false });
  });
  it("limits depth, file size and frontmatter read", async () => {
    const dir = await root();
    let deep = dir;
    for (let i = 0; i < 6; i++) { deep = path.join(deep, `d${i}`); await mkdir(deep); }
    await writeFile(path.join(deep, "allowed.md"), "plain");
    await mkdir(path.join(deep, "extra"));
    await writeFile(path.join(deep, "extra", "hidden.md"), "plain");
    await writeFile(path.join(dir, "oversized.md"), Buffer.alloc(1024 * 1024 + 1));
    await writeFile(path.join(dir, "long-header.md"), `---\ndescription: ${"x".repeat(16384)}\n---\nsecret`);
    const rows = await scanClaudeCommandRoot(dir, "project");
    expect(rows.map(row => row.name)).toEqual(["d0:d1:d2:d3:d4:d5:allowed", "long-header"]);
    expect(rows[1]?.description).toBe("Custom command");
  });
  it("drops the entire root beyond 256 candidates or 2048 entries", async () => {
    const files = await root(), entries = await root();
    await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(path.join(files, `${i}.md`), "body")));
    await Promise.all(Array.from({ length: 2049 }, (_, i) => writeFile(path.join(entries, `${i}.txt`), "")));
    expect(await scanClaudeCommandRoot(files, "project")).toEqual([]);
    expect(await scanClaudeCommandRoot(entries, "project")).toEqual([]);
  });
  it("ignores symlinked roots and parents", async () => {
    const dir = await root();
    await mkdir(path.join(dir, "real")); await writeFile(path.join(dir, "real", "a.md"), "body");
    await symlink(path.join(dir, "real"), path.join(dir, "linked"));
    expect(await scanClaudeCommandRoot(path.join(dir, "linked"), "project")).toEqual([]);
    await mkdir(path.join(dir, "real", "commands"));
    await writeFile(path.join(dir, "real", "commands", "a.md"), "body");
    expect(await scanClaudeCommandRoot(path.join(dir, "linked", "commands"), "project")).toEqual([]);
  });
  it("shares in-flight work and refreshes after TTL", async () => {
    const dir = await root(); await writeFile(path.join(dir, "a.md"), "body");
    const catalog = createClaudeCommandCatalog({ project: dir });
    const first = catalog.list(); expect(catalog.list()).toBe(first);
    expect(await first).toHaveLength(1);
    await writeFile(path.join(dir, "b.md"), "body");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2100);
    try { expect(await catalog.list()).toHaveLength(2); } finally { clock.mockRestore(); }
  });
});

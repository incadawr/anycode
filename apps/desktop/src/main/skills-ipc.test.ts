/**
 * Unit tests for the skills-management IPC handler logic (design
 * slice-P7.20-cut.md §5 W2 gate), exercised as the exported handle* functions
 * off a REAL node fs in scratch tmpdirs (no Electron ipcMain, no ipc). Covers:
 * path custody (a plugin row's delete/reveal refused, a tampered/unknown name
 * refused via not_found, a renderer-injected `path` field ignored), the
 * project/user scope split (no tab ⇒ user-only rows), toggle round-trip
 * preserving sibling config keys, create-scaffold conflict refusal, and
 * import-scan/apply writing converted + suffixed catalog dirs.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleSkillsCreate,
  handleSkillsDelete,
  handleSkillsImportApply,
  handleSkillsImportScan,
  handleSkillsList,
  handleSkillsReveal,
  handleSkillsSetEnabled,
  NodeSkillsFs,
  type SkillsIpcDeps,
} from "./skills-ipc.js";

const TAB_ID = "tab-1";
const fs = new NodeSkillsFs();
const dirs: string[] = [];

async function tmp(prefix = "skipc-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function seed(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function makeDeps(
  workspace: string,
  home: string,
  opts?: { noTab?: boolean; reveal?: (path: string) => void },
): SkillsIpcDeps {
  return {
    home: () => home,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : workspace),
    fs,
    reveal: opts?.reveal ?? (() => {}),
  };
}

async function seedPluginSkill(workspace: string, pluginName: string, skillName: string, description: string): Promise<void> {
  const pluginRoot = join(workspace, ".anycode/plugins", pluginName);
  await mkdir(join(pluginRoot, ".anycode-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".anycode-plugin/plugin.json"),
    JSON.stringify({ name: pluginName, skills: ["skills"] }),
    "utf-8",
  );
  await seed(
    join(pluginRoot, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\nbody\n`,
  );
}

// ---------------------------------------------------------------------------

describe("handleSkillsList", () => {
  it("lists project + user + plugin rows with enabled flags and problems", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody\n");
    await seed(join(ws, ".anycode/skills/broken/SKILL.md"), "no frontmatter\n");
    await seed(join(home, ".anycode/skills/personal/SKILL.md"), "---\nname: personal\ndescription: P\n---\nbody\n");
    await seedPluginSkill(ws, "myplug", "plugskill", "a plugin skill");
    await seed(
      join(ws, ".anycode/config.json"),
      JSON.stringify({ skills: { disabled: ["alpha"] } }),
    );

    const deps = makeDeps(ws, home);
    const snapshot = await handleSkillsList(deps, { tabId: TAB_ID });

    const byName = Object.fromEntries(snapshot.rows.map((r) => [r.name, r]));
    expect(byName.alpha).toMatchObject({ sourceKind: "project", enabled: false });
    expect(byName.personal).toMatchObject({ sourceKind: "user", enabled: true });
    expect(byName.plugskill).toMatchObject({ sourceKind: "plugin", pluginName: "myplug", enabled: true });
    expect(byName.broken).toBeUndefined();
    expect(snapshot.problems.length).toBeGreaterThanOrEqual(1);
  });

  it("relabels rows as user-only when no tab resolves a workspace", async () => {
    const home = await tmp();
    await seed(join(home, ".anycode/skills/personal/SKILL.md"), "---\nname: personal\ndescription: P\n---\nbody\n");

    const deps = makeDeps("/unused", home, { noTab: true });
    const snapshot = await handleSkillsList(deps, {});
    const row = snapshot.rows.find((r) => r.name === "personal");
    expect(row?.sourceKind).toBe("user");
  });
});

// ---------------------------------------------------------------------------

describe("handleSkillsSetEnabled", () => {
  it("toggles a project skill off, preserving sibling config keys (round-trip)", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody\n");
    await seed(
      join(ws, ".anycode/config.json"),
      JSON.stringify({ mcpServers: { s: { command: "node" } }, hooks: { onStart: "x" } }),
    );

    const deps = makeDeps(ws, home);
    const result = await handleSkillsSetEnabled(deps, { tabId: TAB_ID, name: "alpha", enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.rows.find((r) => r.name === "alpha")?.enabled).toBe(false);
    }

    const raw = JSON.parse(await readFile(join(ws, ".anycode/config.json"), "utf-8"));
    expect(raw.skills.disabled).toEqual(["alpha"]);
    expect(raw.mcpServers).toEqual({ s: { command: "node" } });
    expect(raw.hooks).toEqual({ onStart: "x" });

    // toggling back on removes the entry, still preserving siblings.
    const reenable = await handleSkillsSetEnabled(deps, { tabId: TAB_ID, name: "alpha", enabled: true });
    expect(reenable.ok).toBe(true);
    const raw2 = JSON.parse(await readFile(join(ws, ".anycode/config.json"), "utf-8"));
    expect(raw2.skills.disabled).toEqual([]);
    expect(raw2.mcpServers).toEqual({ s: { command: "node" } });
  });

  it("refuses a plugin row with read_only_source", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginSkill(ws, "myplug", "plugskill", "a plugin skill");
    const deps = makeDeps(ws, home);
    const result = await handleSkillsSetEnabled(deps, { tabId: TAB_ID, name: "plugskill", enabled: false });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses an unknown/tampered name with not_found (never touches disk outside the catalog)", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSkillsSetEnabled(deps, {
      tabId: TAB_ID,
      name: "../../etc/passwd",
      enabled: false,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("ignores a renderer-injected path field (identity is name-only)", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody\n");
    const deps = makeDeps(ws, home);
    const result = await handleSkillsSetEnabled(deps, {
      tabId: TAB_ID,
      name: "alpha",
      enabled: false,
      // deliberately injecting a field the request type does not carry (raw is `unknown`; zod strips it at runtime).
      path: "/etc/passwd",
    });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(await readFile(join(ws, ".anycode/config.json"), "utf-8"));
    expect(raw.skills.disabled).toEqual(["alpha"]);
  });
});

// ---------------------------------------------------------------------------

describe("handleSkillsDelete", () => {
  it("deletes an own-catalog skill and cleans the disabled list", async () => {
    const ws = await tmp();
    const home = await tmp();
    const dir = join(ws, ".anycode/skills/alpha");
    await seed(join(dir, "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody\n");
    await seed(
      join(ws, ".anycode/config.json"),
      JSON.stringify({ mcpServers: { s: {} }, skills: { disabled: ["alpha"] } }),
    );

    const deps = makeDeps(ws, home);
    const result = await handleSkillsDelete(deps, { tabId: TAB_ID, name: "alpha" });
    expect(result.ok).toBe(true);
    expect(await exists(dir)).toBe(false);

    const raw = JSON.parse(await readFile(join(ws, ".anycode/config.json"), "utf-8"));
    expect(raw.skills.disabled).toEqual([]);
    expect(raw.mcpServers).toEqual({ s: {} });
  });

  it("refuses to delete a plugin row (read_only_source), directory untouched", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginSkill(ws, "myplug", "plugskill", "a plugin skill");
    const pluginSkillDir = join(ws, ".anycode/plugins/myplug/skills/plugskill");

    const deps = makeDeps(ws, home);
    const result = await handleSkillsDelete(deps, { tabId: TAB_ID, name: "plugskill" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
    expect(await exists(pluginSkillDir)).toBe(true);
  });

  it("refuses an unknown/traversal name with not_found", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSkillsDelete(deps, { tabId: TAB_ID, name: "../../../etc" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSkillsReveal", () => {
  it("reveals an own-catalog skill's real resolved path, ignoring any injected path", async () => {
    const ws = await tmp();
    const home = await tmp();
    const dir = join(ws, ".anycode/skills/alpha");
    await seed(join(dir, "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody\n");
    const revealed: string[] = [];
    const deps = makeDeps(ws, home, { reveal: (p) => revealed.push(p) });

    const result = await handleSkillsReveal(deps, {
      tabId: TAB_ID,
      name: "alpha",
      // deliberately injecting a field the request type does not carry (raw is `unknown`; zod strips it at runtime).
      path: "/etc/passwd",
    });
    expect(result).toEqual({ ok: true });
    expect(revealed).toEqual([join(dir, "SKILL.md")]);
  });

  it("refuses to reveal a plugin row", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginSkill(ws, "myplug", "plugskill", "a plugin skill");
    const revealed: string[] = [];
    const deps = makeDeps(ws, home, { reveal: (p) => revealed.push(p) });

    const result = await handleSkillsReveal(deps, { tabId: TAB_ID, name: "plugskill" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
    expect(revealed).toEqual([]);
  });

  it("refuses an unknown name with not_found", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSkillsReveal(deps, { tabId: TAB_ID, name: "nope" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSkillsCreate", () => {
  it("scaffolds a project skill and refuses a second create at the same name", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);

    const result = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "newskill",
      description: "does a thing",
    });
    expect(result.ok).toBe(true);
    const written = await readFile(join(ws, ".anycode/skills/newskill/SKILL.md"), "utf-8");
    expect(written).toContain("name: newskill");
    expect(written).toContain("description: does a thing");

    const again = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "newskill",
      description: "does a thing again",
    });
    expect(again).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses project scope with no resolvable tab workspace", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home, { noTab: true });
    const result = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "newskill",
      description: "d",
    });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });

  it("refuses an invalid/traversal name, never escaping the catalog root", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "../../evil",
      description: "d",
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(await exists(join(ws, "..", "evil"))).toBe(false);
  });

  it("creates a user-scope skill under home", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "user",
      name: "personal",
      description: "d",
    });
    expect(result.ok).toBe(true);
    expect(await exists(join(home, ".anycode/skills/personal/SKILL.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("handleSkillsImportScan / handleSkillsImportApply", () => {
  it("scans foreign catalogs and applies converted + suffixed candidates", async () => {
    const ws = await tmp();
    const home = await tmp();
    // A pre-existing "flatc" in our own catalog to force a suffix on import.
    await seed(join(ws, ".anycode/skills/flatc/SKILL.md"), "---\nname: flatc\ndescription: ours\n---\nours body\n");
    // Foreign harness catalogs.
    await seed(
      join(home, ".claude/skills/flatc/SKILL.md"),
      "---\nname: flatc\ndescription: flat claude\n---\nforeign body\n",
    );
    await seed(
      join(home, ".codex/skills/nested/SKILL.md"),
      "---\nname: nested\ndescription: codex nested\nmetadata:\n  owner: taskana\n---\nnested body\n",
    );

    const deps = makeDeps(ws, home);
    const scan = await handleSkillsImportScan(deps, { tabId: TAB_ID });
    const byName = Object.fromEntries(scan.candidates.map((c) => [c.name, c]));
    expect(byName.flatc).toMatchObject({ harness: "claude", compatible: true, needsConversion: false, alreadyPresent: true });
    expect(byName.nested).toMatchObject({ harness: "codex", compatible: true, needsConversion: true });

    const apply = await handleSkillsImportApply(deps, {
      tabId: TAB_ID,
      scope: "project",
      ids: [byName.flatc!.id, byName.nested!.id],
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    const byResultName = Object.fromEntries(apply.results.map((r) => [r.id, r]));
    const flatcResult = byResultName[byName.flatc!.id]!;
    expect(flatcResult.applied).toBe(true);
    expect(flatcResult.suffixed).toBe(true);
    expect(flatcResult.name).toBe("flatc-2");
    const nestedResult = byResultName[byName.nested!.id]!;
    expect(nestedResult.applied).toBe(true);
    expect(nestedResult.converted).toBe(true);

    const suffixedContent = await readFile(join(ws, ".anycode/skills/flatc-2/SKILL.md"), "utf-8");
    expect(suffixedContent).toContain("name: flatc-2");
    expect(suffixedContent).toContain("foreign body");
    const convertedContent = await readFile(join(ws, ".anycode/skills/nested/SKILL.md"), "utf-8");
    expect(convertedContent).not.toContain("metadata:");
    expect(convertedContent).toContain("nested body");

    // Our original "flatc" (project row) untouched by the import.
    const originalContent = await readFile(join(ws, ".anycode/skills/flatc/SKILL.md"), "utf-8");
    expect(originalContent).toContain("ours body");
  });

  it("refuses project-scope apply with no resolvable tab workspace", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home, { noTab: true });
    const result = await handleSkillsImportApply(deps, { tabId: TAB_ID, scope: "project", ids: ["whatever"] });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });
});


describe("skills-create security hardening (P7.20 W6-FIX)", () => {
  it("P1-2: refuses create when the skills root is a symlink escaping the catalog", async () => {
    const ws = await tmp();
    const home = await tmp();
    const outside = await tmp();
    // <ws>/.anycode/skills is a symlink to an outside directory.
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await symlink(outside, join(ws, ".anycode/skills"));

    const deps = makeDeps(ws, home);
    const result = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "evil",
      description: "d",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["io_error", "invalid"]).toContain(result.reason);
    }
    // Nothing scaffolded through the symlink into the outside directory.
    expect(await exists(join(outside, "evil"))).toBe(false);
  });

  it("P3-8: refuses a multiline description and writes nothing; single-line still works", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);

    const bad = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "multi",
      description: "one\ntwo",
    });
    expect(bad).toEqual({ ok: false, reason: "invalid" });
    expect(await exists(join(ws, ".anycode/skills/multi"))).toBe(false);

    const good = await handleSkillsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "single",
      description: "one line only",
    });
    expect(good.ok).toBe(true);
    expect(await exists(join(ws, ".anycode/skills/single/SKILL.md"))).toBe(true);
  });
});

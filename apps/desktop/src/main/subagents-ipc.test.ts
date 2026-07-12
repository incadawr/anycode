/**
 * Unit tests for the subagents editor IPC handler logic (design
 * slice-P7.21-cut.md §4 W2 gate), exercised as the exported handle* functions
 * off a REAL node fs in scratch tmpdirs (no Electron ipcMain). Covers: custody
 * (delete/save on builtin/plugin rows refused `read_only_source`; a tampered
 * name/sourceKind pair refused `not_found`; a renderer-injected `path` field
 * ignored by shape), save->list round-trip, rename moving the file, preview
 * returning the W1 builder's real string, and the `no_workspace` path.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProfilePreview, effectiveProfileTools, PERSONAS } from "@anycode/core/subagents-admin";
import {
  handleSubagentsCreate,
  handleSubagentsDelete,
  handleSubagentsList,
  handleSubagentsPreview,
  handleSubagentsRead,
  handleSubagentsReveal,
  handleSubagentsSave,
  NodeSubagentsFs,
  type SubagentsIpcDeps,
} from "./subagents-ipc.js";

const TAB_ID = "tab-1";
const fs = new NodeSubagentsFs();
const dirs: string[] = [];

async function tmp(prefix = "agipc-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function md(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
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
): SubagentsIpcDeps {
  return {
    home: () => home,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : workspace),
    fs,
    reveal: opts?.reveal ?? (() => {}),
  };
}

async function seedPluginAgent(workspace: string, pluginName: string, agentName: string, description: string): Promise<void> {
  const pluginRoot = join(workspace, ".anycode/plugins", pluginName);
  await mkdir(join(pluginRoot, ".anycode-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".anycode-plugin/plugin.json"),
    JSON.stringify({ name: pluginName, agents: ["agents"] }),
    "utf-8",
  );
  await seed(join(pluginRoot, "agents", `${agentName}.md`), md({ name: agentName, description }, "plugin body"));
}

// ---------------------------------------------------------------------------

describe("handleSubagentsList", () => {
  it("prepends built-in rows and lists project + user + plugin catalog rows", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "Reviews code", tools: "Read, Grep" }, "body"));
    await seed(join(home, ".anycode/agents/personal.md"), md({ name: "personal", description: "Personal helper" }, "body"));
    await seed(join(ws, ".anycode/agents/broken.md"), "no frontmatter");
    await seedPluginAgent(ws, "myplug", "plugagent", "a plugin agent");

    const deps = makeDeps(ws, home);
    const snapshot = await handleSubagentsList(deps, { tabId: TAB_ID });
    const byName = Object.fromEntries(snapshot.rows.map((r) => [r.name, r]));

    expect(byName["general-purpose"]).toMatchObject({
      sourceKind: "builtin",
      editable: false,
      toolsBadge: "All tools",
      source: "builtin",
    });
    expect(byName.explore).toMatchObject({ sourceKind: "builtin", editable: false, toolsBadge: "6 tools", toolCount: 6 });
    expect(byName.reviewer).toMatchObject({ sourceKind: "project", editable: true, toolsBadge: "2 tools", toolCount: 2 });
    expect(byName.personal).toMatchObject({ sourceKind: "user", editable: true });
    expect(byName.plugagent).toMatchObject({ sourceKind: "plugin", pluginName: "myplug", editable: false });
    expect(byName.broken).toBeUndefined();
    expect(snapshot.problems.length).toBeGreaterThanOrEqual(1);
  });

  it("relabels rows as user-only when no tab resolves a workspace", async () => {
    const home = await tmp();
    await seed(join(home, ".anycode/agents/personal.md"), md({ name: "personal", description: "P" }, "b"));

    const deps = makeDeps("/unused", home, { noTab: true });
    const snapshot = await handleSubagentsList(deps, {});
    const row = snapshot.rows.find((r) => r.name === "personal");
    expect(row?.sourceKind).toBe("user");
  });

  it("badges general-purpose as All tools (its list IS the full non-spawn default)", () => {
    const fullCount = effectiveProfileTools(PERSONAS["general-purpose"].tools).length;
    expect(effectiveProfileTools(PERSONAS["general-purpose"].tools).length).toBe(fullCount);
    expect(effectiveProfileTools(PERSONAS.explore.tools).length).toBe(6);
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsRead", () => {
  it("reads a project profile's draft + raw md", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "Reviews code", tools: "Read, Grep" }, "You review code."));
    const deps = makeDeps(ws, home);

    const result = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "reviewer", sourceKind: "project" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({ name: "reviewer", description: "Reviews code", tools: ["Read", "Grep"], body: "You review code." });
    expect(result.raw).toContain("You review code.");
  });

  it("never lists or reads a symlinked profile that escapes the catalog (#2)", async () => {
    const ws = await tmp();
    const home = await tmp();
    const outside = await tmp();
    const secret = join(outside, "secret.md");
    await writeFile(secret, md({ name: "leaked", description: "SECRET" }, "secret body"), "utf-8");
    await mkdir(join(ws, ".anycode/agents"), { recursive: true });
    await symlink(secret, join(ws, ".anycode/agents/evil.md"));
    const deps = makeDeps(ws, home);

    // Not surfaced in the list, and unreadable through any (name, sourceKind) pair.
    const snapshot = await handleSubagentsList(deps, { tabId: TAB_ID });
    expect(snapshot.rows.find((r) => r.name === "leaked")).toBeUndefined();
    const read = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "leaked", sourceKind: "project" });
    expect(read.ok).toBe(false);
    const readByFile = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "evil", sourceKind: "project" });
    expect(readByFile.ok).toBe(false);
  });

  it("refuses a builtin identity with read_only_source (no file to read)", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "general-purpose", sourceKind: "builtin" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses a plugin row with read_only_source", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginAgent(ws, "myplug", "plugagent", "a plugin agent");
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "plugagent", sourceKind: "plugin" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses a tampered/unknown (name, sourceKind) pair with not_found", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "d" }, "b"));
    const deps = makeDeps(ws, home);
    // Correct name, WRONG sourceKind — stale renderer identity must fail closed.
    const wrongKind = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "reviewer", sourceKind: "user" });
    expect(wrongKind).toEqual({ ok: false, reason: "not_found" });
    const unknownName = await handleSubagentsRead(deps, { tabId: TAB_ID, name: "../../etc/passwd", sourceKind: "project" });
    expect(unknownName).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsSave", () => {
  it("saves an in-place edit, round-tripping through list", async () => {
    const ws = await tmp();
    const home = await tmp();
    const path = join(ws, ".anycode/agents/reviewer.md");
    await seed(path, md({ name: "reviewer", description: "Reviews code" }, "old body"));
    const deps = makeDeps(ws, home);

    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      draft: { name: "reviewer", description: "Reviews code better", body: "new body" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.rows.find((r) => r.name === "reviewer")?.description).toBe("Reviews code better");

    const onDisk = await readFile(path, "utf-8");
    expect(onDisk).toContain("new body");
    expect(onDisk).toContain("Reviews code better");
  });

  it("renames — moves the file, old path gone, new path present", async () => {
    const ws = await tmp();
    const home = await tmp();
    const oldPath = join(ws, ".anycode/agents/reviewer.md");
    const newPath = join(ws, ".anycode/agents/critic.md");
    await seed(oldPath, md({ name: "reviewer", description: "Reviews code" }, "body"));
    const deps = makeDeps(ws, home);

    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      draft: { name: "critic", description: "Reviews code", body: "body" },
    });
    expect(result.ok).toBe(true);
    expect(await exists(oldPath)).toBe(false);
    expect(await exists(newPath)).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.rows.find((r) => r.name === "critic")).toBeDefined();
    expect(result.snapshot.rows.find((r) => r.name === "reviewer")).toBeUndefined();
  });

  it("refuses a builtin/plugin identity with read_only_source, file untouched", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginAgent(ws, "myplug", "plugagent", "a plugin agent");
    const pluginPath = join(ws, ".anycode/plugins/myplug/agents/plugagent.md");
    const deps = makeDeps(ws, home);

    const builtin = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "general-purpose",
      sourceKind: "builtin",
      draft: { name: "general-purpose", description: "hijacked", body: "b" },
    });
    expect(builtin).toEqual({ ok: false, reason: "read_only_source" });

    const plugin = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "plugagent",
      sourceKind: "plugin",
      draft: { name: "plugagent", description: "hijacked", body: "b" },
    });
    expect(plugin).toEqual({ ok: false, reason: "read_only_source" });
    const stillPlugin = await readFile(pluginPath, "utf-8");
    expect(stillPlugin).toContain("a plugin agent");
  });

  it("refuses a reserved built-in name with reason reserved_name", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "d" }, "b"));
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      draft: { name: "explore", description: "d", body: "b" },
    });
    expect(result).toMatchObject({ ok: false, reason: "reserved_name" });
  });

  it("refuses a spawn-tool request with reason validation_failed and issues", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "d" }, "b"));
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      draft: { name: "reviewer", description: "d", tools: ["Agent"], body: "b" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation_failed");
    expect(result.issues?.length).toBeGreaterThan(0);
  });

  it("refuses a tampered (name, sourceKind) pair with not_found, never touching disk", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "../../etc/passwd",
      sourceKind: "project",
      draft: { name: "passwd", description: "d", body: "b" },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("ignores a renderer-injected path field (identity is name+sourceKind only)", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents/reviewer.md"), md({ name: "reviewer", description: "d" }, "old"));
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsSave(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      draft: { name: "reviewer", description: "d", body: "new" },
      // deliberately injecting a field the request type does not carry (raw is `unknown`; zod strips it at runtime).
      path: "/etc/passwd",
    });
    expect(result.ok).toBe(true);
    const onDisk = await readFile(join(ws, ".anycode/agents/reviewer.md"), "utf-8");
    expect(onDisk).toContain("new");
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsCreate", () => {
  it("scaffolds a project profile", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      draft: { name: "summarizer", description: "Summarizes code", body: "You summarize code." },
    });
    expect(result.ok).toBe(true);
    const written = await readFile(join(ws, ".anycode/agents/summarizer.md"), "utf-8");
    expect(written).toContain("name: summarizer");
    expect(written).toContain("You summarize code.");
  });

  it("creates a user-scope profile under home", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsCreate(deps, {
      tabId: TAB_ID,
      scope: "user",
      draft: { name: "personal", description: "d", body: "b" },
    });
    expect(result.ok).toBe(true);
    expect(await exists(join(home, ".anycode/agents/personal.md"))).toBe(true);
  });

  it("refuses project scope with no resolvable tab workspace", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home, { noTab: true });
    const result = await handleSubagentsCreate(deps, {
      tabId: TAB_ID,
      scope: "project",
      draft: { name: "summarizer", description: "d", body: "b" },
    });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsDelete", () => {
  it("deletes an own-catalog profile", async () => {
    const ws = await tmp();
    const home = await tmp();
    const path = join(ws, ".anycode/agents/reviewer.md");
    await seed(path, md({ name: "reviewer", description: "d" }, "b"));
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsDelete(deps, { tabId: TAB_ID, name: "reviewer", sourceKind: "project" });
    expect(result.ok).toBe(true);
    expect(await exists(path)).toBe(false);
  });

  it("refuses a builtin identity with read_only_source", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsDelete(deps, { tabId: TAB_ID, name: "general-purpose", sourceKind: "builtin" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses a plugin row with read_only_source, directory untouched", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginAgent(ws, "myplug", "plugagent", "a plugin agent");
    const pluginPath = join(ws, ".anycode/plugins/myplug/agents/plugagent.md");
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsDelete(deps, { tabId: TAB_ID, name: "plugagent", sourceKind: "plugin" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
    expect(await exists(pluginPath)).toBe(true);
  });

  it("refuses an unknown/traversal name with not_found", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsDelete(deps, { tabId: TAB_ID, name: "../../../etc", sourceKind: "project" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsReveal", () => {
  it("reveals an own-catalog profile's real resolved path, ignoring any injected path", async () => {
    const ws = await tmp();
    const home = await tmp();
    const path = join(ws, ".anycode/agents/reviewer.md");
    await seed(path, md({ name: "reviewer", description: "d" }, "b"));
    const revealed: string[] = [];
    const deps = makeDeps(ws, home, { reveal: (p) => revealed.push(p) });

    const result = await handleSubagentsReveal(deps, {
      tabId: TAB_ID,
      name: "reviewer",
      sourceKind: "project",
      // deliberately injecting a field the request type does not carry (raw is `unknown`; zod strips it at runtime).
      path: "/etc/passwd",
    });
    expect(result).toEqual({ ok: true });
    expect(revealed).toEqual([path]);
  });

  it("refuses to reveal a builtin or plugin row", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedPluginAgent(ws, "myplug", "plugagent", "a plugin agent");
    const revealed: string[] = [];
    const deps = makeDeps(ws, home, { reveal: (p) => revealed.push(p) });

    const builtin = await handleSubagentsReveal(deps, { tabId: TAB_ID, name: "general-purpose", sourceKind: "builtin" });
    expect(builtin).toEqual({ ok: false, reason: "read_only_source" });
    const plugin = await handleSubagentsReveal(deps, { tabId: TAB_ID, name: "plugagent", sourceKind: "plugin" });
    expect(plugin).toEqual({ ok: false, reason: "read_only_source" });
    expect(revealed).toEqual([]);
  });

  it("refuses an unknown name with not_found", async () => {
    const ws = await tmp();
    const home = await tmp();
    const deps = makeDeps(ws, home);
    const result = await handleSubagentsReveal(deps, { tabId: TAB_ID, name: "nope", sourceKind: "project" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------

describe("handleSubagentsPreview", () => {
  it("returns the REAL builder's output for a draft (W1 parity)", () => {
    const draft = { name: "reviewer", description: "d", tools: ["Read", "Grep"], body: "You review code." };
    const result = handleSubagentsPreview({ draft });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = buildProfilePreview(draft);
    expect(result.systemPrompt).toBe(expected.systemPrompt);
    expect(result.effectiveTools).toEqual(expected.effectiveTools);
    expect(result.systemPrompt).toContain("You review code.");
  });

  it("refuses an invalid payload shape", () => {
    const result = handleSubagentsPreview({ draft: { name: 123, body: "b" } });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

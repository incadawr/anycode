/**
 * skills/admin-scan (P7.20 W1): buildSkillRoots recipe, scanSkillsAdmin
 * (unfiltered rows + disabled flags + problems), the own-roots containment
 * guard, and deleteSkillDir (guarded destructive delete). Real node fs.
 */

import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillRoots,
  ownSkillRoots,
  scanSkillsAdmin,
  isUnderOwnRoots,
  deleteSkillDir,
  anycodeConfigPath,
} from "./admin-scan.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "skadm-"));
  dirs.push(d);
  return d;
}

async function seedSkill(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), body, "utf-8");
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("buildSkillRoots", () => {
  it("orders project > user > plugin roots and drops the user pair when ws===home", () => {
    const full = buildSkillRoots("/ws", "/home", [{ dir: "/plug/skills", source: "plugin:p" }]);
    expect(full.map((r) => r.dir)).toEqual([
      "/ws/.anycode/skills",
      "/ws/.agents/skills",
      "/home/.anycode/skills",
      "/home/.agents/skills",
      "/plug/skills",
    ]);
    const collapsed = buildSkillRoots("/same", "/same", []);
    expect(collapsed.map((r) => r.dir)).toEqual(["/same/.anycode/skills", "/same/.agents/skills"]);
  });
});

describe("scanSkillsAdmin", () => {
  it("lists valid skills with disabled flags, reports problems for broken ones", async () => {
    const ws = await tmp();
    const home = await tmp();
    const wsCatalog = join(ws, ".anycode/skills");
    await seedSkill(wsCatalog, "alpha", "---\nname: alpha\ndescription: A\n---\nbody\n");
    await seedSkill(wsCatalog, "broken", "no frontmatter here\n");
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await writeFile(
      anycodeConfigPath(ws),
      JSON.stringify({ mcpServers: { s: {} }, skills: { disabled: ["alpha"] } }),
      "utf-8",
    );

    const result = await scanSkillsAdmin(fs, { workspace: ws, home });
    const rows = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(rows.alpha).toBeDefined();
    expect(rows.alpha!.disabled).toBe(true);
    expect(rows.alpha!.source).toBe("project");
    expect(rows.broken).toBeUndefined();
    expect(result.problems.length).toBeGreaterThanOrEqual(1);
  });
});

describe("isUnderOwnRoots", () => {
  const roots = ownSkillRoots("/ws", "/home");
  it("accepts a direct child of an own root", () => {
    expect(isUnderOwnRoots("/ws/.anycode/skills/alpha", roots)).toBe(true);
    expect(isUnderOwnRoots("/home/.agents/skills/x/y", roots)).toBe(true);
  });
  it("refuses the root itself, a plugin path, and a traversal escape", () => {
    expect(isUnderOwnRoots("/ws/.anycode/skills", roots)).toBe(false);
    expect(isUnderOwnRoots("/plug/cache/skills/evil", roots)).toBe(false);
    expect(isUnderOwnRoots("/ws/.anycode/skills/../../etc/passwd", roots)).toBe(false);
  });
});

describe("deleteSkillDir", () => {
  it("deletes a dir under an own root and refuses one outside", async () => {
    const ws = await tmp();
    const home = await tmp();
    const roots = ownSkillRoots(ws, home);
    const target = join(ws, ".anycode/skills", "alpha");
    await seedSkill(join(ws, ".anycode/skills"), "alpha", "---\nname: alpha\ndescription: A\n---\n");

    const outside = join(home, "elsewhere", "beta");
    await mkdir(outside, { recursive: true });

    const refused = await deleteSkillDir(fs, outside, roots);
    expect(refused).toEqual({ ok: false, reason: "outside_own_roots" });
    await expect(stat(outside)).resolves.toBeDefined();

    const ok = await deleteSkillDir(fs, target, roots);
    expect(ok).toEqual({ ok: true });
    await expect(stat(target)).rejects.toThrow();
  });

  it("P1-c: refuses delete when the own-catalog root is a symlink escaping the catalog", async () => {
    const ws = await tmp();
    const home = await tmp();
    const outside = await tmp();
    // A real dir OUTSIDE the catalog, exposed only via a symlinked catalog root.
    await mkdir(join(outside, "victim"), { recursive: true });
    await writeFile(join(outside, "victim", "keep.txt"), "do not delete", "utf-8");
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await symlink(outside, join(ws, ".anycode/skills"));

    const roots = ownSkillRoots(ws, home);
    // The path a scan through the symlinked root would resolve to.
    const target = join(ws, ".anycode/skills", "victim");
    const result = await deleteSkillDir(fs, target, roots);
    expect(result).toEqual({ ok: false, reason: "outside_own_roots" });
    // The outside tree is untouched.
    await expect(stat(join(outside, "victim", "keep.txt"))).resolves.toBeDefined();
  });
});

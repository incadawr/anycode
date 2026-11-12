import { mkdirSync, mkdtempSync, existsSync, rmSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentProjectsStore } from "./communication-agent-projects.js";
import { migrateAllowedFolders, type MigratedSession } from "./communication-workspaces-migration.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(dir, 0o700); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); } });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anycode-migrate-")));
  dirs.push(root);
  const a = join(root, "a"), b = join(root, "b");
  for (const folder of [a, b]) mkdirSync(folder);
  const projectsFile = join(root, "projects.json");
  const projects = createAgentProjectsStore({ file: projectsFile, realpathSync });
  const markerFile = join(root, "marker.json");
  const warnings: string[] = [];
  const sessions = new Map<string, MigratedSession>();
  const run = (workspaces: string[], exposed: string[] = [], store = projects) => migrateAllowedFolders({
    markerFile, workspaces, projects: store,
    exposedSessionIds: () => exposed,
    resolveSession: async (id) => sessions.get(id) ?? null,
    warn: (m) => warnings.push(m),
  });
  return { root, a, b, projects, markerFile, projectsFile, warnings, sessions, run };
}

describe("allowed folders migration", () => {
  it("switches on every listed folder that exists and skips one that is gone", async () => {
    const f = setup();
    const result = await f.run([f.a, f.b, join(f.a, "gone")]);
    expect(result).toEqual({ migrated: [f.a, f.b], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(true);
    expect(f.projects.isAllowed(f.b)).toBe(true);
  });

  it("migrates more than two dozen folders, whatever the sidebar would list", async () => {
    const f = setup();
    const many = Array.from({ length: 30 }, (_, i) => { const d = join(f.root, `p${i}`); mkdirSync(d); return d; });
    const result = await f.run(many);
    expect(result.migrated).toHaveLength(30);
    expect(result.ran).toBe(true);
    for (const folder of many) expect(f.projects.isAllowed(folder)).toBe(true);
  });

  it("does not report or rewrite a folder that is already on", async () => {
    const f = setup();
    f.projects.setAllowed(f.a, true);
    expect(await f.run([f.a, f.b])).toEqual({ migrated: [f.b], ran: true });
  });

  it("runs once: a later pass changes nothing, even after the switch is turned off", async () => {
    const f = setup();
    await f.run([f.a]);
    expect(existsSync(f.markerFile)).toBe(true);
    f.projects.setAllowed(f.a, false);
    expect(await f.run([f.a])).toEqual({ migrated: [], ran: false });
    expect(f.projects.isAllowed(f.a)).toBe(false);
  });

  it("an empty list with shared sessions switches on their project folders (a worktree by its root)", async () => {
    const f = setup();
    f.sessions.set("s1", { workspace: f.a });
    f.sessions.set("s2", { workspace: join(f.b, "wt"), projectRoot: f.b, worktree: { path: join(f.b, "wt") } });
    const result = await f.run([], ["s1", "s2"]);
    expect(result).toEqual({ migrated: [f.a, f.b], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(true);
    expect(f.projects.isAllowed(f.b)).toBe(true);
  });

  it("an empty list skips a session that cannot be resolved, logs once, and still records the pass", async () => {
    const f = setup();
    f.sessions.set("s1", { workspace: f.a });
    const result = await f.run([], ["s1", "ghost-1", "ghost-2"]);
    expect(result).toEqual({ migrated: [f.a], ran: true });
    expect(f.warnings).toHaveLength(1);
  });

  it("an empty list with no shared session records the pass and switches nothing on", async () => {
    const f = setup();
    expect(await f.run([])).toEqual({ migrated: [], ran: true });
    expect(f.projects.allowedKeys()).toEqual([]);
  });

  it("a failed write leaves no marker so the next start retries", async () => {
    const f = setup();
    const failing = { ...f.projects, setAllowed: (folder: string, allowed: boolean) => (folder === f.b ? false : f.projects.setAllowed(folder, allowed)) };
    const first = await f.run([f.a, f.b], [], failing);
    expect(first.ran).toBe(false);
    expect(existsSync(f.markerFile)).toBe(false);
    const second = await f.run([f.a, f.b]);
    expect(second).toEqual({ migrated: [f.b], ran: true });
    expect(existsSync(f.markerFile)).toBe(true);
  });

  it("an unwritable marker is not a pass: it retries next start", async () => {
    const f = setup();
    writeFileSync(join(f.root, "blocked"), "x");
    const result = await migrateAllowedFolders({
      markerFile: join(f.root, "blocked", "marker.json"), workspaces: [f.a], projects: f.projects,
      exposedSessionIds: () => [], resolveSession: async () => null,
    });
    expect(result.ran).toBe(false);
  });
});

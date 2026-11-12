import { mkdirSync, mkdtempSync, existsSync, rmSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentProjectsStore } from "./communication-agent-projects.js";
import { loadSettings } from "../settings/files.js";
import { cloneDefaults } from "../settings/schema.js";
import { migrateAllowedFolders } from "./communication-workspaces-migration.js";

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
  const sessions = new Map<string, string>();
  const folderRoots = new Map<string, string>();
  const run = (workspaces: string[], exposed: string[] = [], store = projects, maxAttempts?: number, extra: { settingsLoaded?: boolean; markerFile?: string } = {}) => migrateAllowedFolders({
    markerFile: extra.markerFile ?? markerFile, workspaces, projects: store,
    ...(extra.settingsLoaded !== undefined ? { settingsLoaded: extra.settingsLoaded } : {}),
    exposedSessionIds: () => exposed,
    resolveSession: async (id) => sessions.get(id) ?? null,
    resolveFolder: async (folder) => folderRoots.get(folder) ?? folder,
    warn: (m) => warnings.push(m),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
  return { root, a, b, projects, markerFile, projectsFile, warnings, sessions, folderRoots, run };
}

describe("allowed folders migration", () => {
  it("switches on every listed folder that exists and keeps one that is gone pending", async () => {
    const f = setup();
    const result = await f.run([f.a, f.b, join(f.a, "gone")]);
    expect(result).toEqual({ migrated: [f.a, f.b], ran: false });
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

  it("an empty list with shared sessions switches on their project folders", async () => {
    const f = setup();
    f.sessions.set("s1", f.a);
    f.sessions.set("s2", f.b);
    const result = await f.run([], ["s1", "s2"]);
    expect(result).toEqual({ migrated: [f.a, f.b], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(true);
    expect(f.projects.isAllowed(f.b)).toBe(true);
  });

  it("a listed worktree folder enables its project root", async () => {
    const f = setup();
    const wt = join(f.b, "wt");
    mkdirSync(wt);
    f.folderRoots.set(wt, f.b);
    expect(await f.run([wt])).toEqual({ migrated: [f.b], ran: true });
    expect(f.projects.isAllowed(f.b)).toBe(true);
    expect(f.projects.isAllowed(wt)).toBe(false);
  });

  it("a folder that appears after the first start is enabled on the second", async () => {
    const f = setup();
    const later = join(f.root, "later");
    expect((await f.run([f.a, later])).ran).toBe(false);
    expect(f.projects.isAllowed(later)).toBe(false);
    mkdirSync(later);
    expect(await f.run([f.a, later])).toEqual({ migrated: [later], ran: true });
    expect(f.projects.isAllowed(later)).toBe(true);
  });

  it("a session that cannot be resolved stays pending until it can, then is processed", async () => {
    const f = setup();
    f.sessions.set("s1", f.a);
    expect((await f.run([], ["s1", "ghost"])).ran).toBe(false);
    f.sessions.set("ghost", f.b);
    expect(await f.run([], ["s1", "ghost"])).toEqual({ migrated: [f.b], ran: true });
  });

  it("drops an item pending for the cap number of starts and logs once", async () => {
    const f = setup();
    const gone = join(f.root, "gone");
    for (let boot = 1; boot < 3; boot += 1) expect((await f.run([gone], [], f.projects, 3)).ran).toBe(false);
    expect(f.warnings).toHaveLength(0);
    expect((await f.run([gone], [], f.projects, 3)).ran).toBe(true);
    expect(f.warnings).toHaveLength(1);
    expect(await f.run([gone], [], f.projects, 3)).toEqual({ migrated: [], ran: false });
    expect(f.warnings).toHaveLength(1);
  });

  it("an empty list with no shared session records the pass and switches nothing on", async () => {
    const f = setup();
    expect(await f.run([])).toEqual({ migrated: [], ran: true });
    expect(f.projects.allowedKeys()).toEqual([]);
  });

  it("after a partial failure a retry handles only unprocessed items, so a project switched off stays off", async () => {
    const f = setup();
    const failing = { ...f.projects, setAllowed: (folder: string, allowed: boolean) => (folder === f.b ? false : f.projects.setAllowed(folder, allowed)) };
    const first = await f.run([f.a, f.b], [], failing);
    expect(first.ran).toBe(false);
    expect(f.projects.isAllowed(f.a)).toBe(true);
    f.projects.setAllowed(f.a, false);
    const second = await f.run([f.a, f.b]);
    expect(second).toEqual({ migrated: [f.b], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(false);
    expect(f.projects.isAllowed(f.b)).toBe(true);
  });

  it("treats an older empty marker as a finished pass", async () => {
    const f = setup();
    writeFileSync(f.markerFile, "{}");
    expect(await f.run([f.a])).toEqual({ migrated: [], ran: false });
    expect(f.projects.isAllowed(f.a)).toBe(false);
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

  it("a listed root and a worktree that is gone: the root is switched on and the pass finishes", async () => {
    const f = setup();
    const gone = join(f.b, "wt-gone");
    f.folderRoots.set(gone, f.b);
    expect(await f.run([f.b, gone])).toEqual({ migrated: [f.b], ran: true });
    expect(f.projects.isAllowed(f.b)).toBe(true);
    expect(f.projects.isAllowed(gone)).toBe(false);
  });

  it("only a worktree that is gone is listed: its project root is still switched on", async () => {
    const f = setup();
    const gone = join(f.b, "wt-gone");
    f.folderRoots.set(gone, f.b);
    expect(await f.run([gone])).toEqual({ migrated: [f.b], ran: true });
  });

  it("a listed folder that is missing and has no project stays pending", async () => {
    const f = setup();
    const gone = join(f.root, "nowhere");
    expect(await f.run([f.a, gone])).toEqual({ migrated: [f.a], ran: false });
    expect(f.projects.isAllowed(gone)).toBe(false);
  });

  it("when the state file cannot be written nothing is switched on, so a project turned off is not turned back on", async () => {
    const f = setup();
    writeFileSync(join(f.root, "blocked"), "x");
    const blocked = join(f.root, "blocked", "marker.json");
    expect(await f.run([f.a], [], f.projects, undefined, { markerFile: blocked })).toEqual({ migrated: [], ran: false });
    expect(f.projects.isAllowed(f.a)).toBe(false);
    expect(existsSync(blocked)).toBe(false);
  });

  it("settings that were not loaded change nothing and write no state, so the list is still migrated on the next start", async () => {
    const f = setup();
    f.sessions.set("s1", f.b);
    expect(await f.run([], ["s1"], f.projects, undefined, { settingsLoaded: false })).toEqual({ migrated: [], ran: false });
    expect(existsSync(f.markerFile)).toBe(false);
    expect(f.projects.allowedKeys()).toEqual([]);
    expect(await f.run([f.a])).toEqual({ migrated: [f.a], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(true);
  });

  it.each([
    ["unreadable", (file: string) => mkdirSync(file)],
    ["broken JSON", (file: string) => writeFileSync(file, "{ not json")],
  ])("startup wiring: a settings file that is %s defers the migration, and the next good start migrates the saved list", async (_name, breakIt) => {
    const f = setup();
    const settingsFile = join(dirname(f.markerFile), "settings.json");
    breakIt(settingsFile);
    const loaded = await loadSettings(settingsFile);
    expect(loaded.loadFailed).toBe(true);
    // Exactly what index.ts passes at startup.
    expect(await f.run(loaded.settings.communication?.workspaces ?? [], [], f.projects, undefined, { settingsLoaded: loaded.loadFailed !== true })).toEqual({ migrated: [], ran: false });
    expect(existsSync(f.markerFile)).toBe(false);
    // Next start: the file is readable again and still holds the old list.
    rmSync(settingsFile, { recursive: true, force: true });
    writeFileSync(settingsFile, JSON.stringify({ ...cloneDefaults(), communication: { ...cloneDefaults().communication, workspaces: [f.a] } }));
    const good = await loadSettings(settingsFile);
    expect(good.loadFailed).toBeUndefined();
    expect(good.settings.communication?.workspaces).toEqual([f.a]);
    expect(await f.run(good.settings.communication?.workspaces ?? [], [], f.projects, undefined, { settingsLoaded: good.loadFailed !== true })).toEqual({ migrated: [f.a], ran: true });
    expect(f.projects.isAllowed(f.a)).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentProjectsStore } from "./communication-agent-projects.js";
import { migrateAllowedFolders } from "./communication-workspaces-migration.js";
import { workspaceIdFor } from "./scope-workspaces.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anycode-migrate-")));
  dirs.push(root);
  const known = join(root, "known"), unknown = join(root, "unknown");
  for (const folder of [known, unknown]) mkdirSync(folder);
  const projectsFile = join(root, "projects.json");
  const projects = createAgentProjectsStore({ file: projectsFile, realpathSync });
  const markerFile = join(root, "marker.json");
  const run = (workspaces: string[]) => migrateAllowedFolders({
    markerFile, workspaces, projects, realpathSync,
    knownProjectIds: async () => new Set([workspaceIdFor(known, realpathSync)]),
  });
  return { known, unknown, projects, markerFile, projectsFile, run };
}

describe("allowed folders migration", () => {
  it("switches on only the listed folders that are known projects", async () => {
    const f = setup();
    const result = await f.run([f.known, f.unknown, join(f.known, "gone")]);
    expect(result).toEqual({ migrated: [f.known], ran: true });
    expect(f.projects.isAllowed(f.known)).toBe(true);
    expect(f.projects.isAllowed(f.unknown)).toBe(false);
  });

  it("runs once: a later pass changes nothing, even after the switch is turned off", async () => {
    const f = setup();
    await f.run([f.known]);
    expect(existsSync(f.markerFile)).toBe(true);
    f.projects.setAllowed(f.known, false);
    expect(await f.run([f.known])).toEqual({ migrated: [], ran: false });
    expect(f.projects.isAllowed(f.known)).toBe(false);
  });

  it("an empty list still records the pass, so later folders are never migrated", async () => {
    const f = setup();
    expect(await f.run([])).toEqual({ migrated: [], ran: true });
    expect(await f.run([f.known])).toEqual({ migrated: [], ran: false });
    expect(f.projects.allowedKeys()).toEqual([]);
  });
});

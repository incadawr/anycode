/**
 * One-time migration of the retired Sessions API "Allowed folders" list into
 * the per-project "Agents may open tasks here" switches. The list stops being a
 * gate; each folder that is a known project (an open tab or a recent session)
 * keeps its agents' access by being switched on once. The saved setting is left
 * untouched on disk. A marker file makes the pass run exactly once, whatever
 * the outcome, so a later project is never switched on behind the user's back.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspaceIdFor } from "./scope-workspaces.js";
import type { AgentProjectsStore } from "./communication-agent-projects.js";

export interface WorkspacesMigrationDeps {
  markerFile: string;
  /** The folders saved in `communication.workspaces`. */
  workspaces: readonly string[];
  /** Ids (`ws_...`) of the known projects, from the scope registry. */
  knownProjectIds(): Promise<ReadonlySet<string>>;
  projects: AgentProjectsStore;
  realpathSync(path: string): string;
}

export async function migrateAllowedFolders(deps: WorkspacesMigrationDeps): Promise<{ migrated: string[]; ran: boolean }> {
  if (existsSync(deps.markerFile)) return { migrated: [], ran: false };
  const migrated: string[] = [];
  if (deps.workspaces.length > 0) {
    const known = await deps.knownProjectIds();
    for (const folder of deps.workspaces) {
      try {
        if (known.has(workspaceIdFor(folder, deps.realpathSync)) && deps.projects.setAllowed(folder, true)) migrated.push(folder);
      } catch { /* a folder that cannot be resolved is not a known project */ }
    }
  }
  try {
    mkdirSync(dirname(deps.markerFile), { recursive: true, mode: 0o700 });
    writeFileSync(deps.markerFile, "{}", { mode: 0o600 });
  } catch { /* unwritable: the pass repeats next start, which is idempotent */ }
  return { migrated, ran: true };
}

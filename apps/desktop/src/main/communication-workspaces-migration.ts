/**
 * One-time migration of the retired Sessions API "Allowed folders" list into
 * the per-project "Agents may open tasks here" switches, so agents keep the
 * access they had.
 *
 * - A non-empty list: every listed folder that still exists is switched on
 *   (a folder that is already on is left alone).
 * - An empty list used to mean "any folder" for shared sessions: the canonical
 *   project folder of every session that is currently shared is switched on,
 *   when it can be resolved. Sessions that cannot be resolved are skipped and
 *   reported once.
 *
 * The saved setting is left untouched on disk. The marker file is written only
 * after every write succeeded; on any failure no marker is left, so the next
 * start retries (the pass is idempotent).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProjectsStore } from "./communication-agent-projects.js";

export interface MigratedSession {
  workspace: string;
  projectRoot?: string;
  worktree?: unknown;
}

export interface WorkspacesMigrationDeps {
  markerFile: string;
  /** The folders saved in `communication.workspaces`. */
  workspaces: readonly string[];
  /** Ids of the sessions whose own Sessions API switch is on. Read only for an empty list. */
  exposedSessionIds(): readonly string[];
  /** The stored folders of a session, or null when it cannot be resolved. */
  resolveSession(sessionId: string): Promise<MigratedSession | null>;
  projects: AgentProjectsStore;
  isDirectory?(path: string): boolean;
  warn?(message: string): void;
}

/** The canonical project folder of a session: the project root of a worktree, else its workspace. */
function projectFolderOf(session: MigratedSession): string {
  return session.worktree !== undefined && session.projectRoot !== undefined ? session.projectRoot : session.workspace;
}

export async function migrateAllowedFolders(deps: WorkspacesMigrationDeps): Promise<{ migrated: string[]; ran: boolean }> {
  if (existsSync(deps.markerFile)) return { migrated: [], ran: false };
  const isDirectory = deps.isDirectory ?? existsSync;
  const folders = new Set<string>();
  if (deps.workspaces.length > 0) {
    for (const folder of deps.workspaces) folders.add(folder);
  } else {
    let unresolved = 0;
    for (const sessionId of deps.exposedSessionIds()) {
      let session: MigratedSession | null = null;
      try { session = await deps.resolveSession(sessionId); } catch { session = null; }
      if (session === null) { unresolved += 1; continue; }
      folders.add(projectFolderOf(session));
    }
    if (unresolved > 0) deps.warn?.(`Sessions API migration skipped ${unresolved} shared session(s) whose folder could not be resolved`);
  }
  const migrated: string[] = [];
  let failed = false;
  for (const folder of folders) {
    if (!isDirectory(folder)) continue;
    try {
      if (deps.projects.isAllowed(folder)) continue;
      if (deps.projects.setAllowed(folder, true)) migrated.push(folder); else failed = true;
    } catch { failed = true; }
  }
  if (failed) return { migrated, ran: false };
  try {
    mkdirSync(dirname(deps.markerFile), { recursive: true, mode: 0o700 });
    writeFileSync(deps.markerFile, "{}", { mode: 0o600 });
  } catch { return { migrated, ran: false }; }
  return { migrated, ran: true };
}

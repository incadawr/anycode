/**
 * One-time migration of the retired Sessions API "Allowed folders" list into
 * the per-project "Agents may open tasks here" switches, so agents keep the
 * access they had.
 *
 * - A non-empty list: every listed folder is mapped to its canonical project
 *   folder (a worktree path maps to its project root) and that project is
 *   switched on.
 * - An empty list used to mean "any folder" for shared sessions: the canonical
 *   project folder of every session that is shared at the first start is
 *   switched on (a child session is resolved through its root session).
 *
 * The item list is fixed at the first start and kept in the state file. An
 * item is removed once it is processed, so a later start never touches it
 * again (a project the user switched off stays off). An item whose folder does
 * not exist yet or whose session cannot be resolved stays pending and is
 * retried on the next starts; after 10 starts it is dropped and logged once.
 * The saved setting is left untouched on disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProjectsStore } from "./communication-agent-projects.js";

export interface WorkspacesMigrationDeps {
  /** State file: the pending items and their failed attempts. */
  markerFile: string;
  /** The folders saved in `communication.workspaces`. */
  workspaces: readonly string[];
  /** Ids of the sessions whose own Sessions API switch is on. Read only for an empty list. */
  exposedSessionIds(): readonly string[];
  /** The canonical project folder of a session (a child through its root), or null when it cannot be resolved. */
  resolveSession(sessionId: string): Promise<string | null>;
  /** The canonical project folder of a listed folder; a worktree path maps to its project root. Defaults to the folder itself. */
  resolveFolder?(folder: string): Promise<string>;
  projects: AgentProjectsStore;
  isDirectory?(path: string): boolean;
  warn?(message: string): void;
  /** Starts after which a still-pending item is dropped. Default 10. */
  maxAttempts?: number;
}

interface MigrationState {
  /** Absent in the older marker format, which means the pass is complete. */
  pending?: string[];
  attempts?: Record<string, number>;
}

const FOLDER = "folder:";
const SESSION = "session:";

function readState(file: string): MigrationState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as MigrationState;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch { return {}; }
}

function writeState(file: string, state: MigrationState): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return true;
  } catch { return false; }
}

export async function migrateAllowedFolders(deps: WorkspacesMigrationDeps): Promise<{ migrated: string[]; ran: boolean }> {
  const existing = readState(deps.markerFile);
  if (existing !== null && (!Array.isArray(existing.pending) || existing.pending.length === 0)) return { migrated: [], ran: false };
  const isDirectory = deps.isDirectory ?? existsSync;
  const maxAttempts = deps.maxAttempts ?? 10;
  const migrated: string[] = [];
  let pending: string[];
  if (existing !== null) pending = existing.pending ?? [];
  else if (deps.workspaces.length > 0) pending = deps.workspaces.map((folder) => FOLDER + folder);
  else pending = deps.exposedSessionIds().map((id) => SESSION + id);
  const attempts: Record<string, number> = { ...(existing?.attempts ?? {}) };
  let writable = true;
  const save = (): void => { if (!writeState(deps.markerFile, { pending, attempts })) writable = false; };
  if (existing === null) save();

  for (const item of [...pending]) {
    let project: string | null = null;
    try {
      if (item.startsWith(FOLDER)) {
        const folder = item.slice(FOLDER.length);
        if (isDirectory(folder)) project = deps.resolveFolder ? await deps.resolveFolder(folder) : folder;
      } else {
        project = await deps.resolveSession(item.slice(SESSION.length));
      }
    } catch { project = null; }
    let done = false;
    if (project !== null && isDirectory(project)) {
      try {
        if (deps.projects.isAllowed(project)) done = true;
        else if (deps.projects.setAllowed(project, true)) { migrated.push(project); done = true; }
      } catch { done = false; }
    }
    if (done) {
      pending = pending.filter((entry) => entry !== item);
      delete attempts[item];
    } else {
      attempts[item] = (attempts[item] ?? 0) + 1;
      if (attempts[item] >= maxAttempts) {
        deps.warn?.(`Sessions API migration gave up on ${item.startsWith(FOLDER) ? "folder" : "session"} ${item.slice(item.indexOf(":") + 1)}: it could not be resolved`);
        pending = pending.filter((entry) => entry !== item);
        delete attempts[item];
      }
    }
    save();
  }
  if (!writable) return { migrated, ran: false };
  return { migrated, ran: pending.length === 0 };
}

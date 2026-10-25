/**
 * Taskana 4758: main-side registry behind the Settings scope dropdown.
 *
 * It lists the folders a user can point a Settings pane at (open tabs first,
 * then recent root sessions) and resolves an opaque scope reference back to a
 * folder. The renderer only ever sees `ws_<16 hex>` ids; the id is a pure
 * function of the canonical folder key, and `resolve` accepts a `ws_` id only
 * when it is in this registry's cache and still a directory on disk. Electron-
 * free: every platform effect comes in through the deps bag.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalWorkspaceKey } from "@anycode/core/workspace-trust";
import {
  SCOPE_WORKSPACE_ID_PREFIX,
  type ScopeWorkspaceEntry,
} from "../shared/scope-workspaces.js";

/** Session row shape the registry reads (a subset of persistence SessionMeta). */
export interface ScopeRecentSession {
  workspace: string;
  projectRoot?: string;
  worktree?: unknown;
  updatedAt: number;
}

export interface ScopeWorkspaceRegistryDeps {
  listRootSessions(opts: { limit: number }): Promise<ScopeRecentSession[]>;
  openTabs(): ReadonlyArray<{ tabId: string; workspace: string }>;
  realpathSync(path: string): string;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  statSync(path: string): { isDirectory(): boolean };
  homedir(): string;
  now(): number;
}

export interface ScopeWorkspaceRegistry {
  list(): Promise<ScopeWorkspaceEntry[]>;
  /**
   * Scope reference resolver. `undefined`/empty => undefined; a `ws_` ref =>
   * the cached folder if it is still a directory; anything else => the legacy
   * tab lookup via `tabWorkspace`.
   */
  resolve(ref: string | undefined, tabWorkspace: (tabId: string) => string | undefined): string | undefined;
}

const RECENT_LIMIT = 12;
const TOTAL_LIMIT = 24;
const SESSION_SCAN_LIMIT = 200;

/** `ws_` + first 16 hex chars of sha256(canonical folder key). */
export function workspaceIdFor(path: string, realpathSync: (p: string) => string): string {
  const key = canonicalWorkspaceKey(path, realpathSync);
  return SCOPE_WORKSPACE_ID_PREFIX + createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Home-collapsed display path. Display only: never sent back to main. */
export function displayPathFor(path: string, home: string): string {
  const normalized = path.replace(/\\/g, "/");
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (h !== "" && (normalized === h || normalized.startsWith(`${h}/`))) {
    return `~${normalized.slice(h.length)}`;
  }
  return normalized;
}

export function createScopeWorkspaceRegistry(deps: ScopeWorkspaceRegistryDeps): ScopeWorkspaceRegistry {
  // id -> canonical folder path. Replaced atomically on every list().
  let cache = new Map<string, string>();

  const keyOf = (path: string): string => canonicalWorkspaceKey(path, deps.realpathSync);

  // Initial fill from open tabs so resolve() works before the first list().
  for (const tab of deps.openTabs()) {
    const key = keyOf(tab.workspace);
    cache.set(workspaceIdFor(tab.workspace, deps.realpathSync), key);
  }

  return {
    async list(): Promise<ScopeWorkspaceEntry[]> {
      // Open tabs: always included, first, deduped by canonical key.
      const openTabs = deps.openTabs();
      const allOpenKeys: string[] = [];
      const tabIdsByKey = new Map<string, string[]>();
      for (const tab of openTabs) {
        const key = keyOf(tab.workspace);
        if (!tabIdsByKey.has(key)) {
          tabIdsByKey.set(key, []);
          allOpenKeys.push(key);
        }
        tabIdsByKey.get(key)!.push(tab.tabId);
      }
      const openKeys = allOpenKeys.slice(0, TOTAL_LIMIT);

      // Recents: root sessions only, grouped by folder, newest updatedAt wins.
      let sessions: ScopeRecentSession[] = [];
      try {
        sessions = await deps.listRootSessions({ limit: SESSION_SCAN_LIMIT });
      } catch {
        sessions = [];
      }
      const newest = new Map<string, number>();
      for (const session of sessions) {
        const folder = session.worktree ? (session.projectRoot ?? session.workspace) : session.workspace;
        const key = keyOf(folder);
        const prev = newest.get(key);
        if (prev === undefined || session.updatedAt > prev) newest.set(key, session.updatedAt);
      }
      const recentKeys = [...newest.entries()]
        .filter(([key]) => !tabIdsByKey.has(key))
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(RECENT_LIMIT, TOTAL_LIMIT - openKeys.length))
        .map(([key]) => key);

      const keys = [...openKeys, ...recentKeys];
      const next = new Map<string, string>();
      const workspaces: ScopeWorkspaceEntry[] = [];
      const home = deps.homedir();
      for (const key of keys) {
        const id = workspaceIdFor(key, deps.realpathSync);
        next.set(id, key);
        let exists = false;
        try {
          exists = (await deps.stat(key)).isDirectory();
        } catch {
          exists = false;
        }
        const base = basename(key);
        workspaces.push({
          id,
          name: base === "" ? key : base,
          displayPath: displayPathFor(key, home),
          exists,
          tabIds: tabIdsByKey.get(key) ?? [],
        });
      }
      cache = next;
      return workspaces;
    },

    resolve(ref, tabWorkspace) {
      if (ref === undefined || ref === "") return undefined;
      if (ref.startsWith(SCOPE_WORKSPACE_ID_PREFIX)) {
        const path = cache.get(ref);
        if (path === undefined) return undefined;
        try {
          return deps.statSync(path).isDirectory() ? path : undefined;
        } catch {
          return undefined;
        }
      }
      return tabWorkspace(ref);
    },
  };
}

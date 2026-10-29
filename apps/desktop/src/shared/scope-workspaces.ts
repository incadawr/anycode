/**
 * Taskana 4758: the Settings scope dropdown's workspace list. The renderer
 * receives only opaque ids plus display fields; it never supplies a path back.
 * Value-only and import-free so the sandboxed preload can value-import it.
 */
export const SCOPE_WORKSPACES_LIST_CHANNEL = "anycode:scope-workspaces-list";
export const SCOPE_WORKSPACES_RESOLVE_CHANNEL = "anycode:scope-workspaces-resolve";

/** Prefix of a workspace scope reference (`ws_` + 16 hex). Tab ids never start with it. */
export const SCOPE_WORKSPACE_ID_PREFIX = "ws_";

export interface ScopeWorkspaceEntry {
  /** `ws_<16 hex>`, opaque to the renderer. */
  id: string;
  /** Basename of the folder ("/" => full path). */
  name: string;
  /** Home-collapsed path, for display only; never sent back. */
  displayPath: string;
  /** False when the folder no longer exists on disk (shown disabled). */
  exists: boolean;
  /** Open tabs whose workspace is this folder (for MCP live status join). */
  tabIds: string[];
}

export type ScopeWorkspacesListResult =
  | { ok: true; workspaces: ScopeWorkspaceEntry[] }
  | { ok: false; reason: "failed" };

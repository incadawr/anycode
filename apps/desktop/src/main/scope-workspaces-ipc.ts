/**
 * Taskana 4758: IPC for the Settings scope dropdown's workspace list. The
 * payload is an empty strict object; the result is an allow-listed projection
 * of the registry entries (id, name, displayPath, exists, tabIds). No
 * renderer-supplied path exists anywhere on this channel.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import {
  SCOPE_WORKSPACES_LIST_CHANNEL,
  SCOPE_WORKSPACES_RESOLVE_CHANNEL,
  type ScopeWorkspaceEntry,
  type ScopeWorkspacesListResult,
} from "../shared/scope-workspaces.js";

export interface ScopeWorkspacesIpcDeps {
  registry: { list(): Promise<ScopeWorkspaceEntry[]> };
  resolve?(ref: string): string | undefined;
}

const listPayloadSchema = z.object({}).strict();

export async function handleScopeWorkspacesList(
  deps: ScopeWorkspacesIpcDeps,
  raw: unknown,
): Promise<ScopeWorkspacesListResult> {
  if (raw !== undefined && !listPayloadSchema.safeParse(raw).success) {
    return { ok: false, reason: "failed" };
  }
  try {
    const entries = await deps.registry.list();
    return {
      ok: true,
      workspaces: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        displayPath: entry.displayPath,
        exists: entry.exists,
        tabIds: [...entry.tabIds],
      })),
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export function handleScopeWorkspaceResolve(deps: ScopeWorkspacesIpcDeps, raw: unknown): string | null {
  const parsed = z.object({ ref: z.string().min(1) }).strict().safeParse(raw);
  return parsed.success ? deps.resolve?.(parsed.data.ref) ?? null : null;
}

export function registerScopeWorkspacesIpc(deps: ScopeWorkspacesIpcDeps): void {
  ipcMain.handle(SCOPE_WORKSPACES_LIST_CHANNEL, (_event, raw: unknown) => handleScopeWorkspacesList(deps, raw));
  ipcMain.handle(SCOPE_WORKSPACES_RESOLVE_CHANNEL, (_event, raw: unknown) => handleScopeWorkspaceResolve(deps, raw));
}

import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";
import { checkConfigFilePath } from "./config-file-path.js";
import { projectConfigPath, userConfigPath, compatConfigPath } from "./mcp-config-paths.js";
import type { McpConfigIpcDeps } from "./mcp-config-ipc.js";
import { MCP_CONFIG_OPEN_FILE_CHANNEL, type McpConfigOpenFileResult } from "../shared/mcp-config.js";

const schema = z.strictObject({
  tabId: z.string().min(1).optional(),
  source: z.enum(["project", "user", "compat"]),
  action: z.enum(["open", "reveal"]).optional(),
});

export async function handleMcpConfigOpenFile(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigOpenFileResult> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { tabId, source, action = "open" } = parsed.data;
  try {
    const resolveBase = () => source === "user" ? deps.home() : tabId ? deps.workspaceForTab(tabId) : undefined;
    const base = resolveBase();
    if (base === undefined) return { ok: false, reason: "no_workspace" };
    const target = source === "compat" ? compatConfigPath(base) : source === "user" ? userConfigPath(base) : projectConfigPath(base);
    const checked = await checkConfigFilePath(deps.fs, base, target);
    if (!checked.ok) return checked;
    // Recheck custody immediately before dispatch. OS open still has a local filesystem race.
    if (resolveBase() !== base) return { ok: false, reason: "no_workspace" };
    const fresh = await checkConfigFilePath(deps.fs, base, target);
    if (!fresh.ok) return fresh;
    if (fresh.path !== checked.path) return { ok: false, reason: "unsafe_path" };
    if (action === "reveal") {
      if (!deps.reveal) return { ok: false, reason: "open_failed" };
      deps.reveal(fresh.path);
    } else {
      if (!deps.openPath || await deps.openPath(fresh.path) !== "") return { ok: false, reason: "open_failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "open_failed" };
  }
}

export function registerMcpConfigOpenFileIpc(deps: McpConfigIpcDeps): void {
  guardedIpcHandle(MCP_CONFIG_OPEN_FILE_CHANNEL, (_event, raw) => handleMcpConfigOpenFile(deps, raw), { mainWindowOnly: true });
}

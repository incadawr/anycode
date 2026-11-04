import { dialog } from "electron";
import { open, writeFile } from "node:fs/promises";
import { z } from "zod";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { roleProfiles } from "../shared/role-profiles.js";
import { applySetupImport, buildSetupContent, planSetupImport, validateSetupContent, SetupExportError, type SetupContent } from "./setup-content.js";
import { handleGet, type SettingsIpcDeps } from "./settings-ipc.js";
import { guardedIpcHandle } from "./ipc-guard.js";

interface Dialogs {
  showSaveDialog(options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(options: { properties: ["openFile"]; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>;
}
const filters = [{ name: "JSON", extensions: ["json"] }];
const choicesSchema = z.object({ connections: z.record(z.string(), z.enum(["update-existing", "add-copy", "skip"])), roleProfiles: z.record(z.string(), z.enum(["update-existing", "add-copy", "skip"])) }).strict();
const MAX_BYTES = 2_000_000;
async function readSetupFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid file size");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error("Invalid file size");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

export function createSetupHandlers(deps: SettingsIpcDeps, dialogs: Dialogs = dialog) {
  let pending: { content: SetupContent; settings: string } | undefined;
  return {
    async exportFile() {
      try {
        const { settings } = await loadSettings(deps.settingsPath, deps.logger);
        const content = buildSetupContent(settings, { connectionIds: settings.provider.connections.map((c) => c.id), roleProfileIds: roleProfiles(settings).profiles.map((p) => p.id) });
        const result = await dialogs.showSaveDialog({ defaultPath: "anycode-setup.json", filters });
        if (result.canceled || !result.filePath) return { canceled: true as const };
        await writeFile(result.filePath, JSON.stringify({ version: 1, ...content }, null, 2) + "\n", { mode: 0o600 });
        return { ok: true as const };
      } catch (error) { return { error: error instanceof SetupExportError ? error.message : "Could not export setup. Check connections and proxy settings." }; }
    },
    async preview() {
      pending = undefined;
      try {
        const result = await dialogs.showOpenDialog({ properties: ["openFile"], filters });
        if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
        const bytes = await readSetupFile(result.filePaths[0]);
        const raw: unknown = JSON.parse(bytes.toString("utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
        const { version, ...body } = raw as Record<string, unknown>;
        if (version !== 1) throw new Error();
        const content = validateSetupContent(body);
        const { settings } = await loadSettings(deps.settingsPath, deps.logger);
        const plan = planSetupImport(content, settings);
        pending = { content, settings: JSON.stringify(settings) };
        return { ok: true as const, connections: plan.connections, roleProfiles: plan.roleProfiles };
      } catch { return { error: "Invalid or unreadable setup file." }; }
    },
    async apply(raw: unknown) {
      const parsed = choicesSchema.safeParse(raw);
      if (!parsed.success) return { error: "Invalid collision choices." };
      const choices = parsed.data;
      try {
        return await withSettingsFileLock(deps.settingsPath, async () => {
          if (!pending) return { error: "Open a setup file first." };
          const loaded = await loadSettings(deps.settingsPath, deps.logger);
          if (loaded.readOnly) return { error: "Settings are read-only." };
          if (JSON.stringify(loaded.settings) !== pending.settings) return { error: "Settings changed; open the file again." };
          const result = applySetupImport(planSetupImport(pending.content, loaded.settings), choices);
          await saveSettings(deps.settingsPath, result);
          const addedIds = result.provider.connections.filter((c) => !loaded.settings.provider.connections.some((old) => old.id === c.id && old.providerId === c.providerId)).map((c) => c.id);
          pending = undefined;
          const snapshot = await handleGet(deps);
          await deps.onMutation?.(snapshot);
          return { ok: true as const, addedIds };
        });
      } catch { return { error: "Could not apply setup. Check collision choices and proxy profiles." }; }
    },
  };
}

export function registerSetupIpc(deps: SettingsIpcDeps): void {
  const handlers = createSetupHandlers(deps);
  guardedIpcHandle("anycode:setup-export", () => handlers.exportFile());
  guardedIpcHandle("anycode:setup-preview", () => handlers.preview());
  guardedIpcHandle("anycode:setup-apply", (_event, choices: unknown) => handlers.apply(choices));
}

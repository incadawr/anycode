import { dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { roleProfiles } from "../shared/role-profiles.js";
import { applySetupImport, buildSetupContent, planSetupImport, validateSetupContent, type SetupChoice, type SetupContent } from "./setup-content.js";
import { handleGet, type SettingsIpcDeps } from "./settings-ipc.js";

interface Dialogs {
  showSaveDialog(options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(options: { properties: ["openFile"]; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>;
}
const filters = [{ name: "JSON", extensions: ["json"] }];
type Choices = { connections: Record<string, SetupChoice>; roleProfiles: Record<string, SetupChoice> };

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
      } catch { return { error: "Could not export setup. Check connections, proxy settings, and names or URLs for secret-like text." }; }
    },
    async preview() {
      pending = undefined;
      try {
        const result = await dialogs.showOpenDialog({ properties: ["openFile"], filters });
        if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
        const bytes = await readFile(result.filePaths[0]);
        if (bytes.length > 2_000_000) throw new Error();
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
    async apply(choices: Choices) {
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
  ipcMain.handle("anycode:setup-export", () => handlers.exportFile());
  ipcMain.handle("anycode:setup-preview", () => handlers.preview());
  ipcMain.handle("anycode:setup-apply", (_event, choices: Choices) => handlers.apply(choices));
}

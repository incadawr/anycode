import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { loadSettings, saveSettings } from "../settings/files.js";
import { createSetupHandlers } from "./setup-ipc.js";
import type { SettingsIpcDeps } from "./settings-ipc.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "setup-ipc-")); dirs.push(dir);
  const settingsPath = join(dir, "settings.json"), file = join(dir, "setup.json");
  const vault: SettingsIpcDeps["vault"] = { setSecret: async () => ({ ok: true }), clearSecret: async () => {}, getSecretValue: async () => "fixture-secret", probeSecret: async () => ({ state: "unset" }), statuses: async () => [] };
  const dialogs = { showSaveDialog: async () => ({ canceled: false, filePath: file }), showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) };
  return { file, settingsPath, handlers: createSetupHandlers({ settingsPath, bootEnv: {}, vault }, dialogs) };
}
const choices = { connections: { Team: "update-existing" as const }, roleProfiles: {} };
describe("setup file handlers", () => {
  it("exports without secrets and reimports idempotently", async () => {
    const f = await fixture(); const settings = cloneDefaults();
    settings.provider.custom = [{ id: "custom:one", name: "Gateway", kind: "openai-compatible", baseUrl: "https://example.test/v1", models: ["model"] }];
    settings.provider.connections = [{ id: "conn-one", providerId: "custom:one", label: "Team" }];
    await saveSettings(f.settingsPath, settings);
    expect(await f.handlers.exportFile()).toEqual({ ok: true });
    expect(await readFile(f.file, "utf8")).not.toContain("fixture-secret");
    expect((await f.handlers.preview()).ok).toBe(true);
    expect((await f.handlers.apply(choices)).ok).toBe(true);
    const first = (await loadSettings(f.settingsPath)).settings;
    expect((await f.handlers.preview()).ok).toBe(true);
    expect((await f.handlers.apply(choices)).ok).toBe(true);
    expect((await loadSettings(f.settingsPath)).settings).toEqual(first);
    expect((await f.handlers.preview()).ok).toBe(true);
    expect((await f.handlers.apply({ connections: { Team: "add-copy" }, roleProfiles: {} })).ok).toBe(true);
    expect((await loadSettings(f.settingsPath)).settings.provider.connections).toHaveLength(2);
    expect((await f.handlers.preview()).ok).toBe(true);
    expect((await f.handlers.apply({ connections: { Team: "skip" }, roleProfiles: {} })).ok).toBe(true);
    expect((await loadSettings(f.settingsPath)).settings.provider.connections).toHaveLength(2);
  });
  it("does not write an export containing a secret-like name or URL", async () => {
    for (const [label, baseUrl] of [["sk-fixture-secret", "https://example.test/v1"], ["Team", "https://example.test/sk-fixture-secret"]]) {
      const f = await fixture(); const settings = cloneDefaults();
      settings.provider.custom = [{ id: "custom:one", name: "Gateway", kind: "openai-compatible", baseUrl: baseUrl!, models: [] }];
      settings.provider.connections = [{ id: "conn-one", providerId: "custom:one", label }];
      await saveSettings(f.settingsPath, settings);
      expect((await f.handlers.exportFile()).error).toBeTruthy();
      await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("rejects malformed files", async () => {
    const f = await fixture(); await writeFile(f.file, '{"version":1,"connections":[],"roleProfiles":[],"token":"secret"}');
    expect((await f.handlers.preview()).error).toBeTruthy();
  });
});

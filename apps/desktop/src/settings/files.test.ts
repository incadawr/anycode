/**
 * Unit tests for the atomic settings/secrets file IO (design slice-2.2-cut.md
 * §1.1/§2, frozen by 2.2.1): fail-soft loads, atomic durable saves, exact perms
 * (0644/0600), corrupt-quarantine to `*.corrupt-<ts>`, and the frozen
 * secrets.json v1 format. Every test runs against a fresh scratch dir.
 */

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECRETS_FILE_MODE,
  SECRETS_FILE_VERSION,
  SETTINGS_FILE_MODE,
  emptySecrets,
  loadSecrets,
  loadSettings,
  saveSecrets,
  saveSettings,
  type SecretsFileV1,
} from "./files.js";
import { DEFAULT_SETTINGS, cloneDefaults } from "./schema.js";

let dir: string;
const settingsPath = () => join(dir, "settings.json");
const secretsPath = () => join(dir, "secrets.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Files quarantined out of the way, by basename prefix. */
async function backupsFor(base: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.startsWith(`${base}.corrupt-`));
}

function mode(path: string): Promise<number> {
  return stat(path).then((s) => s.mode & 0o777);
}

describe("loadSettings (fail-soft)", () => {
  it("returns defaults for a missing file, no backup", async () => {
    const result = await loadSettings(settingsPath());
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.readOnly).toBe(false);
    expect(result.corruptBackupPath).toBeUndefined();
  });

  it("round-trips a saved file", async () => {
    const settings = cloneDefaults();
    settings.provider.model = "claude-x";
    settings.ui.theme = "dark";
    await saveSettings(settingsPath(), settings);

    const result = await loadSettings(settingsPath());
    expect(result.settings).toEqual(settings);
    expect(result.readOnly).toBe(false);
  });

  it("quarantines corrupt JSON to *.corrupt-<ts> and returns defaults", async () => {
    await writeFile(settingsPath(), "{ this is not json", "utf8");
    const result = await loadSettings(settingsPath());
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.corruptBackupPath).toBeDefined();
    expect(await backupsFor("settings.json")).toHaveLength(1);
  });

  it("quarantines a schema-invalid file to *.corrupt-<ts> and returns defaults", async () => {
    await writeFile(settingsPath(), JSON.stringify({ version: 1, ui: { theme: 5 } }), "utf8");
    const result = await loadSettings(settingsPath());
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(await backupsFor("settings.json")).toHaveLength(1);
  });

  it("surfaces readOnly (no quarantine) for a newer-version file", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...cloneDefaults(), version: 99 }), "utf8");
    const result = await loadSettings(settingsPath());
    expect(result.readOnly).toBe(true);
    expect(await backupsFor("settings.json")).toHaveLength(0);
  });
});

describe("saveSettings (atomic + perms)", () => {
  it("writes settings.json with 0644 perms and leaves no tmp file", async () => {
    await saveSettings(settingsPath(), cloneDefaults());
    expect(await mode(settingsPath())).toBe(SETTINGS_FILE_MODE);
    const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("creates the parent directory when absent", async () => {
    const nested = join(dir, "sub", "deep", "settings.json");
    await saveSettings(nested, cloneDefaults());
    const result = await loadSettings(nested);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("secrets.json (frozen v1 custody format)", () => {
  it("empty vault for a missing file", async () => {
    const result = await loadSecrets(secretsPath());
    expect(result.file).toEqual(emptySecrets());
    expect(result.file.version).toBe(SECRETS_FILE_VERSION);
  });

  it("round-trips an entry (value treated as opaque ciphertext)", async () => {
    const file: SecretsFileV1 = {
      version: 1,
      entries: { "provider.apiKey": { cipher: "safeStorage", value: "b64-blob==" } },
    };
    await saveSecrets(secretsPath(), file);
    const result = await loadSecrets(secretsPath());
    expect(result.file).toEqual(file);
  });

  it("writes secrets.json with 0600 perms and no tmp leftover", async () => {
    await saveSecrets(secretsPath(), emptySecrets());
    expect(await mode(secretsPath())).toBe(SECRETS_FILE_MODE);
    const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("quarantines a corrupt vault to *.corrupt-<ts> and reports it empty", async () => {
    await writeFile(secretsPath(), "not json at all", "utf8");
    const result = await loadSecrets(secretsPath());
    expect(result.file).toEqual(emptySecrets());
    expect(result.corruptBackupPath).toBeDefined();
    expect(await backupsFor("secrets.json")).toHaveLength(1);
  });

  it("treats a schema-invalid vault as empty (all statuses reset)", async () => {
    await writeFile(secretsPath(), JSON.stringify({ version: 1, entries: { x: { cipher: "rot13" } } }), "utf8");
    const result = await loadSecrets(secretsPath());
    expect(result.file).toEqual(emptySecrets());
  });
});

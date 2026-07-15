/**
 * Bidirectional round-trip between core's CLI-side settings.json writer/reader
 * (`packages/core/src/cli/settings-rules.ts`) and desktop's strict-schema
 * writer/reader (`files.ts`/`schema.ts`) — design slice-P7.5-cut.md §3.3,
 * TASK.8. Proves the two clients are format-compatible on the SAME
 * `~/.anycode/settings.json` `permissions.alwaysAllow` section: one file, one
 * format, two writers. Every test runs against a fresh scratch dir, idiom of
 * files.test.ts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAlwaysAllowRule, loadPersistedAlwaysAllowRules } from "@anycode/core";
import { providerV2 } from "../shared/provider-v2-fixture.js";
import { loadSettings, saveSettings } from "./files.js";
import { cloneDefaults } from "./schema.js";

let dir: string;
const settingsPath = () => join(dir, "settings.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-cli-compat-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cli-settings-compat (core writer <-> desktop schema)", () => {
  it("a core-append against a missing path is readable by desktop loadSettings without quarantine", async () => {
    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Bash", pattern: "git *" });
    expect(result).toEqual({ persisted: true });

    const loaded = await loadSettings(settingsPath());
    expect(loaded.readOnly).toBe(false);
    expect(loaded.corruptBackupPath).toBeUndefined();
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "git *" }]);
  });

  it("a file written by the desktop saveSettings/handleAddRule idiom round-trips through core's reader", async () => {
    const settings = cloneDefaults();
    settings.permissions = {
      alwaysAllow: [
        { toolName: "Write", pattern: "src/**" },
        { toolName: "Read" },
      ],
    };
    await saveSettings(settingsPath(), settings);

    const rules = await loadPersistedAlwaysAllowRules(settingsPath());
    expect(rules).toEqual([
      { toolName: "Write", pattern: "src/**" },
      { toolName: "Read" },
    ]);
  });

  it("a core-append preserves an unknown top-level key byte-for-byte (passthrough)", async () => {
    const settings = cloneDefaults();
    await saveSettings(settingsPath(), settings);
    const loadedBefore = await loadSettings(settingsPath());
    const withUnknownKey = { ...loadedBefore.settings, futureFeature: { enabled: true } };
    await saveSettings(settingsPath(), withUnknownKey as unknown as typeof loadedBefore.settings);

    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Grep" });
    expect(result).toEqual({ persisted: true });

    const loaded = await loadSettings(settingsPath());
    expect(loaded.readOnly).toBe(false);
    expect(loaded.corruptBackupPath).toBeUndefined();
    expect((loaded.settings as unknown as { futureFeature?: unknown }).futureFeature).toEqual({ enabled: true });
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Grep" }]);
  });

  it("a core-append against a v2 file preserves the connections graph byte-for-byte across BOTH writers (§4.7)", async () => {
    // The CLI writer (settings-rules.ts appendAlwaysAllowRuleUnserialized) spreads
    // the WHOLE parsed json and only replaces the `permissions` key, so the v2
    // `provider.connections` block must survive its structure-preserving append
    // without any core-side change beyond widening the version write-gate to
    // accept v2. This proves it empirically rather than assuming it.
    const settings = cloneDefaults();
    settings.provider = providerV2({ id: "z-ai", model: "glm-5.2", reasoningEffort: "high" });
    await saveSettings(settingsPath(), settings);

    // (a) desktop read-modify-write: loadSettings re-parses through settingsSchema.
    const loadedBefore = await loadSettings(settingsPath());
    expect(loadedBefore.settings.provider.activeConnectionId).toBe("conn-z-ai");
    expect(loadedBefore.settings.provider.connections).toEqual([
      { id: "conn-z-ai", providerId: "z-ai", model: "glm-5.2", reasoningEffort: "high" },
    ]);

    // (b) CLI `/allow`-append writer: must ACCEPT the v2 file (write-gate widened)
    // and touch only permissions.alwaysAllow.
    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Bash", pattern: "npm *" });
    expect(result).toEqual({ persisted: true });

    const loaded = await loadSettings(settingsPath());
    expect(loaded.readOnly).toBe(false);
    expect(loaded.corruptBackupPath).toBeUndefined();
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-z-ai");
    expect(loaded.settings.provider.connections).toEqual([
      { id: "conn-z-ai", providerId: "z-ai", model: "glm-5.2", reasoningEffort: "high" },
    ]);
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "npm *" }]);
  });

  it("a core-append against a legacy v1 file still persists (write-gate accepts v1); desktop resets provider on load", async () => {
    // A v1 settings.json written by an older binary must not be refused by the
    // CLI append (ruling §4.7: accept v1 and v2, refuse only > CURRENT).
    const v1 = {
      version: 1,
      provider: { id: "z-ai", model: "glm-4.6" },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    await writeFile(settingsPath(), `${JSON.stringify(v1, null, 2)}\n`, "utf8");

    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Read" });
    expect(result).toEqual({ persisted: true });

    // desktop reads it, resetting the v1 provider to an empty v2 provider (no
    // v1-data carry-over) while preserving the appended rule.
    const loaded = await loadSettings(settingsPath());
    expect(loaded.readOnly).toBe(false);
    expect(loaded.corruptBackupPath).toBeUndefined();
    expect(loaded.settings.version).toBe(2);
    expect(loaded.settings.provider).toEqual({ connections: [] });
    expect(loaded.settings.provider.activeConnectionId).toBeUndefined();
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Read" }]);
  });

  it("a core-append against a newer-than-CURRENT (v3) file refuses with unsupported_version", async () => {
    const v3 = {
      version: 3,
      provider: { connections: [] },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    await writeFile(settingsPath(), `${JSON.stringify(v3, null, 2)}\n`, "utf8");
    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Read" });
    expect(result).toEqual({ persisted: false, reason: "unsupported_version" });
  });
});

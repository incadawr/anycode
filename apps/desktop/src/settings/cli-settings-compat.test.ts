/**
 * Bidirectional round-trip between core's CLI-side settings.json writer/reader
 * (`packages/core/src/cli/settings-rules.ts`) and desktop's strict-schema
 * writer/reader (`files.ts`/`schema.ts`) — design slice-P7.5-cut.md §3.3,
 * TASK.8. Proves the two clients are format-compatible on the SAME
 * `~/.anycode/settings.json` `permissions.alwaysAllow` section: one file, one
 * format, two writers. Every test runs against a fresh scratch dir, idiom of
 * files.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAlwaysAllowRule, loadPersistedAlwaysAllowRules } from "@anycode/core";
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

  it("a core-append preserves provider.defaults (F14, slice-P7.15-cut.md §2.4) across BOTH writers", async () => {
    // Anti-drift obligation flagged in the cut §2.4: a nested `provider` zod
    // object is NOT passthrough on desktop's schema, so a round-trip that
    // re-parses through settingsSchema must declare `defaults` explicitly (see
    // schema.test.ts) or it silently disappears. The CLI writer here
    // (settings-rules.ts appendAlwaysAllowRuleUnserialized) spreads the WHOLE
    // parsed json and only replaces the `permissions` key, so it should already
    // preserve an unrecognised `provider.defaults` byte-for-byte without any
    // core-side fix — this test proves that empirically rather than assuming it.
    const settings = cloneDefaults();
    settings.provider = {
      id: "z-ai",
      model: "glm-5.2",
      defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } },
    };
    await saveSettings(settingsPath(), settings);

    // (a) desktop read-modify-write: loadSettings re-parses through
    // settingsSchema; `provider.defaults` must survive this zod round-trip.
    const loadedBefore = await loadSettings(settingsPath());
    expect(loadedBefore.settings.provider.defaults).toEqual({
      "z-ai": { model: "glm-5.2", reasoningEffort: "high" },
    });

    // (b) CLI `/allow`-append writer: touches only permissions.alwaysAllow.
    const result = await appendAlwaysAllowRule(settingsPath(), { toolName: "Bash", pattern: "npm *" });
    expect(result).toEqual({ persisted: true });

    const loaded = await loadSettings(settingsPath());
    expect(loaded.readOnly).toBe(false);
    expect(loaded.corruptBackupPath).toBeUndefined();
    expect(loaded.settings.provider.defaults).toEqual({ "z-ai": { model: "glm-5.2", reasoningEffort: "high" } });
    expect(loaded.settings.provider.id).toBe("z-ai");
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "npm *" }]);
  });
});

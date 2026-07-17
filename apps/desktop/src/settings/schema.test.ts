/**
 * Unit tests for the settings v2 schema, the v1->v2 reset, deep-partial merge
 * and version policy (design slice-2.2-cut.md §2 + TASK.45 W9). Plus a freeze
 * guard on the value-only contract surface (shared/settings.ts) so the wave
 * cannot drift the channels / env-key list without a red test.
 */

import { describe, expect, it } from "vitest";
import {
  CONNECTION_CREATE_CHANNEL,
  CONNECTION_DELETE_CHANNEL,
  CONNECTION_SET_ACTIVE_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_ENV_KEYS,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
  activeConnection,
  activeProviderView,
  type AnycodeSettings,
} from "../shared/settings.js";
import { providerV2 } from "../shared/provider-v2-fixture.js";
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  cloneDefaults,
  mergeSettings,
  parseSettings,
  settingsSchema,
} from "./schema.js";

describe("frozen contract surface (shared/settings.ts)", () => {
  it("pins the five invoke channels", () => {
    expect(SETTINGS_GET_CHANNEL).toBe("anycode:settings-get");
    expect(SETTINGS_SET_CHANNEL).toBe("anycode:settings-set");
    expect(SECRET_SET_CHANNEL).toBe("anycode:secret-set");
    expect(SECRET_CLEAR_CHANNEL).toBe("anycode:secret-clear");
    expect(PERMISSION_RULE_ADD_CHANNEL).toBe("anycode:permission-rule-add");
  });

  it("pins the connection CRUD channels (TASK.45 W9)", () => {
    expect(CONNECTION_CREATE_CHANNEL).toBe("anycode:connection-create");
    expect(CONNECTION_UPDATE_CHANNEL).toBe("anycode:connection-update");
    expect(CONNECTION_SET_ACTIVE_CHANNEL).toBe("anycode:connection-set-active");
    expect(CONNECTION_DELETE_CHANNEL).toBe("anycode:connection-delete");
  });

  it("pins SECRET_ENV_KEYS (ruling R3)", () => {
    expect(SECRET_ENV_KEYS).toEqual(["ANYCODE_API_KEY"]);
  });
});

describe("settingsSchema (v2)", () => {
  it("accepts the defaults and round-trips through JSON", () => {
    const parsed = settingsSchema.safeParse(cloneDefaults());
    expect(parsed.success).toBe(true);

    const roundTripped = settingsSchema.safeParse(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(roundTripped.success).toBe(true);
    if (roundTripped.success) {
      expect(roundTripped.data).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("accepts a populated connections array", () => {
    const settings: AnycodeSettings = { ...cloneDefaults(), provider: providerV2({ id: "z-ai", model: "glm-5.2" }) };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(settings)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.activeConnectionId).toBe("conn-z-ai");
      expect(parsed.data.provider.connections).toEqual([{ id: "conn-z-ai", providerId: "z-ai", model: "glm-5.2" }]);
      expect(parsed.data.version).toBe(2);
    }
  });

  it("preserves unknown top-level keys (passthrough for forward-compat)", () => {
    const withFuture = { ...cloneDefaults(), futureField: { nested: 1 } };
    const parsed = settingsSchema.safeParse(withFuture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as unknown as Record<string, unknown>).futureField).toEqual({ nested: 1 });
    }
  });

  it("rejects a wrong-typed field", () => {
    const bad = { ...cloneDefaults(), ui: { theme: "neon" } };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a connection with a missing required id/providerId", () => {
    const bad = { ...cloneDefaults(), provider: { connections: [{ providerId: "z-ai" }] } };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a connection with an unrecognized transport", () => {
    const bad = {
      ...cloneDefaults(),
      provider: { connections: [{ id: "c1", providerId: "openai", transport: "openai" }] },
    };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a connection with an invalid reasoningEffort tier", () => {
    const bad = {
      ...cloneDefaults(),
      provider: { connections: [{ id: "c1", providerId: "z-ai", reasoningEffort: "extreme" }] },
    };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts an advisory lastHealth on a connection (W11 field, schema owned here)", () => {
    const settings = {
      ...cloneDefaults(),
      provider: {
        activeConnectionId: "c1",
        connections: [
          { id: "c1", providerId: "openai", lastHealth: { status: "ready", at: "2026-07-15T00:00:00.000Z" } },
        ],
      },
    };
    expect(settingsSchema.safeParse(settings).success).toBe(true);
  });

  it("accepts a connection's authOptional flag and preserves it through parse (dogfood 16.07 'no API key' declaration)", () => {
    const settings = {
      ...cloneDefaults(),
      provider: {
        activeConnectionId: "c1",
        connections: [{ id: "c1", providerId: "custom", baseUrl: "http://localhost:1234/v1", authOptional: true }],
      },
    };
    const parsed = settingsSchema.safeParse(settings);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.connections[0]?.authOptional).toBe(true);
    }
  });
});

describe("v1 reset (settingsMigrations[1])", () => {
  const v1 = (provider: Record<string, unknown>): Record<string, unknown> => ({
    version: 1,
    provider,
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  });

  it("resets a populated v1 provider block to an empty v2 provider (no v1-data carry-over)", () => {
    const result = parseSettings(
      v1({
        id: "z-ai",
        model: "glm-4.6",
        baseUrl: "https://bridge.example",
        transport: "openai-responses",
        defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.settings.version).toBe(2);
    expect(result.settings.provider).toEqual({ connections: [] });
    expect(result.settings.provider.activeConnectionId).toBeUndefined();
    expect(activeConnection(result.settings)).toBeUndefined();
    expect(activeProviderView(result.settings)).toEqual({});
  });

  it("resets a bare-legacy v1 singleton (no provider.id) the same way", () => {
    const result = parseSettings(v1({ model: "claude-x", baseUrl: "https://bridge.example" }));
    expect(result.status).toBe("ok");
    expect(result.settings.provider).toEqual({ connections: [] });
    expect(activeConnection(result.settings)).toBeUndefined();
  });

  it("resets a fresh v1 (empty provider) to an empty v2 provider", () => {
    const result = parseSettings(v1({}));
    expect(result.status).toBe("ok");
    expect(result.settings.provider).toEqual({ connections: [] });
    expect(activeConnection(result.settings)).toBeUndefined();
  });

  it("touches ONLY provider — every other top-level section survives byte-for-byte", () => {
    const result = parseSettings({
      version: 1,
      provider: { id: "z-ai", model: "glm-4.6" },
      tools: { maxTurns: 7 },
      permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] },
      ui: { theme: "dark" },
      security: { allowWeakSecretStorage: false },
      keybindings: { overrides: [{ action: "session.new", bindings: ["mod+shift+n"] }] },
      codex: { binaryPath: "/usr/local/bin/codex" },
    });
    expect(result.status).toBe("ok");
    expect(result.settings.provider).toEqual({ connections: [] });
    expect(result.settings.tools).toEqual({ maxTurns: 7 });
    expect(result.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "git *" }]);
    expect(result.settings.ui.theme).toBe("dark");
    expect(result.settings.keybindings?.overrides).toEqual([{ action: "session.new", bindings: ["mod+shift+n"] }]);
    expect(result.settings.codex?.binaryPath).toBe("/usr/local/bin/codex");
  });

  it("preserves unknown top-level keys across the reset (passthrough forward-compat)", () => {
    const result = parseSettings({ ...v1({ id: "z-ai" }), futureField: { nested: 1 } });
    expect(result.status).toBe("ok");
    expect((result.settings as unknown as Record<string, unknown>).futureField).toEqual({ nested: 1 });
  });
});

describe("keybindings.overrides (F20, slice-P7.24-cut.md §1, additive-optional)", () => {
  it("reads a file with no keybindings field, round-tripping byte-identically (v2)", () => {
    const legacy = cloneDefaults();
    const before = JSON.stringify(legacy);
    const result = parseSettings(JSON.parse(before));
    expect(result.status).toBe("ok");
    expect(result.settings.keybindings).toBeUndefined();
    expect(JSON.stringify(result.settings)).toBe(before); // byte-identical round-trip
  });

  it("validates a file WITH keybindings.overrides", () => {
    const withOverrides: AnycodeSettings = {
      ...cloneDefaults(),
      keybindings: {
        overrides: [
          { action: "palette.toggle", bindings: ["mod+shift+p"] },
          { action: "terminal.toggle", bindings: [] },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withOverrides)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.keybindings?.overrides).toEqual([
        { action: "palette.toggle", bindings: ["mod+shift+p"] },
        { action: "terminal.toggle", bindings: [] },
      ]);
    }
  });

  it("rejects a corrupt override entry (non-string binding)", () => {
    const bad = {
      ...cloneDefaults(),
      keybindings: { overrides: [{ action: "palette.toggle", bindings: [42] }] },
    };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects keybindings missing the overrides array", () => {
    const bad = { ...cloneDefaults(), keybindings: {} };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("survives a read-modify-write cycle (nested overrides not stripped on reparse)", () => {
    const written = mergeSettings(cloneDefaults(), {
      keybindings: { overrides: [{ action: "session.new", bindings: ["mod+shift+n"] }] },
    });
    const reloaded = parseSettings(JSON.parse(JSON.stringify(written)));
    expect(reloaded.status).toBe("ok");
    expect(reloaded.settings.keybindings?.overrides).toEqual([{ action: "session.new", bindings: ["mod+shift+n"] }]);
  });
});

describe("codex (TASK.41, cut §3.5, additive-optional)", () => {
  it("reads a file with no codex field, round-tripping byte-identically (v2)", () => {
    const legacy = cloneDefaults();
    const before = JSON.stringify(legacy);
    const result = parseSettings(JSON.parse(before));
    expect(result.status).toBe("ok");
    expect(result.settings.codex).toBeUndefined();
    expect(JSON.stringify(result.settings)).toBe(before); // byte-identical round-trip
  });

  it("validates a file WITH codex.binaryPath + codex.lastCheck", () => {
    const withCodex: AnycodeSettings = {
      ...cloneDefaults(),
      codex: {
        binaryPath: "/opt/homebrew/bin/codex",
        lastCheck: { status: "ready", version: "0.144.1", at: "2026-07-13T00:00:00.000Z" },
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withCodex)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.codex).toEqual({
        binaryPath: "/opt/homebrew/bin/codex",
        lastCheck: { status: "ready", version: "0.144.1", at: "2026-07-13T00:00:00.000Z" },
      });
    }
  });

  it("drops a corrupt lastCheck.status instead of failing the whole document (MED-2 fix)", () => {
    const bad = {
      ...cloneDefaults(),
      codex: { lastCheck: { status: "bogus", at: "2026-07-13T00:00:00.000Z" } },
    };
    const parsed = settingsSchema.safeParse(bad);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.codex).toBeUndefined();
    }
  });

  it("tolerates a foreign/wrong-typed codex value — every sibling field survives (MED-2, v1 reset)", () => {
    const legacy = {
      version: 1,
      provider: { model: "claude-x" },
      tools: {},
      permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
      codex: "legacy-value",
    };
    const result = parseSettings(legacy);
    expect(result.status).toBe("ok");
    expect(result.settings.codex).toBeUndefined();
    // provider is reset (no v1 carry-over); the OTHER sections still survive.
    expect(result.settings.provider).toEqual({ connections: [] });
    expect(result.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "git *" }]);
  });
});

describe("cloneDefaults", () => {
  it("returns an independent deep copy (no shared mutable arrays)", () => {
    const a = cloneDefaults();
    a.permissions.alwaysAllow.push({ toolName: "Bash" });
    expect(DEFAULT_SETTINGS.permissions.alwaysAllow).toEqual([]);
    expect(cloneDefaults().permissions.alwaysAllow).toEqual([]);
    a.provider.connections.push({ id: "x", providerId: "z-ai" });
    expect(DEFAULT_SETTINGS.provider.connections).toEqual([]);
  });
});

describe("mergeSettings (deep-partial merge)", () => {
  it("merges nested objects key-by-key without dropping siblings", () => {
    const merged = mergeSettings(cloneDefaults(), { ui: { theme: "dark" } });
    expect(merged.ui.theme).toBe("dark");
    expect(merged.provider.connections).toEqual([]); // untouched sibling survives
  });

  it("replaces arrays wholesale (rule editor semantics)", () => {
    const base = mergeSettings(cloneDefaults(), {
      permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] },
    });
    const replaced = mergeSettings(base, {
      permissions: { alwaysAllow: [{ toolName: "Read" }] },
    });
    expect(replaced.permissions.alwaysAllow).toEqual([{ toolName: "Read" }]);
  });

  it("does not mutate the base object", () => {
    const base = cloneDefaults();
    const frozen = JSON.stringify(base);
    mergeSettings(base, { ui: { theme: "dark" } });
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it("preserves version when the patch omits it", () => {
    const merged = mergeSettings(cloneDefaults(), { ui: { theme: "light" } });
    expect(merged.version).toBe(2);
  });
});

describe("parseSettings (version policy)", () => {
  it("parses a valid current-version object as ok", () => {
    const result = parseSettings(cloneDefaults());
    expect(result.status).toBe("ok");
    expect(result.readOnly).toBe(false);
  });

  it("loads a real v1 file to ok (reset, not corrupt)", () => {
    const v1 = { version: 1, provider: { id: "deepseek", model: "deepseek-chat" }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
    const result = parseSettings(v1);
    expect(result.status).toBe("ok");
    expect(result.settings.version).toBe(2);
    expect(result.settings.provider).toEqual({ connections: [] });
  });

  it("flags a newer-than-CURRENT file as read_only, salvaging valid fields (old binary sees v2/v3 as read_only)", () => {
    const future: Record<string, unknown> = {
      ...cloneDefaults(),
      version: CURRENT_SETTINGS_VERSION + 1,
      ui: { theme: "dark" },
    };
    const result = parseSettings(future);
    expect(result.status).toBe("read_only");
    expect(result.readOnly).toBe(true);
    expect(result.settings.ui.theme).toBe("dark");
  });

  it("falls back to defaults (readOnly) for a newer file that no longer validates", () => {
    const result = parseSettings({ version: 99, ui: { theme: "neon" } });
    expect(result.status).toBe("read_only");
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("treats a non-object as corrupt -> defaults", () => {
    expect(parseSettings("nope").status).toBe("corrupt");
    expect(parseSettings(null).status).toBe("corrupt");
    expect(parseSettings([1, 2]).status).toBe("corrupt");
    expect(parseSettings(42).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("treats a schema-invalid current-version object as corrupt -> defaults", () => {
    const result = parseSettings({ version: 2, provider: { connections: [] }, ui: { theme: 123 } });
    expect(result.status).toBe("corrupt");
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("has every section present, an empty connections array and a false consent flag", () => {
    const defaults: AnycodeSettings = DEFAULT_SETTINGS;
    expect(defaults.version).toBe(2);
    expect(defaults.provider.connections).toEqual([]);
    expect(defaults.provider.activeConnectionId).toBeUndefined();
    expect(defaults.security.allowWeakSecretStorage).toBe(false);
    expect(defaults.permissions.alwaysAllow).toEqual([]);
  });
});

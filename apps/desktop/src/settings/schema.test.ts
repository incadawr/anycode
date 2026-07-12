/**
 * Unit tests for the settings schema, migration skeleton, deep-partial merge and
 * version policy (design slice-2.2-cut.md §2, frozen by 2.2.1). Plus a freeze
 * guard on the value-only contract surface (shared/settings.ts) so the wave
 * cannot drift the channels / env-key list without a red test.
 */

import { describe, expect, it } from "vitest";
import {
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_ENV_KEYS,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
  type AnycodeSettings,
} from "../shared/settings.js";
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

  it("pins SECRET_ENV_KEYS (ruling R3)", () => {
    expect(SECRET_ENV_KEYS).toEqual(["ANYCODE_API_KEY"]);
  });
});

describe("settingsSchema", () => {
  it("accepts the defaults and round-trips through JSON", () => {
    const parsed = settingsSchema.safeParse(cloneDefaults());
    expect(parsed.success).toBe(true);

    const roundTripped = settingsSchema.safeParse(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(roundTripped.success).toBe(true);
    if (roundTripped.success) {
      expect(roundTripped.data).toEqual(DEFAULT_SETTINGS);
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
});

describe("provider.id (slice 2.5, additive-optional)", () => {
  it("round-trips a provider.id without bumping the version", () => {
    const withId: AnycodeSettings = {
      ...cloneDefaults(),
      provider: { id: "z-ai", model: "glm-4.6" },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withId)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.id).toBe("z-ai");
      expect(parsed.data.provider.model).toBe("glm-4.6");
      expect(parsed.data.version).toBe(1); // NOT bumped
    }
  });

  it("reads an old file with no provider.id (legacy, byte-for-byte 2.2)", () => {
    // A settings.json written before slice 2.5 has no provider.id at all.
    const legacy = { ...cloneDefaults(), provider: { model: "claude-x" } };
    const result = parseSettings(legacy);
    expect(result.status).toBe("ok");
    expect(result.settings.provider.id).toBeUndefined();
    expect(result.settings.provider.model).toBe("claude-x");
  });

  it("rejects a non-string provider.id", () => {
    const bad = { ...cloneDefaults(), provider: { id: 42 } };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("mergeSettings can set provider.id without dropping model/baseUrl siblings", () => {
    const base = mergeSettings(cloneDefaults(), { provider: { model: "m", baseUrl: "b" } });
    const merged = mergeSettings(base, { provider: { id: "deepseek" } });
    expect(merged.provider).toEqual({ id: "deepseek", model: "m", baseUrl: "b" });
  });
});

describe("provider.defaults (F14, slice-P7.15-cut.md §2.4, additive-optional)", () => {
  it("round-trips a per-provider default through JSON without bumping the version", () => {
    const withDefaults: AnycodeSettings = {
      ...cloneDefaults(),
      provider: {
        id: "z-ai",
        model: "glm-5.2",
        defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } },
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withDefaults)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.defaults).toEqual({ "z-ai": { model: "glm-5.2", reasoningEffort: "high" } });
      expect(parsed.data.version).toBe(1); // NOT bumped
    }
  });

  it("reads an old file with no provider.defaults at all (legacy, byte-for-byte)", () => {
    const legacy = { ...cloneDefaults(), provider: { id: "z-ai", model: "glm-4.6" } };
    const result = parseSettings(legacy);
    expect(result.status).toBe("ok");
    expect(result.settings.provider.defaults).toBeUndefined();
  });

  it("supports multiple provider keys, including the custom/legacy 'custom' key", () => {
    const withMany: AnycodeSettings = {
      ...cloneDefaults(),
      provider: {
        defaults: {
          custom: { reasoningEffort: "off" },
          "z-ai": { model: "glm-4.6", reasoningEffort: "max" },
        },
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withMany)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.defaults).toEqual({
        custom: { reasoningEffort: "off" },
        "z-ai": { model: "glm-4.6", reasoningEffort: "max" },
      });
    }
  });

  it("rejects an invalid reasoningEffort tier inside a default entry", () => {
    const bad = { ...cloneDefaults(), provider: { defaults: { "z-ai": { reasoningEffort: "extreme" } } } };
    expect(settingsSchema.safeParse(bad).success).toBe(false);
  });

  it("mergeSettings can set provider.defaults without dropping id/model siblings", () => {
    const base = mergeSettings(cloneDefaults(), { provider: { id: "z-ai", model: "glm-5.2" } });
    const merged = mergeSettings(base, { provider: { defaults: { "z-ai": { reasoningEffort: "high" } } } });
    expect(merged.provider).toEqual({
      id: "z-ai",
      model: "glm-5.2",
      defaults: { "z-ai": { reasoningEffort: "high" } },
    });
  });

  it("survives a read-modify-write cycle (the exact desktop compat bug the cut calls out)", () => {
    // Simulates: settings-set writes {provider:{defaults}}, then a LATER
    // settings-get reloads through parseSettings/settingsSchema -- the nested
    // `defaults` key must be explicitly declared in the provider zod object
    // (not relying on the top-level .passthrough(), which only covers unknown
    // TOP-LEVEL keys) or it is silently stripped on this second parse.
    const written = mergeSettings(cloneDefaults(), {
      provider: { id: "z-ai", defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } } },
    });
    const reloaded = parseSettings(JSON.parse(JSON.stringify(written)));
    expect(reloaded.status).toBe("ok");
    expect(reloaded.settings.provider.defaults).toEqual({ "z-ai": { model: "glm-5.2", reasoningEffort: "high" } });
  });
});

describe("keybindings.overrides (F20, slice-P7.24-cut.md §1, additive-optional)", () => {
  it("reads an old file with no keybindings field, round-tripping byte-identically", () => {
    // A settings.json written before P7.24 has no keybindings key at all.
    const legacy = cloneDefaults();
    const before = JSON.stringify(legacy);
    const result = parseSettings(JSON.parse(before));
    expect(result.status).toBe("ok");
    expect(result.settings.keybindings).toBeUndefined();
    expect(JSON.stringify(result.settings)).toBe(before); // byte-identical round-trip
  });

  it("validates a file WITH keybindings.overrides without bumping the version", () => {
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
      expect(parsed.data.version).toBe(1); // NOT bumped
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
    expect(reloaded.settings.keybindings?.overrides).toEqual([
      { action: "session.new", bindings: ["mod+shift+n"] },
    ]);
  });

  it("mergeSettings replaces the overrides array wholesale (editor semantics)", () => {
    const base = mergeSettings(cloneDefaults(), {
      keybindings: { overrides: [{ action: "palette.toggle", bindings: ["mod+shift+p"] }] },
    });
    const replaced = mergeSettings(base, {
      keybindings: { overrides: [{ action: "session.new", bindings: ["mod+shift+n"] }] },
    });
    expect(replaced.keybindings?.overrides).toEqual([{ action: "session.new", bindings: ["mod+shift+n"] }]);
  });
});

describe("cloneDefaults", () => {
  it("returns an independent deep copy (no shared mutable arrays)", () => {
    const a = cloneDefaults();
    a.permissions.alwaysAllow.push({ toolName: "Bash" });
    expect(DEFAULT_SETTINGS.permissions.alwaysAllow).toEqual([]);
    expect(cloneDefaults().permissions.alwaysAllow).toEqual([]);
  });
});

describe("mergeSettings (deep-partial merge)", () => {
  it("merges nested objects key-by-key without dropping siblings", () => {
    const merged = mergeSettings(cloneDefaults(), { provider: { model: "claude-x" } });
    expect(merged.provider.model).toBe("claude-x");
    expect(merged.provider.baseUrl).toBeUndefined();
    expect(merged.ui.theme).toBe("system"); // untouched sibling survives
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

  it("ignores undefined patch values (never deletes a base key)", () => {
    const base = mergeSettings(cloneDefaults(), { provider: { model: "keep-me" } });
    const merged = mergeSettings(base, { provider: { baseUrl: undefined } });
    expect(merged.provider.model).toBe("keep-me");
  });

  it("does not mutate the base object", () => {
    const base = cloneDefaults();
    const frozen = JSON.stringify(base);
    mergeSettings(base, { ui: { theme: "dark" } });
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it("preserves version when the patch omits it", () => {
    const merged = mergeSettings(cloneDefaults(), { ui: { theme: "light" } });
    expect(merged.version).toBe(1);
  });
});

describe("parseSettings (version policy)", () => {
  it("parses a valid current-version object as ok", () => {
    const result = parseSettings(cloneDefaults());
    expect(result.status).toBe("ok");
    expect(result.readOnly).toBe(false);
  });

  it("flags a newer-than-CURRENT file as read_only, salvaging valid fields", () => {
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
    const result = parseSettings({ version: 1, ui: { theme: 123 } });
    expect(result.status).toBe("corrupt");
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("has every section present and a false consent flag", () => {
    const defaults: AnycodeSettings = DEFAULT_SETTINGS;
    expect(defaults.version).toBe(1);
    expect(defaults.security.allowWeakSecretStorage).toBe(false);
    expect(defaults.permissions.alwaysAllow).toEqual([]);
  });
});

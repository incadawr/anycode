/**
 * Unit tests for the settings v2 schema, the v1->v2 reset, deep-partial merge
 * and version policy (design slice-2.2-cut.md §2 + TASK.45 W9). Plus a freeze
 * guard on the value-only contract surface (shared/settings.ts) so the wave
 * cannot drift the channels / env-key list without a red test.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  isHttpsOrLocalhostUrl,
  isLoopbackUrl,
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

describe("codex.profiles (codex-profiles cut §2.3, amended §A1.1) — round-trip + zod-granularity", () => {
  it("reads a file with no profiles/activeProfileId/riskAcceptedVersions, round-tripping byte-identically", () => {
    const withCodex: AnycodeSettings = {
      ...cloneDefaults(),
      codex: { binaryPath: "/opt/homebrew/bin/codex", lastCheck: { status: "ready", at: "2026-07-13T00:00:00.000Z" } },
    };
    const before = JSON.stringify(withCodex);
    const result = parseSettings(JSON.parse(before));
    expect(result.status).toBe("ok");
    expect(result.settings.codex?.profiles).toBeUndefined();
    expect(result.settings.codex?.activeProfileId).toBeUndefined();
    expect(result.settings.codex?.riskAcceptedVersions).toBeUndefined();
    expect(JSON.stringify(result.settings)).toBe(before); // byte-identical round-trip
  });

  it("validates a file with valid profiles (linkedHome XOR authLink) + activeProfileId + riskAcceptedVersions", () => {
    const withProfiles: AnycodeSettings = {
      ...cloneDefaults(),
      codex: {
        binaryPath: "/opt/homebrew/bin/codex",
        activeProfileId: "personal",
        riskAcceptedVersions: ["0.145.0"],
        profiles: [
          { id: "personal", label: "Personal", createdAt: "2026-07-14T00:00:00.000Z", authLink: "~/.codex/auth.json" },
          { id: "work-cx", label: "Work (cx)", createdAt: "2026-07-14T00:00:00.000Z", linkedHome: "/Users/x/.codex-accounts/work" },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withProfiles)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.codex?.profiles).toHaveLength(2);
      expect(parsed.data.codex?.profiles?.[0]).toMatchObject({ id: "personal", authLink: "~/.codex/auth.json" });
      expect(parsed.data.codex?.profiles?.[1]).toMatchObject({ id: "work-cx", linkedHome: "/Users/x/.codex-accounts/work" });
      expect(parsed.data.codex?.activeProfileId).toBe("personal");
      expect(parsed.data.codex?.riskAcceptedVersions).toEqual(["0.145.0"]);
    }
  });

  it("zod-granularity: a profile with BOTH authLink and linkedHome (amended §A1.1 rule 3) is dropped alone — binaryPath and the valid sibling profile survive", () => {
    const withBadProfile = {
      ...cloneDefaults(),
      codex: {
        binaryPath: "/opt/homebrew/bin/codex",
        profiles: [
          { id: "broken", label: "Broken", createdAt: "2026-07-14T00:00:00.000Z", authLink: "~/.codex/auth.json", linkedHome: "/tmp/x" },
          { id: "healthy", label: "Healthy", createdAt: "2026-07-14T00:00:00.000Z", authLink: "~/.codex/auth.json" },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(withBadProfile);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // the malformed element is gone, the healthy sibling and binaryPath survive
      expect(parsed.data.codex?.profiles).toHaveLength(1);
      expect(parsed.data.codex?.profiles?.[0]?.id).toBe("healthy");
      expect(parsed.data.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    }
  });

  it("zod-granularity: a profile id containing '../' (path-injection attempt) is dropped alone — siblings and binaryPath survive", () => {
    const withPathInjection = {
      ...cloneDefaults(),
      codex: {
        binaryPath: "/opt/homebrew/bin/codex",
        profiles: [
          { id: "../../etc", label: "Evil", createdAt: "2026-07-14T00:00:00.000Z" },
          { id: "safe-id", label: "Safe", createdAt: "2026-07-14T00:00:00.000Z" },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(withPathInjection);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.codex?.profiles).toHaveLength(1);
      expect(parsed.data.codex?.profiles?.[0]?.id).toBe("safe-id");
      expect(parsed.data.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    }
  });

  it("zod-granularity: a RELATIVE linkedHome ('../other-home') is dropped alone — siblings and binaryPath survive (C0 review F1)", () => {
    // linkedHome feeds the child's CODEX_HOME env; a relative path would
    // resolve against process cwd, so only `~/`-relative or absolute shapes
    // pass (same isTildeOrAbsolutePath guard as authLink, amended §A1.1.4).
    const withRelativeHome = {
      ...cloneDefaults(),
      codex: {
        binaryPath: "/opt/homebrew/bin/codex",
        profiles: [
          { id: "escapee", label: "Evil", createdAt: "2026-07-14T00:00:00.000Z", linkedHome: "../other-home" },
          { id: "tilde-ok", label: "Tilde", createdAt: "2026-07-14T00:00:00.000Z", linkedHome: "~/homes/x" },
          { id: "abs-ok", label: "Abs", createdAt: "2026-07-14T00:00:00.000Z", linkedHome: "/abs/x" },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(withRelativeHome);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.codex?.profiles?.map((p) => p.id)).toEqual(["tilde-ok", "abs-ok"]);
      expect(parsed.data.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    }
  });

  it("RED-PROOF: a naive z.array(profileSchema) with NO per-element tolerance fails the WHOLE array on one bad element — our schema does not", () => {
    // The exact shape codexProfileSchema validates, reconstructed here (it is
    // module-private in schema.ts) WITHOUT the tolerant preprocess wrapper —
    // this is the "before the §2.3 fix" behavior the whole-block
    // `.catch(undefined)` bug class produces one level up.
    const naiveProfileShape = z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
        label: z.string(),
        createdAt: z.string(),
        linkedHome: z.string().optional(),
        authLink: z.string().optional(),
      })
      .refine((profile) => !(profile.linkedHome !== undefined && profile.authLink !== undefined));

    const rawArray = [
      { id: "broken", label: "Broken", createdAt: "2026-07-14T00:00:00.000Z", authLink: "~/.codex/auth.json", linkedHome: "/tmp/x" },
      { id: "healthy", label: "Healthy", createdAt: "2026-07-14T00:00:00.000Z", authLink: "~/.codex/auth.json" },
    ];

    // RED under the naive (non-tolerant) shape: one bad element sinks the WHOLE array.
    const naiveResult = z.array(naiveProfileShape).safeParse(rawArray);
    expect(naiveResult.success).toBe(false);

    // GREEN under our actual (tolerant) settingsSchema: the bad element alone
    // is dropped, the healthy sibling AND binaryPath survive.
    const tolerantResult = settingsSchema.safeParse({
      ...cloneDefaults(),
      codex: { binaryPath: "/opt/homebrew/bin/codex", profiles: rawArray },
    });
    expect(tolerantResult.success).toBe(true);
    if (tolerantResult.success) {
      expect(tolerantResult.data.codex?.profiles).toHaveLength(1);
      expect(tolerantResult.data.codex?.profiles?.[0]?.id).toBe("healthy");
      expect(tolerantResult.data.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    }
  });
});

describe("isHttpsOrLocalhostUrl (cut §9.2, amendment-1 FX2-1 — single source of truth, re-exported by main/provider-ipc.ts)", () => {
  it("accepts https with no userinfo, for any host", () => {
    expect(isHttpsOrLocalhostUrl("https://api.example.com")).toBe(true);
  });

  it("accepts http ONLY for loopback hosts, including [::1]", () => {
    expect(isHttpsOrLocalhostUrl("http://localhost:8080")).toBe(true);
    expect(isHttpsOrLocalhostUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isHttpsOrLocalhostUrl("http://[::1]:8080")).toBe(true);
  });

  it("rejects http for a non-loopback host", () => {
    expect(isHttpsOrLocalhostUrl("http://evil.example.com")).toBe(false);
  });

  // RED-PROOF (F-C): userinfo rejected on every scheme.
  it("RED-PROOF: rejects a URL carrying embedded userinfo, on any allowed scheme", () => {
    expect(isHttpsOrLocalhostUrl("https://user:sekrit-pw@api.example.com")).toBe(false);
    expect(isHttpsOrLocalhostUrl("http://user:pw@localhost:8080")).toBe(false);
  });
});

describe("isLoopbackUrl (FX3-L1 G-A — loopback waiver for the origin-rebind custody guard)", () => {
  it("accepts every loopback host literal, on both schemes (same host set as isHttpsOrLocalhostUrl)", () => {
    expect(isLoopbackUrl("http://localhost:8080")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackUrl("https://localhost:9999")).toBe(true);
  });

  it("rejects a non-loopback host on any scheme", () => {
    expect(isLoopbackUrl("https://api.example.com")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.5:8080")).toBe(false);
    // A DNS name that RESOLVES to loopback is still not a loopback LITERAL —
    // the waiver must never be spoofable via an attacker-controlled record.
    expect(isLoopbackUrl("http://localhost.attacker.example")).toBe(false);
  });

  it("rejects a malformed URL (fail-closed, never throws)", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("provider.custom (cut §9.2) — round-trip + zod-granularity", () => {
  it("reads a file with no provider.custom, round-tripping byte-identically", () => {
    const base = cloneDefaults();
    const before = JSON.stringify(base);
    const result = parseSettings(JSON.parse(before));
    expect(result.status).toBe("ok");
    expect(result.settings.provider.custom).toBeUndefined();
    expect(JSON.stringify(result.settings)).toBe(before);
  });

  it("validates a file with a valid custom provider entry", () => {
    const withCustom: AnycodeSettings = {
      ...cloneDefaults(),
      provider: { connections: [], custom: [{ id: "custom:my-glm", name: "My GLM", baseUrl: "https://api.example.com", kind: "openai-compatible", models: ["glm-4"] }] },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withCustom)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]).toMatchObject({ id: "custom:my-glm", baseUrl: "https://api.example.com" });
    }
  });

  it("allows http:// for localhost/127.0.0.1 but rejects it (and drops the entry) for any other host", () => {
    const mixed = {
      ...cloneDefaults(),
      provider: {
        connections: [],
        custom: [
          { id: "custom:local", name: "Local", baseUrl: "http://localhost:8080", kind: "openai-compatible", models: [] },
          { id: "custom:evil", name: "Evil", baseUrl: "http://evil.example.com", kind: "openai-compatible", models: [] },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]?.id).toBe("custom:local");
    }
  });

  it("zod-granularity: a malformed custom-provider entry is dropped alone — the valid sibling and provider.connections survive", () => {
    const mixed = {
      ...cloneDefaults(),
      provider: {
        connections: [{ id: "conn-1", providerId: "anthropic" }],
        custom: [
          { id: "custom:bad", name: "Bad", baseUrl: "not-a-url", kind: "openai-compatible", models: [] },
          { id: "custom:good", name: "Good", baseUrl: "https://good.example.com", kind: "openai-compatible", models: [] },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]?.id).toBe("custom:good");
      expect(parsed.data.provider.connections).toEqual([{ id: "conn-1", providerId: "anthropic" }]);
    }
  });

  // F-C (amendment-1 FX2-1, custody): a userinfo-carrying baseUrl must never
  // reach settings.json — fail-closed at load, same per-element tolerance as
  // any other malformed custom-provider entry.
  it("zod-granularity: a custom-provider baseUrl carrying embedded userinfo is dropped alone (F-C custody) — the valid sibling survives", () => {
    const mixed = {
      ...cloneDefaults(),
      provider: {
        connections: [],
        custom: [
          { id: "custom:leaky", name: "Leaky", baseUrl: "https://user:sekrit-pw@api.example.com", kind: "openai-compatible", models: [] },
          { id: "custom:good", name: "Good", baseUrl: "https://good.example.com", kind: "openai-compatible", models: [] },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]?.id).toBe("custom:good");
    }
  });

  // F-D (amendment-1 FX2-1): [::1] is accepted at the schema layer, matching
  // provider-ipc.ts's fetch-models policy — previously only the latter
  // allowed it, so a saved [::1] endpoint would fail `settingsSchema.safeParse`
  // on create even though the fetch-models preview for the same URL succeeded.
  it("allows http://[::1] for a custom provider baseUrl (F-D unification)", () => {
    const withIpv6: AnycodeSettings = {
      ...cloneDefaults(),
      provider: {
        connections: [],
        custom: [{ id: "custom:v6", name: "V6", baseUrl: "http://[::1]:8080", kind: "openai-compatible", models: [] }],
      },
    };
    const parsed = settingsSchema.safeParse(JSON.parse(JSON.stringify(withIpv6)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]?.baseUrl).toBe("http://[::1]:8080");
    }
  });

  // W4-R1-M1 (namespace custody): a custom-provider `id` MUST live in the
  // `custom:` vault namespace. A hand-edited (or corrupt/migrated) record whose
  // id names a DIFFERENT namespace — a `connection.<victim>` connection key, or
  // a bare catalog id like `anthropic` — would otherwise let a
  // `custom-provider-fetch-models {id}` decrypt that other namespace's vault key
  // and POST it to the record's attacker-chosen baseUrl (cross-namespace
  // credential exfil). The refine drops the mis-namespaced record whole (same
  // per-element tolerance as a malformed URL), so it never reaches the catalog
  // and fetch-models can never resolve it. The valid `custom:*` sibling and
  // provider.connections survive untouched.
  it("W4-R1-M1: a custom-provider id outside the custom: namespace is dropped alone — the custom:* sibling and connections survive", () => {
    const mixed = {
      ...cloneDefaults(),
      provider: {
        connections: [{ id: "victim", providerId: "anthropic" }],
        custom: [
          { id: "connection.victim", name: "Exfil", baseUrl: "https://attacker.example", kind: "openai", models: [] },
          { id: "anthropic", name: "Catalog collision", baseUrl: "https://attacker.example", kind: "openai", models: [] },
          { id: "custom:legit", name: "Legit", baseUrl: "https://good.example.com", kind: "openai-compatible", models: [] },
        ],
      },
    };
    const parsed = settingsSchema.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.custom).toHaveLength(1);
      expect(parsed.data.provider.custom?.[0]?.id).toBe("custom:legit");
      expect(parsed.data.provider.connections).toEqual([{ id: "victim", providerId: "anthropic" }]);
    }
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

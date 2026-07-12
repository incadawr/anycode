/**
 * Unit tests for the settings/secret IPC handler logic (design §3, ruling §4),
 * exercised as the exported handle* functions off a FAKE vault + scratch
 * settings path (no Electron ipcMain, no OS keychain). Covers: the custody
 * invariant (no secret value in ANY response), the weak-consent refusal
 * pass-through, read-only refusals, rule-add dedup, and the onMutation fire
 * discipline (fires on success, not on refusal).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../settings/files.js";
import type { SecretKey, SecretStatus, SettingsSnapshot } from "../shared/settings.js";
import { isKnownSecretKey } from "./host-env.js";
import type { OAuthOutcome, OAuthProviderConfig } from "./oauth.js";
import {
  buildSettingsSnapshot,
  handleAddRule,
  handleClearSecret,
  handleGet,
  handleOAuthCancel,
  handleOAuthStart,
  handleSet,
  handleSetSecret,
  projectCatalogSummary,
  type OAuthRunnerLike,
  type SettingsIpcDeps,
  type VaultLike,
} from "./settings-ipc.js";
import type { SecretSetResult } from "./vault.js";

const SECRET_VALUE = "sk-super-secret-do-not-leak";

/** In-memory vault fake honouring the VaultLike surface; never touches disk crypto. */
class FakeVault implements VaultLike {
  store = new Map<string, string>();
  /** Force setSecret to refuse (simulates the weak-consent gate). */
  setResult: SecretSetResult = { ok: true };
  tier: SecretStatus["tier"] = "os_encrypted";

  async setSecret(key: SecretKey, value: string): Promise<SecretSetResult> {
    if (!this.setResult.ok) {
      return this.setResult;
    }
    this.store.set(key, value);
    return { ok: true };
  }
  async clearSecret(key: SecretKey): Promise<void> {
    this.store.delete(key);
  }
  async getSecretValue(key: SecretKey): Promise<string | undefined> {
    return this.store.get(key);
  }
  async statuses(bootEnv: NodeJS.ProcessEnv, catalogIds: readonly string[] = []): Promise<SecretStatus[]> {
    const envOverride = bootEnv.ANYCODE_API_KEY !== undefined && bootEnv.ANYCODE_API_KEY.trim() !== "";
    const keys: SecretKey[] = ["provider.apiKey"];
    for (const key of this.store.keys()) {
      if (key !== "provider.apiKey" && isKnownSecretKey(key, catalogIds)) {
        keys.push(key);
      }
    }
    return keys.map((key) => {
      const set = this.store.has(key);
      return {
        key,
        set,
        source: envOverride ? "env" : set ? "vault" : "none",
        tier: this.tier,
      } satisfies SecretStatus;
    });
  }
}

/** Fake OAuth runner: a successful start writes a token blob into the vault. */
class FakeOAuthRunner implements OAuthRunnerLike {
  outcome: OAuthOutcome = { ok: true };
  cancelled: string[] = [];
  constructor(private readonly vault: FakeVault) {}
  async startFlow(config: OAuthProviderConfig): Promise<OAuthOutcome> {
    if (this.outcome.ok) {
      this.vault.store.set(`provider.${config.providerId}.oauth`, "OAUTH-TOKEN-BLOB-SECRET");
    }
    return this.outcome;
  }
  cancel(providerId: string): void {
    this.cancelled.push(providerId);
  }
}

const OAUTH_CONFIG: OAuthProviderConfig = {
  providerId: "acme",
  authorizationUrl: "https://idp/authorize",
  tokenUrl: "https://idp/token",
  clientId: "c",
  scopes: ["s"],
};

let dir: string;
let settingsPath: string;
let vault: FakeVault;

function makeDeps(over: Partial<SettingsIpcDeps> = {}): SettingsIpcDeps {
  return { vault, bootEnv: {}, settingsPath, ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-ipc-"));
  settingsPath = join(dir, "settings.json");
  vault = new FakeVault();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Recursively scan any value for the secret string (custody assertion). */
function containsSecret(value: unknown): boolean {
  return JSON.stringify(value)?.includes(SECRET_VALUE) ?? false;
}

describe("handleGet — snapshot projection", () => {
  it("returns a full snapshot with SecretStatus (never a value)", async () => {
    const snap = await handleGet(makeDeps());
    expect(snap.settings.version).toBe(1);
    expect(snap.secrets).toEqual([
      { key: "provider.apiKey", set: false, source: "none", tier: "os_encrypted" },
    ]);
    expect(snap.providerReady).toBe(false);
    expect(snap.envOverrides).toEqual([]);
    expect(snap.readOnly).toBe(false);
  });

  it("reflects an env override in envOverrides + status source", async () => {
    const snap = await buildSettingsSnapshot(makeDeps({ bootEnv: { ANYCODE_API_KEY: "k", ANYCODE_MODEL: "m" } }));
    expect(snap.envOverrides).toEqual(["ANYCODE_API_KEY", "ANYCODE_MODEL"]);
    expect(snap.secrets[0]?.source).toBe("env");
    expect(snap.providerReady).toBe(true);
  });
});

describe("handleSetSecret — custody + consent (I1 / R1)", () => {
  it("stores the value and returns a snapshot WITHOUT the value anywhere", async () => {
    const onMutation = vi.fn();
    const res = await handleSetSecret(makeDeps({ onMutation }), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.secrets[0]).toMatchObject({ set: true, source: "vault" });
      expect(containsSecret(res)).toBe(false);
    }
    // The value did reach the vault.
    expect(vault.store.get("provider.apiKey")).toBe(SECRET_VALUE);
    // onMutation fired with the fresh snapshot.
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("passes the weak-consent refusal through and does NOT fire onMutation", async () => {
    vault.setResult = { ok: false, reason: "weak_storage_needs_consent" };
    const onMutation = vi.fn();
    const res = await handleSetSecret(makeDeps({ onMutation }), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("reads the consent flag from persisted settings", async () => {
    // Persist consent, then a spy vault records the allowWeak it was handed.
    const spy = vi.spyOn(vault, "setSecret");
    await handleSet(makeDeps(), { security: { allowWeakSecretStorage: true } });
    await handleSetSecret(makeDeps(), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(spy).toHaveBeenLastCalledWith("provider.apiKey", SECRET_VALUE, { allowWeak: true });
  });

  it("rejects a malformed payload as invalid", async () => {
    const res = await handleSetSecret(makeDeps(), { key: "other.key", value: "x" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("handleClearSecret", () => {
  it("clears the vault entry and returns a fresh snapshot", async () => {
    vault.store.set("provider.apiKey", SECRET_VALUE);
    const res = await handleClearSecret(makeDeps(), { key: "provider.apiKey" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.secrets[0]?.set).toBe(false);
    }
    expect(vault.store.has("provider.apiKey")).toBe(false);
  });
});

describe("handleSet — merge + read-only", () => {
  it("deep-partial merges and persists", async () => {
    const res = await handleSet(makeDeps(), { provider: { model: "claude-x" }, ui: { theme: "dark" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.model).toBe("claude-x");
    expect(loaded.settings.ui.theme).toBe("dark");
  });

  it("ignores a version change in the patch", async () => {
    await handleSet(makeDeps(), { version: 99, provider: { model: "m" } });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.version).toBe(1);
  });

  it("refuses read_only when settings.json is a newer version", async () => {
    // A version>CURRENT file loads as readOnly.
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 2, provider: {}, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }),
    );
    const res = await handleSet(makeDeps(), { provider: { model: "m" } });
    expect(res).toEqual({ ok: false, reason: "read_only" });
  });

  it("rejects a non-object patch as invalid", async () => {
    const res = await handleSet(makeDeps(), 42);
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("handleSet — keybindings validation (F20 hardening, defense in depth)", () => {
  it("drops a malformed keybindings section (bindings:null) but still applies sibling settings", async () => {
    const res = await handleSet(makeDeps(), {
      ui: { theme: "dark" },
      keybindings: { overrides: [{ action: "palette.toggle", bindings: null }] },
    });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    // The sibling section still applied…
    expect(loaded.settings.ui.theme).toBe("dark");
    // …but the corrupt keybindings never reached disk (would otherwise be quarantined as corrupt on read).
    expect(loaded.settings.keybindings).toBeUndefined();
  });

  it("persists a well-formed keybindings section", async () => {
    const res = await handleSet(makeDeps(), {
      keybindings: { overrides: [{ action: "session.new", bindings: ["mod+shift+n"] }] },
    });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.keybindings?.overrides).toEqual([{ action: "session.new", bindings: ["mod+shift+n"] }]);
  });

  it("drops a non-array overrides", async () => {
    await handleSet(makeDeps(), { ui: { theme: "light" }, keybindings: { overrides: "nope" } });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.ui.theme).toBe("light");
    expect(loaded.settings.keybindings).toBeUndefined();
  });
});

describe("handleSet — provider.defaults persist (F14, slice-P7.15-cut.md §2.4)", () => {
  it("persists a per-provider default and survives a LATER settings-get reload", async () => {
    // The patch schema (patchSchema = z.record(string, unknown)) is already
    // permissive enough to carry an arbitrary provider.defaults shape through —
    // the compat risk this proves is downstream, in the schema.ts zod re-parse
    // on the NEXT load (loadSettings -> parseSettings -> settingsSchema).
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), {
      provider: { id: "z-ai", defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.settings.provider.defaults).toEqual({
        "z-ai": { model: "glm-5.2", reasoningEffort: "high" },
      });
    }

    // A later, independent settings-get (fresh load off disk) must see the same
    // thing — this is where a provider zod object without the `defaults` key
    // declared would silently strip it.
    const reloaded = await handleGet(makeDeps());
    expect(reloaded.settings.provider.defaults).toEqual({ "z-ai": { model: "glm-5.2", reasoningEffort: "high" } });
  });

  it("a second patch for a DIFFERENT provider id accumulates alongside the first (deep-merge, not array-replace)", async () => {
    await handleSet(makeDeps(), { provider: { defaults: { custom: { reasoningEffort: "off" } } } });
    const res = await handleSet(makeDeps(), { provider: { defaults: { "z-ai": { reasoningEffort: "max" } } } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.defaults).toEqual({
      custom: { reasoningEffort: "off" },
      "z-ai": { reasoningEffort: "max" },
    });
  });

  it("re-patching the SAME provider id overwrites its snapshot (last-write-wins, cut §6 R9)", async () => {
    await handleSet(makeDeps(), { provider: { defaults: { "z-ai": { model: "glm-4.6", reasoningEffort: "off" } } } });
    const res = await handleSet(makeDeps(), {
      provider: { defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } } },
    });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.defaults).toEqual({ "z-ai": { model: "glm-5.2", reasoningEffort: "high" } });
  });

  it("an old settings.json with no provider.defaults loads unchanged (backward-compat)", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        provider: { model: "legacy-model" },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
    const snapshot = await handleGet(makeDeps());
    expect(snapshot.settings.provider.model).toBe("legacy-model");
    expect(snapshot.settings.provider.defaults).toBeUndefined();
  });
});

describe("handleAddRule — dedup append (§5)", () => {
  it("appends a rule and dedups an identical one", async () => {
    const r1 = await handleAddRule(makeDeps(), { toolName: "Bash", pattern: "git *" });
    expect(r1.ok).toBe(true);
    const r2 = await handleAddRule(makeDeps(), { toolName: "Bash", pattern: "git *" });
    expect(r2.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.permissions.alwaysAllow).toEqual([{ toolName: "Bash", pattern: "git *" }]);
  });

  it("treats a different pattern as a distinct rule", async () => {
    await handleAddRule(makeDeps(), { toolName: "Bash", pattern: "git *" });
    await handleAddRule(makeDeps(), { toolName: "Bash", pattern: "npm *" });
    await handleAddRule(makeDeps(), { toolName: "Read" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.permissions.alwaysAllow).toHaveLength(3);
  });

  it("rejects an empty toolName as invalid", async () => {
    const res = await handleAddRule(makeDeps(), { toolName: "" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("custody — no channel ever leaks the value", () => {
  it("every mutating response for a set key is value-free", async () => {
    const deps = makeDeps();
    await handleSetSecret(deps, { key: "provider.apiKey", value: SECRET_VALUE });
    const responses: unknown[] = [
      await handleGet(deps),
      await handleSet(deps, { ui: { theme: "light" } }),
      await handleAddRule(deps, { toolName: "Bash", pattern: "ls *" }),
      await handleClearSecret(deps, { key: "provider.apiKey" }),
    ];
    for (const res of responses) {
      expect(containsSecret(res)).toBe(false);
    }
  });

  it("a snapshot's secrets carry exactly {key,set,source,tier} — no extra fields", async () => {
    vault.store.set("provider.apiKey", SECRET_VALUE);
    const snap: SettingsSnapshot = await handleGet(makeDeps());
    for (const status of snap.secrets) {
      expect(Object.keys(status).sort()).toEqual(["key", "set", "source", "tier"]);
    }
  });
});

// ── slice 2.5 (catalog + multi-key + oauth) ──

const CATALOG_IDS = ["z-ai", "custom", "acme"];

describe("projectCatalogSummary — value-only projection", () => {
  it("projects auth kind, models, and needsBaseUrl for the empty-baseUrl entry", () => {
    const summary = projectCatalogSummary([
      { id: "z-ai", name: "Z.AI", auth: { kind: "api_key" }, baseUrl: "https://z", models: [{ id: "glm", name: "GLM" }] },
      { id: "acme", name: "Acme", auth: { kind: "oauth" }, baseUrl: "https://a", models: [] },
      { id: "custom", name: "Custom", auth: { kind: "api_key" }, baseUrl: "", models: [] },
    ]);
    expect(summary).toEqual([
      { id: "z-ai", name: "Z.AI", authKind: "api_key", models: [{ id: "glm", name: "GLM" }] },
      { id: "acme", name: "Acme", authKind: "oauth", models: [] },
      { id: "custom", name: "Custom", authKind: "api_key", models: [], needsBaseUrl: true },
    ]);
    // Never a baseUrl / key in the projection (custody + no secret).
    expect(JSON.stringify(summary)).not.toContain("https://z");
  });
});

describe("handleSet — provider.id catalog refine (slice 2.5)", () => {
  it("accepts a provider.id that names a catalog entry", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.id).toBe("z-ai");
  });

  it("refuses a provider.id outside the catalog as invalid", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "evil" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("still accepts a legacy patch with no provider.id", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { model: "m" } });
    expect(res.ok).toBe(true);
  });
});

describe("handleSetSecret/handleClearSecret — widened SecretKey refine", () => {
  it("accepts a per-provider apiKey key for a catalog id", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.z-ai.apiKey",
      value: SECRET_VALUE,
    });
    expect(res.ok).toBe(true);
    expect(vault.store.get("provider.z-ai.apiKey")).toBe(SECRET_VALUE);
  });

  it("rejects a per-provider key whose id is not in the catalog", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.evil.apiKey",
      value: "x",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("clears a per-provider key", async () => {
    vault.store.set("provider.z-ai.apiKey", SECRET_VALUE);
    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey" });
    expect(res.ok).toBe(true);
    expect(vault.store.has("provider.z-ai.apiKey")).toBe(false);
  });
});

describe("snapshot — catalog projection + oauth readiness (slice 2.5)", () => {
  it("carries the catalog projection when provided", async () => {
    const catalog = projectCatalogSummary([
      { id: "z-ai", name: "Z.AI", auth: { kind: "api_key" }, baseUrl: "https://z", models: [] },
    ]);
    const snap = await buildSettingsSnapshot(makeDeps({ catalog, catalogIds: CATALOG_IDS }));
    expect(snap.catalog).toEqual(catalog);
  });

  it("providerReady uses the oauth credentialKey (provider.<id>.oauth present)", async () => {
    // Select acme (oauth) with a model, and a stored oauth blob.
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "acme", model: "m" } });
    vault.store.set("provider.acme.oauth", "blob");
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: CATALOG_IDS, authKindFor: (id) => (id === "acme" ? "oauth" : undefined) }),
    );
    expect(snap.providerReady).toBe(true);
  });

  it("providerReady false for an oauth provider with no stored token", async () => {
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "acme", model: "m" } });
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: CATALOG_IDS, authKindFor: (id) => (id === "acme" ? "oauth" : undefined) }),
    );
    expect(snap.providerReady).toBe(false);
  });
});

describe("handleOAuthStart / handleOAuthCancel", () => {
  function oauthDeps(over: Partial<SettingsIpcDeps> = {}): SettingsIpcDeps {
    return makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauth: runner,
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      ...over,
    });
  }
  let runner: FakeOAuthRunner;
  beforeEach(() => {
    runner = new FakeOAuthRunner(vault);
  });

  it("runs the flow and returns a fresh snapshot WITHOUT a token (custody I1)", async () => {
    const onMutation = vi.fn();
    const res = await handleOAuthStart(oauthDeps({ onMutation }), { providerId: "acme" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const oauthStatus = res.snapshot.secrets.find((s) => s.key === "provider.acme.oauth");
      expect(oauthStatus?.set).toBe(true);
      // No token anywhere in the response.
      expect(JSON.stringify(res)).not.toContain("OAUTH-TOKEN-BLOB-SECRET");
    }
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("refuses `unsupported` for a non-oauth / unknown provider", async () => {
    const res = await handleOAuthStart(oauthDeps(), { providerId: "z-ai" });
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("passes an engine cancellation reason through", async () => {
    runner.outcome = { ok: false, reason: "cancelled" };
    const res = await handleOAuthStart(oauthDeps(), { providerId: "acme" });
    expect(res).toEqual({ ok: false, reason: "cancelled" });
  });

  it("refuses read_only when settings.json is newer than this binary", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 2, provider: {}, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }),
    );
    const res = await handleOAuthStart(oauthDeps(), { providerId: "acme" });
    expect(res).toEqual({ ok: false, reason: "read_only" });
  });

  it("handleOAuthCancel forwards the provider id to the engine", async () => {
    await handleOAuthCancel(oauthDeps(), { providerId: "acme" });
    expect(runner.cancelled).toEqual(["acme"]);
  });
});

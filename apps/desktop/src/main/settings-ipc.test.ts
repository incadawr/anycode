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
import type { CatalogSummary, SecretKey, SecretStatus, SettingsSnapshot } from "../shared/settings.js";
import { activeConnection, activeProviderView } from "../shared/settings.js";
import { ENV_PROVIDER_TRANSPORT, isKnownSecretKey } from "./host-env.js";
import type { OAuthOutcome, OAuthProviderConfig } from "./oauth.js";
import {
  buildSettingsSnapshot,
  handleAddRule,
  handleClearSecret,
  handleConnectionCreate,
  handleConnectionDelete,
  handleConnectionSetActive,
  handleConnectionUpdate,
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

/** Fake OAuth runner: a successful start writes a token blob into the vault under the CONNECTION key (§4.3). */
class FakeOAuthRunner implements OAuthRunnerLike {
  outcome: OAuthOutcome = { ok: true };
  cancelled: string[] = [];
  lastConnectionId: string | undefined;
  constructor(private readonly vault: FakeVault) {}
  async startFlow(_config: OAuthProviderConfig, connectionId: string): Promise<OAuthOutcome> {
    this.lastConnectionId = connectionId;
    if (this.outcome.ok) {
      this.vault.store.set(`provider.connection.${connectionId}.oauth`, "OAUTH-TOKEN-BLOB-SECRET");
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
/** Deterministic connection ids for tests (`conn-1`, `conn-2`, …), reset per test. */
let connSeq: number;

function makeDeps(over: Partial<SettingsIpcDeps> = {}): SettingsIpcDeps {
  return { vault, bootEnv: {}, settingsPath, genConnectionId: () => `conn-${++connSeq}`, ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-ipc-"));
  settingsPath = join(dir, "settings.json");
  vault = new FakeVault();
  connSeq = 0;
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
    expect(snap.settings.version).toBe(2);
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

describe("handleSetSecret — custody + consent + write-translation (I1 / R1 / §4.1)", () => {
  it("translates the legacy key to the connection key (value ONLY under provider.connection.<id>.apiKey, never the legacy form)", async () => {
    const onMutation = vi.fn();
    const res = await handleSetSecret(makeDeps({ onMutation }), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The alias mirrors the connection key's status under the legacy key the
      // pre-W12 renderer reads (secrets[0] === provider.apiKey), so it shows set.
      expect(res.snapshot.secrets[0]).toMatchObject({ key: "provider.apiKey", set: true, source: "vault" });
      expect(containsSecret(res)).toBe(false);
    }
    // The value reached the CONNECTION key, and the legacy form was NEVER written.
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.apiKey")).toBe(false);
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
    // Written under the connection key (the legacy form is translated away).
    expect(spy).toHaveBeenLastCalledWith("provider.connection.conn-1.apiKey", SECRET_VALUE, { allowWeak: true });
  });

  it("rejects a malformed payload as invalid", async () => {
    const res = await handleSetSecret(makeDeps(), { key: "other.key", value: "x" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("handleClearSecret", () => {
  it("clears the active connection's key when a legacy key is cleared, returning a fresh snapshot", async () => {
    // A connection holds the secret under its connection key (the W9′ shape).
    await handleSetSecret(makeDeps(), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);

    const res = await handleClearSecret(makeDeps(), { key: "provider.apiKey" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The alias reflects the now-empty connection key.
      expect(res.snapshot.secrets[0]).toMatchObject({ key: "provider.apiKey", set: false });
    }
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);
  });

  it("clearing a legacy key for a provider with no connection is a safe no-op", async () => {
    const res = await handleClearSecret(makeDeps(), { key: "provider.apiKey" });
    expect(res.ok).toBe(true);
  });
});

describe("handleSet — merge + read-only", () => {
  it("deep-partial merges and persists (the legacy provider patch folds onto a connection)", async () => {
    const res = await handleSet(makeDeps(), { provider: { model: "claude-x" }, ui: { theme: "dark" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    // The legacy `provider.model` shim materialised a bare active connection.
    expect(activeProviderView(loaded.settings).model).toBe("claude-x");
    expect(loaded.settings.ui.theme).toBe("dark");
  });

  it("ignores a version change in the patch", async () => {
    await handleSet(makeDeps(), { version: 99, provider: { model: "m" } });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.version).toBe(2);
  });

  it("refuses read_only when settings.json is a newer version than CURRENT", async () => {
    // A version>CURRENT (v3) file loads as readOnly.
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 3, provider: { connections: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }),
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

describe("handleSet — legacy provider patch folds onto the active connection (TASK.45 §4.3 shim)", () => {
  it("folds provider.{id,model,defaults[pid]} onto ONE active connection (no provider.defaults key persisted)", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), {
      provider: { id: "z-ai", defaults: { "z-ai": { model: "glm-5.2", reasoningEffort: "high" } } },
    });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    const view = activeProviderView(loaded.settings);
    expect(view.id).toBe("z-ai");
    expect(view.model).toBe("glm-5.2"); // defaults[pid].model folded onto the connection
    expect(view.reasoningEffort).toBe("high");
    expect(loaded.settings.provider.connections).toHaveLength(1);
    // The v1 `provider.defaults` key does NOT survive — it folded into the connection.
    expect((loaded.settings.provider as unknown as Record<string, unknown>).defaults).toBeUndefined();
    // A later, independent settings-get (fresh load off disk) sees the same connection.
    const reloaded = await handleGet(makeDeps({ catalogIds: CATALOG_IDS }));
    expect(activeProviderView(reloaded.settings).model).toBe("glm-5.2");
  });

  it("re-patching the SAME provider id overwrites its model on the one connection (last-write-wins)", async () => {
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai", model: "glm-4.6" } });
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai", model: "glm-5.2" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toHaveLength(1);
    expect(activeProviderView(loaded.settings).model).toBe("glm-5.2");
  });

  it("an old v1 settings.json on disk is reset to an empty provider on load (no v1 carry-over)", async () => {
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
    expect(snapshot.settings.provider).toEqual({ connections: [] });
    expect(activeProviderView(snapshot.settings)).toEqual({});
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

  it("projects defaultTransport/supportedTransports/authOptional only when the source entry declares them (TASK.43 W5)", () => {
    const summary = projectCatalogSummary([
      {
        id: "openai",
        name: "OpenAI",
        auth: { kind: "api_key" },
        baseUrl: "https://api.openai.com/v1",
        models: [],
        defaultTransport: "openai-responses",
        supportedTransports: ["openai-responses", "openai-chat-completions"],
      },
      {
        id: "vllm",
        name: "vLLM",
        auth: { kind: "api_key" },
        baseUrl: "",
        models: [],
        defaultTransport: "openai-chat-completions",
        supportedTransports: ["openai-chat-completions"],
        authOptional: true,
      },
      { id: "z-ai", name: "Z.AI", auth: { kind: "api_key" }, baseUrl: "https://z", models: [] },
    ]);
    expect(summary).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        authKind: "api_key",
        models: [],
        defaultTransport: "openai-responses",
        supportedTransports: ["openai-responses", "openai-chat-completions"],
      },
      {
        id: "vllm",
        name: "vLLM",
        authKind: "api_key",
        models: [],
        needsBaseUrl: true,
        defaultTransport: "openai-chat-completions",
        supportedTransports: ["openai-chat-completions"],
        authOptional: true,
      },
      // No transport fields at all when the source entry omits them — a legacy
      // fixture's output is byte-identical to pre-W5.
      { id: "z-ai", name: "Z.AI", authKind: "api_key", models: [] },
    ]);
  });

  it("projects isCustom ONLY for the literal custom sentinel, never for a non-custom needsBaseUrl template like vLLM (TASK.43 W5-FIX #2/#5)", () => {
    const summary = projectCatalogSummary([
      { id: "vllm", name: "vLLM", auth: { kind: "api_key" }, baseUrl: "", models: [], isCustom: false },
      { id: "custom", name: "Custom endpoint", auth: { kind: "api_key" }, baseUrl: "", models: [], isCustom: true },
    ]);
    const vllm = summary.find((e) => e.id === "vllm");
    const custom = summary.find((e) => e.id === "custom");
    // Both needsBaseUrl; only the custom sentinel is isCustom. The renderer's
    // providerSecretKey/displayedProviderId key off this distinction.
    expect(vllm?.needsBaseUrl).toBe(true);
    expect(vllm?.isCustom).toBeUndefined();
    expect(custom?.needsBaseUrl).toBe(true);
    expect(custom?.isCustom).toBe(true);
  });
});

describe("snapshot — auth-policy + unsupported-transport readiness (TASK.43 W5, cut Risk #3)", () => {
  const VLLM_ID = "vllm";
  const TRANSPORT_CATALOG_IDS = ["vllm", "custom"];

  function transportCatalog(): CatalogSummary {
    return projectCatalogSummary([
      {
        id: VLLM_ID,
        name: "vLLM",
        auth: { kind: "api_key" },
        baseUrl: "",
        models: [],
        defaultTransport: "openai-chat-completions",
        supportedTransports: ["openai-chat-completions"],
        authOptional: true,
      },
    ]);
  }

  it("vLLM (authOptional) is ready with a model and no key at all", async () => {
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      provider: { id: VLLM_ID, model: "m" },
    });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }));
    expect(snap.providerReady).toBe(true);
  });

  it("blocks readiness when settings.provider.transport is outside the selected entry's supportedTransports", async () => {
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      provider: { id: VLLM_ID, model: "m", transport: "openai-responses" },
    });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }));
    expect(snap.providerReady).toBe(false);
  });

  it("blocks readiness when the ANYCODE_PROVIDER_TRANSPORT env rung forces an unsupported transport (TASK.43 W5-FIX #1)", async () => {
    // vLLM supports only chat-completions; settings.transport is UNSET, so the
    // guard's only signal is the env override. Pre-W5-FIX the guard ignored the
    // env rung entirely, saw the (supported) catalog default, and wrongly
    // reported ready — contradicting the fork the env actually forces.
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      provider: { id: VLLM_ID, model: "m" },
    });
    const snap = await buildSettingsSnapshot(
      makeDeps({
        catalogIds: TRANSPORT_CATALOG_IDS,
        catalog: transportCatalog(),
        bootEnv: { [ENV_PROVIDER_TRANSPORT]: "openai-responses" },
      }),
    );
    expect(snap.providerReady).toBe(false);
  });

  // main's real wiring always projects EVERY catalog entry (including custom)
  // into `deps.catalog` — `selectedTransportInfo` looks the selected id up
  // there, so the fixture must include it too.
  const CUSTOM_CATALOG: CatalogSummary = projectCatalogSummary([
    { id: "custom", name: "Custom endpoint", auth: { kind: "api_key" }, baseUrl: "", models: [] },
  ]);

  it("custom becomes auth-optional once its resolved transport is an OpenAI-family one", async () => {
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      provider: { id: "custom", model: "m", baseUrl: "http://localhost:8000/v1", transport: "openai-chat-completions" },
    });
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: CUSTOM_CATALOG, isCustom: (id) => id === "custom" }),
    );
    expect(snap.providerReady).toBe(true);
  });

  it("custom stays fail-closed (requires a key) on the default anthropic-messages transport", async () => {
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      provider: { id: "custom", model: "m", baseUrl: "https://bridge.example" },
    });
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: CUSTOM_CATALOG, isCustom: (id) => id === "custom" }),
    );
    expect(snap.providerReady).toBe(false);
  });

  it("an env-forced OpenAI transport on a keyless custom endpoint waives auth ⇒ ready (TASK.43 W5-FIX #1)", async () => {
    // settings.transport UNSET; the env rung forces an OpenAI-family transport.
    // Pre-W5-FIX the auth waiver read only settings.transport (unset ⇒ treated
    // as anthropic-messages), demanded a key, and reported NOT ready — blind to
    // the env transport the fork actually runs.
    await handleSet(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      provider: { id: "custom", model: "m", baseUrl: "http://localhost:8000/v1" },
    });
    const snap = await buildSettingsSnapshot(
      makeDeps({
        catalogIds: TRANSPORT_CATALOG_IDS,
        catalog: CUSTOM_CATALOG,
        isCustom: (id) => id === "custom",
        bootEnv: { [ENV_PROVIDER_TRANSPORT]: "openai-chat-completions" },
      }),
    );
    expect(snap.providerReady).toBe(true);
  });
});

describe("handleSet — provider.id catalog refine (slice 2.5)", () => {
  it("accepts a provider.id that names a catalog entry", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(activeProviderView(loaded.settings).id).toBe("z-ai");
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

describe("handleSetSecret/handleClearSecret — widened SecretKey refine + write-translation", () => {
  it("accepts a per-provider apiKey key for a catalog id, storing it under that provider's connection key", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.z-ai.apiKey",
      value: SECRET_VALUE,
    });
    expect(res.ok).toBe(true);
    // Translated to the connection key for a freshly-created z-ai connection;
    // the legacy `provider.z-ai.apiKey` form is never written.
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.z-ai.apiKey")).toBe(false);
  });

  it("rejects a per-provider key whose id is not in the catalog", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.evil.apiKey",
      value: "x",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("clears a per-provider key by translating it to the provider's connection key", async () => {
    // Establish a z-ai connection holding the secret under its connection key.
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey" });
    expect(res.ok).toBe(true);
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);
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

  it("providerReady uses the oauth credentialKey (the active connection's oauth key present)", async () => {
    // Select acme (oauth) with a model, and a stored oauth blob under the
    // connection's key (W9′ keys credentials by connection).
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "acme", model: "m" } });
    vault.store.set("provider.connection.conn-1.oauth", "blob");
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
      JSON.stringify({ version: 3, provider: { connections: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }),
    );
    const res = await handleOAuthStart(oauthDeps(), { providerId: "acme" });
    expect(res).toEqual({ ok: false, reason: "read_only" });
  });

  it("handleOAuthCancel forwards the provider id to the engine", async () => {
    await handleOAuthCancel(oauthDeps(), { providerId: "acme" });
    expect(runner.cancelled).toEqual(["acme"]);
  });

  it("threads the target connection id into the engine (persist-by-connection, §4.3)", async () => {
    const res = await handleOAuthStart(oauthDeps(), { providerId: "acme" });
    expect(res.ok).toBe(true);
    // A connection was minted for acme and its id was handed to the engine.
    expect(runner.lastConnectionId).toBe("conn-1");
    const loaded = await loadSettings(settingsPath);
    expect(activeConnection(loaded.settings)?.providerId).toBe("acme");
  });
});

// ── TASK.45 W9′ new seams: write-path, CRUD custody, alias, refine-reject ──

describe("pre-W12 secret write-path end-to-end (§4.1, DoD item 4)", () => {
  it("pick provider → enter key → snapshot: connection created+active, secret ONLY under the connection key, alias visible, ready", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    // (1) pick a provider through the OLD generic settings-set channel.
    await handleSet(deps, { provider: { id: "z-ai", model: "glm-4.6" } });
    // (2) enter a key through the OLD generic secret-set channel (legacy-shaped key).
    const setRes = await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(setRes.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    // A connection was created and is the default for new sessions.
    expect(loaded.settings.provider.connections).toHaveLength(1);
    const conn = activeConnection(loaded.settings);
    expect(conn?.providerId).toBe("z-ai");
    expect(loaded.settings.provider.activeConnectionId).toBe(conn?.id);

    // The secret lives ONLY under the connection key; both legacy forms are absent.
    expect(vault.store.get(`provider.connection.${conn?.id}.apiKey`)).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.z-ai.apiKey")).toBe(false);
    expect(vault.store.has("provider.apiKey")).toBe(false);

    // The snapshot mirrors the connection key's status under the legacy alias the
    // pre-W12 renderer reads (providerSecretKey("z-ai") === "provider.z-ai.apiKey").
    const snap = await buildSettingsSnapshot(deps);
    expect(snap.secrets.find((s) => s.key === "provider.z-ai.apiKey")?.set).toBe(true);
    // The readiness gate reads the connection key -> providerReady flips true.
    expect(snap.providerReady).toBe(true);
  });

  it("negative: the raw secrets store never holds a legacy form (custody + no desync)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleSetSecret(deps, { key: "provider.apiKey", value: SECRET_VALUE });
    expect([...vault.store.keys()]).toEqual(["provider.connection.conn-1.apiKey"]);
  });
});

describe("snapshot — legacy alias projection (§4.2)", () => {
  it("mirrors the active connection's key status under the legacy alias, value-less", async () => {
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai", model: "m" } });
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: CATALOG_IDS }));
    const alias = snap.secrets.find((s) => s.key === "provider.z-ai.apiKey");
    expect(alias).toMatchObject({ set: true, source: "vault" });
    expect(Object.keys(alias ?? {}).sort()).toEqual(["key", "set", "source", "tier"]); // value-less
    expect(containsSecret(snap)).toBe(false);
  });

  it("reflects an env override on the alias source", async () => {
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai", model: "m" } });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: CATALOG_IDS, bootEnv: { ANYCODE_API_KEY: "k" } }));
    expect(snap.secrets.find((s) => s.key === "provider.z-ai.apiKey")?.source).toBe("env");
  });
});

describe("handleSet — refine-rejects a wholesale connections graph (DoD item 6)", () => {
  it("rejects a wholesale connections array through the generic settings-set path", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), {
      provider: { connections: [{ id: "x", providerId: "z-ai" }] },
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    // Nothing persisted.
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toEqual([]);
  });

  it("rejects an activeConnectionId through the generic settings-set path", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { activeConnectionId: "x" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("connection CRUD — custody + lifecycle (DoD item 5)", () => {
  it("create rejects a payload carrying a credential field (.strict) — plaintext never crosses IPC", async () => {
    const withApiKey = await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), {
      providerId: "z-ai",
      apiKey: SECRET_VALUE,
    });
    expect(withApiKey).toEqual({ ok: false, reason: "invalid" });
    const withToken = await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), {
      providerId: "z-ai",
      token: SECRET_VALUE,
    });
    expect(withToken).toEqual({ ok: false, reason: "invalid" });
    // Nothing persisted, and the secret never reached the vault.
    expect(vault.store.size).toBe(0);
    expect((await loadSettings(settingsPath)).settings.provider.connections).toEqual([]);
  });

  it("update rejects a payload carrying a credential field (.strict)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" });
    const res = await handleConnectionUpdate(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1", apiKey: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("create mints conn-<id>, activates the first connection, rejects a non-catalog providerId", async () => {
    const bad = await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "evil" });
    expect(bad).toEqual({ ok: false, reason: "invalid" });

    const res = await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai", model: "glm-5.2" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toEqual([{ id: "conn-1", providerId: "z-ai", model: "glm-5.2" }]);
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-1"); // first connection activates
  });

  it("update patches metadata (never a credential); not_found for an unknown id", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" });
    const res = await handleConnectionUpdate(makeDeps({ catalogIds: CATALOG_IDS }), {
      id: "conn-1",
      model: "glm-5.2",
      label: "Prod",
    });
    expect(res.ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.provider.connections[0]).toMatchObject({
      model: "glm-5.2",
      label: "Prod",
    });

    const missing = await handleConnectionUpdate(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-nope", model: "x" });
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("set-active switches the default; not_found for an unknown id", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1 (active)
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "acme" }); // conn-2
    const res = await handleConnectionSetActive(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-2" });
    expect(res.ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.provider.activeConnectionId).toBe("conn-2");

    const missing = await handleConnectionSetActive(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-nope" });
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("delete clears BOTH connection secrets first, then removes metadata + active id (idempotent)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1 active
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);

    const clearSpy = vi.spyOn(vault, "clearSecret");
    const res = await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" });
    expect(res.ok).toBe(true);
    // secrets-first: both credential kinds cleared before metadata removal.
    expect(clearSpy).toHaveBeenCalledWith("provider.connection.conn-1.apiKey");
    expect(clearSpy).toHaveBeenCalledWith("provider.connection.conn-1.oauth");
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toEqual([]);
    expect(loaded.settings.provider.activeConnectionId).toBeUndefined();
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);

    // Idempotent: deleting an already-gone connection still succeeds.
    const again = await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" });
    expect(again.ok).toBe(true);
  });

  it("no CRUD response ever carries a secret value (custody)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" });
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const responses = [
      await handleConnectionUpdate(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1", model: "m" }),
      await handleConnectionSetActive(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" }),
      await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" }),
    ];
    for (const res of responses) {
      expect(containsSecret(res)).toBe(false);
    }
  });
});

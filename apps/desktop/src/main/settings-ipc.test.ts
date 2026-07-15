/**
 * Unit tests for the settings/secret IPC handler logic (design §3, ruling §4),
 * exercised as the exported handle* functions off a FAKE vault + scratch
 * settings path (no Electron ipcMain, no OS keychain). Covers: the custody
 * invariant (no secret value in ANY response), the weak-consent refusal
 * pass-through, read-only refusals, rule-add dedup, and the onMutation fire
 * discipline (fires on success, not on refusal).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../settings/files.js";
import type { CatalogSummary, SecretKey, SecretStatus, SettingsSnapshot } from "../shared/settings.js";
import { activeConnection, activeProviderView } from "../shared/settings.js";
import { ENV_PROVIDER_TRANSPORT, isKnownSecretKey } from "./host-env.js";
import type { OAuthOutcome, OAuthProviderConfig } from "./oauth.js";
import {
  applyConnectionHealthEvent,
  buildSettingsSnapshot,
  handleAddRule,
  handleClearSecret,
  handleConnectionCheck,
  handleConnectionCreate,
  handleConnectionDelete,
  handleConnectionSetActive,
  handleConnectionUpdate,
  handleGet,
  handleOAuthCancel,
  handleOAuthStart,
  handleSet,
  handleSetSecret,
  mapProviderFailureCodeToHealthStatus,
  projectCatalogSummary,
  sanitizeProviderFailureCode,
  type ConnectionProbeOutcome,
  type OAuthRunnerLike,
  type SettingsIpcDeps,
  type VaultLike,
} from "./settings-ipc.js";
import type { SecretSetResult } from "./vault.js";

/**
 * Controllable gate over the real settings/files IO (mutation-lock test, §2.3).
 * When `armed`, every `loadSettings`/`saveSettings` performed by a handler parks
 * on the queue after the real read (loads) or before the real write (saves) so a
 * test can drive a deterministic interleave and observe the load/save order.
 * Disarmed by default -> pure pass-through, so every other test is untouched.
 */
const ipcGate = vi.hoisted(() => {
  const queue: Array<{ type: "load" | "save"; release: () => void }> = [];
  const log: string[] = [];
  let armed = false;
  return {
    queue,
    log,
    arm(): void {
      armed = true;
      queue.length = 0;
      log.length = 0;
    },
    disarm(): void {
      armed = false;
    },
    isArmed(): boolean {
      return armed;
    },
    wait(type: "load" | "save"): Promise<void> {
      log.push(type);
      return new Promise<void>((resolve) => {
        queue.push({ type, release: resolve });
      });
    },
  };
});

vi.mock("../settings/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/files.js")>();
  return {
    ...actual,
    loadSettings: async (...args: Parameters<typeof actual.loadSettings>) => {
      const result = await actual.loadSettings(...args);
      if (ipcGate.isArmed()) {
        await ipcGate.wait("load");
      }
      return result;
    },
    saveSettings: async (...args: Parameters<typeof actual.saveSettings>) => {
      if (ipcGate.isArmed()) {
        await ipcGate.wait("save");
      }
      return actual.saveSettings(...args);
    },
  };
});

/** Drives an armed `ipcGate`: releases the front of the queue between microtask flushes until `p` settles. */
async function drainGate(p: Promise<unknown>): Promise<void> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 500 && !settled; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ev = ipcGate.queue.shift();
    if (ev) {
      ev.release();
    }
  }
}

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
  /** W11-FIX2 #2: records markConnectionDeleting/revert call order for handler-wiring pins. */
  markedDeleting: string[] = [];
  reverted: string[] = [];
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
  markConnectionDeleting(connectionId: string): () => void {
    this.markedDeleting.push(connectionId);
    let reverted = false;
    return () => {
      if (!reverted) {
        reverted = true;
        this.reverted.push(connectionId);
      }
    };
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
  ipcGate.disarm();
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

  it("refuses to delete a connection pinned to a LIVE session (connection_in_use) and keeps its secrets (W10 delete-guard)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const clearSpy = vi.spyOn(vault, "clearSecret");
    const res = await handleConnectionDelete(
      makeDeps({ catalogIds: CATALOG_IDS, connectionInUse: (id) => id === "conn-1" }),
      { id: "conn-1" },
    );
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    // A blocked delete touches NOTHING: no secret cleared, connection intact.
    expect(clearSpy).not.toHaveBeenCalled();
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
    expect((await loadSettings(settingsPath)).settings.provider.connections).toHaveLength(1);
  });

  it("refuses delete when the pin is RESERVED but not yet registered (W10-FIX F3 early guard, registered ∪ pending)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const clearSpy = vi.spyOn(vault, "clearSecret");
    // A resume has RESERVED this pin (synchronously, before its tab is registered):
    // `connectionInUse` unions the reservation set, so the early guard refuses.
    const reserved = new Set(["conn-1"]);
    const res = await handleConnectionDelete(
      makeDeps({ catalogIds: CATALOG_IDS, connectionInUse: (id) => reserved.has(id) }),
      { id: "conn-1" },
    );
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    // Early refusal touches nothing.
    expect(clearSpy).not.toHaveBeenCalled();
    expect((await loadSettings(settingsPath)).settings.provider.connections).toHaveLength(1);
  });

  it("re-checks connectionInUse AFTER the secret-clears and aborts if it flipped (W10-FIX F3 late re-check)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const clearSpy = vi.spyOn(vault, "clearSecret");
    // Free at the EARLY check; a resume registers the pin during the awaited
    // clears, so the LATE re-check (2nd call) sees it in use.
    let calls = 0;
    const connectionInUse = (id: string): boolean => {
      calls += 1;
      return id === "conn-1" && calls >= 2;
    };
    const res = await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS, connectionInUse }), { id: "conn-1" });
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    // Degradation is asymmetric: secrets ARE cleared (keyless, recoverable) but the
    // connection metadata is NOT removed — the live session is never pulled out.
    expect(clearSpy).toHaveBeenCalledWith("provider.connection.conn-1.apiKey");
    expect(clearSpy).toHaveBeenCalledWith("provider.connection.conn-1.oauth");
    expect((await loadSettings(settingsPath)).settings.provider.connections).toHaveLength(1);
    expect((await loadSettings(settingsPath)).settings.provider.activeConnectionId).toBe("conn-1");
  });

  it("cancels an in-flight oauth flow for the deleted connection's provider (residual §6.5)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-1
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    // The engine must not persist a blob under a just-deleted connection id.
    expect(oauth.cancelled).toContain("acme");
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

describe("handleConnectionDelete — tombstone wiring (W11-FIX2 #2, handler layer)", () => {
  it("marks the connection deleting BEFORE the first clearSecret call", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const markSpy = vi.spyOn(oauth, "markConnectionDeleting");
    const clearSpy = vi.spyOn(vault, "clearSecret");
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-1
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    // The tombstone must be in place strictly before the FIRST vault-clear —
    // otherwise a same-connection write settling in the window between the
    // clear and the mark could still slip past the compensation's tombstone
    // check and strand a blob under the just-deleted id.
    const markCallOrder = markSpy.mock.invocationCallOrder[0];
    const firstClearCallOrder = clearSpy.mock.invocationCallOrder[0];
    expect(markCallOrder).toBeDefined();
    expect(firstClearCallOrder).toBeDefined();
    expect(markCallOrder as number).toBeLessThan(firstClearCallOrder as number);
  });

  it("commits the tombstone on a successful delete (no revert)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-1
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    expect(oauth.reverted).toEqual([]);
  });

  it("reverts the tombstone when the LATE re-check aborts the delete (W10-FIX F3 abort path)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    let calls = 0;
    const connectionInUse = (id: string): boolean => {
      calls += 1;
      return id === "conn-1" && calls >= 2;
    };
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
      connectionInUse,
    });
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-1
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    // The connection SURVIVES the aborted delete — its tombstone must not
    // remain, or a later legitimate re-sign-in flow for it would regress M6
    // (a superseded-but-alive write wrongly compensated away).
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    expect(oauth.reverted).toEqual(["conn-1"]);
    expect((await loadSettings(settingsPath)).settings.provider.connections).toHaveLength(1);
  });
});

// ── TASK.45 W11: connection health classification + advisory persist ──

describe("mapProviderFailureCodeToHealthStatus — classification table (401 ≠ 429 ≠ timeout ≠ bad-model)", () => {
  it("maps auth (401) to auth_invalid", () => {
    expect(mapProviderFailureCodeToHealthStatus("auth")).toBe("auth_invalid");
  });

  it("maps forbidden (403) to forbidden — distinct from auth_invalid", () => {
    expect(mapProviderFailureCodeToHealthStatus("forbidden")).toBe("forbidden");
  });

  it("maps rate_limited (429) and quota (429 quota-exhaustion) to rate_limited — never auth_invalid", () => {
    expect(mapProviderFailureCodeToHealthStatus("rate_limited")).toBe("rate_limited");
    expect(mapProviderFailureCodeToHealthStatus("quota")).toBe("rate_limited");
  });

  it("maps connect_timeout/network/server to unreachable — distinct from auth_invalid and rate_limited", () => {
    expect(mapProviderFailureCodeToHealthStatus("connect_timeout")).toBe("unreachable");
    expect(mapProviderFailureCodeToHealthStatus("network")).toBe("unreachable");
    expect(mapProviderFailureCodeToHealthStatus("server")).toBe("unreachable");
  });

  it("maps a bad-model-shaped failure (\"unknown\") to misconfigured — NEVER auth_invalid", () => {
    const status = mapProviderFailureCodeToHealthStatus("unknown");
    expect(status).toBe("misconfigured");
    expect(status).not.toBe("auth_invalid");
  });

  it("defaults an unrecognised future code to unreachable, never a credential-is-bad bucket", () => {
    const status = mapProviderFailureCodeToHealthStatus("some_future_code");
    expect(status).toBe("unreachable");
    expect(status).not.toBe("auth_invalid");
    expect(status).not.toBe("forbidden");
  });
});

describe("sanitizeProviderFailureCode — untrusted host->main boundary (TASK.45 W11-FIX H1)", () => {
  it.each(["auth", "forbidden", "rate_limited", "quota", "connect_timeout", "network", "server", "unknown"])(
    "passes the legitimate code %s through unchanged",
    (code) => {
      expect(sanitizeProviderFailureCode(code)).toBe(code);
    },
  );

  it("collapses an arbitrary/leaked string (e.g. a bearer token) to \"unknown\" rather than persisting it verbatim", () => {
    expect(sanitizeProviderFailureCode("Bearer sk-should-not-persist")).toBe("unknown");
  });

  it("collapses a non-string value to \"unknown\"", () => {
    expect(sanitizeProviderFailureCode(undefined)).toBe("unknown");
    expect(sanitizeProviderFailureCode(null)).toBe("unknown");
    expect(sanitizeProviderFailureCode(42)).toBe("unknown");
    expect(sanitizeProviderFailureCode({ code: "auth" })).toBe("unknown");
  });

  it("end-to-end: a leaked/arbitrary host code never reaches persisted lastHealth.safeCode verbatim", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T00:00:00.000Z" });

    // Mirrors what the main-boundary consumer (index.ts onProviderHealthEvent)
    // does: sanitize the raw host-reported code before it ever reaches
    // applyConnectionHealthEvent.
    await applyConnectionHealthEvent(deps, "conn-1", {
      kind: "failure",
      code: sanitizeProviderFailureCode("Bearer sk-should-not-persist"),
    });

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.lastHealth?.safeCode).toBe("unknown");
    // "unknown" is itself a legitimate table entry (an unclassified core
    // failure, e.g. a 400 bad-model request) mapped to "misconfigured" — NOT
    // "auth_invalid"/"forbidden", so a garbage host code can never paint a
    // connection's credential state as bad.
    expect(reloaded.settings.provider.connections[0]?.lastHealth?.status).toBe("misconfigured");
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "collapses the inherited Object.prototype member %s to \"unknown\" (W11-FIX2 #1, proto-permeable whitelist)",
    (code) => {
      expect(sanitizeProviderFailureCode(code)).toBe("unknown");
    },
  );

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "maps the inherited Object.prototype member %s to \"unreachable\" as a string, never the inherited function/object (W11-FIX2 #1)",
    (code) => {
      const status = mapProviderFailureCodeToHealthStatus(code);
      expect(typeof status).toBe("string");
      expect(status).toBe("unreachable");
    },
  );

  it("blast-e2e: a health event carrying code:\"constructor\" never quarantines settings.json on the next boot (W11-FIX2 #1)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T00:00:00.000Z" });

    await applyConnectionHealthEvent(deps, "conn-1", {
      kind: "failure",
      code: sanitizeProviderFailureCode("constructor"),
    });

    // A fresh load (simulating a restart) must re-read the file we just wrote
    // WITHOUT falling back to read-only/quarantine defaults — a non-string
    // `status` value (the inherited `Object` function, pre-fix) fails
    // JSON.stringify silently, drops the required schema field, and sends the
    // NEXT loadSettings into the corrupt-file fail-soft path.
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.readOnly).toBe(false);
    expect(reloaded.settings.provider.connections).toHaveLength(1);
    // sanitize("constructor") -> "unknown" (a legitimate table entry) -> map
    // "unknown" -> "misconfigured" — a valid enum string, never the pre-fix
    // inherited Object constructor function that fails JSON.stringify.
    expect(reloaded.settings.provider.connections[0]?.lastHealth?.status).toBe("misconfigured");
    expect(typeof reloaded.settings.provider.connections[0]?.lastHealth?.status).toBe("string");
  });
});

describe("applyConnectionHealthEvent — advisory persist round-trip + \"Last known\" after restart", () => {
  it("persists {status, at, safeCode} for a failure event and survives a fresh reload (advisory, not a live status)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T00:00:00.000Z" });

    await applyConnectionHealthEvent(deps, "conn-1", { kind: "failure", code: "auth" });

    // "Last known" (task doc §3): a completely fresh load — simulating a
    // restart — still reads back the exact same advisory record.
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "auth_invalid",
      at: "2026-07-15T00:00:00.000Z",
      safeCode: "auth",
    });
  });

  it("persists {status: ready} with no safeCode for a success event", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T00:00:00.000Z" });

    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" });

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "ready",
      at: "2026-07-15T00:00:00.000Z",
    });
  });

  it("is a race-safe no-op when the connection was deleted mid-flight", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" });
    const deps = makeDeps({ catalogIds: CATALOG_IDS });

    await expect(applyConnectionHealthEvent(deps, "conn-1", { kind: "success" })).resolves.toBeUndefined();
    expect((await loadSettings(settingsPath)).settings.provider.connections).toEqual([]);
  });

  it("never fires onMutation — health is advisory and must not trigger the readiness/auto-tab refresh a real settings mutation does", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const onMutation = vi.fn();
    const deps = makeDeps({ catalogIds: CATALOG_IDS, onMutation });

    await applyConnectionHealthEvent(deps, "conn-1", { kind: "failure", code: "rate_limited" });

    expect(onMutation).not.toHaveBeenCalled();
  });
});

describe("handleSetSecret / handleClearSecret — reset health to unchecked (cut §W11 \"replace/clear key -> unchecked\")", () => {
  it("a first-time secret-set on a connection resets health to unchecked", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T01:00:00.000Z" });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "failure", code: "auth" }); // pre-existing auth_invalid

    const res = await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(res.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "unchecked",
      at: "2026-07-15T01:00:00.000Z",
    });
  });

  it("clearing a secret also resets health to unchecked", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T02:00:00.000Z" });
    await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" }); // ready

    const res = await handleClearSecret(deps, { key: "provider.z-ai.apiKey" });
    expect(res.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "unchecked",
      at: "2026-07-15T02:00:00.000Z",
    });
  });

  it("a refused (weak-storage) secret-set does NOT reset health — nothing actually changed", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "failure", code: "auth" });
    vault.setResult = { ok: false, reason: "weak_storage_needs_consent" };

    const res = await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "weak_storage_needs_consent" });

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.lastHealth?.status).toBe("auth_invalid");
  });
});

describe("handleConnectionUpdate — resets health on a significant ENDPOINT field edit only", () => {
  it("changing model/transport/baseUrl resets health to unchecked", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai", model: "glm-4.5" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T03:00:00.000Z" });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" });

    const res = await handleConnectionUpdate(deps, { id: "conn-1", model: "glm-5.2" });
    expect(res.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "unchecked",
      at: "2026-07-15T03:00:00.000Z",
    });
  });

  it("a label-only edit (or resending the SAME model) leaves health untouched", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai", model: "glm-4.5" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" });

    const res = await handleConnectionUpdate(deps, { id: "conn-1", label: "Work", model: "glm-4.5" });
    expect(res.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.lastHealth?.status).toBe("ready");
  });
});

describe("handleConnectionCheck — probe (TASK.45 W11)", () => {
  it("with NO probe wired (default), behaves byte-identically to the W9 scaffold: no network call, health untouched", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });

    const res = await handleConnectionCheck(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    // Never billed, never probed: health is whatever secret-set already reset it
    // to (unchecked) — connection-check with no probe dep writes NOTHING.
    expect(loaded.settings.provider.connections[0]?.lastHealth?.status).toBe("unchecked");
  });

  it("not_found for an unknown id — never calls the probe", async () => {
    const probeConnection = vi.fn<(...args: unknown[]) => Promise<ConnectionProbeOutcome>>();
    const deps = makeDeps({ catalogIds: CATALOG_IDS, probeConnection });
    const res = await handleConnectionCheck(deps, { id: "conn-nope" });
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(probeConnection).not.toHaveBeenCalled();
  });

  it("never probes a connection with no resolvable credential (nothing to check with)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1, keyless
    const probeConnection = vi.fn<(...args: unknown[]) => Promise<ConnectionProbeOutcome>>();
    const deps = makeDeps({ catalogIds: CATALOG_IDS, probeConnection });

    const res = await handleConnectionCheck(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    expect(probeConnection).not.toHaveBeenCalled();
  });

  it("a wired probe's ok:true writes ready; ok:false classifies + writes safeCode — through the SAME table", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const bootstrap = makeDeps({ catalogIds: CATALOG_IDS });
    await handleSetSecret(bootstrap, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });

    const ok: ConnectionProbeOutcome = { ok: true };
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T04:00:00.000Z", probeConnection: async () => ok });
    const res = await handleConnectionCheck(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.provider.connections[0]?.lastHealth).toEqual({
      status: "ready",
      at: "2026-07-15T04:00:00.000Z",
    });

    const failing: ConnectionProbeOutcome = { ok: false, code: "auth" };
    const deps2 = makeDeps({
      catalogIds: CATALOG_IDS,
      now: () => "2026-07-15T05:00:00.000Z",
      probeConnection: async () => failing,
    });
    await handleConnectionCheck(deps2, { id: "conn-1" });
    expect((await loadSettings(settingsPath)).settings.provider.connections[0]?.lastHealth).toEqual({
      status: "auth_invalid",
      at: "2026-07-15T05:00:00.000Z",
      safeCode: "auth",
    });
  });

  it("never falls back to a billable request — connection-check calls the probe AT MOST once", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const bootstrap = makeDeps({ catalogIds: CATALOG_IDS });
    await handleSetSecret(bootstrap, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    const probeConnection = vi.fn<(...args: unknown[]) => Promise<ConnectionProbeOutcome>>().mockResolvedValue({ ok: true });
    const deps = makeDeps({ catalogIds: CATALOG_IDS, probeConnection });

    await handleConnectionCheck(deps, { id: "conn-1" });

    expect(probeConnection).toHaveBeenCalledTimes(1);
  });
});

// ── W9′-FIX #1: legacy writes target the ACTIVE connection, not first-match (§1.4) ──

describe("W9′-FIX #1 — legacy writes target the ACTIVE connection (§1.4)", () => {
  /** Fixture: two connections of the SAME provider bucket (each with a model so
   * readiness can hinge on the credential), active = the SECOND. */
  async function twoConnActiveSecond(deps: SettingsIpcDeps, providerId: string): Promise<void> {
    await handleConnectionCreate(deps, { providerId, model: "m" }); // conn-1 (first ⇒ active by default)
    await handleConnectionCreate(deps, { providerId, model: "m", setActive: true }); // conn-2 (now active)
    expect((await loadSettings(settingsPath)).settings.provider.activeConnectionId).toBe("conn-2");
  }

  it("handleSetSecret routes a legacy key to the ACTIVE connection's key (not the first match)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await twoConnActiveSecond(deps, "z-ai");
    const res = await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(res.ok).toBe(true);
    // The runtime reads the ACTIVE connection's key -> the write MUST land there.
    expect(vault.store.get("provider.connection.conn-2.apiKey")).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);
    // No new connection minted (find, don't create) and readiness reflects the active key.
    expect((await loadSettings(settingsPath)).settings.provider.connections).toHaveLength(2);
    expect((await buildSettingsSnapshot(deps)).providerReady).toBe(true);
  });

  it("handleSet (legacy provider re-pick) keeps the ACTIVE connection active — no silent flip to first-match (§1.2)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await twoConnActiveSecond(deps, "z-ai");
    const res = await handleSet(deps, { provider: { id: "z-ai" } });
    expect(res.ok).toBe(true);
    // Re-selecting the same provider while conn-2 is active must NOT switch the
    // account under the user to conn-1 (the pre-fix first-match behaviour).
    expect((await loadSettings(settingsPath)).settings.provider.activeConnectionId).toBe("conn-2");
  });

  it("handleOAuthStart threads the ACTIVE connection id to the engine (not first-match)", async () => {
    const runner = new FakeOAuthRunner(vault);
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauth: runner,
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
    });
    await twoConnActiveSecond(deps, "acme");
    const res = await handleOAuthStart(deps, { providerId: "acme" });
    expect(res.ok).toBe(true);
    expect(runner.lastConnectionId).toBe("conn-2");
  });

  it("DoD item-4 extension — pre-W12 write-path with TWO connections lands the secret ONLY under the active key", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await twoConnActiveSecond(deps, "z-ai");
    const setRes = await handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE });
    expect(setRes.ok).toBe(true);
    // Secret ONLY under the active connection; the first connection stays empty.
    expect(vault.store.get("provider.connection.conn-2.apiKey")).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);
    // Alias status (what the pre-W12 renderer reads) mirrors the active key.
    const snap = await buildSettingsSnapshot(deps);
    expect(snap.secrets.find((s) => s.key === "provider.z-ai.apiKey")?.set).toBe(true);
    expect(snap.providerReady).toBe(true);
  });
});

// ── W9′-FIX #2: settings mutation lock (§2.3) ──

describe("W9′-FIX #2 — settings mutation lock (§2.3)", () => {
  it("serializes concurrent settings-set ‖ secret-set — neither read-modify-write is lost", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    ipcGate.arm();
    const p = Promise.all([
      handleSet(deps, { provider: { id: "z-ai", model: "USER-MODEL" } }),
      handleSetSecret(deps, { key: "provider.z-ai.apiKey", value: SECRET_VALUE }),
    ]);
    await drainGate(p);
    await p;
    ipcGate.disarm();

    // Under the lock the second load is STRICTLY after the first save (no shared
    // base). Unlocked it is [load, load, save, save] -> a lost update. The
    // trailing "save" is handleSetSecret's OWN write (TASK.45 W11): it persists
    // the `lastHealth: unchecked` reset onto the connection right after the vault
    // write, inside the SAME lock critical section — ordering is unaffected.
    expect(ipcGate.log).toEqual(["load", "save", "load", "save"]);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toHaveLength(1);
    const active = activeConnection(loaded.settings);
    // The user's provider pick (model) survives — not clobbered by the racing write.
    expect(active?.model).toBe("USER-MODEL");
    // The secret landed on the ONE surviving connection (no orphan / no desync).
    expect(vault.store.get(`provider.connection.${active?.id}.apiKey`)).toBe(SECRET_VALUE);
    expect((await buildSettingsSnapshot(deps)).providerReady).toBe(true);
  });

  it("concurrent rule-adds both persist (lock covers handleAddRule — no lost update)", async () => {
    const deps = makeDeps();
    ipcGate.arm();
    const p = Promise.all([
      handleAddRule(deps, { toolName: "Bash", pattern: "git *" }),
      handleAddRule(deps, { toolName: "Read" }),
    ]);
    await drainGate(p);
    await p;
    ipcGate.disarm();
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.permissions.alwaysAllow).toHaveLength(2);
  });

  it("an in-flight oauth flow does NOT block a concurrent settings-set (flow runs OUTSIDE the lock)", async () => {
    let releaseFlow: () => void = () => undefined;
    const flowGate = new Promise<void>((resolve) => {
      releaseFlow = resolve;
    });
    const runner: OAuthRunnerLike = {
      async startFlow() {
        await flowGate; // hang until the test releases it
        return { ok: true };
      },
      cancel() {
        /* no-op */
      },
      markConnectionDeleting() {
        return () => undefined;
      },
    };
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauth: runner,
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
    });
    const oauthP = handleOAuthStart(deps, { providerId: "acme" }); // enters flow, hangs
    // A concurrent settings-set must complete while the flow is still in flight.
    const setRes = await handleSet(deps, { ui: { theme: "dark" } });
    expect(setRes.ok).toBe(true);
    releaseFlow();
    expect((await oauthP).ok).toBe(true);
  });
});

// ── W9′-FIX #3: refused secret-set rolls the connection back (§3.3) ──

describe("W9′-FIX #3 — refusal rollback (§3.3)", () => {
  it("a refused weak-storage secret-set leaves NO persisted connection", async () => {
    vault.setResult = { ok: false, reason: "weak_storage_needs_consent" };
    const setSpy = vi.spyOn(vault, "setSecret");
    const res = await handleSetSecret(makeDeps(), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    // The just-minted connection is rolled back — nothing persists.
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toEqual([]);
    expect(loaded.settings.provider.activeConnectionId).toBeUndefined();
    expect(setSpy).toHaveBeenCalledTimes(1); // no second write after rollback
  });

  it("convergence regress: consent granted → the same set persists ONE connection with the key", async () => {
    await handleSet(makeDeps(), { security: { allowWeakSecretStorage: true } });
    const res = await handleSetSecret(makeDeps(), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toHaveLength(1);
    const active = activeConnection(loaded.settings);
    expect(vault.store.get(`provider.connection.${active?.id}.apiKey`)).toBe(SECRET_VALUE);
  });
});

// ── W9′-FIX #4: connection-key custody in handleSetSecret only (§4.3) ──

describe("W9′-FIX #4 — connection-key custody (§4.3)", () => {
  it("rejects a connection-key whose id is absent from the graph (not_found) — vault untouched", async () => {
    const setSpy = vi.spyOn(vault, "setSecret");
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-nope.apiKey",
      value: SECRET_VALUE,
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(setSpy).not.toHaveBeenCalled();
    expect(vault.store.size).toBe(0);
  });

  it("rejects a connection-key whose suffix mismatches the connection's auth kind (invalid)", async () => {
    // conn-1 is an api_key provider (z-ai); an .oauth key for it is invalid.
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" });
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-1.oauth",
      value: SECRET_VALUE,
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.store.has("provider.connection.conn-1.oauth")).toBe(false);
  });

  it("accepts a valid connection-key of the right kind (positive regress)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" });
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-1.apiKey",
      value: SECRET_VALUE,
    });
    expect(res.ok).toBe(true);
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
  });

  it("clear stays permissive for a non-existent connection-key (custody fix must NOT touch clear)", async () => {
    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-nope.oauth",
    });
    expect(res.ok).toBe(true);
  });
});

// ── W9′-FIX #5: validated merge — no quarantine-wipe of settings.json (§5.3) ──

describe("W9′-FIX #5 — validated merge (§5.3)", () => {
  it("rejects an invalid provider transport (invalid) and leaves settings.json intact (no quarantine)", async () => {
    // Seed a valid baseline, capture its bytes.
    await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai", model: "glm-4.6" } });
    const before = await readFile(settingsPath, "utf8");

    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { transport: "bogus" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });

    const after = await readFile(settingsPath, "utf8");
    expect(after).toBe(before); // byte-identical: the bogus enum never persisted
    const loaded = await loadSettings(settingsPath);
    expect(loaded.corruptBackupPath).toBeUndefined(); // no quarantine on reload
    expect(activeProviderView(loaded.settings).id).toBe("z-ai"); // config survived
  });

  it("rejects a type error in a non-provider section (tools.concurrency) as invalid", async () => {
    const res = await handleSet(makeDeps(), { tools: { concurrency: "nope" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.corruptBackupPath).toBeUndefined();
  });

  it("unknown top-level keys still survive a valid merge (passthrough invariant preserved — validate-only)", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 2,
        provider: { connections: [] },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
        futureThing: { a: 1 },
      }),
    );
    const res = await handleSet(makeDeps(), { ui: { theme: "dark" } });
    expect(res.ok).toBe(true);
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(raw.futureThing).toEqual({ a: 1 }); // a future-version key is NOT stripped
    expect((raw.ui as { theme: string }).theme).toBe("dark");
  });
});

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

/**
 * W11-FIX3 guard control: makes the NEXT `saveSettings` call reject with a
 * given error (simulates a non-writable disk), then auto-clears so every
 * other test is an unaffected pass-through.
 */
const saveSettingsControl = vi.hoisted(() => {
  let pendingError: Error | undefined;
  return {
    failNext(err: Error): void {
      pendingError = err;
    },
    consume(): Error | undefined {
      const err = pendingError;
      pendingError = undefined;
      return err;
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
      const failure = saveSettingsControl.consume();
      if (failure) {
        throw failure;
      }
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

/**
 * W11-FIX3: a vault whose `statuses` call always fails (simulates a locked
 * keychain on the post-save snapshot leg), while `setSecret`/`clearSecret`/
 * `getSecretValue` delegate to a real `FakeVault` so the durable-clear path
 * behaves normally.
 */
class FailingStatusesVault implements VaultLike {
  constructor(private readonly inner: FakeVault) {}
  setSecret(key: SecretKey, value: string): Promise<SecretSetResult> {
    return this.inner.setSecret(key, value);
  }
  clearSecret(key: SecretKey): Promise<void> {
    return this.inner.clearSecret(key);
  }
  getSecretValue(key: SecretKey): Promise<string | undefined> {
    return this.inner.getSecretValue(key);
  }
  async statuses(): Promise<SecretStatus[]> {
    throw new Error("vault statuses unavailable (locked keychain)");
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
  saveSettingsControl.consume();
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

describe("handleSetSecret — connection-scoped write only (TASK.45 W12: legacy write-translation retired)", () => {
  it("writes the value under the connection's OWN key when the connection exists", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const onMutation = vi.fn();
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS, onMutation }), {
      key: "provider.connection.conn-1.apiKey",
      value: SECRET_VALUE,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(containsSecret(res)).toBe(false);
    }
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("rejects a legacy-shaped key (bare provider.apiKey) — no longer a write target", async () => {
    const res = await handleSetSecret(makeDeps(), { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.store.size).toBe(0);
  });

  it("rejects a legacy per-provider key (provider.<id>.apiKey) — no longer a write target", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.z-ai.apiKey",
      value: SECRET_VALUE,
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.store.size).toBe(0);
  });

  it("passes the weak-consent refusal through and does NOT fire onMutation", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    vault.setResult = { ok: false, reason: "weak_storage_needs_consent" };
    const onMutation = vi.fn();
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS, onMutation }), {
      key: "provider.connection.conn-1.apiKey",
      value: SECRET_VALUE,
    });
    expect(res).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("reads the consent flag from persisted settings", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const spy = vi.spyOn(vault, "setSecret");
    await handleSet(makeDeps(), { security: { allowWeakSecretStorage: true } });
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-1.apiKey",
      value: SECRET_VALUE,
    });
    expect(spy).toHaveBeenLastCalledWith("provider.connection.conn-1.apiKey", SECRET_VALUE, { allowWeak: true });
  });

  it("rejects a malformed payload as invalid", async () => {
    const res = await handleSetSecret(makeDeps(), { key: "other.key", value: "x" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("handleClearSecret", () => {
  it("clears a connection's OWN key, returning a fresh snapshot", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.connection.conn-1.apiKey",
      value: SECRET_VALUE,
    });
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);

    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey" });
    expect(res.ok).toBe(true);
    expect(vault.store.has("provider.connection.conn-1.apiKey")).toBe(false);
  });

  it("clearing an orphan connection-key (no such connection) is a safe no-op", async () => {
    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-nope.apiKey" });
    expect(res.ok).toBe(true);
  });

  it("rejects a legacy-shaped key (bare provider.apiKey) — no longer a clear target", async () => {
    const res = await handleClearSecret(makeDeps(), { key: "provider.apiKey" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("handleSet — merge + read-only", () => {
  it("deep-partial merges a non-provider patch and persists", async () => {
    const res = await handleSet(makeDeps(), { ui: { theme: "dark" } });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.ui.theme).toBe("dark");
  });

  it("ignores a version change in the patch", async () => {
    await handleSet(makeDeps(), { version: 99, ui: { theme: "dark" } });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.version).toBe(2);
  });

  it("refuses read_only when settings.json is a newer version than CURRENT", async () => {
    // A version>CURRENT (v3) file loads as readOnly.
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 3, provider: { connections: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }),
    );
    const res = await handleSet(makeDeps(), { ui: { theme: "dark" } });
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

describe("handleGet — v1 settings.json on disk resets to an empty provider (no v1 carry-over, no migration)", () => {
  it("an old v1 settings.json on disk is reset to an empty provider on load", async () => {
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
    // connectionSecretKey/selectDisplayValue key off this distinction.
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
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      providerId: VLLM_ID,
      model: "m",
    });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }));
    expect(snap.providerReady).toBe(true);
  });

  it("blocks readiness when settings.provider.transport is outside the selected entry's supportedTransports", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      providerId: VLLM_ID,
      model: "m",
      transport: "openai-responses",
    });
    const snap = await buildSettingsSnapshot(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }));
    expect(snap.providerReady).toBe(false);
  });

  it("blocks readiness when the ANYCODE_PROVIDER_TRANSPORT env rung forces an unsupported transport (TASK.43 W5-FIX #1)", async () => {
    // vLLM supports only chat-completions; settings.transport is UNSET, so the
    // guard's only signal is the env override. Pre-W5-FIX the guard ignored the
    // env rung entirely, saw the (supported) catalog default, and wrongly
    // reported ready — contradicting the fork the env actually forces.
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: transportCatalog() }), {
      providerId: VLLM_ID,
      model: "m",
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
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      providerId: "custom",
      model: "m",
      baseUrl: "http://localhost:8000/v1",
      transport: "openai-chat-completions",
    });
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS, catalog: CUSTOM_CATALOG, isCustom: (id) => id === "custom" }),
    );
    expect(snap.providerReady).toBe(true);
  });

  it("custom stays fail-closed (requires a key) on the default anthropic-messages transport", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      providerId: "custom",
      model: "m",
      baseUrl: "https://bridge.example",
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
    await handleConnectionCreate(makeDeps({ catalogIds: TRANSPORT_CATALOG_IDS }), {
      providerId: "custom",
      model: "m",
      baseUrl: "http://localhost:8000/v1",
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

describe("handleSet — provider refine-reject (TASK.45 W12: the connection graph is CRUD-only)", () => {
  it("rejects ANY provider key sent through the generic settings-set path", async () => {
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toEqual([]);
  });

  it("still applies sibling (non-provider) sections in the SAME rejected patch — no, the whole call is refused", async () => {
    // A `provider` key anywhere in the payload refuses the WHOLE call (not a
    // partial apply) — the connection graph is CRUD-only, and mixing it into a
    // patch that also touches `ui` must not silently drop just the provider part.
    const res = await handleSet(makeDeps({ catalogIds: CATALOG_IDS }), { provider: { id: "z-ai" }, ui: { theme: "dark" } });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.ui.theme).toBe("system"); // untouched
  });
});

describe("handleSetSecret/handleClearSecret — catalog-scoped legacy keys are refused too (TASK.45 W12)", () => {
  it("rejects a per-provider apiKey key even for a valid catalog id — connection-scoped only", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.z-ai.apiKey",
      value: SECRET_VALUE,
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.store.size).toBe(0);
  });

  it("rejects a per-provider key whose id is not in the catalog (isKnownSecretKey gate, before the connection-scope check)", async () => {
    const res = await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), {
      key: "provider.evil.apiKey",
      value: "x",
    });
    expect(res).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a per-provider key clear too — connection-scoped only", async () => {
    const res = await handleClearSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.z-ai.apiKey" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
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
    // Create+activate an acme (oauth) connection with a model, and a stored
    // oauth blob under the connection's key (connections key credentials by id).
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "acme", model: "m" }); // conn-1
    vault.store.set("provider.connection.conn-1.oauth", "blob");
    const snap = await buildSettingsSnapshot(
      makeDeps({ catalogIds: CATALOG_IDS, authKindFor: (id) => (id === "acme" ? "oauth" : undefined) }),
    );
    expect(snap.providerReady).toBe(true);
  });

  it("providerReady false for an oauth provider with no stored token", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "acme", model: "m" }); // conn-1
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
      // No alias projection (TASK.45 W12): the status lives under the connection's
      // OWN key — the engine minted+persisted conn-1 for this flow's first run.
      const oauthStatus = res.snapshot.secrets.find((s) => s.key === "provider.connection.conn-1.oauth");
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

// ── TASK.45 W12-FIX §1: OAuth start is connection-scoped (codex W12 review #1) ──

describe("handleOAuthStart — connection-scoped (`connectionId` present, W12-FIX §1)", () => {
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

  // §1.1 — hits ONLY the handler layer: with `connectionId` absent the schema
  // drops it and bucketConnection resolves the ACTIVE connection (conn-1, A) —
  // reverting the handler's connectionId-aware branch is what turns this red.
  it("§1.1 routes to the EXACT connectionId given, not the active/bucket connection", async () => {
    const deps = oauthDeps();
    await handleConnectionCreate(deps, { providerId: "acme", model: "m" }); // conn-1 (A, active by default)
    await handleConnectionCreate(deps, { providerId: "acme", model: "m" }); // conn-2 (B, not active)
    const res = await handleOAuthStart(deps, { providerId: "acme", connectionId: "conn-2" });
    expect(res.ok).toBe(true);
    expect(runner.lastConnectionId).toBe("conn-2");
    // The token landed under B's own key, never A's.
    expect(vault.store.has("provider.connection.conn-2.oauth")).toBe(true);
    expect(vault.store.has("provider.connection.conn-1.oauth")).toBe(false);
  });

  // §1.2 — custody guard: a connectionId from a DIFFERENT provider bucket must
  // refuse, zero side effects. Reverting the `inSameProviderBucket` check (or
  // dropping it) turns this red — the flow would otherwise start on a
  // mismatched connection's credential.
  it("§1.2 custody guard: refuses `failed` when connectionId belongs to a different provider bucket", async () => {
    const deps = oauthDeps();
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1 (api_key bucket)
    const res = await handleOAuthStart(deps, { providerId: "acme", connectionId: "conn-1" });
    expect(res).toEqual({ ok: false, reason: "failed" });
    expect(runner.lastConnectionId).toBeUndefined();
    expect(vault.store.size).toBe(0);
  });

  // §1.3 — not-found: refuses `failed`, engine never called, connections
  // array never grows (anti-mint — the connectionId path must never fall
  // back to findOrCreate's minting behavior).
  it("§1.3 not-found connectionId: refuses `failed`, engine not called, no connection minted", async () => {
    const deps = oauthDeps();
    const res = await handleOAuthStart(deps, { providerId: "acme", connectionId: "conn-nope" });
    expect(res).toEqual({ ok: false, reason: "failed" });
    expect(runner.lastConnectionId).toBeUndefined();
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toHaveLength(0);
  });

  // §1.6 — legacy regress: invoking WITHOUT connectionId must still hit the
  // pre-existing findOrCreate/bucket path byte-for-byte (pinned via the
  // EXISTING oauth describe block above, untouched by this wave — this test
  // only re-confirms the two paths coexist off the SAME handler).
  it("§1.6 absent connectionId still uses findOrCreate (legacy path unaffected)", async () => {
    const deps = oauthDeps();
    const res = await handleOAuthStart(deps, { providerId: "acme" });
    expect(res.ok).toBe(true);
    expect(runner.lastConnectionId).toBe("conn-1");
  });

  // §4-pin (W12-FIX2 §4, codex W12-FIX review #4): intentional NO-ACTION —
  // `unsupported` (the provider isn't oauth) dominates connectionId validation
  // by design; pinned so the precedence question isn't re-litigated later.
  // Green-at-base: this is an intent pin, not a fix.
  it("§4-pin support-precedence: unsupported wins over a bogus connectionId for a non-oauth provider", async () => {
    const deps = oauthDeps();
    const res = await handleOAuthStart(deps, { providerId: "z-ai", connectionId: "missing" });
    expect(res).toEqual({ ok: false, reason: "unsupported" });
    expect(runner.lastConnectionId).toBeUndefined();
  });
});

// ── TASK.45 W12: connection-CRUD write path, custody, alias-free, refine-reject ──

describe("connection CRUD write-path end-to-end (W12, DoD item 4 replacement — no legacy key anywhere)", () => {
  it("create connection → secret-set by connection id → snapshot: active, secret ONLY under the connection key, ready", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    // (1) create+activate a connection through the connection-create CRUD channel.
    const created = await handleConnectionCreate(deps, { providerId: "z-ai", model: "glm-4.6" });
    expect(created.ok).toBe(true);
    const conn = created.ok ? created.snapshot.settings.provider.connections[0] : undefined;
    expect(conn?.providerId).toBe("z-ai");

    // (2) write the credential through secret-set, keyed DIRECTLY by connection id.
    const setRes = await handleSetSecret(deps, { key: `provider.connection.${conn?.id}.apiKey`, value: SECRET_VALUE });
    expect(setRes.ok).toBe(true);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections).toHaveLength(1);
    expect(loaded.settings.provider.activeConnectionId).toBe(conn?.id);

    // The secret lives ONLY under the connection key; no legacy form anywhere.
    expect(vault.store.get(`provider.connection.${conn?.id}.apiKey`)).toBe(SECRET_VALUE);
    expect(vault.store.has("provider.z-ai.apiKey")).toBe(false);
    expect(vault.store.has("provider.apiKey")).toBe(false);
    expect([...vault.store.keys()]).toEqual([`provider.connection.${conn?.id}.apiKey`]);

    // No alias projection: the snapshot's secrets carry ONLY the connection key
    // (plus the vault's own static `provider.apiKey` allow-list entry, unset).
    const snap = await buildSettingsSnapshot(deps);
    expect(snap.secrets.some((s) => s.key === "provider.z-ai.apiKey")).toBe(false);
    expect(snap.secrets.find((s) => s.key === `provider.connection.${conn?.id}.apiKey`)?.set).toBe(true);
    // The readiness gate reads the connection key -> providerReady flips true.
    expect(snap.providerReady).toBe(true);
  });

  it("negative: a legacy-shaped secret-set never reaches the vault at all (refused invalid, not translated)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    const res = await handleSetSecret(deps, { key: "provider.apiKey", value: SECRET_VALUE });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(vault.store.size).toBe(0);
    expect((await loadSettings(settingsPath)).settings.provider.connections).toEqual([]);
  });
});

// ── TASK.45 W12-FIX2 §1: connection-create returns the authoritative minted id ──

describe("handleConnectionCreate — createdConnectionId (W12-FIX2 §1, codex W12-FIX review #1)", () => {
  // §1.1 — hits ONLY the handler layer: the id is already in the handler's hand
  // (`genConnectionId`) before persistProvider ever runs. Reverting the hunk that
  // threads it onto the ok-result turns this red — the field is simply absent.
  it("§1.1 ok-result carries createdConnectionId, equal to the minted connection's id in the snapshot", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    const res = await handleConnectionCreate(deps, { providerId: "z-ai", model: "glm-4.6" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.createdConnectionId).toBe("conn-1");
      expect(res.snapshot.settings.provider.connections.map((c) => c.id)).toEqual(["conn-1"]);
    }
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
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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
    await handleSetSecret(makeDeps({ catalogIds: CATALOG_IDS }), { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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

// ── TASK.45 W12-FIX §2: auto-promote a successor when the ACTIVE connection is deleted (codex W12 review #2) ──

describe("handleConnectionDelete — auto-promotes a successor when the ACTIVE connection is deleted (W12-FIX §2)", () => {
  // §2.1 — the core fix: reverting `remaining[0]?.id` back to `undefined`
  // turns this red (active would be cleared instead of promoted).
  it("§2.1 deleting the active connection promotes the first REMAINING connection (array order)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleConnectionCreate(deps, { providerId: "z-ai" }); // conn-1 (A, active by default)
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-2 (B)
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-2");
  });

  // §2.2 — deleting a NON-active connection must not touch active (regress).
  it("§2.2 deleting a non-active connection leaves active untouched", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleConnectionCreate(deps, { providerId: "z-ai" }); // conn-1 (A, active)
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-2 (B)
    const res = await handleConnectionDelete(deps, { id: "conn-2" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-1");
  });

  // §2.3 — deleting the LAST connection still clears active (no successor to promote).
  it("§2.3 deleting the only remaining connection clears active (no successor)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleConnectionCreate(deps, { providerId: "z-ai" }); // conn-1 (active, only connection)
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.activeConnectionId).toBeUndefined();
  });

  // §2.4 — the W10-FIX F3 abort guard (both legs) must still leave active
  // completely untouched — the promotion logic must never run on an aborted
  // delete (existing W10-FIX assertions above are NOT edited by this test).
  it("§2.4 an ABORTED delete (connection_in_use, early guard) never promotes — active untouched", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS, connectionInUse: (id) => id === "conn-1" });
    await handleConnectionCreate(deps, { providerId: "z-ai" }); // conn-1 (A, active)
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-2 (B)
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-1");
    expect(loaded.settings.provider.connections).toHaveLength(2);
  });

  it("§2.4b an ABORTED delete (connection_in_use, LATE re-check) never promotes — active untouched", async () => {
    let calls = 0;
    const connectionInUse = (id: string): boolean => {
      calls += 1;
      return id === "conn-1" && calls >= 2;
    };
    const deps = makeDeps({ catalogIds: CATALOG_IDS, connectionInUse });
    await handleConnectionCreate(deps, { providerId: "z-ai" }); // conn-1 (A, active)
    await handleConnectionCreate(deps, { providerId: "acme" }); // conn-2 (B)
    const res = await handleConnectionDelete(deps, { id: "conn-1" });
    expect(res).toEqual({ ok: false, reason: "connection_in_use" });
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.activeConnectionId).toBe("conn-1");
    expect(loaded.settings.provider.connections).toHaveLength(2);
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

describe("handleConnectionDelete — tombstone commit point is the durable save, not the composite resolve (W11-FIX3)", () => {
  it("does NOT revert the tombstone when the post-save snapshot leg throws AFTER a successful durable save (vault leg)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const setupDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(setupDeps, { providerId: "acme" }); // conn-1

    const deleteDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
      vault: new FailingStatusesVault(vault),
    });
    await expect(handleConnectionDelete(deleteDeps, { id: "conn-1" })).rejects.toThrow();

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections).toHaveLength(0);
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    expect(oauth.reverted).toEqual([]);
  });

  it("does NOT revert the tombstone when the post-save emit leg throws AFTER a successful durable save (emit leg)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const setupDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(setupDeps, { providerId: "acme" }); // conn-1

    const failingOnMutation = vi.fn().mockRejectedValue(new Error("window destroyed mid-delete"));
    const deleteDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
      onMutation: failingOnMutation,
    });
    await expect(handleConnectionDelete(deleteDeps, { id: "conn-1" })).rejects.toThrow();

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections).toHaveLength(0);
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    expect(oauth.reverted).toEqual([]);
  });

  it("DOES revert the tombstone when the durable save itself throws (guard: reverse side of the invariant)", async () => {
    const oauth = new FakeOAuthRunner(vault);
    const setupDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await handleConnectionCreate(setupDeps, { providerId: "acme" }); // conn-1

    saveSettingsControl.failNext(new Error("disk full"));
    const deleteDeps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
      oauth,
    });
    await expect(handleConnectionDelete(deleteDeps, { id: "conn-1" })).rejects.toThrow();

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections).toHaveLength(1);
    expect(oauth.markedDeleting).toEqual(["conn-1"]);
    expect(oauth.reverted).toEqual(["conn-1"]);
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

  it("persists {status: ready} with no safeCode for a success event, resolving true (a write actually landed)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T00:00:00.000Z" });

    await expect(applyConnectionHealthEvent(deps, "conn-1", { kind: "success" })).resolves.toBe(true);

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.settings.provider.connections[0]?.lastHealth).toEqual({
      status: "ready",
      at: "2026-07-15T00:00:00.000Z",
    });
  });

  it("is a race-safe no-op when the connection was deleted mid-flight, resolving false", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    await handleConnectionDelete(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1" });
    const deps = makeDeps({ catalogIds: CATALOG_IDS });

    await expect(applyConnectionHealthEvent(deps, "conn-1", { kind: "success" })).resolves.toBe(false);
    expect((await loadSettings(settingsPath)).settings.provider.connections).toEqual([]);
  });

  it("is a no-op when settings.json is read-only (newer version than CURRENT), resolving false", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 3,
        provider: { connections: [{ id: "conn-1", providerId: "z-ai" }] },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
    const deps = makeDeps({ catalogIds: CATALOG_IDS });

    await expect(applyConnectionHealthEvent(deps, "conn-1", { kind: "success" })).resolves.toBe(false);
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

    const res = await handleSetSecret(deps, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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
    await handleSetSecret(deps, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" }); // ready

    const res = await handleClearSecret(deps, { key: "provider.connection.conn-1.apiKey" });
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

    const res = await handleSetSecret(deps, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
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

// ── TASK.45 W12-FIX §3: `""`-sentinel clears transport back to catalog default (codex W12 review #3) ──

describe('handleConnectionUpdate — ""-sentinel clears transport (W12-FIX §3)', () => {
  // §3.1 — the handler layer: reverting either the zod union (`""` refused
  // `invalid`) or the normalize-before-persist step turns this red.
  it('§3.1 update {transport:""} on an explicit transport clears it: no `transport` key on disk, health resets', async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS, now: () => "2026-07-15T04:00:00.000Z" });
    await handleConnectionCreate(deps, { providerId: "z-ai", model: "glm-4.5", transport: "openai-chat-completions" }); // conn-1
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" });

    const res = await handleConnectionUpdate(deps, { id: "conn-1", transport: "" });
    expect(res.ok).toBe(true);

    // Disk guard (anti-regression on the persisted schema): raw file content,
    // not a snapshot projection — the `""` sentinel must NEVER be written,
    // and the key must be absent entirely (not merely `transport: undefined`).
    const raw = await readFile(settingsPath, "utf8");
    expect(raw).not.toContain('"transport"');
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.transport).toBeUndefined();
    expect(loaded.settings.provider.connections[0]?.lastHealth?.status).toBe("unchecked");
  });

  // §3.2 — normalization: clearing an ALREADY-absent transport is a true
  // no-op for health (a naive `req.transport !== undefined` comparison,
  // instead of comparing the NORMALIZED value against `existing.transport`,
  // would wrongly reset health here).
  it('§3.2 update {transport:""} when transport was already absent is a health no-op', async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleConnectionCreate(deps, { providerId: "z-ai", model: "glm-4.5" }); // conn-1, no transport
    await applyConnectionHealthEvent(deps, "conn-1", { kind: "success" });

    const res = await handleConnectionUpdate(deps, { id: "conn-1", transport: "" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.transport).toBeUndefined();
    expect(loaded.settings.provider.connections[0]?.lastHealth?.status).toBe("ready");
  });

  // §3.4 — regress: omitting transport entirely on update keeps the old value.
  it("§3.4 update WITHOUT the transport field keeps the existing transport (regress)", async () => {
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleConnectionCreate(deps, { providerId: "z-ai", model: "glm-4.5", transport: "openai-responses" }); // conn-1
    const res = await handleConnectionUpdate(deps, { id: "conn-1", label: "Work" });
    expect(res.ok).toBe(true);
    const loaded = await loadSettings(settingsPath);
    expect(loaded.settings.provider.connections[0]?.transport).toBe("openai-responses");
  });
});

describe("handleConnectionCheck — probe (TASK.45 W11)", () => {
  it("with NO probe wired (default), behaves byte-identically to the W9 scaffold: no network call, health untouched", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    await handleSetSecret(deps, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });

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
    await handleSetSecret(bootstrap, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });

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
    await handleSetSecret(bootstrap, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE });
    const probeConnection = vi.fn<(...args: unknown[]) => Promise<ConnectionProbeOutcome>>().mockResolvedValue({ ok: true });
    const deps = makeDeps({ catalogIds: CATALOG_IDS, probeConnection });

    await handleConnectionCheck(deps, { id: "conn-1" });

    expect(probeConnection).toHaveBeenCalledTimes(1);
  });
});

// ── OAuth prep still finds the ACTIVE connection of a provider bucket (§4.3) ──
// `findOrCreateConnectionByProvider`/`bucketConnection` survive the W12
// write-seam removal (they are NOT part of the retired shim — OAuth prep is the
// one remaining caller, cut §4.3/§8 "downstream W10/W11: без изменений").

describe("handleOAuthStart routes to the ACTIVE connection of a provider bucket, not first-match", () => {
  it("threads the ACTIVE connection id to the engine when two connections share a provider", async () => {
    const runner = new FakeOAuthRunner(vault);
    const deps = makeDeps({
      catalogIds: CATALOG_IDS,
      authKindFor: (id) => (id === "acme" ? "oauth" : undefined),
      oauth: runner,
      oauthConfigFor: (id) => (id === "acme" ? OAUTH_CONFIG : undefined),
    });
    await handleConnectionCreate(deps, { providerId: "acme", model: "m" }); // conn-1 (first ⇒ active by default)
    await handleConnectionCreate(deps, { providerId: "acme", model: "m", setActive: true }); // conn-2 (now active)
    const res = await handleOAuthStart(deps, { providerId: "acme" });
    expect(res.ok).toBe(true);
    expect(runner.lastConnectionId).toBe("conn-2");
  });
});

// ── W9′-FIX #2: settings mutation lock (§2.3) ──

describe("W9′-FIX #2 — settings mutation lock (§2.3)", () => {
  it("serializes concurrent connection-update ‖ secret-set on the same connection — neither write is lost (TASK.45 W12 shape)", async () => {
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai" }); // conn-1
    const deps = makeDeps({ catalogIds: CATALOG_IDS });
    ipcGate.arm();
    const p = Promise.all([
      handleConnectionUpdate(deps, { id: "conn-1", model: "USER-MODEL" }),
      handleSetSecret(deps, { key: "provider.connection.conn-1.apiKey", value: SECRET_VALUE }),
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
    // The metadata edit survives — not clobbered by the racing secret write.
    expect(loaded.settings.provider.connections[0]?.model).toBe("USER-MODEL");
    // The secret landed on the connection (no orphan / no desync).
    expect(vault.store.get("provider.connection.conn-1.apiKey")).toBe(SECRET_VALUE);
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

// W9′-FIX #3 ("refusal rollback") retired with the write-seam (TASK.45 W12):
// a secret-set can no longer mint a connection at all (connection-create is a
// separate, prior step), so there is nothing left to roll back — the
// not-yet-created-connection state W9′-FIX #4 below tests (`not_found`) is
// the direct replacement.

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
  it("rejects an invalid transport enum in connection-update (invalid) and leaves settings.json intact (no quarantine)", async () => {
    // Seed a valid baseline, capture its bytes.
    await handleConnectionCreate(makeDeps({ catalogIds: CATALOG_IDS }), { providerId: "z-ai", model: "glm-4.6" }); // conn-1
    const before = await readFile(settingsPath, "utf8");

    const res = await handleConnectionUpdate(makeDeps({ catalogIds: CATALOG_IDS }), { id: "conn-1", transport: "bogus" });
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

// ── TASK.45 W12 gate: the legacy write-seam is FULLY retired, not just unused ──
// (metadata-shim + secret-write-translation + alias-projection, cut §4.4/§8 —
// "снимаются одним пунктом"). A mechanical grep, not just behavioral tests, so
// a future edit can't quietly resurrect a dead symbol name without this
// failing — the retired names must never reappear in EITHER file's source text.

describe("legacy write-seam retirement — mechanical source-text gate (TASK.45 W12)", () => {
  const RETIRED_SYMBOLS = [
    "applyLegacyProviderPatch",
    "LegacyProviderPatch",
    "translateSecretKey",
    "legacyAliasKey",
    "projectAliasStatus",
    "legacyProviderPatchSchema",
    "hasLegacyFieldEdit",
  ];

  it("settings-ipc.ts contains none of the retired shim/translation/alias symbol names", async () => {
    const source = await readFile(new URL("./settings-ipc.ts", import.meta.url), "utf8");
    for (const symbol of RETIRED_SYMBOLS) {
      expect(source).not.toContain(symbol);
    }
  });

  it("shared/settings.ts contains none of the retired symbol names either (the type itself is gone)", async () => {
    const source = await readFile(new URL("../shared/settings.ts", import.meta.url), "utf8");
    for (const symbol of RETIRED_SYMBOLS) {
      expect(source).not.toContain(symbol);
    }
    // SettingsPatch no longer carries a `provider` sub-shape at all.
    expect(source).not.toContain("provider?: LegacyProviderPatch");
  });

  it("findOrCreateConnectionByProvider/bucketConnection survive (OAuth prep's own use, NOT part of the retired shim)", async () => {
    const source = await readFile(new URL("./settings-ipc.ts", import.meta.url), "utf8");
    expect(source).toContain("findOrCreateConnectionByProvider");
    expect(source).toContain("bucketConnection");
  });
});

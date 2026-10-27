/**
 * Production-wiring regression test (FX4, Fable iter-7 ruling): proves that a
 * `custom:*` connection created through the REAL IPC chain — custom-provider-
 * create -> connection-create -> tab-create — is actually spawnable, i.e. that
 * main/index.ts's `activeCredential`/`selectedTransportInfo` route a
 * `custom:*` providerId correctly and that the module-level `providerReady`
 * flip (`refreshProviderState`, wired as `onMutation`) reaches
 * `TabHostManager.isEngineReady`.
 *
 * Before FX4, `activeCredential` read the active connection's
 * `provider.connection.<id>.apiKey` for EVERY providerId (never the custom
 * provider's own `provider.<custom-id>.apiKey`), and `selectedTransportInfo`
 * fell through to the generic no-catalog-entry branch for any `custom:*` id
 * (no supported-transport guard, `authOptional` always false). Both defects
 * made `computeProviderReady` return false forever for a fully-configured
 * custom provider, so `tab-create` refused every "new" request with
 * `not_ready` — the feature was wired end-to-end everywhere except the
 * readiness gate. settings-ipc.test.ts's mirror-module unit tests prove the
 * SAME defect in the renderer-facing `settings:get` snapshot; this file
 * proves it against the actual gate a tab-create request hits, fed by the
 * REAL `refreshProviderState()` — not an injected `providerReady` stub, which
 * would make the assertion tautological.
 *
 * Boots main/index.ts for real off a scratch settings/secrets/`:memory:` DB
 * profile, exactly like index.appVersion-wiring.test.ts (see that file for
 * why main/index.ts can only ever be exercised this way).
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_CREATE_CHANNEL } from "../shared/settings.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { TAB_CREATE_CHANNEL, TAB_REBIND_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";

// GitHub #19: main now installs its application menu inside `app.whenReady()`
// and then continues through the ENTIRE boot chain (window, updater, services).
// These wiring tests boot the real module, so they get headroom over the 5 s
// default that the full suite's parallel load can exceed.
vi.setConfig({ testTimeout: 15_000 });


// Not statically imported from ./provider-ipc.js: that module chain-imports
// "electron" too, and a top-level import of it here resolves before this
// file's own `vi.mock("electron", ...)` factory has finished hoisting,
// throwing "Cannot access 'FakeBrowserWindow' before initialization" (same
// reason ./index.js itself is only ever dynamically imported inside each
// `it` below). Duplicated literal — provider-ipc.ts holds the source of
// truth — same "duplicated on purpose" convention as index.appVersion-
// wiring.test.ts.
const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
type CustomProviderMutationResult =
  | { ok: true; providers: Array<{ id: string }> }
  | { ok: false; reason: string };

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so the capturing map exists before vi.mock's hoisted factory
// below closes over it (same pattern as index.appVersion-wiring.test.ts).
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
}));

/**
 * Fake `UtilityProcess` returned by the mocked `utilityProcess.fork` — real
 * enough for `TabHostManager.spawnTabHost`/`deliverTabPort` to run their real
 * code (`.on`/`.once`/`.postMessage`/`.kill`) without ever spawning a real
 * process. No test here drives spawn/exit/message events; the handlers just
 * need somewhere harmless to register.
 */
class FakeHostProcess {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
  on = vi.fn(() => this);
  once = vi.fn(() => this);
}

/**
 * Minimal fake BrowserWindow: accepts every call createWindow()/
 * wireWindowStateEvents()/TabHostManager.deliverTabPort make, fires nothing.
 * A superset of index.appVersion-wiring.test.ts's copy — deliverTabPort
 * additionally needs `isDestroyed()` and `webContents.postMessage()`.
 */
class FakeBrowserWindow {
  webContents = { on: vi.fn(), send: vi.fn(), postMessage: vi.fn() };
  on = vi.fn();
  isMaximized = vi.fn(() => false);
  isFullScreen = vi.fn(() => false);
  isDestroyed = vi.fn(() => false);
  loadFile = vi.fn(async () => undefined);
  loadURL = vi.fn(async () => undefined);
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0-test",
    getAppPath: () => "/fake/app",
    getPath: () => "/fake/userdata",
    setPath: vi.fn(),
    dock: undefined,
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  // GitHub #19: main installs an explicit application menu inside
  // app.whenReady(); a wiring test must provide the primitives it touches.
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
    getApplicationMenu: vi.fn(() => null),
  },
  dialog: {
    showOpenDialogSync: vi.fn(() => undefined),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
  },
  utilityProcess: {
    fork: vi.fn(() => new FakeHostProcess()),
  },
  ipcMain: {
    handle: (channel: string, listener: IpcHandler): void => {
      ipcHandlers.set(channel, listener);
    },
    // panel-track CUT.md D9 (TASK.96 96-P1): registerPreviewPanelIpc's
    // SET_BOUNDS channel is the first main-process user of `ipcMain.on`
    // (one-way, no reply) — this file's real-index.ts boot reaches it too,
    // so the mock needs a harmless no-op capture, not just `.handle`.
    on: vi.fn(),
  },
}));

// electron-updater is CJS-interop default-imported in index.ts; registerUpdater
// (real, kept unmocked) never touches this when `app.isPackaged` is false
// (updater.ts's own documented gate), so an inert stub is enough.
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
    },
  },
}));

// Codex discovery/doctor is real subprocess probing — genuinely external and
// non-deterministic, and irrelevant to the readiness-gate wiring this file
// tests. Mocked to a fast, side-effect-free controller.
vi.mock("./codex-ipc.js", () => ({
  ENGINES_CHANGED_CHANNEL: "anycode:engines-changed",
  registerCodexIpc: vi.fn(() => ({
    recheck: vi.fn(async () => ({})),
    pickBinary: vi.fn(async () => ({ ok: false })),
    loginStart: vi.fn(async () => ({ ok: false })),
    loginCancel: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  })),
}));

let dir: string;

/** Polls the captured ipcMain.handle registrations until `channel` appears (main's whenReady callback is async). */
async function waitForHandler(channel: string, timeoutMs = 5000): Promise<IpcHandler> {
  const start = Date.now();
  for (;;) {
    const handler = ipcHandlers.get(channel);
    if (handler !== undefined) return handler;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `ipcMain.handle(${channel}) was never registered within ${timeoutMs}ms — main/index.ts's ` +
          `app.whenReady() callback did not reach the registration (see stderr above for the real cause).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  ipcHandlers.clear();
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-providerready-"));
  // Dev-profile isolation lever (main/dev-profile.ts, gated on !isPackaged):
  // redirects settings.json/secrets.json off the developer's real ~/.anycode
  // without needing to mock loadSettings/Vault at all.
  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = join(dir, "settings.json");
  process.env.ANYCODE_SECRETS_PATH = join(dir, "secrets.json");
  // Ungated main/index.ts lever straight off ANYCODE_DB_PATH — `:memory:` keeps
  // persistence.listSessions()/the worktree janitor pass instant and inert.
  process.env.ANYCODE_DB_PATH = ":memory:";
  delete process.env.ANYCODE_API_KEY;
  delete process.env.ANYCODE_USER_DATA_DIR;
  delete process.env.ANYCODE_WORKSPACE;
  delete process.env.ANYCODE_RESUME;
  delete process.env.ELECTRON_RENDERER_URL;
  // `declare const __ANYCODE_DEV_AUTOMATION__` is an electron-vite build-time
  // `define`, never materialized under vitest — without this, index.ts's dev-
  // automation-server gate throws ReferenceError deep inside the whenReady
  // callback (an unhandled rejection this file must not risk).
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;
});

afterEach(async () => {
  delete process.env.ANYCODE_AUTOMATION;
  delete process.env.ANYCODE_SETTINGS_PATH;
  delete process.env.ANYCODE_SECRETS_PATH;
  delete process.env.ANYCODE_DB_PATH;
  delete process.env.ANYCODE_API_KEY;
  // The previous boot's async tail can still be writing under `dir` while rm
  // walks it (observed as ENOTEMPTY on loaded CI runners); node's built-in
  // retry re-walks the tree until the tail settles.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("main/index.ts — custom:* readiness-gate wiring (FX4)", () => {
  it("TASK.152: a bare custom sentinel connection with authOptional + model (no key) is spawnable — the gate honours the connection's own declaration", async () => {
    // The live incident shape verbatim: providerId "custom" (the bare catalog
    // sentinel, NOT a custom:<slug> record), model set, authOptional true, no
    // baseUrl, no key anywhere. The custom catalog entry's default transport
    // is anthropic-messages, so the transport-level authOptional stays false
    // — only the connection's own declaration (projected through
    // activeProviderView into selectedTransportInfo/computeProviderReadiness)
    // can waive the key. Pre-TASK.152 the module-level providerReady gate
    // stayed false and tab-create refused not_ready with the generic
    // "Configure a provider" copy.
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        version: 2,
        provider: {
          connections: [{ id: "conn-1", providerId: "custom", model: "m", authOptional: true }],
          activeConnectionId: "conn-1",
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );

    await import("./index.js");
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;

    expect(tabResult.ok).toBe(true);
    if (!tabResult.ok) {
      expect((tabResult as { reason: string }).reason).not.toBe("not_ready");
    }
  });


  it("a custom:* connection with its OWN key, made active, is spawnable — tab-create does NOT refuse not_ready", async () => {
    await import("./index.js");

    const handleCustomCreate = await waitForHandler(CUSTOM_PROVIDER_CREATE_CHANNEL);
    const handleConnectionCreate = await waitForHandler(CONNECTION_CREATE_CHANNEL);
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);

    const created = (await handleCustomCreate({}, {
      name: "My Anthropic-compatible endpoint",
      baseUrl: "https://bridge.example.com",
      kind: "anthropic",
      apiKey: "sk-real-wiring-key",
    })) as CustomProviderMutationResult;
    if (!created.ok) {
      throw new Error(`setup failed: custom-provider-create returned ${JSON.stringify(created)}`);
    }
    const customId = created.providers[0]?.id;
    expect(customId).toBeDefined();

    // First connection ever created auto-activates (settings-ipc.ts
    // handleConnectionCreate) — this is the connection tab-create's "new"
    // path pins the session to (main/tab-ipc.ts's `activeConnectionId`).
    const connectionResult = (await handleConnectionCreate({}, {
      providerId: customId,
      model: "claude-bridge-model",
    })) as SettingsMutationResult;
    expect(connectionResult).toMatchObject({ ok: true });

    // onMutation already ran refreshProviderState() synchronously inside the
    // handler above (main/index.ts's settingsIpcDeps.onMutation) — the
    // module-level `providerReady` TabHostManager reads is live BEFORE this
    // call, not something this test has to poll for.
    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;

    expect(tabResult.ok).toBe(true);
    if (!tabResult.ok) {
      // Only reached on failure — surfaces WHICH refusal reason regressed.
      expect((tabResult as { reason: string }).reason).not.toBe("not_ready");
    }
  });

  it("W4-R3-1: a dangling custom:* connection (record deleted, credential orphaned) is fail-closed — tab-create refuses not_ready", async () => {
    // Pre-seed a settings.json whose ACTIVE connection names a custom:* provider
    // whose RECORD is gone (deleted via the generic settings-patch channel, which
    // skips handleCustomProviderDelete's clear-first ordering). ANYCODE_API_KEY
    // stands in for the orphaned credential the R3-1 finding calls out — it
    // short-circuits apiKeyReady in the boot snapshot exactly as a leftover vault
    // key would. NO transport is selected (env + connection both leave it unset),
    // so before the fix selectedTransportInfo fell through to the generic branch
    // with supportedTransports=undefined, computeProviderReady SKIPPED its
    // transport guard, and providerReady was wrongly true — tab-create spawned a
    // fork buildHostEnv can no longer supply a baseUrl or key for.
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        version: 2,
        provider: {
          connections: [{ id: "conn-1", providerId: "custom:gone", model: "m" }],
          activeConnectionId: "conn-1",
          custom: [],
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );
    process.env.ANYCODE_API_KEY = "sk-orphan-env";

    await import("./index.js");
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;

    expect(tabResult.ok).toBe(false);
    if (!tabResult.ok) {
      expect((tabResult as { reason: string }).reason).toBe("not_ready");
    }
  });

  it("TASK.109: resume of a session pinned to a live-but-dead connection opens the tab — the rebind escape stays reachable", async () => {
    // The card's frame (Taskana 4103): a session pinned to a connection whose
    // KEY/QUOTA is dead while the connection itself is still configured.
    // `resolveResumePin` (main/index.ts) only checks EXISTENCE, and the resume
    // gate answers from the ACTIVE connection's readiness — so this resume
    // must NOT be refused (`connection_missing`/`not_ready`): the tab opens
    // and the model-chip rebind (TASK.106 cut 2) is the escape. The code-side
    // half of the card's demanded live smoke; the full ~90k-token replay
    // against real connections remains an owner action.
    const dbPath = join(dir, "anycode.sqlite");
    // The beforeEach default is `:memory:` — a real file DB lets this test
    // seed a session row BEFORE main/index.ts boots.
    process.env.ANYCODE_DB_PATH = dbPath;

    // Seed BEFORE `await import("./index.js")` (same pattern as
    // checkpoints-rewind-wire.test.ts): a session pinned to conn-dead.
    const { SqlitePersistenceAdapter } = await import("@anycode/core/persistence");
    const store = new SqlitePersistenceAdapter(dbPath);
    await store.createSession({ id: "s-t109", workspace: dir, model: "m", mode: "build" });
    await store.touchSession("s-t109", { connectionId: "conn-dead" });
    await store.close();

    // TWO keyless-legal connections (TASK.152's authOptional rule): conn-live
    // ACTIVE and healthy; conn-dead configured but classified quota-dead —
    // `rate_limited` is the classified signal (settings-ipc.ts), advisory only.
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        version: 2,
        provider: {
          connections: [
            { id: "conn-live", providerId: "custom", model: "m", authOptional: true },
            {
              id: "conn-dead",
              providerId: "custom",
              model: "m",
              authOptional: true,
              lastHealth: { status: "rate_limited", at: "2026-10-01T00:00:00.000Z" },
            },
          ],
          activeConnectionId: "conn-live",
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );

    await import("./index.js");
    const resume = await waitForHandler(TAB_CREATE_CHANNEL);
    const res = (await resume({}, { kind: "resume", sessionId: "s-t109" })) as CreateTabResult;

    // The tab OPENS — never `connection_missing` (the connection exists) and
    // never `not_ready` (the gate answers from the ACTIVE connection).
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error(`resume of a live-but-dead pin was refused: ${JSON.stringify(res)}`);
    }

    // Drive the escape's first hop: the rebind channel is wired and its guard
    // chain runs against the real registry. Accept `busy` (the fake
    // utilityProcess.fork host never reaches a running-port state) or `ok` —
    // either proves the channel is live; `unknown_tab`/`connection_missing`
    // would mean the escape is unreachable. The respawned host's full history
    // replay needs a real host — out of scope (owner live smoke).
    const rebind = await waitForHandler(TAB_REBIND_CHANNEL);
    const r2 = (await rebind({}, {
      tabId: (res as { tabId: string }).tabId,
      connectionId: "conn-live",
    })) as { ok: boolean; reason?: string };
    if (r2.ok) {
      // ok:true — the rebind fully completed against the real registry.
    } else {
      expect(r2.reason).not.toBe("unknown_tab");
      expect(r2.reason).not.toBe("connection_missing");
    }

    // The OLD pin survived untouched: re-read settings.json from disk —
    // re-pin/rebind never rewrote settings (only the session row's pin
    // moved); conn-dead is still there with its lastHealth intact and
    // conn-live is still the active connection.
    const rawSettings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
      provider: {
        connections: Array<{ id: string; lastHealth?: { status: string; at: string } }>;
        activeConnectionId: string;
      };
    };
    const connDead = rawSettings.provider.connections.find((c) => c.id === "conn-dead");
    expect(connDead).toBeDefined();
    expect(connDead?.lastHealth).toEqual({ status: "rate_limited", at: "2026-10-01T00:00:00.000Z" });
    expect(rawSettings.provider.activeConnectionId).toBe("conn-live");
  });
});

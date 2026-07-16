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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_CREATE_CHANNEL } from "../shared/settings.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { TAB_CREATE_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";

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
  await rm(dir, { recursive: true, force: true });
});

describe("main/index.ts — custom:* readiness-gate wiring (FX4)", () => {
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
});

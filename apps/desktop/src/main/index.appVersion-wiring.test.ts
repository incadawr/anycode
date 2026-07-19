/**
 * Production-wiring regression test (W14-fix, TASK.49/TASK.47): proves that
 * `main/index.ts` — not just settings-ipc.ts's injectable deps bag — really
 * wires `app.getVersion()` into `SettingsIpcDeps.getAppVersion`, and that the
 * value reaches the `settings:get` snapshot the renderer's About panel reads
 * (`SettingsScreen.tsx`'s `snapshot.appVersion`).
 *
 * settings-ipc.test.ts already proves `handleGet`/`handleSet` respect an
 * INJECTED `getAppVersion` (or its absence) — it never imports main/index.ts,
 * so it cannot catch main/index.ts's actual wiring silently regressing (e.g.
 * the `getAppVersion: () => app.getVersion()` line being deleted from
 * `settingsIpcDeps`). That gap is exactly the discriminating hole this file
 * closes: every assertion below fails if that one line disappears, while
 * every other test in the repo stays green.
 *
 * main/index.ts is a top-level Electron module that runs its entire body on
 * import (boot-tree.test.ts calls it "un-importable" for this reason). This
 * test earns the import by mocking every Electron primitive plus the two
 * genuinely external/non-deterministic dependencies (Codex discovery,
 * electron-updater's singleton) and letting `app.whenReady()` resolve so its
 * callback runs for real — persistence, settings-ipc, host-env, and the tab/
 * window/mcp/skills/subagents/profile IPC registrations all run their REAL
 * code, unmocked, against a scratch `:memory:` DB and a scratch settings/
 * secrets directory (via the `ANYCODE_AUTOMATION=1` dev-profile override
 * lever — main/dev-profile.ts — so this never touches the developer's real
 * `~/.anycode`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_CREATE_CHANNEL, SETTINGS_GET_CHANNEL } from "../shared/settings.js";
import type { SettingsMutationResult, SettingsSnapshot } from "../shared/settings.js";

// Not statically imported from ./provider-ipc.js: that module chain-imports
// "electron" too, and a top-level import of it here resolves before this
// file's own `vi.mock("electron", ...)` factory has finished hoisting,
// throwing "Cannot access 'FakeBrowserWindow' before initialization" (same
// reason ./index.js itself is only ever dynamically imported inside each
// `it` below). Duplicated literal — provider-ipc.ts holds the source of
// truth — same "duplicated on purpose" convention as every other channel
// name in preload/index.ts.
const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
type CustomProviderMutationResult =
  | { ok: true; providers: Array<{ id: string }> }
  | { ok: false; reason: string };

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so the capturing map exists before vi.mock's hoisted factory
// below closes over it (same pattern as window-ipc.test.ts).
const { ipcHandlers, mockAppGetVersion } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  mockAppGetVersion: { current: () => "0.0.0-unset" as string },
}));

/** Minimal fake BrowserWindow: accepts every call createWindow()/wireWindowStateEvents() make, fires nothing. */
class FakeBrowserWindow {
  webContents = { on: vi.fn(), send: vi.fn() };
  on = vi.fn();
  isMaximized = vi.fn(() => false);
  isFullScreen = vi.fn(() => false);
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
    // Reads through a ref cell so each test can repoint the mocked version
    // AFTER import (index.ts wires `() => app.getVersion()`, a closure —
    // it re-reads at call time, exactly like the real Electron `app`).
    getVersion: (): string => mockAppGetVersion.current(),
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
    fork: vi.fn(),
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
// non-deterministic, and irrelevant to the getAppVersion wiring this file
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
          `app.whenReady() callback did not reach registerSettingsIpc (see stderr above for the real cause).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  ipcHandlers.clear();
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-boot-"));
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
  // The previous boot's async tail can still be writing under `dir` while rm
  // walks it (observed as ENOTEMPTY on loaded CI runners); node's built-in
  // retry re-walks the tree until the tail settles.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("main/index.ts — getAppVersion production wiring (TASK.49)", () => {
  it("boots the real settingsIpcDeps wiring and answers settings:get with app.getVersion()'s live value", async () => {
    mockAppGetVersion.current = () => "9.9.9-wiring-proof";

    await import("./index.js");

    const handleSettingsGet = await waitForHandler(SETTINGS_GET_CHANNEL);
    const snapshot = (await handleSettingsGet({})) as SettingsSnapshot;

    expect(snapshot.appVersion).toBe("9.9.9-wiring-proof");
  });

  it("tracks a repointed app.getVersion() on a second boot (not a hardcoded string)", async () => {
    mockAppGetVersion.current = () => "1.2.3-second-boot";

    await import("./index.js");

    const handleSettingsGet = await waitForHandler(SETTINGS_GET_CHANNEL);
    const snapshot = (await handleSettingsGet({})) as SettingsSnapshot;

    expect(snapshot.appVersion).toBe("1.2.3-second-boot");
  });
});

describe("main/index.ts — custom-provider IPC production wiring (TASK.54, FX2-4)", () => {
  it("wires registerProviderIpc so anycode:custom-provider-create is actually reachable", async () => {
    await import("./index.js");

    const handleCreate = await waitForHandler(CUSTOM_PROVIDER_CREATE_CHANNEL);
    const result = (await handleCreate({}, {
      name: "Local vLLM",
      baseUrl: "https://example.com",
      kind: "openai-compatible",
      apiKey: "sk-test-key",
    })) as CustomProviderMutationResult;

    expect(result.ok).toBe(true);
  });

  it("recognizes a just-created custom provider id as a valid connection providerId with no restart (catalogIds union is live, not a boot-time snapshot)", async () => {
    await import("./index.js");

    const handleCreate = await waitForHandler(CUSTOM_PROVIDER_CREATE_CHANNEL);
    const handleConnectionCreate = await waitForHandler(CONNECTION_CREATE_CHANNEL);

    const created = (await handleCreate({}, {
      name: "Local vLLM",
      baseUrl: "https://example.com",
      kind: "openai-compatible",
      apiKey: "sk-test-key",
    })) as CustomProviderMutationResult;
    if (!created.ok) {
      throw new Error(`setup failed: custom-provider-create returned ${JSON.stringify(created)}`);
    }
    const customId = created.providers[0]?.id;
    expect(customId).toBeDefined();

    // Pre-fix, `settingsIpcDeps.catalogIds` was a boot-time-only
    // `catalogProviderIds()` snapshot never unioned with `provider.custom[]`
    // ids and never refreshed post-boot — `handleConnectionCreate`'s
    // `catalogIds.includes(req.providerId)` gate would refuse this with
    // `{ ok: false, reason: "invalid" }` even though the provider above was
    // just created successfully.
    const connectionResult = (await handleConnectionCreate({}, {
      providerId: customId,
    })) as SettingsMutationResult;

    expect(connectionResult).toMatchObject({ ok: true });
  });
});

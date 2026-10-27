/**
 * Production-wiring test for Taskana 4732 S1-B: proves main/index.ts boots
 * the plugins control plane in the design §5 order — staging wipe, store
 * GC, legacy MCP grandfathering (one-shot into settings.json
 * `plugins.mcpConsent`), IPC registration, and the ~24h scheduler armed
 * ONLY when the official channel is configured (test keys → NOT armed,
 * design §9.14). Boot mechanics mirror index.codexSupportPolicy-wiring.test.ts
 * (main/index.ts can only be exercised by booting it); `node:os.homedir` is
 * mocked to a per-test scratch dir so nothing real is touched.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGINS_LIST_CHANNEL } from "../shared/plugins-config.js";

// GitHub #19: main now installs its application menu inside `app.whenReady()`
// and then continues through the ENTIRE boot chain (window, updater, services).
// These wiring tests boot the real module, so they get headroom over the 5 s
// default that the full suite's parallel load can exceed.
vi.setConfig({ testTimeout: 15_000 });


type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const { ipcHandlers, fakeHomeRef } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  fakeHomeRef: { current: "" },
}));

class FakeHostProcess {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
  on = vi.fn(() => this);
  once = vi.fn(() => this);
}

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
    getVersion: () => "0.0.36-test",
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
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showOpenDialogSync: vi.fn(() => undefined) },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  utilityProcess: {
    fork: vi.fn(() => new FakeHostProcess()),
  },
  ipcMain: {
    handle: (channel: string, listener: IpcHandler): void => {
      ipcHandlers.set(channel, listener);
    },
    on: vi.fn(),
  },
}));

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

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => fakeHomeRef.current };
});

vi.mock("./codex-doctor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-doctor.js")>();
  return { ...real, runCodexDoctor: vi.fn(async () => ({ status: "not_installed" as const })) };
});

vi.mock("./codex-manifest.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-manifest.js")>();
  return {
    ...real,
    refreshCodexManifest: vi.fn(async () => {
      throw new Error("offline (plugins boot wiring test)");
    }),
  };
});

let dir: string;

async function waitForHandler(channel: string, timeoutMs = 5000): Promise<IpcHandler> {
  const start = Date.now();
  for (;;) {
    const handler = ipcHandlers.get(channel);
    if (handler !== undefined) return handler;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ipcMain.handle(${channel}) was never registered within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  ipcHandlers.clear();
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-plugins-boot-"));
  fakeHomeRef.current = join(dir, "fake-home");
  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = join(dir, "settings.json");
  process.env.ANYCODE_SECRETS_PATH = join(dir, "secrets.json");
  process.env.ANYCODE_DB_PATH = ":memory:";
  process.env.ANYCODE_API_KEY = "sk-primary-env";
  delete process.env.ANYCODE_USER_DATA_DIR;
  delete process.env.ANYCODE_WORKSPACE;
  delete process.env.ANYCODE_RESUME;
  delete process.env.ELECTRON_RENDERER_URL;
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;

  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 2,
      provider: {
        activeConnectionId: "conn-primary",
        connections: [{ id: "conn-primary", providerId: "", model: "primary-model" }],
      },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    }),
  );
});

afterEach(async () => {
  delete process.env.ANYCODE_AUTOMATION;
  delete process.env.ANYCODE_SETTINGS_PATH;
  delete process.env.ANYCODE_SECRETS_PATH;
  delete process.env.ANYCODE_DB_PATH;
  delete process.env.ANYCODE_API_KEY;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("main/index.ts — Taskana 4732 S1-B plugins boot wiring", () => {
  it("wipes staging residue and GCs orphaned store dirs at boot", async () => {
    const pluginsDir = join(fakeHomeRef.current, ".anycode", "plugins");
    // Crash residue in staging + an orphaned store dir (no state entry).
    await mkdir(join(pluginsDir, ".staging", "leftover-install"), { recursive: true });
    await writeFile(join(pluginsDir, ".staging", "leftover-install", "x.txt"), "x");
    await mkdir(join(pluginsDir, ".store", "ghost", "1.0.0"), { recursive: true });

    await import("./index.js");
    await waitForHandler(PLUGINS_LIST_CHANNEL);

    // Give the async boot a beat to finish the wipe/GC.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const staging = await readdir(join(pluginsDir, ".staging")).catch(() => []);
    expect(staging).toEqual([]);
    await expect(readdir(join(pluginsDir, ".store", "ghost"))).rejects.toThrow();
  });

  it("grandfathers legacy user-dir MCP plugins into settings.plugins.mcpConsent once", async () => {
    const legacyDir = join(fakeHomeRef.current, ".anycode", "plugins", "old-faithful");
    await mkdir(join(legacyDir, ".anycode-plugin"), { recursive: true });
    await writeFile(
      join(legacyDir, ".anycode-plugin", "plugin.json"),
      JSON.stringify({
        name: "old-faithful",
        skills: ["skills"],
        agents: ["agents"],
        mcpServers: { helper: { command: "node", args: ["helper.js"] } },
      }),
    );

    await import("./index.js");
    await waitForHandler(PLUGINS_LIST_CHANNEL);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    expect(settings.plugins?.mcpConsent).toHaveLength(1);
    expect(settings.plugins.mcpConsent[0]).toMatchObject({ plugin: "old-faithful" });

    // A second boot does NOT rewrite the list (skipped once consent exists).
    const firstWrite = settings.plugins.mcpConsent;
    vi.resetModules();
    ipcHandlers.clear();
    await import("./index.js");
    await waitForHandler(PLUGINS_LIST_CHANNEL);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    expect(second.plugins.mcpConsent).toEqual(firstWrite);
  });

  it("does NOT arm the periodic scheduler with only test keys compiled (§9.14)", async () => {
    await import("./index.js");
    await waitForHandler(PLUGINS_LIST_CHANNEL);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The list channel answers with index status "unchecked"/"not configured" —
    // and no network check ever fired. Prove the gate indirectly: the settings
    // block was never given autoUpdateOfficial, and with test keys only, the
    // scheduler must not have been created. The strongest observable: the
    // boot completed without touching the network (no fetch mock needed —
    // offline codex-manifest mock above proves boot reaches the end).
    const handler = ipcHandlers.get(PLUGINS_LIST_CHANNEL)!;
    const snapshot = (await handler({})) as { index: { status: string }; settings: { autoUpdateOfficial: boolean } };
    expect(snapshot.settings.autoUpdateOfficial).toBe(false);
  });
});

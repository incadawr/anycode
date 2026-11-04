/**
 * Production-wiring test: proves that main/index.ts really stamps
 * `settings.claude.contextWindowTokens` into every host fork's env under
 * `ANYCODE_CLAUDE_CONTEXT_WINDOW` — the carrier `buildClaudeChildEnv` turns
 * into the Claude CLI's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (pinned in the
 * claude-client suites). This is the half no unit test can reach: the fact
 * under test is that the `engineEnv` overlay reads the LIVE settings at fork
 * time, so a saved limit reaches the next Claude session with no cache to
 * invalidate — and that "not configured" stamps the EMPTY STRING, so an
 * ambient shell export of the carrier name can never ride the bootEnv spread
 * into a fork and impersonate a setting the user never made.
 *
 * Boot mechanics mirror index.codexSupportPolicy-wiring.test.ts (see its
 * header for why main/index.ts can only be exercised by booting it).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_CLAUDE_CONTEXT_WINDOW } from "../shared/engines.js";
import { PROFILE_STATS_GET_CHANNEL } from "../shared/profile-config.js";
import { TAB_CREATE_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";

vi.setConfig({ testTimeout: 15_000 });

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

interface ForkCall {
  env: NodeJS.ProcessEnv;
}

const { ipcHandlers, forkCalls, fakeHomeRef } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  forkCalls: [] as ForkCall[],
  fakeHomeRef: { current: "" },
}));

class FakeHostProcess {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
  on = vi.fn(() => this);
  once = vi.fn(() => this);
}

// Shared fake webContents: main/index.ts's IPC guard resolves its trusted
// sender to the live main window's webContents, so the rig must present THIS
// identity as the sender (plus its top frame) when driving captured handlers.
const FAKE_MAIN_WEBCONTENTS = {
  setWindowOpenHandler: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
  postMessage: vi.fn(),
  isDestroyed: vi.fn(() => false),
  isLoading: vi.fn(() => false),
  mainFrame: { frame: "main" },
};

class FakeBrowserWindow {
  webContents = FAKE_MAIN_WEBCONTENTS;
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
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
    getApplicationMenu: vi.fn(() => null),
  },
  dialog: { showOpenDialogSync: vi.fn(() => undefined) },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  utilityProcess: {
    fork: vi.fn((_entry: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      forkCalls.push({ env: options.env });
      return new FakeHostProcess();
    }),
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

// The boot-time claude doctor probe spawns a real subprocess — inert-mocked.
vi.mock("./claude-doctor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./claude-doctor.js")>();
  return { ...real, runClaudeDoctor: vi.fn(async () => ({ status: "not_installed" as const })) };
});

let dir: string;

async function waitForHandler(channel: string, timeoutMs = 5000): Promise<IpcHandler> {
  const start = Date.now();
  for (;;) {
    const handler = ipcHandlers.get(channel);
    if (handler !== undefined) {
      // The guard only serves a trusted main-window top-frame event; wrap so
      // drive sites keep their ({}, payload) shape while the real handler gets
      // the exact event Electron would deliver from the main window.
      return ((_event: unknown, ...args: unknown[]) =>
        handler({ sender: FAKE_MAIN_WEBCONTENTS, senderFrame: FAKE_MAIN_WEBCONTENTS.mainFrame } as unknown, ...args)) as IpcHandler;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ipcMain.handle(${channel}) was never registered within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  ipcHandlers.clear();
  forkCalls.length = 0;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-claude-window-"));
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
  // A shell that already exports the carrier name — the forged value the
  // absent-setting case must prove does NOT reach the fork.
  process.env[ENV_CLAUDE_CONTEXT_WINDOW] = "999999";
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;
});

afterEach(async () => {
  delete process.env.ANYCODE_AUTOMATION;
  delete process.env.ANYCODE_SETTINGS_PATH;
  delete process.env.ANYCODE_SECRETS_PATH;
  delete process.env.ANYCODE_DB_PATH;
  delete process.env.ANYCODE_API_KEY;
  delete process.env[ENV_CLAUDE_CONTEXT_WINDOW];
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function bootWithSettings(settings: Record<string, unknown>): Promise<void> {
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
      ...settings,
    }),
  );
  await import("./index.js");
  await waitForHandler(PROFILE_STATS_GET_CHANNEL);
}

describe("main/index.ts — the claude context-window limit reaches the host fork", () => {
  it("stamps the persisted limit into the fork env", async () => {
    await bootWithSettings({ claude: { contextWindowTokens: 260000 } });
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]!.env[ENV_CLAUDE_CONTEXT_WINDOW]).toBe("260000");
  });

  it("not configured: the fork env carries the EMPTY carrier, never an ambient shell value", async () => {
    await bootWithSettings({});
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]!.env[ENV_CLAUDE_CONTEXT_WINDOW]).toBe("");
  });
});

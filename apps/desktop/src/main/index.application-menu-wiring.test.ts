/**
 * GitHub #19 — production-wiring regression test. Proves `main/index.ts`
 * (not just application-menu.ts's pure builder) really installs the explicit
 * menu before the first window and that a packaged build cannot re-enable the
 * dev reload entries even when the compile-time dev flag is set.
 *
 * Follows index.appVersion-wiring.test.ts's precedent: every Electron
 * primitive plus the external dependencies are mocked, `app.whenReady()`
 * resolves, and the real whenReady callback runs against a scratch `:memory:`
 * DB and scratch settings (the `ANYCODE_AUTOMATION=1` dev-profile lever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GitHub #19: main now installs its application menu inside `app.whenReady()`
// and then continues through the ENTIRE boot chain (window, updater, services).
// These wiring tests boot the real module, so they get headroom over the 5 s
// default that the full suite's parallel load can exceed.
vi.setConfig({ testTimeout: 15_000 });


type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const { ipcHandlers, menuState } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  menuState: {
    events: [] as string[],
    setApplicationMenu: vi.fn((_menu: unknown) => { menuState.events.push("set-menu"); }),
    buildFromTemplate: vi.fn((template: unknown) => template),
    lastTemplate: undefined as unknown,
    appPackaged: { current: false },
  },
}));

/** The application menu template is captured; the window constructor logs order. */
function installedTemplate(): { role?: string; accelerator?: string; label?: string; submenu?: unknown[] }[] {
  return (menuState.lastTemplate as { role?: string; accelerator?: string; label?: string; submenu?: unknown[] }[]) ?? [];
}

function hasReloadEntries(template: unknown[]): boolean {
  const forbiddenRoles = new Set(["reload", "forceReload", "toggleDevTools", "viewMenu"]);
  let found = false;
  const walk = (node: { role?: string; accelerator?: string; submenu?: unknown[] }): void => {
    if (!node || typeof node !== "object") return;
    if (node.role !== undefined && forbiddenRoles.has(node.role)) found = true;
    if (node.accelerator !== undefined && /\+R$/i.test(node.accelerator)) found = true;
    if (Array.isArray(node.submenu)) for (const child of node.submenu) walk(child as { role?: string; accelerator?: string; submenu?: unknown[] });
  };
  for (const node of template) walk(node as { role?: string; accelerator?: string; submenu?: unknown[] });
  return found;
}

class FakeBrowserWindow {
  webContents = { on: vi.fn(), send: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(), toggleDevTools: vi.fn() };
  on = vi.fn();
  isMaximized = vi.fn(() => false);
  isFullScreen = vi.fn(() => false);
  loadFile = vi.fn(async () => undefined);
  loadURL = vi.fn(async () => undefined);
  constructor() {
    menuState.events.push("create-window");
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
  Menu: {
    setApplicationMenu: (menu: unknown): void => {
      menuState.lastTemplate = menu;
      menuState.setApplicationMenu(menu);
    },
    buildFromTemplate: menuState.buildFromTemplate,
  },
  app: {
    get isPackaged(): boolean {
      return menuState.appPackaged.current;
    },
    getVersion: () => "0.0.0-wiring",
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
    showMessageBox: vi.fn(async () => ({ response: 0 })),
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

beforeEach(async () => {
  ipcHandlers.clear();
  menuState.events.length = 0;
  menuState.setApplicationMenu.mockClear();
  menuState.buildFromTemplate.mockClear();
  menuState.lastTemplate = undefined;
  menuState.appPackaged.current = false;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-menu-boot-"));
  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = join(dir, "settings.json");
  process.env.ANYCODE_SECRETS_PATH = join(dir, "secrets.json");
  process.env.ANYCODE_DB_PATH = ":memory:";
  delete process.env.ANYCODE_USER_DATA_DIR;
  delete process.env.ANYCODE_WORKSPACE;
  delete process.env.ANYCODE_RESUME;
  delete process.env.ELECTRON_RENDERER_URL;
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;
});

afterEach(async () => {
  delete process.env.ANYCODE_AUTOMATION;
  delete process.env.ANYCODE_SETTINGS_PATH;
  delete process.env.ANYCODE_SECRETS_PATH;
  delete process.env.ANYCODE_DB_PATH;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function boot(): Promise<void> {
  await import("./index.js");
  await vi.waitFor(() => expect(menuState.setApplicationMenu).toHaveBeenCalled(), { timeout: 5000 });
}

describe("main/index.ts — application menu production wiring (GitHub #19)", () => {
  it("installs the menu before the first window and ships no reload entry in a dev-unflagged build", async () => {
    await boot();
    expect(menuState.events.indexOf("set-menu")).toBeGreaterThanOrEqual(0);
    expect(menuState.events.indexOf("create-window")).toBeGreaterThan(menuState.events.indexOf("set-menu"));
    expect(hasReloadEntries(installedTemplate())).toBe(false);
  });

  it("a packaged build cannot enable the dev reload entries even when the dev flag is set", async () => {
    menuState.appPackaged.current = true;
    (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = true;
    await boot();
    expect(menuState.events.indexOf("set-menu")).toBeGreaterThanOrEqual(0);
    expect(hasReloadEntries(installedTemplate())).toBe(false);
  });
});

/**
 * Production-wiring test for TASK.206: proves that main/index.ts really stamps
 * the ACTIVE Codex version-support policy into every host fork's env, and that
 * the policy it stamps is the one the Settings card and the Doctor judge by —
 * the manifest ranges plus `settings.codex.riskAcceptedVersions`.
 *
 * This is the half no unit test can reach. `codexSupportPolicyFor` /
 * `encodeCodexSupportPolicy` are pure and pinned in their own suites; the fact
 * under test here is that the `engineEnv` overlay CALLS them, off the live
 * module-scope policy, at fork time. Before TASK.206 nothing carried the
 * policy across the process boundary at all, so the host judged codex versions
 * by a compile-time constant while the screen judged by the manifest (issue
 * #4: Settings said "Supported range >=0.144.0 <0.152.0", Doctor said `ready`,
 * the in-app installer installed 0.151.0, and the host refused to start).
 *
 * Boot mechanics mirror index.recognizer-wiring.test.ts (see its header for
 * why main/index.ts can only be exercised by booting it). `node:os.homedir` is
 * mocked to a per-test scratch dir and the manifest refresh is mocked inert,
 * so this test never reads or writes the developer's real `~/.anycode`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_CODEX_MANIFEST } from "../shared/codex-support.js";
import { ENV_CODEX_SUPPORT_POLICY, decodeCodexSupportPolicy } from "../shared/codex-version-policy.js";
import { PROFILE_STATS_GET_CHANNEL } from "../shared/profile-config.js";
import { TAB_CREATE_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";

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
  dialog: { showOpenDialogSync: vi.fn(() => undefined) },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  utilityProcess: {
    // The fork ENV is the whole subject of this file, so unlike the sibling
    // wiring tests this mock records it.
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

// Every homedir-derived path (the codex profiles root the manifest cache lives
// under, the vault, the settings defaults) lands in a disposable scratch home.
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => fakeHomeRef.current };
});

// The boot-time codex recheck spawns a real subprocess — inert-mocked.
vi.mock("./codex-doctor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-doctor.js")>();
  return { ...real, runCodexDoctor: vi.fn(async () => ({ status: "not_installed" as const })) };
});

// ONLY the network refresh is mocked; `activeCodexVersionPolicy`,
// `setActiveCodexVersionPolicy` and `codexSupportPolicyFor` stay REAL — they
// are what this test is checking the wiring of. Failing like an offline run
// leaves the active manifest at BUNDLED, which is what the assertions expect.
vi.mock("./codex-manifest.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-manifest.js")>();
  return {
    ...real,
    refreshCodexManifest: vi.fn(async () => {
      throw new Error("offline (codex support-policy wiring test)");
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
  forkCalls.length = 0;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-codex-policy-"));
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
  // A shell that already exports the carrier name: main must OVERWRITE it, not
  // let it ride the bootEnv spread into the fork (the reason the stamp is
  // unconditional). A forged wide-open policy is the interesting value.
  process.env[ENV_CODEX_SUPPORT_POLICY] = JSON.stringify({ ranges: [">=0.0.1 <99.0.0"], riskAccepted: [] });
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;

  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 2,
      provider: {
        activeConnectionId: "conn-primary",
        connections: [{ id: "conn-primary", providerId: "", model: "primary-model" }],
      },
      // The §7.4 acceptance the "use it anyway" button writes. Its presence in
      // the fork env is what proves the stamp reads the LIVE policy (seeded
      // from settings at boot) rather than a compile-time default.
      codex: { riskAcceptedVersions: ["9.9.9"] },
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
  delete process.env[ENV_CODEX_SUPPORT_POLICY];
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("main/index.ts — codex version-support policy reaches the host fork (TASK.206)", () => {
  it("stamps the active manifest ranges and the persisted risk acceptances into the fork env, overwriting an ambient value", async () => {
    await import("./index.js");

    // Registered AFTER the `setActiveCodexVersionPolicy` seeding line, so
    // waiting on it means the boot really loaded the risk list from settings.
    await waitForHandler(PROFILE_STATS_GET_CHANNEL);
    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);

    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    expect(forkCalls).toHaveLength(1);

    const carrier = forkCalls[0]!.env[ENV_CODEX_SUPPORT_POLICY];
    expect(carrier).toBeDefined();
    expect(decodeCodexSupportPolicy(carrier)).toEqual({
      ranges: BUNDLED_CODEX_MANIFEST.supported.map((entry) => entry.range),
      riskAcceptedVersions: ["9.9.9"],
    });
  });
});

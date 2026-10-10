/**
 * Production-wiring test for Taskana 4230 (part 1): proves that main/index.ts
 * boots the PERIODIC manifest-refresh schedule and the refresh-before-refusal
 * helper on the profiles-root cache file, that a CHANGED periodic tick
 * re-triggers the doctor recheck, and that a self-check boot gets NONE of the
 * new automatic networking.
 *
 * Boot mechanics mirror index.codexSupportPolicy-wiring.test.ts (see its
 * header). `node:os.homedir` is mocked to a per-test scratch dir; the
 * codex-manifest module's three new seams are mocked recording, failing inert
 * (the boot refresh throws like an offline run), so this test never touches
 * the network or the developer's real `~/.anycode`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_CODEX_SUPPORT_POLICY } from "../shared/codex-version-policy.js";
import { PROFILE_STATS_GET_CHANNEL } from "../shared/profile-config.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const ENGINES_CHANGED_CHANNEL = "anycode:engines-changed"; // duplicated literal, same convention as the sibling wiring file.

const { ipcHandlers, sentChannels, fakeHomeRef, manifestMocks, doctorMock } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  sentChannels: [] as string[],
  fakeHomeRef: { current: "" },
  doctorMock: { runCodexDoctor: vi.fn(async () => ({ status: "not_installed" as const })) },
  manifestMocks: {
    refreshCodexManifest: vi.fn(async () => {
      throw new Error("offline (schedule wiring)");
    }),
    startCodexManifestRefreshSchedule: vi.fn(() => ({ stop: vi.fn() })),
    createCodexManifestRefusalRefresh: vi.fn(() => ({ refreshBeforeRefusal: vi.fn(async () => false) })),
  },
}));

class FakeHostProcess {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
  on = vi.fn(() => this);
  once = vi.fn(() => this);
}

class FakeBrowserWindow {
  // `isDestroyed` on both the window and its webContents models a LIVE window
  // (sendToMainWindow asks before touching `.webContents` — TASK.199).
  webContents = {
    on: vi.fn(),
    send: vi.fn((channel: string) => {
      sentChannels.push(channel);
    }),
    postMessage: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
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
    // The self-check boot path calls app.exit when its (mocked-away) renderer
    // probe cannot succeed; keep it inert so no late rejection escapes.
    exit: vi.fn(),
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

// The boot-time codex recheck spawns a real subprocess — inert-mocked.
vi.mock("./codex-doctor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-doctor.js")>();
  return { ...real, runCodexDoctor: doctorMock.runCodexDoctor };
});

vi.mock("./codex-manifest.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-manifest.js")>();
  return {
    ...real,
    refreshCodexManifest: manifestMocks.refreshCodexManifest,
    startCodexManifestRefreshSchedule: manifestMocks.startCodexManifestRefreshSchedule,
    createCodexManifestRefusalRefresh: manifestMocks.createCodexManifestRefusalRefresh,
  };
});

// Reject #1 (round 2): the shared ENGINES_CHANGED channel is NOT a Codex
// completion signal (Claude/other boot activity pushes it too). Instead,
// partially mock registerCodexIpc to WRAP the real controller — production
// index wiring stays real; we only record every recheck call's exact
// arguments and its completion promise off the live controller seam.
const { codexIpcRecorder } = vi.hoisted(() => ({
  codexIpcRecorder: {
    recheckCalls: [] as Array<{ profileId?: string; force?: boolean; completion: Promise<unknown> }>,
    wrap(controller: import("./codex-ipc.js").CodexOnboardingController): import("./codex-ipc.js").CodexOnboardingController {
      return {
        ...controller,
        recheck: (profileId?: string, options?: { force?: boolean }) => {
          const completion = controller.recheck(profileId, options);
          codexIpcRecorder.recheckCalls.push({ profileId, force: options?.force, completion });
          return completion;
        },
      };
    },
  },
}));

vi.mock("./codex-ipc.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-ipc.js")>();
  return {
    ...real,
    registerCodexIpc: (deps: import("./codex-ipc.js").CodexIpcDeps) => codexIpcRecorder.wrap(real.registerCodexIpc(deps)),
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

async function bootIndex(): Promise<void> {
  await import("./index.js");
  await waitForHandler(PROFILE_STATS_GET_CHANNEL);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function enginesChangedCount(): number {
  return sentChannels.filter((channel) => channel === ENGINES_CHANGED_CHANNEL).length;
}

beforeEach(async () => {
  ipcHandlers.clear();
  sentChannels.length = 0;
  doctorMock.runCodexDoctor.mockClear();
  manifestMocks.refreshCodexManifest.mockClear();
  manifestMocks.startCodexManifestRefreshSchedule.mockClear();
  manifestMocks.createCodexManifestRefusalRefresh.mockClear();
  codexIpcRecorder.recheckCalls.length = 0;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-manifest-refresh-"));
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
  // The automation lever (W4-F0) overrides the profiles root away from
  // homedir(); scrub it so this test exercises the production default.
  delete process.env.ANYCODE_CODEX_PROFILES_HOME;
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
      codex: {},
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

describe("main/index.ts — periodic manifest refresh + refresh-before-refusal wiring (Taskana 4230)", () => {
  it("boots the periodic schedule and the refusal refresh on the profiles-root cache file", async () => {
    await bootIndex();

    expect(manifestMocks.startCodexManifestRefreshSchedule).toHaveBeenCalledTimes(1);
    const scheduleArgs = (manifestMocks.startCodexManifestRefreshSchedule.mock.calls as unknown as Array<[{ cacheFile: string; onResult: (result: unknown, changed: boolean) => void }]>)[0]![0];
    expect(scheduleArgs.cacheFile.endsWith(join(".anycode", "codex", "manifest.json"))).toBe(true);
    expect(scheduleArgs.cacheFile.startsWith(join(dir, "fake-home"))).toBe(true);
    expect(typeof scheduleArgs.onResult).toBe("function");

    expect(manifestMocks.createCodexManifestRefusalRefresh).toHaveBeenCalledTimes(1);
    const refusalArgs = (manifestMocks.createCodexManifestRefusalRefresh.mock.calls as unknown as Array<[{ cacheFile: string }]>)[0]![0];
    expect(refusalArgs.cacheFile).toBe(scheduleArgs.cacheFile);

    // The boot refresh fires once (the mocked one throws like an offline run).
    await waitFor(() => manifestMocks.refreshCodexManifest.mock.calls.length >= 1, "boot refresh");
    expect(manifestMocks.refreshCodexManifest).toHaveBeenCalledTimes(1);
  });

  it("a CHANGED periodic tick re-triggers the doctor recheck; an unchanged tick does not (rejected-rig: recorded Codex recheck completions, not shared-channel totals)", async () => {
    await bootIndex();
    await waitFor(() => manifestMocks.refreshCodexManifest.mock.calls.length >= 1, "boot refresh");
    // DETERMINISTIC settle: await every recheck the BOOT queued (via the
    // wrapped controller's recorded completion promises) — after this, the
    // recorder is quiescent and the tick assertions below are not racing
    // boot work.
    for (const call of [...codexIpcRecorder.recheckCalls]) {
      await call.completion.catch(() => {});
    }
    const scheduleArgs = (manifestMocks.startCodexManifestRefreshSchedule.mock.calls as unknown as Array<[{ onResult: (result: unknown, changed: boolean) => void }]>)[0]![0];
    const callsBeforeTick = codexIpcRecorder.recheckCalls.length;

    // CHANGED tick: must call recheck(undefined, { force: true }) exactly
    // once. Awaiting the tick's recorded completion promise (microtask drain
    // first so the fire-and-forget closure runs) is the whole synchronization.
    scheduleArgs.onResult({ manifest: { updated: "changed" }, source: "network" }, true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const afterChanged = codexIpcRecorder.recheckCalls.slice(callsBeforeTick);
    expect(afterChanged).toHaveLength(1);
    expect(afterChanged[0]!.profileId).toBeUndefined();
    expect(afterChanged[0]!.force).toBe(true);
    await afterChanged[0]!.completion.catch(() => {});

    // UNCHANGED tick: adds NO recheck call. Drain the same depth of
    // microtasks the changed tick needed for its closure to run, then assert
    // the recorder is unchanged — no sleep, no shared-channel counting.
    const beforeUnchanged = codexIpcRecorder.recheckCalls.length;
    scheduleArgs.onResult({ manifest: { updated: "same" }, source: "network" }, false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(codexIpcRecorder.recheckCalls.length).toBe(beforeUnchanged);
  });

  it("self-check boot: NO schedule, NO refusal refresh, NO boot refresh (no new automatic networking)", async () => {
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    process.argv = [...savedArgv, "--self-check"];
    try {
      await bootIndex();
      expect(manifestMocks.startCodexManifestRefreshSchedule).not.toHaveBeenCalled();
      expect(manifestMocks.createCodexManifestRefusalRefresh).not.toHaveBeenCalled();
      expect(manifestMocks.refreshCodexManifest).not.toHaveBeenCalled();
    } finally {
      process.argv = savedArgv;
      // selfCheckEnvironment scrubs process.env at module top — restore it.
      process.env = savedEnv;
    }
  });
});

/**
 * Production-wiring + RED-proof test for the `ANYCODE_CODEX_PROFILES_HOME`
 * lever (codex-profiles W4-F0, findings S1-2): proves that `main/index.ts` —
 * not just the injectable deps bags — really resolves the lever ONCE at the
 * codex registration site and threads the resulting `home` into every
 * consumer that derives the profiles root:
 *
 *  1. `registerCodexIpc` (the profile registry) — a created profile's home
 *     lands under `<lever>/.anycode/codex/profile-<id>`, never the real one;
 *  2. `refreshCodexManifest`'s boot cache file — `<lever>/.anycode/codex/
 *     manifest.json`;
 *  3. `registerCodexInstallIpc` — the install controller's own manifest cache
 *     file (observed via the manifest-refresh channel's captured options);
 *  4. the rollout-import resolver — `rollout-list` reads a profile's
 *     `sessions/` dir under the lever root.
 *
 * Plus the DoD's RED-proof: the lever set WITHOUT the double gate
 * (`ANYCODE_AUTOMATION` unset, or a packaged build) is IGNORED — the profile
 * tree lands under the (mocked) real homedir instead. Those two tests go red
 * if either half of the gate is dropped from `resolveCodexProfilesHome`.
 *
 * Boot mechanics mirror index.appVersion-wiring.test.ts (see its header for
 * why index.ts must be dynamically imported under a hoisted electron mock).
 * `node:os.homedir` is mocked to a per-test scratch dir so the REFUSED-lever
 * paths write into a disposable fake home, never the developer's real `~`
 * (the whole point of the lever under test). Codex discovery's doctor spawn
 * and the manifest's network fetch are mocked inert — genuinely external,
 * and irrelevant to the home threading this file tests; the profile
 * registry, install controller wiring, and rollout IPC all run their REAL
 * code.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Duplicated channel literals — codex-ipc.ts / codex-install.ts /
// codex-rollout-ipc.ts hold the sources of truth; same "duplicated on
// purpose" convention as index.appVersion-wiring.test.ts's own channel copy
// (a static import of those modules here would chain-import "electron"
// before the vi.mock factory hoists).
const CODEX_PROFILE_CREATE_CHANNEL = "anycode:codex-profile-create";
const CODEX_MANIFEST_REFRESH_CHANNEL = "anycode:codex-manifest-refresh";
const CODEX_ROLLOUT_LIST_CHANNEL = "anycode:codex-rollout-list";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const { ipcHandlers, mockIsPackaged, fakeHomeRef, manifestCalls, hostEnvScrubCalls } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  mockIsPackaged: { current: false },
  fakeHomeRef: { current: "/tmp/anycode-fake-home-unset" },
  manifestCalls: [] as Array<{ cacheFile?: string; force?: boolean }>,
  hostEnvScrubCalls: [] as Array<{ override: string | null; varAfter: string | undefined }>,
}));

/** Minimal fake BrowserWindow (index.appVersion-wiring.test.ts's shape). */
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
    // Read through a getter so each test can flip the packaged flag BEFORE
    // its dynamic `import("./index.js")` — the lever's gate reads it at the
    // registration site.
    get isPackaged() {
      return mockIsPackaged.current;
    },
    getVersion: () => "0.0.0-codex-home-wiring",
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
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
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

// The refused-lever paths must land in a DISPOSABLE fake home, never the
// developer's real `~` (settings default paths, the profile tree, the vault
// — all homedir-derived when the automation overrides are off/refused).
// Everything but `homedir` stays real.
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => fakeHomeRef.current };
});

// W4-F0b host-lever forward: a TRANSPARENT wrap around the real
// `applyCodexProfilesHomeOverride` — the production scrub still runs; the
// wrap only records what `buildHostEnvFor` (main/index.ts) passed it and
// whether the var survived in the fork env AFTER the scrub. This binds the
// main-scrub RED-proof to the ACTUAL buildHostEnvFor output, not just to the
// host-env unit: dropping either the wiring line in buildHostEnvFor (zero
// calls) or the delete branch in host-env.ts (varAfter carries the ambient
// value) turns the tests below red.
vi.mock("./host-env.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./host-env.js")>();
  return {
    ...real,
    applyCodexProfilesHomeOverride: (env: NodeJS.ProcessEnv, override: string | null): void => {
      real.applyCodexProfilesHomeOverride(env, override);
      hostEnvScrubCalls.push({ override, varAfter: env.ANYCODE_CODEX_PROFILES_HOME });
    },
  };
});

// The boot-time recheck's doctor spawn is a real subprocess — inert-mocked
// (discovery itself is fs-only and stays real); the profile registry this
// file tests never routes through it.
vi.mock("./codex-doctor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-doctor.js")>();
  return { ...real, runCodexDoctor: vi.fn(async () => ({ status: "not_installed" as const })) };
});

// The manifest refresh is a real network fetch — mocked to capture its
// options (the cacheFile is EXACTLY the threading fact under test) and then
// fail like an offline run (index.ts's own `.catch(() => {})` swallows it;
// the install controller's refreshManifest surfaces the rejection to its
// caller, which this test catches explicitly).
vi.mock("./codex-manifest.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./codex-manifest.js")>();
  return {
    ...real,
    refreshCodexManifest: vi.fn(async (options: { cacheFile?: string; force?: boolean }) => {
      manifestCalls.push({ cacheFile: options.cacheFile, force: options.force });
      throw new Error("offline (codex-home wiring test)");
    }),
  };
});

let scratch: string;
let fakeHome: string;
let leverRoot: string;

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

/** The derived profiles root for a given user home — mirrors codexProfilesRoot (main/codex-profiles.ts). */
function profilesRoot(home: string): string {
  return join(home, ".anycode", "codex");
}

async function bootAndCreateProfile(): Promise<void> {
  await import("./index.js");
  const create = await waitForHandler(CODEX_PROFILE_CREATE_CHANNEL);
  const created = (await create({}, { label: "smoke" })) as { ok: boolean; profile?: { id: string } };
  expect(created.ok).toBe(true);
  expect(created.profile?.id).toBe("smoke");
}

beforeEach(async () => {
  ipcHandlers.clear();
  manifestCalls.length = 0;
  hostEnvScrubCalls.length = 0;
  mockIsPackaged.current = false;
  vi.resetModules();
  scratch = await mkdtemp(join(tmpdir(), "anycode-codex-home-wiring-"));
  fakeHome = join(scratch, "fake-home");
  leverRoot = join(scratch, "lever-root");
  await mkdir(fakeHome, { recursive: true });
  fakeHomeRef.current = fakeHome;
  process.env.ANYCODE_CODEX_PROFILES_HOME = leverRoot;
  process.env.ANYCODE_DB_PATH = ":memory:";
  delete process.env.ANYCODE_USER_DATA_DIR;
  delete process.env.ANYCODE_WORKSPACE;
  delete process.env.ANYCODE_RESUME;
  delete process.env.ELECTRON_RENDERER_URL;
  delete process.env.CODEX_HOME;
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;
});

afterEach(async () => {
  delete process.env.ANYCODE_AUTOMATION;
  delete process.env.ANYCODE_SETTINGS_PATH;
  delete process.env.ANYCODE_SECRETS_PATH;
  delete process.env.ANYCODE_CODEX_PROFILES_HOME;
  delete process.env.ANYCODE_DB_PATH;
  await rm(scratch, { recursive: true, force: true });
});

describe("main/index.ts — ANYCODE_CODEX_PROFILES_HOME wiring (W4-F0, S1-2)", () => {
  it("threads the lever into the profile registry, the boot manifest cache, the install controller, and the rollout resolver (double gate satisfied)", async () => {
    process.env.ANYCODE_AUTOMATION = "1";
    process.env.ANYCODE_SETTINGS_PATH = join(scratch, "settings.json");
    process.env.ANYCODE_SECRETS_PATH = join(scratch, "secrets.json");

    await bootAndCreateProfile();

    // 1. registerCodexIpc: the created profile home derives from the lever,
    //    and NOTHING landed under the (fake) real home.
    expect(existsSync(join(profilesRoot(leverRoot), "profile-smoke"))).toBe(true);
    expect(existsSync(join(profilesRoot(fakeHome), "profile-smoke"))).toBe(false);

    // 2. refreshCodexManifest boot call: cache file under the lever root.
    expect(manifestCalls[0]?.cacheFile).toBe(join(profilesRoot(leverRoot), "manifest.json"));

    // 3. registerCodexInstallIpc: the install controller derived ITS manifest
    //    cache file from the lever too (observed via the refresh channel's
    //    forced call; the mocked fetch rejects — that rejection is expected).
    const refresh = await waitForHandler(CODEX_MANIFEST_REFRESH_CHANNEL);
    await expect(Promise.resolve(refresh({}))).rejects.toThrow("offline (codex-home wiring test)");
    const forced = manifestCalls.find((call) => call.force === true);
    expect(forced?.cacheFile).toBe(join(profilesRoot(leverRoot), "manifest.json"));

    // 4. rollout-import resolver: a rollout planted in the LEVER-rooted
    //    profile home is listed for that profile.
    const sessionsDay = join(profilesRoot(leverRoot), "profile-smoke", "sessions", "2026", "07", "17");
    await mkdir(sessionsDay, { recursive: true });
    await writeFile(join(sessionsDay, "rollout-wiring.jsonl"), "");
    const list = await waitForHandler(CODEX_ROLLOUT_LIST_CHANNEL);
    const listed = (await list({}, { profileId: "smoke" })) as { ok: boolean; rollouts?: Array<{ fileName: string }> };
    expect(listed.ok).toBe(true);
    expect(listed.rollouts?.map((entry) => entry.fileName)).toEqual(["2026/07/17/rollout-wiring.jsonl"]);
  });

  it("RED-proof: the lever WITHOUT ANYCODE_AUTOMATION=1 is ignored — the profile tree derives from the real homedir", async () => {
    delete process.env.ANYCODE_AUTOMATION;
    // No settings-path override either (it shares the refused gate): the
    // settings default is homedir-derived, i.e. contained in the fake home.
    delete process.env.ANYCODE_SETTINGS_PATH;
    delete process.env.ANYCODE_SECRETS_PATH;

    await bootAndCreateProfile();

    expect(existsSync(join(profilesRoot(fakeHome), "profile-smoke"))).toBe(true);
    expect(existsSync(join(profilesRoot(leverRoot), "profile-smoke"))).toBe(false);
    expect(manifestCalls[0]?.cacheFile).toBe(join(profilesRoot(fakeHome), "manifest.json"));
  });

  it("RED-proof: the lever in a PACKAGED build is ignored even with ANYCODE_AUTOMATION=1", async () => {
    mockIsPackaged.current = true;
    process.env.ANYCODE_AUTOMATION = "1";
    delete process.env.ANYCODE_SETTINGS_PATH;
    delete process.env.ANYCODE_SECRETS_PATH;

    await bootAndCreateProfile();

    expect(existsSync(join(profilesRoot(fakeHome), "profile-smoke"))).toBe(true);
    expect(existsSync(join(profilesRoot(leverRoot), "profile-smoke"))).toBe(false);
    expect(manifestCalls[0]?.cacheFile).toBe(join(profilesRoot(fakeHome), "manifest.json"));
  });
});

describe("main/index.ts — host fork env forward of the lever (W4-F0b, Fable ruling iter-10)", () => {
  it("forwards the vetted lever into the host fork env when the double gate is satisfied", async () => {
    process.env.ANYCODE_AUTOMATION = "1";
    process.env.ANYCODE_SETTINGS_PATH = join(scratch, "settings.json");
    process.env.ANYCODE_SECRETS_PATH = join(scratch, "secrets.json");

    await import("./index.js");
    await waitForHandler(CODEX_PROFILE_CREATE_CHANNEL);

    // refreshProviderState (and with it buildHostEnvFor) is awaited BEFORE the
    // codex registration site, so by now the scrub ran at least once.
    expect(hostEnvScrubCalls.length).toBeGreaterThan(0);
    for (const call of hostEnvScrubCalls) {
      expect(call.override).toBe(leverRoot);
      expect(call.varAfter).toBe(leverRoot);
    }
  });

  it("RED-proof (main-scrub): an ambient lever with the gate refused is structurally DELETED from the buildHostEnvFor output", async () => {
    // The ambient var IS in process.env (beforeEach) and therefore in the
    // bootEnv snapshot buildHostEnv spreads — but automation is off, so the
    // gate yields null and the delete branch must strip it from the fork env.
    delete process.env.ANYCODE_AUTOMATION;
    delete process.env.ANYCODE_SETTINGS_PATH;
    delete process.env.ANYCODE_SECRETS_PATH;

    await import("./index.js");
    await waitForHandler(CODEX_PROFILE_CREATE_CHANNEL);

    expect(hostEnvScrubCalls.length).toBeGreaterThan(0);
    for (const call of hostEnvScrubCalls) {
      expect(call.override).toBeNull();
      expect(call.varAfter).toBeUndefined();
    }
  });

  it("RED-proof (main-scrub): a PACKAGED build refuses the gate and strips the ambient lever the same way", async () => {
    mockIsPackaged.current = true;
    process.env.ANYCODE_AUTOMATION = "1";
    delete process.env.ANYCODE_SETTINGS_PATH;
    delete process.env.ANYCODE_SECRETS_PATH;

    await import("./index.js");
    await waitForHandler(CODEX_PROFILE_CREATE_CHANNEL);

    expect(hostEnvScrubCalls.length).toBeGreaterThan(0);
    for (const call of hostEnvScrubCalls) {
      expect(call.override).toBeNull();
      expect(call.varAfter).toBeUndefined();
    }
  });
});

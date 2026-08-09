/**
 * Production-wiring regression test (TASK.102 CUT-S2 §10.9.3 F4, review
 * findings from commit `ddc2705`): proves that `main/index.ts` — not just the
 * pure policy function it delegates to — really SUPPLIES
 * `TabHostManagerDeps.resolveProviderConnection` when it constructs the
 * `TabHostManager`, and that the closure it wires resolves a providerId
 * through the REAL, LIVE settings snapshot main maintains (not a boot-time
 * copy).
 *
 * `shared/settings.test.ts` proves `resolveProviderConnection(settings,
 * providerId)` is correct in isolation — it never imports main/index.ts, so
 * it cannot catch the composition root failing to pass that function to
 * `TabHostManager` at all (F4's original defect: the dependency was declared
 * on `TabHostManagerDeps` and never supplied). `main/tabs.test.ts` injects
 * its OWN fake `resolveProviderConnection` straight into `TabHostManager`'s
 * constructor, which proves `spawnChild` USES the dep correctly but is blind
 * to whether `main/index.ts` wires a real one — exactly the pattern that let
 * F4 hide from every existing suite. This file closes that gap the same way
 * index.appVersion-wiring.test.ts closes it for `getAppVersion`: boot the
 * real composition root and observe the actual dependency it constructs
 * `TabHostManager` with.
 *
 * Capture technique: `TabHostManager.spawnChild` only calls
 * `resolveProviderConnection` deep inside the child-spawn control-plane
 * message handler, reachable only from a running host's own process message
 * — too heavy a rig for a wiring test and not this file's concern (that
 * behavior belongs to tabs.test.ts, owned elsewhere). Instead, `./tabs.js` is
 * mocked as a TRANSPARENT wrap (same convention as index.codexProfilesHome-
 * wiring.test.ts's `./host-env.js` wrap): the real `TabHostManager` class is
 * kept, subclassed only to record the `deps` object main's composition root
 * actually passes to `new TabHostManager(...)`. Every other line of
 * `main/index.ts`'s real boot path — settings load, custom-provider IPC,
 * connection IPC, onMutation reload — runs unmocked. The captured
 * `resolveProviderConnection` closure is then called DIRECTLY, so this test
 * exercises the identical function `spawnChild` would call, without needing
 * to drive a full child-spawn message round trip through a fake host
 * process.
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
import type { TabHostManagerDeps } from "./tabs.js";

// Not statically imported from ./provider-ipc.js: that module chain-imports
// "electron" too, and a top-level import of it here resolves before this
// file's own `vi.mock("electron", ...)` factory has finished hoisting,
// throwing "Cannot access 'FakeBrowserWindow' before initialization" (same
// reason ./index.js itself is only ever dynamically imported inside each
// `it` below). Duplicated literal — provider-ipc.ts holds the source of
// truth — same "duplicated on purpose" convention as index.providerReady-
// wiring.test.ts.
const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
type CustomProviderMutationResult =
  | { ok: true; providers: Array<{ id: string }> }
  | { ok: false; reason: string };

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so both capturing cells exist before vi.mock's hoisted
// factories below close over them (same pattern as every other index.*-
// wiring.test.ts file). `capturedDeps` holds ONLY the latest boot's deps —
// each test performs exactly one boot, and beforeEach resets it, so there is
// no cross-boot bleed to filter (unlike codexProfilesHome-wiring.test.ts's
// shared call arrays, which accumulate across a suite that boots more than
// once per describe block's shared state).
const { ipcHandlers, capturedDeps } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  capturedDeps: { current: undefined as TabHostManagerDeps | undefined },
}));

// Transparent wrap around the real TabHostManager (host-env.js wrap
// convention, index.codexProfilesHome-wiring.test.ts): the real class runs
// unmodified — this only records the `deps` object main/index.ts's
// composition root actually constructs it with, so `resolveProviderConnection`
// below is the IDENTICAL closure `spawnChild` would call, not a re-derived
// stand-in. Deleting or breaking the wiring line in main/index.ts changes
// what lands in `capturedDeps.current`, which is the whole point.
vi.mock("./tabs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tabs.js")>();
  class CapturingTabHostManager extends real.TabHostManager {
    constructor(deps: TabHostManagerDeps) {
      super(deps);
      capturedDeps.current = deps;
    }
  }
  return { ...real, TabHostManager: CapturingTabHostManager };
});

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
    // No test in this file ever calls tab-create — resolveProviderConnection
    // is exercised by calling the captured closure directly — so fork never
    // needs to return a usable process.
    fork: vi.fn(),
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
// non-deterministic, and irrelevant to the resolveProviderConnection wiring
// this file tests. Mocked to a fast, side-effect-free controller.
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
  capturedDeps.current = undefined;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-resolveproviderconn-"));
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

describe("main/index.ts — resolveProviderConnection production wiring (F4)", () => {
  it("a configured+active connection for a providerId resolves to its connection id through the REAL, live settings", async () => {
    await import("./index.js");

    const handleCustomCreate = await waitForHandler(CUSTOM_PROVIDER_CREATE_CHANNEL);
    const handleConnectionCreate = await waitForHandler(CONNECTION_CREATE_CHANNEL);

    // By the time main/index.ts has registered these two IPC channels, the
    // `new TabHostManager(...)` call (earlier in the same whenReady callback)
    // has already run — this is the assertion F4's original defect breaks:
    // the dependency was declared on TabHostManagerDeps but never supplied.
    expect(capturedDeps.current?.resolveProviderConnection).toBeTypeOf("function");

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
    // handleConnectionCreate) — this is the connection an explicit
    // `Agent(tier:"session", provider:customId)` spawn is supposed to land on.
    const connectionResult = (await handleConnectionCreate({}, {
      providerId: customId,
      model: "claude-bridge-model",
    })) as SettingsMutationResult;
    expect(connectionResult).toMatchObject({ ok: true });
    const createdConnectionId = connectionResult.ok ? connectionResult.createdConnectionId : undefined;
    expect(createdConnectionId).toBeDefined();

    // settings-ipc.ts's emitMutation is awaited INSIDE persistProvider, before
    // handleConnectionCreate's promise resolves — main/index.ts's onMutation
    // hook has already reloaded the module-level `settings` snapshot the
    // captured closure below reads by the time this line runs; nothing here
    // is polled for.
    expect(capturedDeps.current?.resolveProviderConnection?.(customId as string)).toBe(createdConnectionId);
  });

  it("a providerId with no usable connection resolves to nothing, so the caller can refuse the spawn closed", async () => {
    await import("./index.js");

    // No connection is ever created in this test — the freshly-booted
    // settings snapshot has an empty `provider.connections`.
    await waitForHandler(CUSTOM_PROVIDER_CREATE_CHANNEL);

    expect(capturedDeps.current?.resolveProviderConnection).toBeTypeOf("function");
    expect(capturedDeps.current?.resolveProviderConnection?.("anthropic")).toBeUndefined();
  });
});

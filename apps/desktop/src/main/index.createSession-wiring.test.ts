/**
 * boots the REAL
 * `main/index.ts` and drives the `create_session` hook through the object main
 * hands to `createCommunicationController`. That is the only way to prove the
 * WIRING, not just the extracted function:
 *
 * - the deps bag must read the tab manager at CALL time (boot builds the bag
 *   BEFORE `manager` is assigned — snapshotting it froze `null`, so every
 *   `create_session` answered `not_ready`),
 * - the pin must be primed through the REAL `primeNewSessionPin` /
 *   `resolveResumePin` chain before `createTab`, or a NON-active connection's
 *   fork env is a cache miss and the tab dies fail-closed as `crash_looped`.
 *
 * Two connections: the ACTIVE
 * DeepSeek one and a non-active GLM one. The assertion is the fork env main
 * really passes to `utilityProcess.fork`.
 *
 * Boot mechanics mirror index.codexSupportPolicy-wiring.test.ts: `node:os`
 * homedir and `app.getPath` point into a scratch dir, so this never reads or
 * writes the developer's real `~/.anycode`.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_SET_ACTIVE_CHANNEL, CONNECTION_DELETE_CHANNEL } from "../shared/settings.js";
import { TAB_CREATE_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

interface CreateSessionRequest {
  workspace: string;
  engine?: "core" | "codex" | "claude";
  model?: string;
  handle?: string;
}
interface CreateSessionOutcome {
  ok: boolean;
  reason?: string;
  detail?: string;
  sessionId?: string;
  tabId?: string;
}
interface CapturedDeps {
  createSessionByAgent?: (request: CreateSessionRequest) => Promise<CreateSessionOutcome>;
}
interface ForkCall {
  env: NodeJS.ProcessEnv;
  host: FakeHostProcess;
}

const { ipcHandlers, forkCalls, scratchRef, captured, buildGate } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  forkCalls: [] as ForkCall[],
  scratchRef: { userData: "", home: "" },
  captured: { deps: null as CapturedDeps | null, mutation: null as null | ((settings: import("../shared/settings.js").AnycodeSettings) => void | Promise<void>) },
  buildGate: { hook: undefined as undefined | ((id: string | undefined, settings: import("../shared/settings.js").AnycodeSettings) => void | Promise<void>) },
}));


vi.mock("./host-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-env.js")>();
  return { ...actual, buildHostEnv: async (...args: Parameters<typeof actual.buildHostEnv>) => {
    await buildGate.hook?.(args[0].settings.provider.activeConnectionId, args[0].settings);
    const env = await actual.buildHostEnv(...args);
    env.ANYCODE_API_KEY = args[0].settings.provider.connections?.some((connection) => connection.model === "glm-refreshed") && args[0].settings.provider.activeConnectionId === "conn-glm"
      ? "test-key-refreshed" : `test-key-${args[0].settings.provider.activeConnectionId}`;
    return env;
  } };
});

vi.mock("./provider-ipc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-ipc.js")>();
  return { ...actual, registerProviderIpc: (deps: Parameters<typeof actual.registerProviderIpc>[0]) => {
    captured.mutation = deps.onMutation ?? null;
    return actual.registerProviderIpc(deps);
  } };
});

class FakeHostProcess extends EventEmitter {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
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
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0-test",
    getAppPath: () => "/fake/app",
    // The communication stores (agent projects, session switches) live under
    // userData — a scratch dir, never the developer's.
    getPath: () => scratchRef.userData,
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
    fork: vi.fn((_entry: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const host = new FakeHostProcess();
      forkCalls.push({ env: options.env, host });
      return host;
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

// The vault, settings defaults and the workspace-trust store are all
// homedir-derived: every one of them must land in the scratch home.
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => scratchRef.home };
});

// Codex discovery/doctor is real subprocess probing — inert here.
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

/**
 * Captures the deps object main hands the Sessions API controller — that object
 * IS the `create_session` production path. The real server is never started
 * (no listener, no discovery file), everything else stays REAL.
 */
vi.mock("./communication-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./communication-controller.js")>();
  return {
    ...actual,
    createCommunicationController: (deps: CapturedDeps) => {
      captured.deps = deps;
      return {
        apply: async () => ({ state: "off", workspaces: 0, sessions: 0 }),
        regenerateToken: async () => ({ ok: false, reason: "not_running" }),
        status: () => ({ state: "off", workspaces: 0, sessions: 0 }),
        discoveryFile: () => undefined,
        dispose: async () => undefined,
      };
    },
  };
});

let dir: string;
let workspace: string;
/**
 * The app's own environment (this suite may run inside AnyCode, which exports
 * ANYCODE_MODEL/ANYCODE_BASE_URL/recognizer carriers). A clean launch has none
 * of them, and `buildHostEnv` fills blanks from settings — so a leaked value
 * would both mask the pinned env and copy the developer's real config into a
 * fork. Stashed and removed for the whole file.
 */
let savedAmbient: Record<string, string | undefined> = {};

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

/** The canonical workspace key both the trust store and the project switch are keyed by. */
async function canonicalKey(path: string): Promise<string> {
  return realpath(path);
}

beforeEach(async () => {
  ipcHandlers.clear();
  forkCalls.length = 0;
  captured.deps = null;
  captured.mutation = null;
  buildGate.hook = undefined;
  vi.resetModules();
  savedAmbient = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ANYCODE_")) {
      savedAmbient[key] = process.env[key];
      delete process.env[key];
    }
  }
  dir = await mkdtemp(join(tmpdir(), "anycode-index-createsession-"));
  scratchRef.home = join(dir, "home");
  scratchRef.userData = join(dir, "userdata");
  workspace = join(dir, "ws");
  await mkdir(scratchRef.home, { recursive: true });
  await mkdir(scratchRef.userData, { recursive: true });
  await mkdir(workspace, { recursive: true });

  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = join(dir, "settings.json");
  process.env.ANYCODE_SECRETS_PATH = join(dir, "secrets.json");
  process.env.ANYCODE_DB_PATH = ":memory:";
  delete process.env.ELECTRON_RENDERER_URL;
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;

  const key = await canonicalKey(workspace);
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 2,
      provider: {
        // Active: DeepSeek. Non-active: the GLM coding plan from the card —
        // it only works when ITS env is primed before the fork.
        connections: [
          { id: "conn-active", providerId: "custom", model: "deepseek-flash", authOptional: true },
          { id: "conn-glm", providerId: "custom", model: "glm-5.3", authOptional: true },
        ],
        activeConnectionId: "conn-active",
      },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    }),
  );
  // The folder is trusted (the `create_session` gate) and the project switch
  // is ON (also a gate). Both are main-owned files, seeded the way the UI
  // would leave them.
  await mkdir(join(scratchRef.home, ".anycode"), { recursive: true });
  await writeFile(
    join(scratchRef.home, ".anycode", "workspace-trust.json"),
    JSON.stringify({ version: 1, folders: { [key]: { decision: "trusted", hash: "h", decidedAt: "2026-10-26T00:00:00.000Z" } } }),
  );
  await writeFile(join(scratchRef.userData, "communication-agent-projects.json"), JSON.stringify({ [key]: true }));
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("ANYCODE_")) delete process.env[key];
  for (const [key, value] of Object.entries(savedAmbient)) if (value !== undefined) process.env[key] = value;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Boots main and returns the captured create_session hook (after the tab manager exists). */
async function boot(): Promise<(request: CreateSessionRequest) => Promise<CreateSessionOutcome>> {
  await import("./index.js");
  // TAB_CREATE is registered after `manager = new TabHostManager(...)`, so its
  // presence proves boot reached the post-manager wiring.
  const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
  await waitForHandler("anycode:custom-provider-create");
  const deps = captured.deps;
  if (deps?.createSessionByAgent === undefined) throw new Error("main did not wire createSessionByAgent");
  // A control tab-create proves the manager itself is live in this boot.
  const control = (await handleTabCreate({}, { kind: "new", workspace })) as CreateTabResult;
  expect(control.ok).toBe(true);
  forkCalls.length = 0;
  return deps.createSessionByAgent;
}

describe("main/index.ts — create_session on a NON-active connection reaches the fork", () => {
  it("opens the GLM connection's tab with ITS env instead of crash_looping on a cache miss", async () => {
    const create = await boot();

    const outcome = await create({ workspace, engine: "core", model: "glm-5.3" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`create_session refused: ${JSON.stringify(outcome)}`);

    expect(forkCalls).toHaveLength(1);
    const env = forkCalls[0]!.env;
    // The pinned connection IS the requested one — not the active DeepSeek one,
    // and not a refusal that would have left the tab crash_looped.
    expect(env.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    expect(env.ANYCODE_MODEL).toBe("glm-5.3");
    // the host can only record its own crash if main
    // stamps the diagnostics directory into its env — this is the file the
    // user (and the next session) can read when a tab dies.
    expect(env.ANYCODE_DIAGNOSTICS_DIR).toBe(join(scratchRef.userData, "diagnostics"));
  }, 30_000);

  it("keeps the active connection as the default when no model is named", async () => {
    const create = await boot();

    const outcome = await create({ workspace, engine: "core" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`create_session refused: ${JSON.stringify(outcome)}`);
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]!.env.ANYCODE_CONNECTION_ID).toBe("conn-active");
    expect(forkCalls[0]!.env.ANYCODE_MODEL).toBe("deepseek-flash");
  }, 30_000);
});

it("keeps an active pin reserved and primed when settings switch during admission", async () => {
  const create = await boot();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  buildGate.hook = async (id) => {
    if (id === "conn-active") { buildGate.hook = undefined; entered(); await paused; }
  };
  const pending = create({ workspace, engine: "core", model: "deepseek-flash" });
  await started;
  const remove = await waitForHandler(CONNECTION_DELETE_CHANNEL);
  expect(await remove({}, { id: "conn-active" })).toMatchObject({ ok: false, reason: "connection_in_use" });
  const activate = await waitForHandler(CONNECTION_SET_ACTIVE_CHANNEL);
  expect(await activate({}, { id: "conn-glm" })).toMatchObject({ ok: true });
  release();
  expect(await pending).toMatchObject({ ok: true });
  expect(forkCalls.at(-1)?.env).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-active", ANYCODE_MODEL: "deepseek-flash" });
}, 30_000);

it("serializes overlapping provider refreshes before a pinned tab respawns", async () => {
  const create = await boot();
  expect(await create({ workspace, engine: "core", model: "glm-5.3" })).toMatchObject({ ok: true });
  const host = forkCalls.at(-1)!.host;
  const initial = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  initial.provider.connections[1].models = ["glm-old"];
  const fresh = structuredClone(initial);
  fresh.provider.connections[1].models = ["glm-new"];
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  buildGate.hook = async (id, current) => {
    if (id === "conn-glm" && current.provider.connections.some((connection) => connection.models?.includes("glm-old"))) { buildGate.hook = undefined; entered(); await paused; }
  };
  const mutate = captured.mutation!;
  const first = mutate(initial);
  await started;
  let secondFinished = false;
  const second = Promise.resolve(mutate(fresh)).then(() => { secondFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(secondFinished).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(secondFinished).toBe(true);
  host.emit("exit", 1);
  expect(forkCalls.at(-1)?.env.ANYCODE_CONNECTION_ID).toBe("conn-glm");
}, 30_000);

it("uses the newly active connection credentials while its refresh is paused", async () => {
  const create = await boot();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  buildGate.hook = async (id) => {
    if (id === "conn-glm") { buildGate.hook = undefined; entered(); await paused; }
  };
  const activate = await waitForHandler(CONNECTION_SET_ACTIVE_CHANNEL);
  const switching = activate({}, { id: "conn-glm" });
  await started;
  expect(await create({ workspace, engine: "core", model: "glm-5.3" })).toMatchObject({ ok: true });
  expect(forkCalls.at(-1)?.env).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_MODEL: "glm-5.3", ANYCODE_API_KEY: "test-key-conn-glm" });
  release();
  await switching;
}, 30_000);

it("keeps a prime that finishes after refresh replaces the cache", async () => {
  const create = await boot();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  buildGate.hook = async (id) => {
    if (id === "conn-glm") { buildGate.hook = undefined; entered(); await paused; }
  };
  const pending = create({ workspace, engine: "core", model: "glm-5.3" });
  await started;
  const fresh = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  await captured.mutation!(fresh);
  release();
  expect(await pending).toMatchObject({ ok: true });
  const host = forkCalls.at(-1)!.host;
  expect(forkCalls.at(-1)?.env).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_MODEL: "glm-5.3", ANYCODE_API_KEY: "test-key-conn-glm" });
  host.emit("exit", 1);
  expect(forkCalls.at(-1)?.env).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_API_KEY: "test-key-conn-glm" });
}, 30_000);


it("defers an existing pinned host's respawn until refreshed settings are ready", async () => {
  const create = await boot();
  await create({ workspace, engine: "core", model: "glm-5.3" });
  const host = forkCalls.at(-1)!.host;
  const fresh = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  fresh.provider.connections[1].model = "glm-refreshed";
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  buildGate.hook = async (id) => { if (id === "conn-active") { buildGate.hook = undefined; entered(); await paused; } };
  const refresh = captured.mutation!(fresh);
  await started;
  const count = forkCalls.length;
  host.emit("exit", 1);
  expect(forkCalls).toHaveLength(count);
  release();
  await refresh;
  await vi.waitFor(() => expect(forkCalls).toHaveLength(count + 1));
  expect(forkCalls.at(-1)!.env).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_MODEL: "glm-refreshed", ANYCODE_API_KEY: "test-key-refreshed" });
}, 30_000);

it("registers managed plugin role discovery for Settings", async () => {
  const root = join(scratchRef.home, ".anycode/plugins/.store/demo/1.0.0");
  await mkdir(join(root, ".anycode-plugin"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, ".anycode-plugin/plugin.json"), JSON.stringify({ manifestVersion: 1, name: "demo", version: "1.0.0", agents: ["agents"] }));
  const profile = join(root, "agents/reviewer.md");
  await writeFile(profile, "---\nname: reviewer\ndescription: reviews\n---\nbody\n");
  await writeFile(join(scratchRef.home, ".anycode/plugins/state.json"), JSON.stringify({ version: 1, plugins: { demo: { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } }, removedDefaults: [], disabled: [] }));
  await boot();
  const list = await waitForHandler("anycode:subagents-list");
  const snapshot = await list({}, {});
  expect(snapshot).toMatchObject({ roleClaims: expect.arrayContaining([{ name: "reviewer", path: profile }]) });
}, 30_000);

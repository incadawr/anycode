/**
 * TASK.133 / Taskana 4117 — production-wiring regression test for the
 * per-connection proxy fetch + updater session routing in main/index.ts.
 *
 * Same rig family as index.appVersion-wiring.test.ts (scratch dev-profile
 * boot of the REAL main/index.ts, every Electron primitive mocked) extended
 * with `session.fromPartition` (records setProxy calls per partition name)
 * and `net.request`. `./provider-ipc.js`, `./token-broker.js`, `./oauth.js`
 * and `./updater.js` are TRANSPARENT wraps that record the deps bags main's
 * composition root constructs them with, so the assertions exercise the
 * identical closures production uses.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_REF_SET_CHANNEL } from "../shared/proxy.js";
import { UPDATE_CHECK_CHANNEL } from "../shared/updates.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so the capturing cells exist before the hoisted vi.mock
// factories close over them (same pattern as every other index.*-wiring file).
const { ipcHandlers, captured, fakeSessions, netRequests, electronRefs } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, IpcHandler>();
  const captured = {
    providerIpcDeps: [] as unknown[],
    tokenBrokerDeps: [] as unknown[],
    oauthDeps: [] as unknown[],
    updaterDeps: [] as unknown[],
    updaterLoginListeners: [] as unknown[],
  };
  /** partition name -> { setProxyCalls, closeAllConnectionsCalls, clearAuthCacheCalls } */
  const fakeSessions = new Map<
    string,
    { setProxyCalls: unknown[]; closeAllConnectionsCalls: number; clearAuthCacheCalls: number }
  >();
  const netRequests: unknown[] = [];
  const electronRefs = {
    appIsPackaged: { current: false as boolean },
    /**
     * Per-partition injectable failures (TASK.133 defect 3 regression rig).
     * The PRODUCTION wiring obtains its session object from
     * `session.fromPartition` below, whose methods consult this shared
     * backing — so an injected failure is guaranteed to be the one
     * production hits (a fresh wrapper per call can never be poisoned).
     */
    sessionFailures: {
      current: {} as {
        setProxy?: (config: unknown) => Promise<void> | never;
        closeAllConnections?: () => Promise<void>;
        clearAuthCache?: () => Promise<void>;
      },
    },
  };
  return { ipcHandlers, captured, fakeSessions, netRequests, electronRefs };
});

/**
 * Stable per-partition session object. `fromPartition` in the electron mock
 * returns THE SAME object for a given name, and every method reads the shared
 * `sessionFailures` backing FIRST — failure injection reaches production.
 */
function fakeSessionFor(name: string): {
  setProxyCalls: unknown[];
  closeAllConnectionsCalls: number;
  clearAuthCacheCalls: number;
  setProxy(config: unknown): Promise<void>;
  closeAllConnections(): Promise<void>;
  clearAuthCache(): Promise<void>;
} {
  let entry = fakeSessions.get(name);
  if (entry === undefined) {
    entry = { setProxyCalls: [], closeAllConnectionsCalls: 0, clearAuthCacheCalls: 0 };
    fakeSessions.set(name, entry);
  }
  const e = entry;
  const session = {
    get setProxyCalls() {
      return e.setProxyCalls;
    },
    get closeAllConnectionsCalls() {
      return e.closeAllConnectionsCalls;
    },
    get clearAuthCacheCalls() {
      return e.clearAuthCacheCalls;
    },
    setProxy: async (config: unknown): Promise<void> => {
      const fail = electronRefs.sessionFailures.current.setProxy;
      if (fail !== undefined) {
        await fail(config); // injected failure — throw must reach production
        return;
      }
      e.setProxyCalls.push(config);
    },
    closeAllConnections: async () => {
      const fail = electronRefs.sessionFailures.current.closeAllConnections;
      if (fail !== undefined) {
        await fail();
        return;
      }
      e.closeAllConnectionsCalls += 1;
    },
    clearAuthCache: async () => {
      const fail = electronRefs.sessionFailures.current.clearAuthCache;
      if (fail !== undefined) {
        await fail();
        return;
      }
      e.clearAuthCacheCalls += 1;
    },
  };
  return session;
}

/** Recursively collects message/cause text from an error chain. */
function collectErrorText(err: unknown, depth = 0): string[] {
  if (err === null || err === undefined || depth > 6 || typeof err !== "object") {
    return [String(err)];
  }
  const parts: string[] = [];
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    parts.push(message);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    parts.push(...collectErrorText(cause, depth + 1));
  }
  return parts;
}

/** Minimal fake BrowserWindow (same as index.appVersion-wiring.test.ts). */
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
    // Read through a ref cell so a test can flip isPackaged AFTER import —
    // index.ts closes over `app.isPackaged` at registerUpdater time, so each
    // test boots with the value it needs (updater routing needs packaged).
    get isPackaged() {
      return electronRefs.appIsPackaged.current;
    },
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
  session: {
    // fresh wrapper per call, but state is the MEMOIZED shared entry and every
    // method consults the shared sessionFailures backing — injections reach
    // whichever wrapper production holds.
    fromPartition: (name: string) => fakeSessionFor(name),
    defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") },
  },
  net: {
    request: vi.fn((opts: unknown) => {
      netRequests.push(opts);
      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        abort: vi.fn(),
      };
    }),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
  },
  utilityProcess: { fork: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: IpcHandler): void => {
      ipcHandlers.set(channel, listener);
    },
    on: vi.fn(),
  },
}));

// electron-updater: capture the "login" listener main registers; the rest inert.
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      on: vi.fn((event: string, listener: unknown) => {
        if (event === "login") {
          captured.updaterLoginListeners.push(listener);
        }
        return undefined;
      }),
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
    },
  },
}));

// Transparent wraps: the real modules run; only the deps bags are recorded.
vi.mock("./provider-ipc.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./provider-ipc.js")>();
  return {
    ...real,
    registerProviderIpc: (deps: unknown) => {
      captured.providerIpcDeps.push(deps);
      return real.registerProviderIpc(deps as Parameters<typeof real.registerProviderIpc>[0]);
    },
  };
});
vi.mock("./token-broker.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./token-broker.js")>();
  return {
    ...real,
    TokenBroker: class extends real.TokenBroker {
      constructor(deps: ConstructorParameters<typeof real.TokenBroker>[0]) {
        super(deps);
        captured.tokenBrokerDeps.push(deps);
      }
    },
  };
});
vi.mock("./oauth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./oauth.js")>();
  return {
    ...real,
    OAuthEngine: class extends real.OAuthEngine {
      constructor(deps: ConstructorParameters<typeof real.OAuthEngine>[0]) {
        super(deps);
        captured.oauthDeps.push(deps);
      }
    },
  };
});
vi.mock("./updater.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./updater.js")>();
  return {
    ...real,
    registerUpdater: (deps: Parameters<typeof real.registerUpdater>[0]) => {
      captured.updaterDeps.push(deps);
      return real.registerUpdater(deps);
    },
  };
});

// Codex discovery/doctor: real subprocess probing, irrelevant here.
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
let settingsPath: string;

async function waitForHandler(channel: string, timeoutMs = 8000): Promise<IpcHandler> {
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

/** Seeds the app-scope proxy config into the scratch settings.json. */
function seedNetwork(network: unknown): void {
  const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...doc, network }));
}

beforeEach(async () => {
  ipcHandlers.clear();
  captured.providerIpcDeps.length = 0;
  captured.tokenBrokerDeps.length = 0;
  captured.oauthDeps.length = 0;
  captured.updaterDeps.length = 0;
  captured.updaterLoginListeners.length = 0;
  fakeSessions.clear();
  netRequests.length = 0;
  electronRefs.appIsPackaged.current = false;
  electronRefs.sessionFailures.current = {};
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-proxypy-"));
  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = settingsPath = join(dir, "settings.json");
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

/** Seeds a vault-backed proxy-profile password into the scratch secrets.json (plaintext tier: no OS keychain in tests). */
function seedProxyPassword(profileId: string, password: string): void {
  const { readFileSync: rf, writeFileSync: wf } = require("node:fs") as typeof import("node:fs");
  const path = join(dir, "secrets.json");
  let entries: Record<string, unknown> = {};
  try {
    entries = (JSON.parse(rf(path, "utf8")) as { entries?: Record<string, unknown> }).entries ?? {};
  } catch {
    /* no file yet */
  }
  entries[`proxy.profile.${profileId}.password`] = { cipher: "plaintext", value: password };
  wf(path, JSON.stringify({ version: 1, entries }));
}

/** Overwrites the scratch settings.json wholesale (pre-boot seeding). */
function seedSettings(over: Record<string, unknown>): void {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      version: 2,
      provider: { connections: [] },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
      ...over,
    }),
  );
}

describe("main/index.ts — TASK.133 proxy wiring", () => {
  it("wires the production per-connection fetch into all three seams", async () => {
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    expect(captured.providerIpcDeps.at(-1)).toMatchObject({ connectionFetch: expect.any(Function) });
    expect(captured.tokenBrokerDeps.at(-1)).toMatchObject({ fetchFor: expect.any(Function) });
    expect(captured.oauthDeps.at(-1)).toMatchObject({ fetchFor: expect.any(Function) });
    expect(captured.updaterDeps.at(-1)).toMatchObject({ beforeNetwork: expect.any(Function) });
    expect(captured.updaterLoginListeners.length).toBeGreaterThan(0);
  });

  it("no proxy setting: NO partition is ever touched", async () => {
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    expect(fakeSessions.size).toBe(0);
  });

  it("app-scope manual proxy (seeded pre-boot): updater partition configured, scheme preserved", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128" }], proxyRef: "proxy-a" } });
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    // The bypass list is the canonical loopback-default translation
    // (supervisor correction 5: effectiveNoProxy incl. loopback).
    expect(fakeSessionFor("electron-updater").setProxyCalls).toContainEqual({
      mode: "fixed_servers",
      proxyRules: "https://proxy.corp:3128",
      proxyBypassRules: "localhost,*.localhost,127.0.0.1,*.127.0.0.1,[::1]",
    });
  });

  it("clearing the app proxy resets a previously managed updater partition to system defaults", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128" }], proxyRef: "proxy-a" } });
    await import("./index.js");
    const handleProxyRefSet = await waitForHandler(PROXY_REF_SET_CHANNEL);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    expect(fakeSessionFor("electron-updater").setProxyCalls.length).toBeGreaterThan(0);
    // Drive main's REAL mutation path: proxy-ref-set with ref:null deletes
    // network.proxyRef and fires onMutation, which refreshes the live
    // module-level settings the routing decision reads.
    const result = (await handleProxyRefSet({}, { scope: { kind: "app" }, ref: null })) as { ok: boolean };
    expect(result.ok).toBe(true);
    await beforeNetwork();
    expect(fakeSessionFor("electron-updater").setProxyCalls.at(-1)).toEqual({ mode: "system" });
  });

  it("misconfigured app proxy: the routing gate throws a fixed credential-free error and no provider partition is touched", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-bad", name: "Bad", mode: "manual", url: "proxy.corp" }], proxyRef: "proxy-bad" } });
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await expect(beforeNetwork()).rejects.toThrowError(/proxy is configured but unusable/);
    for (const [name, entry] of fakeSessions) {
      if (name.startsWith("anycode-proxy-")) {
        expect(entry.setProxyCalls).toEqual([]);
      }
    }
  });

  it("REGRESSION defect2: password rotation at the same host:port flushes closeAllConnections + clearAuthCache and re-arms the login handler", async () => {
    // Production plumbing: the password lives in the VAULT
    // (proxy.profile.<id>.password), the profile carries only `login`.
    const seedRotated = (password: string | undefined): void => {
      seedSettings({
        network: {
          proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "http://proxy.corp:3128", login: "u" }],
          proxyRef: "proxy-a",
        },
      });
      if (password !== undefined) {
        seedProxyPassword("proxy-a", password);
      }
    };
    seedRotated("pw-one");
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    const loginHandler = captured.updaterLoginListeners.at(-1) as
      | ((authInfo: { isProxy: boolean; host: string; port: number }, cb: (u?: string, p?: string) => void) => void)
      | undefined;
    expect(loginHandler).toBeInstanceOf(Function);
    const challenge = (cb: (u?: string, p?: string) => void) =>
      loginHandler?.({ isProxy: true, host: "proxy.corp", port: 3128 }, cb);
    await beforeNetwork();
    const creds1: string[] = [];
    challenge((u, p) => creds1.push(`${u}:${p}`));
    const flushCount1 = fakeSessionFor("electron-updater").closeAllConnectionsCalls;
    // Rotate the password in the vault at the SAME host:port, then refresh
    // main's live settings + password cache through the real mutation channel.
    seedProxyPassword("proxy-a", "pw-two");
    const handleProxyRefSet = await waitForHandler(PROXY_REF_SET_CHANNEL);
    await handleProxyRefSet({}, { scope: { kind: "app" }, ref: "proxy-a" }); // re-pin -> reload + onMutation
    await beforeNetwork();
    const ses2 = fakeSessionFor("electron-updater");
    expect(ses2.closeAllConnectionsCalls).toBeGreaterThan(flushCount1); // auth cache + sockets flushed
    expect(ses2.clearAuthCacheCalls).toBeGreaterThanOrEqual(1);
    const creds2: string[] = [];
    challenge((u, p) => creds2.push(`${u}:${p}`));
    expect(creds1[0]).not.toBe(creds2[0]); // the CURRENT password answers, not a boot-time capture
    expect(creds1[0]).toContain("pw-one");
    expect(creds2[0]).toContain("pw-two");
    // Unrelated proxy host: no credentials, ever.
    const unrelated: Array<[string, string]> = [];
    loginHandler?.({ isProxy: true, host: "evil.example", port: 3128 }, (u, p) => unrelated.push([u ?? "", p ?? ""]));
    expect(unrelated).toEqual([["", ""]]);
  });

  it("REGRESSION defect2: an HTTPS proxy with no explicit port authenticates on 443, not 80", async () => {
    seedSettings({
      network: { proxyProfiles: [{ id: "proxy-s", name: "S", mode: "manual", url: "https://proxy.corp", login: "u" }], proxyRef: "proxy-s" },
    });
    seedProxyPassword("proxy-s", "pw");
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    const loginHandler = captured.updaterLoginListeners.at(-1) as
      | ((authInfo: { isProxy: boolean; host: string; port: number }, cb: (u?: string, p?: string) => void) => void)
      | undefined;
    const answers: Array<[string, string]> = [];
    loginHandler?.({ isProxy: true, host: "proxy.corp", port: 443 }, (u, p) => answers.push([u ?? "", p ?? ""]));
    expect(answers.at(-1)).toEqual(["u", "pw"]); // credentials supplied for the https default port 443
    loginHandler?.({ isProxy: true, host: "proxy.corp", port: 80 }, (u, p) => answers.push([u ?? "", p ?? ""]));
    expect(answers.at(-1)).toEqual(["", ""]); // 80 is NOT the configured https default — challenge fails honestly
  });

  it("REGRESSION defect2: removing the app proxy clears credentials and resets the managed partition (flushed)", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128", login: "u" }], proxyRef: "proxy-a" } });
    seedProxyPassword("proxy-a", "pw");
    await import("./index.js");
    const handleProxyRefSet = await waitForHandler(PROXY_REF_SET_CHANNEL);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    const loginHandler = captured.updaterLoginListeners.at(-1) as
      | ((authInfo: { isProxy: boolean; host: string; port: number }, cb: (u?: string, p?: string) => void) => void)
      | undefined;
    const withCreds: Array<[string, string]> = [];
    loginHandler?.({ isProxy: true, host: "proxy.corp", port: 3128 }, (u, p) => withCreds.push([u ?? "", p ?? ""]));
    expect(withCreds).toEqual([["u", "pw"]]);
    await handleProxyRefSet({}, { scope: { kind: "app" }, ref: null }); // remove
    await beforeNetwork();
    const ses = fakeSessionFor("electron-updater");
    expect(ses.setProxyCalls.at(-1)).toEqual({ mode: "system" }); // reset of a WE-managed partition
    expect(ses.closeAllConnectionsCalls).toBeGreaterThanOrEqual(1); // flushed, not just re-set
    expect(ses.clearAuthCacheCalls).toBeGreaterThanOrEqual(1);
    const after: Array<[string, string]> = [];
    loginHandler?.({ isProxy: true, host: "proxy.corp", port: 3128 }, (u, p) => after.push([u ?? "", p ?? ""]));
    expect(after).toEqual([["", ""]]); // stale credentials cleared on config removal
  });

  it("REGRESSION defect3: a setProxy failure through the production wiring rejects with a sanitized fixed error — credential-bearing sentinel never leaks", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128", login: "u" }], proxyRef: "proxy-a" } });
    seedProxyPassword("proxy-a", "hunter2");
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    // Poison the UPDATER partition's setProxy through the SHARED backing —
    // production's updaterSession() reads the same backing, so the injected
    // failure is guaranteed to be hit.
    let injected = 0;
    electronRefs.sessionFailures.current.setProxy = async () => {
      injected += 1;
      throw new Error("setProxy rejected for https://u:hunter2@proxy.corp:3128");
    };
    const err = await beforeNetwork().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // UNCONDITIONAL: the injection must have fired and the gate must reject.
    expect(injected).toBe(1);
    expect(err).toBeInstanceOf(Error);
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("proxy.corp");
    expect(err?.message).not.toMatch(/hunter2|proxy\.corp/);
  });

  it("REGRESSION defect3: a flush failure (closeAllConnections quoting the authenticated proxy URL) rejects sanitized and the updater request never runs", async () => {
    // Boot WITH an app proxy, apply it once (partition now managed), then
    // change the credentials so the next beforeNetwork must FLUSH — and
    // poison closeAllConnections with a credential-bearing rejection.
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128", login: "u" }], proxyRef: "proxy-a" } });
    seedProxyPassword("proxy-a", "hunter2");
    await import("./index.js");
    const handleProxyRefSet = await waitForHandler(PROXY_REF_SET_CHANNEL);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork(); // applies fixed_servers → partition managed, configKey recorded
    expect(fakeSessionFor("electron-updater").setProxyCalls.length).toBe(1);
    // Rotate the password: same host:port, different credential — the next
    // decision's configKey differs, so flushSession must run before apply.
    seedProxyPassword("proxy-a", "rotated-secret");
    let injected = 0;
    electronRefs.sessionFailures.current.closeAllConnections = async () => {
      injected += 1;
      throw new Error("closeAllConnections failed for https://u:hunter2@proxy.corp:3128");
    };
    // The settings the gate reads are re-loaded from disk on mutation:
    await handleProxyRefSet({}, { scope: { kind: "app" }, ref: "proxy-a" }); // re-set → reload
    const err = await beforeNetwork().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // UNCONDITIONAL: the injected flush failure fired, the gate rejected, the
    // sanitized message/cause carries no credentials and no proxy host.
    expect(injected).toBe(1);
    expect(err).toBeInstanceOf(Error);
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("rotated-secret");
    expect(text).not.toContain("proxy.corp");
    // Fail-closed: the updater request never runs past the gate (no new
    // setProxy landed — the flush aborted the decision before applyProxy).
    expect(fakeSessionFor("electron-updater").setProxyCalls.length).toBe(1);
  });

  it("REGRESSION defect3: a clearAuthCache flush failure is sanitized too (both flush halves covered)", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128", login: "u" }], proxyRef: "proxy-a" } });
    seedProxyPassword("proxy-a", "hunter2");
    await import("./index.js");
    const handleProxyRefSet = await waitForHandler(PROXY_REF_SET_CHANNEL);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    seedProxyPassword("proxy-a", "rotated-secret");
    let injected = 0;
    electronRefs.sessionFailures.current.clearAuthCache = async () => {
      injected += 1;
      throw new Error("clearAuthCache failed for https://u:hunter2@proxy.corp:3128");
    };
    await handleProxyRefSet({}, { scope: { kind: "app" }, ref: "proxy-a" });
    const err = await beforeNetwork().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(injected).toBe(1);
    expect(err).toBeInstanceOf(Error);
    const text = JSON.stringify(collectErrorText(err));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("rotated-secret");
    expect(text).not.toContain("proxy.corp");
    expect(fakeSessionFor("electron-updater").setProxyCalls.length).toBe(1); // no apply after failed flush
  });

  it("explicit-direct app proxy routes the updater partition to mode direct (removal restores system)", async () => {
    seedSettings({ network: { proxyProfiles: [{ id: "proxy-a", name: "A", mode: "manual", url: "https://proxy.corp:3128" }], proxyRef: "direct" } });
    await import("./index.js");
    await waitForHandler(PROXY_REF_SET_CHANNEL).catch(() => undefined);
    const beforeNetwork = (captured.updaterDeps.at(-1) as { beforeNetwork: () => Promise<void> }).beforeNetwork;
    await beforeNetwork();
    expect(fakeSessionFor("electron-updater").setProxyCalls).toEqual([{ mode: "direct" }]);
  });
});

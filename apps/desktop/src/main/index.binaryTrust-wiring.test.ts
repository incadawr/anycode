/**
 * Production-wiring regression test (TASK.103, D-S4-5): proves that
 * `main/index.ts` — not just settings-ipc.ts's injectable deps bag — really
 * wires a REAL `statBinaryForTrust` (realpathSync -> statSync) into
 * `SettingsIpcDeps`, so the binary-trust grant channel persists a
 * fingerprint that matches the staged binary's ACTUAL on-disk stat, not an
 * injected fake's.
 *
 * settings-ipc.test.ts already proves `handleBinaryTrustGrant`/`Revoke`
 * respect an INJECTED `statBinaryForTrust` seam — it never imports
 * main/index.ts, so it cannot catch main/index.ts's actual wiring silently
 * regressing (e.g. the `statBinaryForTrust`/`platform` lines being deleted
 * from `settingsIpcDeps`, or main falling back to the seam's absent-default
 * `{ok:false, reason:"invalid"}` for every grant). That gap is exactly the
 * discriminating hole this file closes (mirrors index.appVersion-wiring.test.ts's
 * own rationale and mocking discipline).
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BINARY_TRUST_GRANT_CHANNEL, BINARY_TRUST_REVOKE_CHANNEL } from "../shared/settings.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { readTrustedBinaryConsentsSync } from "../settings/files.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so the capturing map exists before vi.mock's hoisted factory
// below closes over it (same pattern as index.appVersion-wiring.test.ts).
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
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
    getVersion: (): string => "0.0.0-test",
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
// non-deterministic, and irrelevant to the binary-trust-grant wiring this
// file tests. Mocked to a fast, side-effect-free controller (same fake as
// index.appVersion-wiring.test.ts).
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
let scratchBin: string;

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
  dir = await mkdtemp(join(tmpdir(), "anycode-index-binarytrust-"));
  // A REAL staged executable, self-owned, in a self-owned directory (`dir`
  // itself, mkdtemp'd 0700) — the grant handler stats it directly, no trust
  // gate involved, so no world-writable staging is needed here.
  scratchBin = join(dir, "staged-codex");
  await writeFile(scratchBin, "#!/bin/sh\nexit 0\n");
  await chmod(scratchBin, 0o755);
  // Dev-profile isolation lever (main/dev-profile.ts, gated on !isPackaged):
  // redirects settings.json/secrets.json off the developer's real ~/.anycode.
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

describe("main/index.ts — binary-trust grant/revoke production wiring (TASK.103, D-S4-5)", () => {
  it("BS8 grants a REAL staged binary: settings.json on disk carries a fingerprint matching the file's live statSync tuple", async () => {
    await import("./index.js");

    const handleGrant = await waitForHandler(BINARY_TRUST_GRANT_CHANNEL);
    const result = (await handleGrant({}, { path: scratchBin })) as SettingsMutationResult;

    expect(result.ok).toBe(true);

    const resolvedPath = realpathSync(scratchBin);
    const liveStat = statSync(resolvedPath);
    const expectedFingerprint = {
      mode: liveStat.mode,
      uid: liveStat.uid,
      gid: liveStat.gid,
      size: liveStat.size,
      mtimeMs: liveStat.mtimeMs,
    };

    // Read settings.json directly off disk — the strongest form of "main
    // really wired the production seam", not just "the handler's return
    // value looked right".
    const onDisk = readTrustedBinaryConsentsSync(process.env.ANYCODE_SETTINGS_PATH);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toEqual({
      path: resolvedPath,
      fingerprint: expectedFingerprint,
      grantedAt: expect.any(String),
    });

    if (result.ok) {
      expect(result.snapshot.settings.security.trustedBinaries).toEqual(onDisk);
    }
  });

  it("BS8 revokes a granted path: settings.json on disk no longer carries it", async () => {
    await import("./index.js");

    const handleGrant = await waitForHandler(BINARY_TRUST_GRANT_CHANNEL);
    const handleRevoke = await waitForHandler(BINARY_TRUST_REVOKE_CHANNEL);

    await handleGrant({}, { path: scratchBin });
    const resolvedPath = realpathSync(scratchBin);
    expect(readTrustedBinaryConsentsSync(process.env.ANYCODE_SETTINGS_PATH)).toHaveLength(1);

    const revokeResult = (await handleRevoke({}, { path: resolvedPath })) as SettingsMutationResult;
    expect(revokeResult.ok).toBe(true);
    expect(readTrustedBinaryConsentsSync(process.env.ANYCODE_SETTINGS_PATH)).toEqual([]);
  });
});

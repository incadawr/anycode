/**
 * Production-wiring test (TASK.198 E1 §1.2/§7): proves that main/index.ts's
 * TWO settings-mutation hooks (the generic settings-set + connection-CRUD path
 * wired through `settingsIpcDeps.onMutation`, and the custom-provider CRUD
 * path wired through `registerProviderIpc`'s own `onMutation`) actually
 * recompute the vision-fallback recognizer's resolved endpoint, compare its
 * fingerprint against the last one pushed, and push a fresh
 * `RecognizerConfigChanged` to every live root core tab's host ONLY when the
 * fingerprint moved — never on an unrelated mutation (finding #7: a resolved
 * secret must never ride an unrelated mutation's wire). Also proves the
 * `connectionInUse` delete-guard now refuses deleting the connection the
 * recognizer setting points at.
 *
 * Boots main/index.ts for real off a scratch settings/secrets/`:memory:`
 * profile, exactly like index.providerReady-wiring.test.ts (see that file for
 * why main/index.ts can only ever be exercised this way) — the fingerprint
 * comparison state and the mutation-hook wiring live at module scope, so a
 * plain unit test of an exported pure function cannot exercise the actual
 * hook wiring this test is for.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  CONNECTION_DELETE_CHANNEL,
  SECRET_SET_CHANNEL,
  SETTINGS_SET_CHANNEL,
} from "../shared/settings.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { TAB_CREATE_CHANNEL } from "../shared/tabs.js";
import type { CreateTabResult } from "../shared/tabs.js";
import {
  RECOGNIZER_CONFIG_CHANGED_TYPE,
  RECOGNIZER_SET_CHANNEL,
  type RecognizerConfigChanged,
} from "../shared/recognizer.js";
// Local literal, not an import from provider-ipc.js: that module pulls in
// `electron`, whose vi.mock factory (hoisted above the class declarations in
// this file) would run before they initialize. Same pattern as the sibling
// index.*-wiring tests' own local CUSTOM_PROVIDER_*_CHANNEL constants.
const CUSTOM_PROVIDER_UPDATE_CHANNEL = "anycode:custom-provider-update";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

// `vi.hoisted` so the capturing collections exist before vi.mock's hoisted
// factory below closes over them (same pattern as index.providerReady-wiring.test.ts).
const { ipcHandlers, hostProcesses } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  hostProcesses: [] as FakeHostProcessType[],
}));

interface FakeHostProcessType {
  pid: number;
  postMessage: (...args: unknown[]) => void;
  kill: (...args: unknown[]) => unknown;
  on: (...args: unknown[]) => unknown;
  once: (...args: unknown[]) => unknown;
}

/**
 * Fake `UtilityProcess` returned by the mocked `utilityProcess.fork` — real
 * enough for `TabHostManager.spawnTabHost`/`deliverTabPort` to run their real
 * code without ever spawning a real process. Every instance is pushed to the
 * hoisted `hostProcesses` array so a test can inspect exactly which fork's
 * `postMessage` received the live recognizer push.
 */
class FakeHostProcess implements FakeHostProcessType {
  pid = 4242;
  postMessage = vi.fn();
  kill = vi.fn();
  on = vi.fn(() => this);
  once = vi.fn(() => this);
}

/** Minimal fake BrowserWindow — a superset copy of index.providerReady-wiring.test.ts's. */
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
    fork: vi.fn(() => {
      const proc = new FakeHostProcess();
      hostProcesses.push(proc);
      return proc;
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

/** Every RecognizerConfigChanged a fake host process received, in call order. */
function recognizerPushes(proc: FakeHostProcessType): RecognizerConfigChanged[] {
  const postMessage = proc.postMessage as unknown as { mock: { calls: unknown[][] } };
  return postMessage.mock.calls
    .map((call) => call[0] as { type?: unknown })
    .filter((msg): msg is RecognizerConfigChanged => msg.type === RECOGNIZER_CONFIG_CHANGED_TYPE);
}

beforeEach(async () => {
  ipcHandlers.clear();
  hostProcesses.length = 0;
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "anycode-index-recognizer-"));
  process.env.ANYCODE_AUTOMATION = "1";
  process.env.ANYCODE_SETTINGS_PATH = join(dir, "settings.json");
  process.env.ANYCODE_SECRETS_PATH = join(dir, "secrets.json");
  process.env.ANYCODE_DB_PATH = ":memory:";
  // Readiness for the ACTIVE (primary) connection comes from an env override —
  // this test is about the recognizer's OWN, SEPARATE connection, not about
  // the primary provider ladder.
  process.env.ANYCODE_API_KEY = "sk-primary-env";
  delete process.env.ANYCODE_USER_DATA_DIR;
  delete process.env.ANYCODE_WORKSPACE;
  delete process.env.ANYCODE_RESUME;
  delete process.env.ELECTRON_RENDERER_URL;
  (globalThis as Record<string, unknown>).__ANYCODE_DEV_AUTOMATION__ = false;

  // Two ALREADY-CONFIGURED bare/custom connections: `conn-primary` (active,
  // ready via the env override above) and `conn-vision` (a second, unrelated
  // connection with its OWN baseUrl/transport/vault key — the recognizer's
  // target). No `recognizer` key yet: the fallback starts OFF.
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 2,
      provider: {
        activeConnectionId: "conn-primary",
        connections: [
          { id: "conn-primary", providerId: "", model: "primary-model" },
          {
            id: "conn-vision",
            providerId: "",
            model: "vision-model-x",
            baseUrl: "https://vision.example.com",
            transport: "openai-chat-completions",
          },
        ],
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

describe("main/index.ts — recognizer live-push wiring (TASK.198 E1)", () => {
  it("stays silent on an unrelated mutation, pushes the resolved secret when the recognizer setting actually changes, and refuses deleting its connection", async () => {
    await import("./index.js");

    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const handleSettingsSet = await waitForHandler(SETTINGS_SET_CHANNEL);
    const handleSecretSet = await waitForHandler(SECRET_SET_CHANNEL);
    const handleConnectionDelete = await waitForHandler(CONNECTION_DELETE_CHANNEL);
    const handleRecognizerSet = await waitForHandler(RECOGNIZER_SET_CHANNEL);

    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    expect(hostProcesses).toHaveLength(1);
    const rootHost = hostProcesses[0]!;

    // 1) An UNRELATED settings mutation (recognizer stays absent/off) must not
    // push anything — silence is the byte-identical-to-today posture too.
    const unrelated1 = (await handleSettingsSet({}, { ui: { theme: "dark" } })) as SettingsMutationResult;
    expect(unrelated1).toMatchObject({ ok: true });
    expect(recognizerPushes(rootHost)).toHaveLength(0);

    // Seed the recognizer connection's OWN vault credential before turning the
    // fallback on, so the push below can be checked for the REAL resolved
    // secret rather than an env stand-in.
    const secretResult = (await handleSecretSet(
      {},
      { key: "provider.connection.conn-vision.apiKey", value: "sk-vision-real" },
    )) as SettingsMutationResult;
    expect(secretResult).toMatchObject({ ok: true });
    // secret-set never touches settings.json's recognizer field, so it must
    // not push anything either (fingerprint is settings-derived, unaffected).
    expect(recognizerPushes(rootHost)).toHaveLength(0);

    // 2) `settings.recognizer` has exactly ONE writer: the dedicated
    // `recognizer-set` channel. The generic patch path refuses it loudly
    // (settings-ipc.ts's `handleSet`), because `deepMerge` skips every
    // `undefined` patch value and so that path could only ever turn the
    // fallback ON, never off. Pinned here rather than assumed: it is the whole
    // reason the turn-on below cannot go through `settings-set`, and a refusal
    // that silently became a merge would make the rest of this test vacuous.
    const genericRecognizerPatch = (await handleSettingsSet(
      {},
      { recognizer: { connectionId: "conn-vision", modelId: "vision-model-x" } },
    )) as SettingsMutationResult;
    expect(genericRecognizerPatch).toMatchObject({ ok: false, reason: "invalid" });
    expect(recognizerPushes(rootHost)).toHaveLength(0);

    // Turning the fallback ON (settings.recognizer set for the first time) is a
    // fingerprint change — this MUST push, carrying the resolved secret. The
    // dedicated channel emits the SAME mutation the generic path does, so the
    // hook wiring exercised here is the production one.
    const turnOn = (await handleRecognizerSet(
      {},
      { recognizer: { connectionId: "conn-vision", modelId: "vision-model-x" } },
    )) as SettingsMutationResult;
    expect(turnOn).toMatchObject({ ok: true });
    const pushesAfterOn = recognizerPushes(rootHost);
    expect(pushesAfterOn).toHaveLength(1);
    expect(pushesAfterOn[0]).toEqual({
      type: RECOGNIZER_CONFIG_CHANGED_TYPE,
      endpoint: {
        transport: "openai-chat-completions",
        baseUrl: "https://vision.example.com",
        apiKey: "sk-vision-real",
        model: "vision-model-x",
      },
    });

    // 3) A SECOND unrelated mutation, with the recognizer now ACTIVE, must
    // still stay silent — the fingerprint (connectionId+modelId+baseUrl+
    // transport) has not moved.
    const unrelated2 = (await handleSettingsSet({}, { ui: { theme: "light" } })) as SettingsMutationResult;
    expect(unrelated2).toMatchObject({ ok: true });
    expect(recognizerPushes(rootHost)).toHaveLength(1); // unchanged — still exactly the one push from step 2

    // 4) `connectionInUse` now also covers the recognizer's connection: delete
    // is refused, with the same reason a pinned-session connection gets.
    const deleteResult = (await handleConnectionDelete({}, { id: "conn-vision" })) as SettingsMutationResult;
    expect(deleteResult).toMatchObject({ ok: false, reason: "connection_in_use" });
  });

  // TASK.202: an API-key rotation moves NO fingerprint field (the deliberate
  // no-vault-read property), so the push-side `onSecretWritten` sentinel is
  // the only thing that can carry it — rotating the recognizer connection's
  // OWN key must force a second push; rotating an UNRELATED key must not.
  it("TASK.202: rotating the recognizer connection's key force-pushes; rotating an unrelated key stays silent", async () => {
    await import("./index.js");

    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const handleSecretSet = await waitForHandler(SECRET_SET_CHANNEL);
    const handleRecognizerSet = await waitForHandler(RECOGNIZER_SET_CHANNEL);

    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    const rootHost = hostProcesses[0]!;

    // Seed the credential, then turn the recognizer on (one push).
    const seed = (await handleSecretSet(
      {},
      { key: "provider.connection.conn-vision.apiKey", value: "sk-vision-real" },
    )) as SettingsMutationResult;
    expect(seed).toMatchObject({ ok: true });
    expect(recognizerPushes(rootHost)).toHaveLength(0);

    const turnOn = (await handleRecognizerSet(
      {},
      { recognizer: { connectionId: "conn-vision", modelId: "vision-model-x" } },
    )) as SettingsMutationResult;
    expect(turnOn).toMatchObject({ ok: true });
    const pushesAfterOn = recognizerPushes(rootHost);
    expect(pushesAfterOn).toHaveLength(1);
    expect(pushesAfterOn[0]?.endpoint).toMatchObject({ apiKey: "sk-vision-real" });

    // Rotate the recognizer's OWN key: fingerprint is still, but the sentinel
    // forces the push — and the endpoint carries the ROTATED secret with the
    // same baseUrl/transport/model.
    const rotate = (await handleSecretSet(
      {},
      { key: "provider.connection.conn-vision.apiKey", value: "sk-vision-rotated" },
    )) as SettingsMutationResult;
    expect(rotate).toMatchObject({ ok: true });
    const pushesAfterRotate = recognizerPushes(rootHost);
    expect(pushesAfterRotate).toHaveLength(2);
    expect(pushesAfterRotate[1]).toEqual({
      type: RECOGNIZER_CONFIG_CHANGED_TYPE,
      endpoint: {
        transport: "openai-chat-completions",
        baseUrl: "https://vision.example.com",
        apiKey: "sk-vision-rotated",
        model: "vision-model-x",
      },
    });

    // Rotate an UNRELATED connection's key: no push — still exactly 2.
    const unrelated = (await handleSecretSet(
      {},
      { key: "provider.connection.conn-primary.apiKey", value: "sk-other" },
    )) as SettingsMutationResult;
    expect(unrelated).toMatchObject({ ok: true });
    expect(recognizerPushes(rootHost)).toHaveLength(2);
  });

  // TASK.202 second half: a custom-provider recognizer connection. Its
  // credential and address both live on the CustomProviderRecord, so the
  // fingerprint now mirrors the record's baseUrl (push fires on a baseUrl
  // edit with no key change) and `onSecretWritten` covers a key rotation
  // through the provider channel.
  it("TASK.202: a custom-provider recognizer connection pushes when its record's key rotates and when its record's baseUrl is edited", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        version: 2,
        provider: {
          activeConnectionId: "conn-primary",
          connections: [
            { id: "conn-primary", providerId: "", model: "primary-model" },
            { id: "conn-vision", providerId: "custom:vision-slug", model: "vision-model-x" },
          ],
          custom: [
            {
              id: "custom:vision-slug",
              name: "Vision custom",
              baseUrl: "https://vision-custom.example.com/v1",
              kind: "openai-compatible",
              models: ["vision-model-x"],
            },
          ],
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      }),
    );

    await import("./index.js");

    const handleTabCreate = await waitForHandler(TAB_CREATE_CHANNEL);
    const handleRecognizerSet = await waitForHandler(RECOGNIZER_SET_CHANNEL);
    const handleCustomProviderUpdate = await waitForHandler(CUSTOM_PROVIDER_UPDATE_CHANNEL);

    const tabResult = (await handleTabCreate({}, { kind: "new", workspace: dir })) as CreateTabResult;
    expect(tabResult.ok).toBe(true);
    const rootHost = hostProcesses[0]!;

    // Seed the record's key through the provider channel's own create — but
    // the record already exists in the fixture, so the key lands via update.
    const seedKey = (await handleCustomProviderUpdate(
      {},
      { id: "custom:vision-slug", apiKey: "sk-custom-1" },
    )) as { ok: boolean };
    expect(seedKey.ok).toBe(true);
    // The recognizer is not on yet — no push.
    expect(recognizerPushes(rootHost)).toHaveLength(0);

    const turnOn = (await handleRecognizerSet(
      {},
      { recognizer: { connectionId: "conn-vision", modelId: "vision-model-x" } },
    )) as SettingsMutationResult;
    expect(turnOn).toMatchObject({ ok: true });
    const pushesAfterOn = recognizerPushes(rootHost);
    expect(pushesAfterOn).toHaveLength(1);
    expect(pushesAfterOn[0]?.endpoint).toMatchObject({
      baseUrl: "https://vision-custom.example.com/v1",
      apiKey: "sk-custom-1",
    });

    // Rotate the record's key through the provider channel (same-origin, no
    // baseUrl change): fingerprint still, sentinel forces the push.
    const rotate = (await handleCustomProviderUpdate(
      {},
      { id: "custom:vision-slug", apiKey: "sk-custom-2" },
    )) as { ok: boolean };
    expect(rotate.ok).toBe(true);
    const pushesAfterRotate = recognizerPushes(rootHost);
    expect(pushesAfterRotate).toHaveLength(2);
    expect(pushesAfterRotate[1]?.endpoint).toMatchObject({
      baseUrl: "https://vision-custom.example.com/v1",
      apiKey: "sk-custom-2",
    });

    // Edit the record's baseUrl (with a fresh key, cross-origin): the
    // fingerprint's own baseUrl mirror moves — push with the new address.
    const move = (await handleCustomProviderUpdate(
      {},
      { id: "custom:vision-slug", baseUrl: "https://moved.example.com/v1", apiKey: "sk-custom-3" },
    )) as { ok: boolean };
    expect(move.ok).toBe(true);
    const pushesAfterMove = recognizerPushes(rootHost);
    expect(pushesAfterMove).toHaveLength(3);
    expect(pushesAfterMove[2]?.endpoint).toMatchObject({
      baseUrl: "https://moved.example.com/v1",
      apiKey: "sk-custom-3",
    });

    // A models-only update writes no vault key and moves no fingerprint
    // field — silence.
    const modelsOnly = (await handleCustomProviderUpdate(
      {},
      { id: "custom:vision-slug", models: ["vision-model-x"] },
    )) as { ok: boolean };
    expect(modelsOnly.ok).toBe(true);
    expect(recognizerPushes(rootHost)).toHaveLength(3);
  });
});

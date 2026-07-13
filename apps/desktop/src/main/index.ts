/**

 * thin process: no agent logic. It owns the window, workspace/env resolution,
 * the SQLite persistence connection (picker reads + migration ordering), the N
 * host utilityProcess lifecycles (delegated to TabHostManager), and the two
 * control planes (main<->host over parentPort, main<->renderer over ipc).
 *
 * Responsibilities:

 *    must be present before spawning; otherwise an error dialog and clean exit.

 *    spawn, so main migrates and every host then opens an already-migrated
 *    schema (WAL: main's long-lived reader never blocks the host writers). The
 *    connection also backs the session picker's reads (tab-ipc sessions-list).

 *    ANYCODE_WORKSPACE starts one tab. A normal GUI launch starts with zero tabs
 *    and opens the folder dialog only after the user asks for a new session.
 *  - Multi-host lifecycle: TabHostManager (main/tabs.ts) owns Map<tabId,
 *    TabHost>, spawn/respawn (per-tab + global storm breaker), channel delivery,
 *    and parallel graceful shutdown. Main injects the real Electron primitives.
 *  - Tab control plane: registerTabIpc (main/tab-ipc.ts) wires create/close/list.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, MessageChannelMain, app, dialog, nativeImage, safeStorage, shell, utilityProcess } from "electron";
// electron-updater is CJS and exposes `autoUpdater` via a dynamic getter that
// Node's cjs-module-lexer cannot see as a named export; a named ESM import
// (`import { autoUpdater }`) throws at module-link time and blocks boot. The
// default-import + destructure is the supported CJS-interop shape.
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { SqlitePersistenceAdapter } from "@anycode/core/persistence";
import {
  catalogProviderIds,
  findCatalogEntry,
  getBuiltinCatalog,
  isCustomProvider,
  resolveEndpoint,
} from "@anycode/core/catalog";
import type { FileIoLogger } from "../settings/files.js";
import { defaultSecretsPath, defaultSettingsPath, loadSettings } from "../settings/files.js";
import type { AnycodeSettings, SecretKey } from "../shared/settings.js";
import {
  applySubagentsHomeOverride,
  buildHostEnv,
  computeProviderReady,
  scrubSecretEnv,
  snapshotBootEnv,
  type ResolvedProviderSelection,
} from "./host-env.js";
import { NodeMcpConfigFs, registerMcpConfigIpc } from "./mcp-config-ipc.js";
import { NodeProfileFs, registerProfileIpc } from "./profile-ipc.js";
import { NodeSkillsFs, registerSkillsIpc } from "./skills-ipc.js";
import { NodeSubagentsFs, registerSubagentsIpc } from "./subagents-ipc.js";
import { OAuthEngine, oauthConfigFromEntry } from "./oauth.js";
import { projectCatalogSummary, registerSettingsIpc } from "./settings-ipc.js";
import { TabHostManager } from "./tabs.js";
import { TokenBroker, resolveProviderSelection, type CatalogSelectionInfo } from "./token-broker.js";
import { registerTabIpc } from "./tab-ipc.js";
import { ENV_CODEX_BIN, ENV_ENGINE, ENV_HOST_GENERATION, type EngineId } from "../shared/engines.js";
import { resolveCodexBinary } from "./codex-binary.js";
import { createEngineProcessReaper } from "./engine-reaper.js";
import { registerUpdater } from "./updater.js";

/** Replaced by electron-vite: true in `dev`, false in production builds. */
declare const __ANYCODE_DEV_AUTOMATION__: boolean;
import { registerWindowIpc, wireWindowStateEvents, readWindowState } from "./window-ipc.js";
import { WINDOW_STATE_CHANNEL } from "../shared/window.js";
import { Vault } from "./vault.js";
import {
  isRefusedUserDataOverride,
  resolveMcpImportHome,
  resolveSecretsPathOverride,
  resolveSettingsPathOverride,
  resolveUserDataOverride,
} from "./dev-profile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only override for the skills import scan's `home`
 * (design/slice-P7.20-cut.md §4), mirroring `resolveMcpImportHome`
 * (main/dev-profile.ts) exactly rather than importing it -- this lever is
 * skills-specific (`ANYCODE_SKILLS_IMPORT_HOME`) and local to this
 * registration site, same "duplicated on purpose" rule as `SkillsFs` in
 * skills-ipc.ts. Same double gate: `ANYCODE_AUTOMATION==="1" && !isPackaged`,
 * plus a non-empty ABSOLUTE path -- a packaged production build NEVER honors
 * the var, so `home()` always falls back to `os.homedir()` there. Points
 * `scanHarnessSkills` at a disposable fixture directory instead of the real
 * `~` (the skills-ui-smoke harness, W4).
 */
function resolveSkillsImportHome(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (env.ANYCODE_AUTOMATION !== "1" || isPackaged) {
    return null;
  }
  const raw = env.ANYCODE_SKILLS_IMPORT_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Dev-only override for the subagents editor's `home` (design/slice-P7.21-cut.md
 * §4 W2), same "duplicated on purpose" rule as `resolveSkillsImportHome` above
 * (`ANYCODE_SUBAGENTS_HOME`, local to this registration site). Same double
 * gate: `ANYCODE_AUTOMATION==="1" && !isPackaged`, plus a non-empty ABSOLUTE
 * path — a packaged production build NEVER honors the var, so `home()` always
 * falls back to `os.homedir()` there. Points `scanAgentProfilesAdmin`'s
 * user-scope root at a disposable fixture directory instead of the real `~`
 * (the subagents-ui-smoke harness, W4).
 */
function resolveSubagentsHome(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (env.ANYCODE_AUTOMATION !== "1" || isPackaged) {
    return null;
  }
  const raw = env.ANYCODE_SUBAGENTS_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Dev-only override for the Profile-stats pane's `home` (design/slice-P7.22-
 * cut.md §2-D2/D5 W2), same "duplicated on purpose" rule as
 * `resolveSubagentsHome` above (`ANYCODE_PROFILE_HOME`, local to this
 * registration site). Same double gate: `ANYCODE_AUTOMATION==="1" &&
 * !isPackaged`, plus a non-empty ABSOLUTE path — a packaged production build
 * NEVER honors the var, so `home()` always falls back to `os.homedir()` there.
 * Points the user-scope telemetry-config/sink-dir resolution at a disposable
 * fixture directory instead of the real `~` (the profile-ui-smoke harness, W4)
 * — Profile has no per-tab workspace concept at all (D2), so unlike skills/
 * subagents this is the ONLY home lever the pane needs.
 */
function resolveProfileHome(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (env.ANYCODE_AUTOMATION !== "1" || isPackaged) {
    return null;
  }
  const raw = env.ANYCODE_PROFILE_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

// Dev-only automation profile isolation (design/slice-P7.H-cut.md §4.2): must
// run at module top level, BEFORE `app.whenReady()` registration below —
// Electron decides the userData/localStorage partition at ready time, so a
// whenReady-callback repoint is already too late. Double-gated dev-only
// (fail-closed for a packaged build) and off by default: a normal dev launch
// with no automation env is byte-identical to before this slice.
const devUserDataOverride = resolveUserDataOverride(process.env, app.isPackaged);
if (devUserDataOverride !== null) {
  // A mkdir failure here (e.g. an unwritable/invalid override path) must not
  // crash boot before a single window exists — catch, warn once, and fall
  // back to Electron's default userData profile (design codex finding
  // P7.H-4: graceful degradation, not an uncaught throw at module top level).
  try {
    mkdirSync(devUserDataOverride, { recursive: true });
    app.setPath("userData", devUserDataOverride);
    console.log(`[main] userData overridden (automation dev profile): ${devUserDataOverride}`);
  } catch (error) {
    console.warn(
      `[main] failed to apply automation dev profile override (${devUserDataOverride}); falling back to the default userData profile`,
      error,
    );
  }
} else if (isRefusedUserDataOverride(process.env, app.isPackaged)) {
  console.warn("[main] ANYCODE_USER_DATA_DIR set but refused (packaged build, or a relative path)");
}

/**
 * Environment variable names. These mirror the contract of core's
 * provider/env.ts (loadEnvConfig requires API_KEY + MODEL, DB_PATH defaults):
 * duplicated as local string literals on purpose rather than value-importing
 * @anycode/core, which would bundle the whole core runtime into the thin main
 * process. Kept in sync with that module by contract.
 */
const ENV_WORKSPACE = "ANYCODE_WORKSPACE";
const ENV_DB_PATH = "ANYCODE_DB_PATH";
/** Phase-2 §4.1: desktop --resume mirror via env (GUI launches have no argv). */
const ENV_RESUME = "ANYCODE_RESUME";
/**
 * Dev-only settings.json path override (design/slice-P7.15-cut.md §2.6),
 * forwarded verbatim into the host fork's env below so `host/boot.ts`'s
 * `seedAlwaysAllowRules` reads the SAME already-gated path (the host process
 * has no `isPackaged` signal of its own to re-derive the gate).
 */
const ENV_SETTINGS_PATH = "ANYCODE_SETTINGS_PATH";

let win: BrowserWindow | null = null;
/**
 * Persistence connection (§2.3), opened once at boot before the first host
 * spawn. Held module-level so before-quit can close it after the hosts stop.
 */
let persistence: SqlitePersistenceAdapter | null = null;
/** Multi-host lifecycle manager (§2.2); null until boot wires it. */
let manager: TabHostManager | null = null;
/** Set once quit begins, to gate the before-quit handler's second pass. */
let quitting = false;



/**
 * Immutable boot-env snapshot (ruling §3.3), captured BEFORE the live
 * `process.env` is scrubbed of SECRET_ENV_KEYS. Every provider-env read in main
 * (host fork env, envOverrides, readiness) uses this, so the scrub is invisible
 * to them while a Bash child of main can no longer inherit the key.
 */
let bootEnv: NodeJS.ProcessEnv = {};
/** Loaded settings (source of provider defaults + consent flag). */
let settings: AnycodeSettings | null = null;
/** Current readiness = apiKey(env|vault) && model(env|settings); gates host spawns. */
let providerReady = false;
/** Main-validated optional binary; no engine readiness is implied by its presence. */
let codexBinaryPath: string | null = null;
/**
 * The host fork env, rebuilt async on every successful mutation and read

 * up by the next respawn.
 */
let currentHostEnv: NodeJS.ProcessEnv = {};
/**
 * A `--resume`/ANYCODE_RESUME id parked while unconfigured: consumed by the
 * first explicit initial-tab launch (ready boot or the deferred flow).
 */
let parkedResumeId: string | undefined;

const fileLogger: FileIoLogger = {
  warn: (message, err) => console.warn(`[main] ${message}`, err ?? ""),
};

function resolvePreloadPath(): string {
  return join(__dirname, "../preload/index.cjs");
}

function resolveHostEntry(): string {
  return join(__dirname, "host.js");
}

function resolveRendererIndex(): string {
  return join(__dirname, "../renderer/index.html");
}

/** DB path: ANYCODE_DB_PATH env -> ~/.anycode/anycode.sqlite (same default as host/CLI). */
function resolveDbPath(): string {
  const fromEnv = process.env[ENV_DB_PATH];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return join(homedir(), ".anycode", "anycode.sqlite");
}

/** Workspace supplied explicitly by the environment, if any. */
function resolveWorkspaceFromEnv(): string | undefined {
  const fromEnv = process.env[ENV_WORKSPACE];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return undefined;
}

/** Workspace: ANYCODE_WORKSPACE env -> optional open-directory dialog -> null. */
function resolveWorkspace(opts: { prompt: boolean }): string | null {
  const fromEnv = resolveWorkspaceFromEnv();
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (!opts.prompt) {
    return null;
  }
  const picked = dialog.showOpenDialogSync({ properties: ["openDirectory"], defaultPath: homedir() });
  if (picked !== undefined && picked.length > 0 && picked[0] !== undefined) {
    return picked[0];
  }
  return null;
}

/**
 * Parses --resume <id> | --resume=<id> from argv (mirror of core's parseCliArgs,
 * cli/main.ts:91-101). Scans the whole argv so it is robust to Electron's
 * [electron, appPath, ...userArgs] shape.
 */
function parseResumeArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--resume") {
      const value = argv[i + 1];
      if (value !== undefined) {
        return value;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      return arg.slice("--resume=".length);
    }
  }
  return undefined;
}

/** The resume session id from argv or ANYCODE_RESUME (argv wins), if any. */
function resolveResumeId(): string | undefined {
  const fromArgv = parseResumeArg(process.argv);
  if (fromArgv !== undefined && fromArgv.trim() !== "") {
    return fromArgv;
  }
  const fromEnv = process.env[ENV_RESUME];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return undefined;
}

function createWindow(): void {
  // Custom titlebar (design/ui-track custom-titlebar §4): frameless chrome so the
  // renderer draws the caption buttons + drag regions itself. macOS keeps its
  // native traffic lights via titleBarStyle:"hidden" (positioned into the
  // sidebar cap); win32 hides its caption bar; every other platform is fully
  // frameless. backgroundColor kills the white flash on a frameless resize.
  const platform = process.platform;
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#161616",
    ...(platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 17 } }
      : platform === "win32"
        ? { titleBarStyle: "hidden" as const }
        : { frame: false }),
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("closed", () => {
    win = null;
  });

  // Forward maximize/fullscreen transitions to the renderer so the custom
  // titlebar can flip its Maximize<->Restore glyph and drag-region clearance.
  wireWindowStateEvents(win);

  // Re-deliver a fresh port to every live tab on every load, not just the first:
  // a vite reload or a renderer crash re-loads the page and each tab must get a

  // once, for the same reload-resilience reason: a reloaded renderer boots with
  // no state and must be told the live maximize/fullscreen values immediately.
  win.webContents.on("did-finish-load", () => {
    manager?.deliverAllTabPorts();
    win?.webContents.send(WINDOW_STATE_CHANNEL, readWindowState(win));
  });

  const rendererDevServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererDevServerUrl !== undefined) {
    void win.loadURL(rendererDevServerUrl);
  } else {
    void win.loadFile(resolveRendererIndex());
  }
}

/** Vault decrypt accessor; null vault (pre-boot) yields no value. */
let vault: Vault | null = null;
const getSecret = (key: Parameters<Vault["getSecretValue"]>[0]): Promise<string | undefined> =>
  vault === null ? Promise.resolve(undefined) : vault.getSecretValue(key);



/** TokenBroker + OAuth engine; null until boot wires them (need the vault). */
let tokenBroker: TokenBroker | null = null;
let oauthEngine: OAuthEngine | null = null;

/**
 * Core-backed catalog projection for host-env (which is core-free): a catalog id
 * -> {baseUrl, authKind, isCustom}, or undefined for an unknown id (legacy
 * fallback). baseUrl is the resolveEndpoint projection; a `custom` entry has an
 * empty baseUrl and the caller substitutes settings.provider.baseUrl.
 */
function resolveCatalog(id: string): CatalogSelectionInfo | undefined {
  const entry = findCatalogEntry(id);
  if (entry === undefined) {
    return undefined;
  }
  return {
    baseUrl: resolveEndpoint(entry, "", "").baseUrl,
    authKind: entry.auth.kind,
    isCustom: isCustomProvider(id),
  };
}

/** Auth kind of a catalog id (undefined = unknown id). */
function authKindFor(id: string): "api_key" | "oauth" | undefined {
  return findCatalogEntry(id)?.auth.kind;
}

/** Vault key gating readiness for the selected provider (undefined = legacy). */
function credentialKeyFor(current: AnycodeSettings): SecretKey | undefined {
  const id = current.provider.id;

  // renderer's providerSecretKey (a needsBaseUrl entry uses the bare legacy key).
  if (id === undefined || id.trim() === "" || isCustomProvider(id)) {
    return undefined;
  }
  const kind = authKindFor(id);
  if (kind === undefined) {
    return undefined;
  }
  return kind === "oauth" ? `provider.${id}.oauth` : `provider.${id}.apiKey`;
}

/** Fresh OAuth access token via the broker (undefined pre-boot / not signed in). */
const getAccessTokenFor = (id: string): Promise<string | undefined> =>
  tokenBroker === null ? Promise.resolve(undefined) : tokenBroker.getAccessToken(id);

/**
 * Recomputes the host fork env + readiness from the current settings/vault


 * scrub never changes the outcome.
 */
async function refreshProviderState(): Promise<void> {
  const current = settings ?? { version: 1, provider: {}, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
  // Catalog resolution (slice 2.5): main resolves the selected provider's
  // baseUrl/model/credential; buildHostEnv stays core-free via this injected fn.
  // Absent/unknown provider.id -> resolveProviderSelection yields undefined ->
  // buildHostEnv takes the byte-for-byte legacy 2.2 path.
  const resolveSelection = (): Promise<ResolvedProviderSelection | undefined> =>
    resolveProviderSelection({
      settings: current,
      resolveCatalog,
      getApiKey: (id) => getSecret(`provider.${id}.apiKey`),
      getAccessToken: getAccessTokenFor,
    });
  currentHostEnv = await buildHostEnv({ bootEnv, settings: current, getSecret, resolveSelection });
  applySubagentsHomeOverride(currentHostEnv, resolveSubagentsHome(bootEnv, app.isPackaged));
  providerReady = await computeProviderReady({
    bootEnv,
    settings: current,
    getSecret,
    credentialKey: credentialKeyFor(current),
  });
}

/**
 * Launches an explicit initial tab. Resolves the session from a parked resume id
 * or ANYCODE_WORKSPACE; normal GUI launch no longer prompts here. `deliverNow`
 * posts the port immediately (the deferred flow runs after did-finish-load, which
 * would otherwise never re-fire); the ready-boot flow lets did-finish-load deliver.
 */
async function startInitialTab(opts: {
  onNoWorkspace: "quit" | "stay";
  deliverNow: boolean;
  promptForWorkspace: boolean;
}): Promise<void> {
  if (manager === null || persistence === null) {
    return;
  }
  const resumeId = parkedResumeId;
  parkedResumeId = undefined;

  const resumed = resumeId !== undefined ? await persistence.getSession(resumeId) : null;
  if (resumeId !== undefined && resumed === null) {
    console.warn(`[main] no session found for --resume ${resumeId}; starting a new session`);
  }

  let workspace: string;
  let sessionId: string;
  let resume: boolean;
  if (resumed !== null) {
    workspace = resumed.workspace;
    sessionId = resumed.id;
    resume = true;
    console.log(`[main] resuming session ${resumed.id} in ${resumed.workspace}`);
  } else {
    const resolvedWorkspace = resolveWorkspace({ prompt: opts.promptForWorkspace });
    if (resolvedWorkspace === null) {
      if (opts.onNoWorkspace === "quit") {
        console.error("[main] no workspace selected; quitting");
        app.quit();
      } else {
        console.log("[main] no workspace selected; staying in Welcome");
      }
      return;
    }
    workspace = resolvedWorkspace;
    sessionId = randomUUID();
    resume = false;
    console.log(`[main] workspace: ${workspace}`);
  }

  const created = manager.createTab({ workspace, sessionId, resume });
  if (!created.ok) {
    console.error(`[main] failed to create initial tab: ${created.reason}`);
    return;
  }
  if (opts.deliverNow) {
    manager.deliverTabPort(created.tab);
  }
}

void app.whenReady().then(async () => {
  // Dev dock icon (macOS): a packaged .app draws its Dock/Cmd-Tab icon from the
  // bundled icon.icns, but `electron-vite dev` runs the generic Electron binary,
  // so the Dock shows the default Electron icon. Point it at the app icon in dev
  // only; the packaged path is covered by electron-builder's mac.icon.
  if (process.platform === "darwin" && !app.isPackaged) {
    const devIcon = nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.png"));
    if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
  }


  // boot-env snapshot BEFORE anything spawns, then scrub the secret keys from the

  // respawn key-rotation are preserved, but a Bash child spawned by main can no
  // longer inherit ANYCODE_API_KEY. Non-secret ANYCODE_* (incl. the automation
  // gate) stay in the live env.
  bootEnv = snapshotBootEnv(process.env);
  scrubSecretEnv(process.env);
  const codexBinary = resolveCodexBinary(bootEnv[ENV_CODEX_BIN]);
  codexBinaryPath = codexBinary.path;
  if (codexBinary.reason !== undefined) {
    console.warn(`[main] Codex binary unavailable: ${codexBinary.reason}`);
  }


  // and migrates once (a read forces open()+migrate()), then hosts open the
  // already-migrated schema. WAL keeps main's long-lived reader from blocking
  // the host writers.
  const dbPath = resolveDbPath();
  persistence = new SqlitePersistenceAdapter(dbPath);
  await persistence.listSessions({ limit: 1 });
  console.log(`[main] persistence opened + migrated: ${dbPath}`);


  // safeStorage holder, and compute the initial host env + readiness from the
  // boot snapshot.
  // Dev-only settings/secrets path isolation (design/slice-P7.15-cut.md §2.6):
  // mirrors the userData override above — double-gated
  // (`ANYCODE_AUTOMATION==="1" && !isPackaged`), fail-closed, off by default,
  // so a normal launch resolves the exact same ~/.anycode paths as before.
  const settingsPath = resolveSettingsPathOverride(process.env, app.isPackaged) ?? defaultSettingsPath();
  const secretsPath = resolveSecretsPathOverride(process.env, app.isPackaged) ?? defaultSecretsPath();
  // Propagate the already-vetted settings path into the boot-env snapshot so
  // every host fork below (buildHostEnv spreads `bootEnv`) sees the identical
  // path `seedAlwaysAllowRules` should read — never a raw, ungated env value.
  bootEnv[ENV_SETTINGS_PATH] = settingsPath;
  const loaded = await loadSettings(settingsPath, fileLogger);
  settings = loaded.settings;
  vault = new Vault({ safeStorage, secretsPath, logger: fileLogger });
  // TokenBroker + OAuth engine (slice 2.5 §3.2/§3.3): main-owned custody. The
  // broker refreshes/rotates oauth tokens (single-flight); the engine runs the
  // loopback+PKCE sign-in. Both read weak-storage consent fresh from settings.
  tokenBroker = new TokenBroker({
    vault,
    resolveConfig: (id) => oauthConfigFromEntry(findCatalogEntry(id)),
    allowWeak: () => settings?.security.allowWeakSecretStorage ?? false,
    logger: fileLogger,
  });
  oauthEngine = new OAuthEngine({
    vault,
    openExternal: (url) => shell.openExternal(url),
    logger: fileLogger,
  });
  parkedResumeId = resolveResumeId();
  await refreshProviderState();

  manager = new TabHostManager({
    fork: (entry, args, opts) => utilityProcess.fork(entry, [...args], opts),
    hostEntry: resolveHostEntry(),
    createChannel: () => new MessageChannelMain(),
    getWindow: () => win,


    env: () => currentHostEnv,
    providerReady: () => providerReady,
    // Codex has no dependency on AnyCode's provider settings. Its only
    // main-plane readiness fact is the boot-time validated executable path;
    // account verification remains inside the owned native session bootstrap.
    engineReady: (engine: EngineId) =>
      engine === "core" ? providerReady : engine === "codex" && codexBinaryPath !== null,
    engineEnv: (engine: EngineId, generation: number) => ({
      [ENV_ENGINE]: engine,
      [ENV_HOST_GENERATION]: String(generation),
      ...(engine === "codex" && codexBinaryPath !== null ? { [ENV_CODEX_BIN]: codexBinaryPath } : {}),
    }),
    reapEngineProcess: createEngineProcessReaper(),
    // Credential channel (slice 2.5 §3.3): an oauth-mode host asks main for a
    // fresh access token per attempt; resolve it for the selected oauth provider
    // (undefined for api_key / legacy -> the host keeps its static env key).
    resolveCredential: async () => {
      const id = settings?.provider.id;
      if (id === undefined || authKindFor(id) !== "oauth") {
        return undefined;
      }
      return getAccessTokenFor(id);
    },
  });

  registerTabIpc({ manager, persistence, dialog });

  // Window control plane (design/ui-track custom-titlebar §4): the four caption
  // handlers the renderer's custom titlebar drives. getWindow mirrors the
  // module-level nullable `win`, the same accessor seam the manager/updater use.
  registerWindowIpc({ getWindow: () => win });

  // Settings control plane (ruling §4). After every successful mutation main
  // rebuilds the host env + readiness. Normal GUI launch stays at zero tabs;
  // only explicit initial targets (`--resume`/ANYCODE_RESUME or ANYCODE_WORKSPACE)
  // are started after a readiness flip.
  registerSettingsIpc({
    vault,
    bootEnv,
    settingsPath,
    logger: fileLogger,
    // Slice 2.5: catalog allow-list + projection + oauth wiring (additive).
    catalogIds: catalogProviderIds(),
    catalog: projectCatalogSummary(getBuiltinCatalog().providers),
    authKindFor,
    isCustom: isCustomProvider,
    oauth: oauthEngine,
    oauthConfigFor: (id) => oauthConfigFromEntry(findCatalogEntry(id)),
    onMutation: async () => {
      settings = (await loadSettings(settingsPath, fileLogger)).settings;
      await refreshProviderState();
      if (
        providerReady &&
        manager !== null &&
        manager.count() === 0 &&
        !quitting &&
        (parkedResumeId !== undefined || resolveWorkspaceFromEnv() !== undefined)
      ) {
        await startInitialTab({ onNoWorkspace: "stay", deliverNow: true, promptForWorkspace: false });
      }
    },
  });

  // MCP config management control plane (design/slice-P7.19-cut.md §3/§4 W2):
  // `home` resolves via `ANYCODE_MCP_IMPORT_HOME` ONLY under the dev/automation
  // double gate (W5-FIX, finding 5 — `resolveMcpImportHome` refuses it in a
  // packaged production build), else the real homedir; `workspaceForTab` reads

  registerMcpConfigIpc({
    home: () => resolveMcpImportHome(process.env, app.isPackaged) ?? homedir(),
    workspaceForTab: (tabId) => manager?.getTab(tabId)?.workspace,
    fs: new NodeMcpConfigFs(),
  });

  // Skills management control plane (design/slice-P7.20-cut.md §5 W2): mirrors
  // the MCP config registration exactly. `home` resolves via
  // `ANYCODE_SKILLS_IMPORT_HOME` ONLY under the same dev/automation double gate
  // as `ANYCODE_MCP_IMPORT_HOME` (`resolveSkillsImportHome` below refuses it in
  // a packaged production build), else the real homedir; `workspaceForTab`

  // `reveal` injects the one Electron primitive (`shell.showItemInFolder`) the
  // handlers need, so `main/skills-ipc.ts` itself stays Electron-free and unit-
  // testable off a plain deps bag.
  registerSkillsIpc({
    home: () => resolveSkillsImportHome(process.env, app.isPackaged) ?? homedir(),
    workspaceForTab: (tabId) => manager?.getTab(tabId)?.workspace,
    fs: new NodeSkillsFs(),
    reveal: (path) => shell.showItemInFolder(path),
  });

  // Subagents editor control plane (design/slice-P7.21-cut.md §4 W2): mirrors
  // the skills registration exactly. `home` resolves via
  // `ANYCODE_SUBAGENTS_HOME` ONLY under the same dev/automation double gate as
  // `ANYCODE_SKILLS_IMPORT_HOME` (`resolveSubagentsHome` above refuses it in a
  // packaged production build), else the real homedir; `workspaceForTab` reads

  // injects the one Electron primitive (`shell.showItemInFolder`) the handlers
  // need, so `main/subagents-ipc.ts` itself stays Electron-free and unit-
  // testable off a plain deps bag.
  registerSubagentsIpc({
    home: () => resolveSubagentsHome(process.env, app.isPackaged) ?? homedir(),
    workspaceForTab: (tabId) => manager?.getTab(tabId)?.workspace,
    fs: new NodeSubagentsFs(),
    reveal: (path) => shell.showItemInFolder(path),
  });

  // Profile-stats control plane (design/slice-P7.22-cut.md §2-D5 W2): mirrors
  // the skills/subagents registration exactly. `home` resolves via
  // `ANYCODE_PROFILE_HOME` ONLY under the same dev/automation double gate as
  // `ANYCODE_SUBAGENTS_HOME` (`resolveProfileHome` above refuses it in a
  // packaged production build), else the real homedir; there is no
  // `workspaceForTab` lever here — Profile is a user-scope-only page (D2), it
  // never resolves a per-tab project config; `reveal` injects the one
  // Electron primitive (`shell.showItemInFolder`) the handlers need, so
  // `main/profile-ipc.ts` itself stays Electron-free and unit-testable off a
  // plain deps bag.
  registerProfileIpc({
    home: () => resolveProfileHome(process.env, app.isPackaged) ?? homedir(),
    fs: new NodeProfileFs(),
    reveal: (path) => shell.showItemInFolder(path),
    env: process.env,
  });

  createWindow();

  // Auto-updater (design/slice-2.6-cut.md §6): additive register — gated
  // internally on app.isPackaged, so a dev run never touches autoUpdater.
  registerUpdater({ autoUpdater, isPackaged: app.isPackaged, getWindow: () => win, logger: fileLogger });

  // Boot decision tree: explicit initial targets start a tab; a normal GUI launch
  // opens with zero tabs and no folder dialog. The parked resume id waits for the
  // readiness flip via onMutation when the provider is not configured yet.
  if (providerReady && (parkedResumeId !== undefined || resolveWorkspaceFromEnv() !== undefined)) {
    await startInitialTab({ onNoWorkspace: "stay", deliverNow: false, promptForWorkspace: false });
  } else {
    console.log("[main] opening window with zero tabs");
  }

  // Dev-only automation channel: the compile-time gate is false in a release
  // build, so Rollup removes this dynamic import and its server chunk. The
  // runtime env/unpackaged checks remain defense in depth for `electron-vite
  // dev`. A bind failure must not take down the GUI, so it is logged, not thrown.
  const automationManager = manager;
  if (__ANYCODE_DEV_AUTOMATION__ && process.env.ANYCODE_AUTOMATION === "1" && !app.isPackaged && automationManager !== null) {
    try {
      const { startAutomationServer } = await import("./automation/server.js");
      await startAutomationServer({ getWindow: () => win, manager: automationManager, app });
    } catch (error) {
      console.error("[main] automation server failed to start", error);
    }
  }
});

app.on("window-all-closed", () => {
  // Single-window MVP (design §11): closing the window quits the app on every
  // platform, routing through before-quit so the hosts shut down gracefully.
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) {
    // Second pass after shutdownAllTabHosts resolved: let the quit proceed.
    return;
  }
  quitting = true;
  if (manager === null || manager.count() === 0) {
    // Nothing to shut down (e.g. env-validation exit); quit normally.
    return;
  }
  event.preventDefault();
  const activeManager = manager;
  const activePersistence = persistence;
  void activeManager
    .shutdownAllTabHosts()
    .then(async () => {
      // Close the picker/migration connection last, after every host has
      // drained its own write-behind queue and exited.
      await activePersistence?.close();
    })
    .finally(() => app.quit());
});

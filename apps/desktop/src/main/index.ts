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
import { access, realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, MessageChannelMain, app, dialog, nativeImage, safeStorage, shell, utilityProcess } from "electron";
// electron-updater is CJS and exposes `autoUpdater` via a dynamic getter that
// Node's cjs-module-lexer cannot see as a named export; a named ESM import
// (`import { autoUpdater }`) throws at module-link time and blocks boot. The
// default-import + destructure is the supported CJS-interop shape.
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { SqlitePersistenceAdapter } from "@anycode/core/persistence";
import { NodeExecutionAdapter } from "@anycode/core/node-execution";
import { NodeGitAdapter } from "@anycode/core/node-git";
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
import { activeConnection, activeProviderView, connectionById } from "../shared/settings.js";
import {
  applyCodexProfilesHomeOverride,
  applySubagentsHomeOverride,
  buildHostEnv,
  computeProviderReady,
  connectionSecretKey,
  customKindDefaultTransport,
  customProviderIds,
  customProviderSecretKey,
  customSupportedTransports,
  findCustomProviderRecord,
  isCustomProviderRecordId,
  resolveEffectiveTransport,
  scrubSecretEnv,
  shouldSkipConnectionHealthBinding,
  snapshotBootEnv,
  type ResolvedProviderSelection,
} from "./host-env.js";
import { NodeMcpConfigFs, registerMcpConfigIpc } from "./mcp-config-ipc.js";
import { NodeProfileFs, registerProfileIpc } from "./profile-ipc.js";
import { NodeSkillsFs, registerSkillsIpc } from "./skills-ipc.js";
import { NodeSubagentsFs, registerSubagentsIpc } from "./subagents-ipc.js";
import { OAuthEngine, oauthConfigFromEntry } from "./oauth.js";
import { registerProviderIpc } from "./provider-ipc.js";
import {
  applyConnectionHealthEvent,
  handleSet,
  projectCatalogSummary,
  registerSettingsIpc,
  sanitizeProviderFailureCode,
  type SettingsIpcDeps,
} from "./settings-ipc.js";
import type { ProviderHealthEvent } from "../shared/provider-health.js";
import { TabHostManager, createPinReservations } from "./tabs.js";
import { TokenBroker, resolveProviderSelection, type CatalogSelectionInfo } from "./token-broker.js";
import { registerTabIpc, type ResolveCodexProfileResult } from "./tab-ipc.js";
import { ENV_CODEX_BIN, ENV_ENGINE, ENV_HOST_GENERATION, type EngineId } from "../shared/engines.js";
// SLICE-CC A1 (cut §1.2): new import line — ENV_CLAUDE_BIN mirrors ENV_CODEX_BIN above.
import { ENV_CLAUDE_BIN } from "../shared/engines.js";
import { ENGINES_CHANGED_CHANNEL, registerCodexIpc, type CodexOnboardingController } from "./codex-ipc.js";
// SLICE-CC A3 (cut §1.2): new import line — mirrors the codex-ipc import above.
import { registerClaudeIpc, type ClaudeOnboardingController } from "./claude-ipc.js";
import { SYSTEM_PROFILE_ID, codexProfilesRoot, resolveCodexProfile } from "./codex-profiles.js";
import { registerCodexRolloutIpc } from "./codex-rollout-ipc.js";
import { registerCodexInstallIpc } from "./codex-install.js";
import { refreshCodexManifest, setActiveCodexVersionPolicy } from "./codex-manifest.js";
import { closeAllCodexChildren, installCodexChildExitGuard, liveCodexChildCount } from "./codex-children.js";
import { createEngineProcessReaper } from "./engine-reaper.js";
import { registerUpdater, type UpdaterController } from "./updater.js";
import { runWorktreeJanitor } from "./worktree-janitor.js";

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

// TASK.45 W11-FIX (W13 live-dogfood finding): push-only, no payload — the
// renderer re-fetches via `settings.get()` (settings-store.ts's
// `subscribeProviderHealth`). Duplicated literal, not a `shared/**` export
// (preload/index.ts holds the byte-identical copy) — same "duplicated on
// purpose" precedent as `ENGINES_CHANGED_CHANNEL`.
const PROVIDER_HEALTH_CHANGED_CHANNEL = "anycode:provider-health-changed";

/**
 * Normalizes a raw host-reported `ProviderHealthEvent` into the shape
 * `applyConnectionHealthEvent` accepts, or `undefined` to drop it entirely
 * (TASK.45 W11-FIX H1). `tabs.ts` casts the parentPort message to
 * `ProviderHealthEvent` with NO runtime shape validation, so at the process
 * boundary `kind` can be any string despite the type-level `"success" |
 * "failure"` union (only a first-party host is the real producer, but the
 * boundary itself must not trust that). A `kind` outside the two known
 * literals is DROPPED rather than coerced to failure — coercing an
 * unrecognised shape into "failure" would paint a healthy connection red on
 * a signal the host was never meant to send. `code` is sanitized via
 * `sanitizeProviderFailureCode` so an arbitrary/leaked string can never reach
 * persisted `lastHealth.safeCode`.
 */
function normalizeProviderHealthEvent(
  event: ProviderHealthEvent,
): { kind: "success" } | { kind: "failure"; code: string } | undefined {
  if (event.kind === "success") {
    return { kind: "success" };
  }
  if (event.kind === "failure") {
    return { kind: "failure", code: sanitizeProviderFailureCode(event.code) };
  }
  return undefined;
}

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

/**
 * Dev-only override for the user home the Codex profile tree
 * (`<home>/.anycode/codex/…`) lives under (codex-profiles W4-F0, findings
 * S1-2), same "duplicated on purpose" rule as `resolveProfileHome` above
 * (`ANYCODE_CODEX_PROFILES_HOME`, local to this module). Same double gate:
 * `ANYCODE_AUTOMATION==="1" && !isPackaged` — a packaged production build
 * NEVER honors the var (and never throws on it), so every consumer falls
 * back to the real `os.homedir()` there. Lets a live smoke mint
 * `plain`/`authLink` profiles in a disposable root instead of writing into
 * the owner's real `~/.anycode/codex` (W4-S1b/S2/S3/S4).
 *
 * Write-plane delta from the read-plane sibling levers above (W4-F0d, Fable
 * ruling iter-11): gate satisfied + var present + malformed (empty or
 * relative after trim) THROWS instead of returning null. This base is where
 * the profile registry / install plane CREATE directories, so a silent
 * null-fallback would route every write into the owner's real
 * `~/.anycode/codex` on a mere operator typo (unexpanded `~`, relative path,
 * empty string) — the forbidden write, masked as a green smoke run. The
 * message family matches the host-side reader
 * (`resolveCodexProfilesHomeOverride`, host/engines/codex/codex-home.ts) by
 * contract — grep parity. Gate-refused and var-absent still resolve to
 * `null` with no throw: ambient garbage never breaks a normal dev launch or
 * a packaged build, and an automation run without the lever keeps the
 * production byte-path.
 */
function resolveCodexProfilesHome(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (env.ANYCODE_AUTOMATION !== "1" || isPackaged) {
    return null;
  }
  const raw = env.ANYCODE_CODEX_PROFILES_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      "ANYCODE_CODEX_PROFILES_HOME is set but empty under automation; refusing to boot instead of falling back to the real home",
    );
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `ANYCODE_CODEX_PROFILES_HOME must be an absolute path under automation, got ${JSON.stringify(trimmed)}; refusing to boot instead of falling back to the real home`,
    );
  }
  return trimmed;
}

/**
 * The W4-F0 codex profiles-home lever (findings S1-2), resolved ONCE at
 * module scope (W4-F0d eager fail-fast, Fable ruling iter-11): a malformed
 * value under the automation gate throws HERE — a synchronous boot refusal
 * with a non-zero exit, before a single mkdir of ANY plane (including the
 * userData override below) and before the whenReady registration ever runs
 * (a throw inside the whenReady callback would be an unhandled rejection and
 * a half-alive windowless app instead). This single resolution is the one
 * truth consumed by BOTH sites: `buildHostEnvFor`'s set-or-DELETE host-fork
 * scrub and the whenReady codex registration site (profile registry /
 * install plane / manifest cache / rollout resolver /
 * `resolveCodexProfileForTab`), so the main-plane resolutions of one record
 * can never disagree. `undefined` (production / gate-refused / var-absent)
 * leaves every consumer on its real `homedir()` default.
 */
const codexProfilesHome: string | undefined = resolveCodexProfilesHome(process.env, app.isPackaged) ?? undefined;

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
/**
 * Codex onboarding control plane (TASK.41). Held module-level for the SAME
 * reason `manager` is: quit must be able to tear down what it spawned. Its
 * doctor/login/preflight children are `detached` process-group leaders, so they
 * survive an Electron exit that does not await their teardown (W2-review
 * Critical) — `before-quit`/`will-quit` below await `shutdown()`.
 */
let codexOnboarding: CodexOnboardingController | null = null;
/**
 * Claude onboarding control plane (SLICE-CC A3, cut §1.2 mirror of
 * `codexOnboarding` above). Its doctor children are bounded, short-lived
 * one-shot probes (main/claude-doctor.ts) that tear themselves down before
 * their own promise settles — unlike Codex's login flow, CC-A has no
 * long-lived detached child that could outlive quit, so `shutdown()` here is
 * a lighter hook (see claude-ipc.ts's own doc comment).
 */
let claudeOnboarding: ClaudeOnboardingController | null = null;
/** Discovery ladder's last winning candidate for the Claude engine (mirrors `codexBinaryPath` below). */
let claudeBinaryPath: string | null = null;
/** Set once quit begins, to gate the before-quit handler's second pass. */
let quitting = false;
/** Auto-updater controller (TASK.47 W15) — held module-level so before-quit can clear its armed schedule timer. Null until boot registers it. */
let updaterController: UpdaterController | null = null;



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
/**
 * Codex onboarding state (TASK.41, cut §2(g)): `codexBinaryPath` is the
 * discovery ladder's last winning candidate (informational — its mere
 * presence no longer implies readiness), updated by codex-ipc's `onSnapshot`
 * callback, fired after every recheck/pick-binary/login-success, so a Codex
 * tab can be created the moment onboarding completes — no app restart.
 * Readiness itself is PER PROFILE (codex-profiles cut §4.2: a function of
 * (binary, profile), not one global boolean) — `engineReady("codex")` reads
 * `codexOnboarding.readyFor(...)` directly off the controller's in-memory
 * per-profile report cache.
 */
let codexBinaryPath: string | null = null;
/**
 * The host fork env, rebuilt async on every successful mutation and read

 * up by the next respawn.
 */
let currentHostEnv: NodeJS.ProcessEnv = {};
/**
 * Per-pinned-connection host env (TASK.45 W10). A tab pinned to a connection that
 * is NOT the current active one (a resumed non-active connection, or one whose
 * default has since changed) forks with the env resolved for ITS connection, so
 * a default-switch never retargets a live session's account. Rebuilt on every
 * `refreshProviderState` for the connections the manager reports as live-pinned,
 * so a key-replace on a pinned connection is picked up on its next respawn. A
 * pin equal to the active connection resolves to `currentHostEnv` (always fresh).
 */
let hostEnvByConnection = new Map<string, NodeJS.ProcessEnv>();
/**
 * In-flight pinned-connection reservations (TASK.45 W10-FIX F3, layer a). A resume
 * synchronously reserves its pin BEFORE priming the env and releases it once the
 * tab is registered (or on failure), so the delete-guard's `connectionInUse` sees
 * the pin as in-use across the whole window — registered ∪ pending — closing the
 * resume/delete TOCTOU with no lock in the resume path (the §3.2 deadlock).
 */
const pinReservations = createPinReservations();
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
    needsBaseUrl: entry.baseUrl === "",
    defaultTransport: entry.defaultTransport,
    supportedTransports: entry.supportedTransports,
  };
}

/** Auth kind of a catalog id (undefined = unknown id). */
function authKindFor(id: string): "api_key" | "oauth" | undefined {
  return findCatalogEntry(id)?.auth.kind;
}

/**
 * The active connection's credential key (TASK.45 v2): its own connection key.
 * `{}` when no connection is active.
 *
 * FX4: a `custom:*` providerId routes at the custom provider's OWN shared
 * vault key (`provider.<custom-id>.apiKey`, host-env.ts's
 * `customProviderSecretKey`) instead of the connection key — mirroring
 * `buildHostEnv`'s custom-provider route, which never reads the connection
 * key for a custom id. Deliberately NO record look-up: a deleted custom
 * provider still yields its (now-orphaned) secret key, so the vault read
 * naturally comes back unset and the fail-closed default gate does the rest.
 */
function activeCredential(current: AnycodeSettings): { credentialKey?: SecretKey } {
  const connection = activeConnection(current);
  if (connection === undefined) {
    return {};
  }
  const providerId = connection.providerId;
  if (isCustomProviderRecordId(providerId)) {
    return { credentialKey: customProviderSecretKey(providerId) };
  }
  const kind = providerId === "" ? undefined : authKindFor(providerId);
  const authKind: "api_key" | "oauth" = kind === "oauth" ? "oauth" : "api_key";
  return { credentialKey: connectionSecretKey(connection.id, authKind) };
}

/**
 * buildHostEnv's legacy/custom/no-active branch credential: the active
 * connection's api-key connection key. An oauth connection never reaches this
 * branch (it takes the catalog path).
 */
const resolveActiveCredential = (current: AnycodeSettings): (() => Promise<string | undefined>) => {
  const spec = activeCredential(current);
  return () => (spec.credentialKey === undefined ? Promise.resolve(undefined) : getSecret(spec.credentialKey));
};

/** Fresh OAuth access token via the broker (blob by connectionId, config by providerId); undefined pre-boot / not signed in. */
const getAccessTokenFor = (connectionId: string, providerId: string): Promise<string | undefined> =>
  tokenBroker === null ? Promise.resolve(undefined) : tokenBroker.getAccessToken(connectionId, providerId);

/**
 * Auth-policy + transport-guard inputs for `computeProviderReady` (TASK.43 W5,
 * cut Risk #3) — the core-aware counterpart of settings-ipc.ts's own
 * `selectedTransportInfo` (that module stays core-free, so it re-derives the
 * same thing off the projected `CatalogSummary` instead of `findCatalogEntry`).
 * `authOptional` is true either statically (a catalog entry marked
 * `authOptional`, e.g. vLLM) or dynamically for `custom` once its resolved
 * transport is an OpenAI-family one (mirrors core's `loadEnvConfig`).
 *
 * FX4: a `custom:*` providerId with a live record resolves its OWN kind-implied
 * ladder (`customKindDefaultTransport`/`customSupportedTransports`, mirroring
 * `buildHostEnv`'s custom-provider route) BEFORE `findCatalogEntry` is even
 * consulted — `findCatalogEntry` only knows builtin ids, so it would otherwise
 * fall through to the generic no-catalog-entry branch below (no supported-
 * transport guard, `authOptional` always false, wrongly blocking a keyless
 * openai-family custom provider). A deleted record (providerId still
 * `custom:*` but no matching entry in `settings.provider.custom[]`) falls
 * through unchanged to that same generic fail-closed branch.
 */
function selectedTransportInfo(current: AnycodeSettings): {
  authOptional: boolean;
  resolvedTransport?: string;
  supportedTransports?: readonly string[];
} {
  const view = activeProviderView(current);
  const id = view.id;
  // Legacy / no-catalog branches: still apply the env rung over the active
  // connection's transport, but there is no catalog entry to validate against.
  const resolveLegacy = (): string | undefined =>
    resolveEffectiveTransport({ bootEnv, settingsTransport: view.transport }).value;
  if (id === undefined || id.trim() === "") {
    return { authOptional: false, resolvedTransport: resolveLegacy() };
  }
  const customRecord = isCustomProviderRecordId(id) ? findCustomProviderRecord(current, id) : undefined;
  if (customRecord !== undefined) {
    // resolvedTransport is always defined here: customKindDefaultTransport
    // always supplies a defaultTransport rung, so resolveEffectiveTransport's
    // ladder never falls through to "unset".
    const resolvedTransport = resolveEffectiveTransport({
      bootEnv,
      settingsTransport: view.transport,
      defaultTransport: customKindDefaultTransport(customRecord.kind),
    }).value;
    return {
      authOptional: resolvedTransport !== "anthropic-messages",
      resolvedTransport,
      supportedTransports: customSupportedTransports(customRecord.kind),
    };
  }
  if (isCustomProviderRecordId(id)) {
    // W4-R3-1: a `custom:*` id with NO live record (deleted while a connection
    // still names it — e.g. removed via the generic settings-patch channel,
    // which skips handleCustomProviderDelete's clear-first, leaving an orphaned
    // vault key). `buildHostEnv` fail-closes here (neither baseUrl nor key), so
    // readiness MUST be false even if that orphaned key or ANYCODE_API_KEY is
    // present. An empty supportedTransports set trips computeProviderReady's
    // transport guard — but only when resolvedTransport is defined, so pin a
    // non-empty sentinel when neither env nor the connection selects one (a bare
    // resolveLegacy() can be undefined, which would SKIP the guard entirely).
    return { authOptional: false, resolvedTransport: resolveLegacy() ?? "custom-provider-deleted", supportedTransports: [] };
  }
  const entry = findCatalogEntry(id);
  if (entry === undefined) {
    return { authOptional: false, resolvedTransport: resolveLegacy() };
  }
  // Env-inclusive ladder (env > active-connection transport > catalog default)
  // so the readiness guard + the custom auth-waiver see the SAME transport the
  // fork runs.
  const resolvedTransport = resolveEffectiveTransport({
    bootEnv,
    settingsTransport: view.transport,
    defaultTransport: entry.defaultTransport,
  }).value;
  const authOptional =
    entry.authOptional === true ||
    (isCustomProvider(id) && resolvedTransport !== undefined && resolvedTransport !== "anthropic-messages");
  return { authOptional, resolvedTransport, supportedTransports: entry.supportedTransports };
}

/** Current settings, or the empty v2 default (pre-load / fresh install). */
function currentSettings(): AnycodeSettings {
  return (
    settings ?? {
      version: 2,
      provider: { connections: [] },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    }
  );
}

/**
 * The allow-list `isKnownSecretKey`/`Vault.statuses` (via settingsIpcDeps)
 * check a `provider.<id>.{apiKey,oauth}` vault key against: every builtin
 * catalog id, unioned with every custom-provider id currently in `current`
 * (TASK.54, host-env.ts's `customProviderIds` seam). Recomputed — not a
 * boot-time snapshot — so a custom provider created/renamed/deleted after
 * boot is reflected on its very next settings/provider IPC call.
 */
function catalogIdsFor(current: AnycodeSettings): string[] {
  return [...catalogProviderIds(), ...customProviderIds(current)];
}

/**
 * A copy of `current` with the active connection overridden to `connectionId`
 * (TASK.45 W10): routes every existing active-connection resolver
 * (resolveProviderSelection / activeCredential / activeProviderView) at the
 * PINNED connection without duplicating any of that logic. Used to build a fork
 * env for a session pinned to a non-active connection (resume / post-switch).
 */
function settingsPinnedTo(current: AnycodeSettings, connectionId: string): AnycodeSettings {
  return { ...current, provider: { ...current.provider, activeConnectionId: connectionId } };
}

/**
 * Builds the host fork env for a given settings view (its active connection).
 * Shared by the active-connection env (`currentHostEnv`) and every pinned
 * connection env — same core-free resolution path, just a different view.
 */
async function buildHostEnvFor(current: AnycodeSettings): Promise<NodeJS.ProcessEnv> {
  const resolveSelection = (): Promise<ResolvedProviderSelection | undefined> =>
    resolveProviderSelection({
      settings: current,
      resolveCatalog,
      getApiKey: (connectionId) => getSecret(connectionSecretKey(connectionId, "api_key")),
      getAccessToken: getAccessTokenFor,
    });
  const env = await buildHostEnv({
    bootEnv,
    settings: current,
    getSecret,
    resolveSelection,
    resolveActiveCredential: resolveActiveCredential(current),
  });
  applySubagentsHomeOverride(env, resolveSubagentsHome(bootEnv, app.isPackaged));
  // W4-F0b host lever forward (Fable ruling iter-10): set-or-DELETE, so a raw
  // ambient var can never ride the bootEnv spread into a host fork ungated.
  // Consumes the module-scope `codexProfilesHome` const (W4-F0d single eager
  // resolution) — F0b's stateless per-rebuild re-resolve is gone: module
  // scope initializes before whenReady, so the ordering hazard it defended
  // against (refreshProviderState racing a whenReady-time assignment) no
  // longer exists by construction.
  applyCodexProfilesHomeOverride(env, codexProfilesHome ?? null);
  return env;
}

/**
 * Recomputes the host fork env + readiness from the current settings/vault so a
 * scrub never changes the outcome. Also rebuilds the per-pinned-connection env
 * cache (TASK.45 W10) for every connection a live tab is pinned to that is NOT
 * the active one, so a resumed/pinned session keeps its own account and a
 * key-replace on that connection is honoured on its next respawn.
 */
async function refreshProviderState(): Promise<void> {
  const current = currentSettings();
  currentHostEnv = await buildHostEnvFor(current);
  const transportInfo = selectedTransportInfo(current);
  const credential = activeCredential(current);
  providerReady = await computeProviderReady({
    bootEnv,
    settings: current,
    getSecret,
    credentialKey: credential.credentialKey,
    authOptional: transportInfo.authOptional,
    resolvedTransport: transportInfo.resolvedTransport,
    supportedTransports: transportInfo.supportedTransports,
  });

  const activeId = current.provider.activeConnectionId;
  const next = new Map<string, NodeJS.ProcessEnv>();
  for (const id of manager?.pinnedConnectionIds() ?? new Set<string>()) {
    // A pin equal to the active connection uses `currentHostEnv`; a deleted pin
    // (blocked from deletion while live, but defensive) has no env to build.
    if (id !== activeId && connectionById(current, id) !== undefined) {
      next.set(id, await buildHostEnvFor(settingsPinnedTo(current, id)));
    }
  }
  hostEnvByConnection = next;
}

/**
 * The fork base env for a tab pinned to `connectionId` (TASK.45 W10). Active pin
 * (or none) -> the always-fresh `currentHostEnv`; a non-active pin -> its cached
 * per-connection env.
 *
 * TASK.45 W10-FIX F3 (layer c, fail-closed): a cache-MISS for a pinned non-active
 * id returns `undefined` — NEVER `currentHostEnv`. The only way a live-pinned
 * non-active connection is absent from the cache is that its connection was
 * deleted (`refreshProviderState` drops deleted pins), so falling back to the
 * active env would run the wrong account's credentials under this pin's
 * ANYCODE_CONNECTION_ID. The spawn path (main/tabs.ts) refuses to fork on
 * `undefined` instead. A healthy pin is always primed by `ensurePinnedEnv` /
 * `refreshProviderState` before it spawns, so this only ever bites the deleted case.
 */
function hostEnvForConnection(connectionId?: string): NodeJS.ProcessEnv | undefined {
  if (connectionId === undefined || connectionId === currentSettings().provider.activeConnectionId) {
    return currentHostEnv;
  }
  return hostEnvByConnection.get(connectionId);
}

/**
 * Primes the per-connection env cache for a pinned connection before its tab
 * spawns (TASK.45 W10). A no-op for the active connection (uses currentHostEnv)
 * or a missing one (the caller has already refused `connection_missing`).
 */
async function ensurePinnedEnv(connectionId: string): Promise<void> {
  const current = currentSettings();
  if (connectionId === current.provider.activeConnectionId) {
    return;
  }
  if (connectionById(current, connectionId) === undefined) {
    return;
  }
  hostEnvByConnection.set(connectionId, await buildHostEnvFor(settingsPinnedTo(current, connectionId)));
}

/**
 * Resolves a resumed session's pinned connection (TASK.45 W10 resume matrix):
 *  - no pin (legacy session) -> ok, no connection id (resume on current default);
 *  - pin still exists -> reserve + prime its env + ok with the id;
 *  - pin deleted -> refusal carrying the missing id (renderer replacement flow).
 *
 * TASK.45 W10-FIX F3 (layer a): the existence check and the reservation are done
 * SYNCHRONOUSLY (before the first `await`, one microtask — JS atomicity), so a
 * concurrent `handleConnectionDelete` either sees the reservation and refuses
 * `connection_in_use`, or has already removed the connection so this refuses
 * `connection_missing`. The `ok` result carries a `release` the caller invokes in
 * a `finally` AFTER `manager.createTab` (by which point the pin is visible via the
 * registered tab) and on every failure path, so the pin is never briefly
 * unguarded. Deliberately takes NO settings lock (the §3.2 re-entrant deadlock).
 */
async function resolveResumePin(meta: {
  connectionId?: string;
}): Promise<{ ok: true; connectionId?: string; release: () => void } | { ok: false; connectionId: string }> {
  const pinnedId = meta.connectionId;
  if (pinnedId === undefined) {
    return { ok: true, release: () => {} };
  }
  // Synchronous check + reserve (no await between them): the reservation makes the
  // pin `connectionInUse` for any delete that races past this point.
  if (connectionById(currentSettings(), pinnedId) === undefined) {
    return { ok: false, connectionId: pinnedId };
  }
  pinReservations.reserve(pinnedId);
  try {
    await ensurePinnedEnv(pinnedId);
  } catch (error) {
    pinReservations.release(pinnedId);
    throw error;
  }
  // TASK.45 W11-FIX M4-narrowing: `ensurePinnedEnv`'s vault reads are the
  // longest await in this path, so a concurrent `handleConnectionDelete` can
  // finish entirely (including its `onMutation` refresh, which drops this
  // pin from `hostEnvByConnection`) while priming was in flight. Re-checking
  // existence here narrows the dead-tab window down to this sub-await gap: a
  // pin that died mid-prime now refuses `connection_missing` immediately
  // (the caller's already-reserved slot is released) instead of registering
  // a tab that would only die on its first respawn. Custody stays with layer
  // (c) (main/tabs.ts) for whatever residual window remains — no settings
  // lock is taken here (the §3.2 re-entrant deadlock).
  if (connectionById(currentSettings(), pinnedId) === undefined) {
    pinReservations.release(pinnedId);
    return { ok: false, connectionId: pinnedId };
  }
  return { ok: true, connectionId: pinnedId, release: () => pinReservations.release(pinnedId) };
}

/**
 * Resolves an opaque Codex profile id — a new tab's draft pick, or a resumed
 * session's persisted `codexProfileId` — against the profile registry
 * (codex-profiles cut §3.3, W3-F) into the argv facts main/tabs.ts forwards.
 * `system` (never persisted as a real record) is the one deliberate ambient
 * case: `{ok:true}` with no `codexProfile` at all, byte-identical to today's
 * behaviour. Any OTHER id absent from the registry refuses `{ok:false}`
 * fail-closed — a deleted/renamed real profile must never silently fall back
 * to the ambient account (same custody rule as `resolveResumePin`'s
 * connection refusal above).
 */
async function resolveCodexProfileForTab(profileId: string): Promise<ResolveCodexProfileResult> {
  if (profileId === SYSTEM_PROFILE_ID) {
    return { ok: true };
  }
  const record = settings?.codex?.profiles?.find((profile) => profile.id === profileId);
  if (record === undefined) {
    return { ok: false };
  }
  // Resolved against the SAME home the registry uses (W4-F0 lever,
  // `codexProfilesHome` — undefined in production): the argv facts this
  // produces (linked --codex-home, expanded --codex-auth-link) must agree
  // with what the registry created/asserted for this record.
  const resolution = resolveCodexProfile(record, codexProfilesHome);
  if (!resolution.ok || resolution.profile.codexHome === undefined) {
    return { ok: false };
  }
  const { profile } = resolution;
  return {
    ok: true,
    codexProfile: {
      id: profile.id,
      ...(profile.linked ? { home: profile.codexHome } : {}),
      ...(profile.authLink !== undefined ? { authLink: profile.authLink } : {}),
    },
  };
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
  // TASK.45 W10: the initial tab pins to a connection too. A resume re-pins to
  // the session's stored connection (a deleted pin is NOT silently switched to
  // the default — the tab is skipped so the picker surfaces the replacement); a
  // new session pins to the current active connection.
  let connectionId: string | undefined;
  // W10-FIX F3: released once the tab is registered (or on any early return) so
  // the resume/delete reservation never outlives the window it guards.
  let releasePin: (() => void) | undefined;
  // Codex-profiles W3-F: the initial (app-launch) resume re-resolves the
  // session's persisted profile too, same fail-closed rule as the tab-ipc.ts
  // resume branch — undefined for a legacy/system session (ambient CODEX_HOME).
  let codexProfileParam: { id?: string; home?: string; authLink?: string } | undefined;
  if (resumed !== null) {
    const pin = await resolveResumePin(resumed);
    if (!pin.ok) {
      console.warn(
        `[main] session ${resumed.id} is pinned to a deleted connection (${pin.connectionId}); not auto-resuming — choose a replacement in the session picker`,
      );
      return;
    }
    if (resumed.codexProfileId !== undefined) {
      const resolvedProfile = await resolveCodexProfileForTab(resumed.codexProfileId);
      if (!resolvedProfile.ok) {
        console.warn(
          `[main] session ${resumed.id} is pinned to a missing Codex profile (${resumed.codexProfileId}); not auto-resuming`,
        );
        pin.release?.();
        return;
      }
      codexProfileParam = resolvedProfile.codexProfile;
    }
    workspace = resumed.workspace;
    sessionId = resumed.id;
    resume = true;
    connectionId = pin.connectionId;
    releasePin = pin.release;
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
    connectionId = settings?.provider.activeConnectionId;
    console.log(`[main] workspace: ${workspace}`);
  }

  try {
    const created = manager.createTab({
      workspace,
      sessionId,
      resume,
      ...(connectionId !== undefined ? { connectionId } : {}),
      ...(codexProfileParam !== undefined ? { codexProfile: codexProfileParam } : {}),
    });
    if (!created.ok) {
      console.error(`[main] failed to create initial tab: ${created.reason}`);
      return;
    }
    if (opts.deliverNow) {
      manager.deliverTabPort(created.tab);
    }
  } finally {
    // The tab (if created) is now registered, so its pin is guarded by the
    // registered set — safe to drop the in-flight reservation.
    releasePin?.();
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
  // Codex discovery+diagnosis itself is wired further below (registerCodexIpc
  // + the fire-and-forget initial recheck), once `settings` is loaded — the
  // discovery ladder's "settings" rung needs `settings.codex.binaryPath`,
  // which does not exist yet at this point in boot.


  // and migrates once (a read forces open()+migrate()), then hosts open the
  // already-migrated schema. WAL keeps main's long-lived reader from blocking
  // the host writers.
  const dbPath = resolveDbPath();
  persistence = new SqlitePersistenceAdapter(dbPath);
  await persistence.listSessions({ limit: 1 });
  console.log(`[main] persistence opened + migrated: ${dbPath}`);

  // One global, ledger-driven pass before any tab host can mutate worktree
  // state. It never discovers deletion authority from a namespace/prefix: only
  // exact durable cleanup records are eligible, and every ambiguity is retained.
  try {
    const janitorExec = new NodeExecutionAdapter();
    const janitor = await runWorktreeJanitor({
      persistence,
      gitForWorkspace: (cwd) => new NodeGitAdapter({ exec: janitorExec, cwd }),
      exists: async (target) => {
        try {
          await access(target);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      log: (message) => console.log(message),
    });
    if (janitor.examined > 0) {
      console.log(
        `[main] worktree janitor complete: examined=${janitor.examined} cleaned=${janitor.cleaned} retained=${janitor.retained}`,
      );
    }
  } catch (error) {
    // Cleanup is fail-safe. A DB/Git outage leaves ledgers intact for the next
    // startup or the owning session's normal continuation path.
    console.warn(`[main] worktree janitor skipped: ${error instanceof Error ? error.message : String(error)}`);
  }


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
  // Boot-time scrub of stale v1 provider secrets (TASK.45 W9 §2): W9′ keys every
  // credential by connection, so a leftover legacy `provider.apiKey` /
  // `provider.<id>.{apiKey,oauth}` would lie to readiness/status projections.
  // Deletes ONLY the two exact legacy forms (enumerate-good — connection keys and
  // unrecognized keys are untouched), idempotent + fail-soft internally. It
  // touches secrets.json, not settings.json, so no read_only gate is needed.
  await vault.scrubLegacyProviderKeys(catalogProviderIds());
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


    // TASK.45 W10: fork env resolved for the tab's PINNED connection (session
    // pinning), not merely the current active one.
    env: (connectionId) => hostEnvForConnection(connectionId),
    // TASK.45 W10-FIX F2: the pinned connection's immutable providerId for the
    // tab-port envelope, so the renderer's ModelPill targets the PINNED
    // connection's catalog + write-target. Undefined for a since-deleted pin.
    describeConnection: (connectionId) => {
      if (settings === null) return undefined;
      const connection = connectionById(settings, connectionId);
      return connection === undefined ? undefined : { providerId: connection.providerId };
    },
    providerReady: () => providerReady,
    // Codex has no dependency on AnyCode's provider settings. Its main-plane
    // readiness fact is the codex-doctor-CONFIRMED status (version-compatible
    // AND signed in, TASK.41 п.2/п.3) — a merely-discovered-but-unchecked or
    // stale-cached path is never enough to let a tab spawn. Readiness is
    // per PROFILE (codex-profiles cut §4.2): the tab layer threads the profile
    // the spawn will run under as the optional second argument (S3-1 — the
    // draft's pick on a new tab, the persisted meta pick on a resume); absent,
    // the ACTIVE profile answers — today's single-profile behavior.
    engineReady: (engine: EngineId, codexProfileId?: string) => {
      // SLICE-CC A1 (cut §1.2): claude branch tracks REAL doctor readiness
      // even though main/tabs.ts's canSpawn("claude") refuses every spawn
      // unconditionally until CC-C — CC-C then only needs to remove that
      // hard block, since this readiness fact is already wired correctly.
      if (engine === "claude") return claudeOnboarding?.readyFor() ?? false;
      return engine === "core" ? providerReady : engine === "codex" && (codexOnboarding?.readyFor(codexProfileId) ?? false);
    },
    engineEnv: (engine: EngineId, generation: number) => ({
      [ENV_ENGINE]: engine,
      [ENV_HOST_GENERATION]: String(generation),
      ...(engine === "codex" && codexBinaryPath !== null ? { [ENV_CODEX_BIN]: codexBinaryPath } : {}),
      ...(engine === "claude" && claudeBinaryPath !== null ? { [ENV_CLAUDE_BIN]: claudeBinaryPath } : {}),
    }),
    reapEngineProcess: createEngineProcessReaper(),
    // Credential channel (slice 2.5 §3.3 + TASK.45 W10): an oauth-mode host asks
    // main for a fresh access token per attempt; resolve it for the tab's PINNED
    // connection (its own account across a default-switch), falling back to the
    // active one for an unpinned/legacy tab. Undefined for api_key / legacy ->
    // the host keeps its static env key.
    resolveCredential: async (connectionId) => {
      if (settings === null) {
        return undefined;
      }
      const connection =
        connectionId !== undefined ? connectionById(settings, connectionId) : activeConnection(settings);
      if (connection === undefined || connection.providerId === "" || authKindFor(connection.providerId) !== "oauth") {
        return undefined;
      }
      return getAccessTokenFor(connection.id, connection.providerId);
    },
    // TASK.45 W11: a core host's real request outcome for its pinned connection.
    // `settingsIpcDeps` is declared further below in this SAME function scope —
    // this callback only ever fires long after boot() has finished (the next
    // agent_event/finish on a live tab), by which point it is long since
    // assigned (same forward-reference precedent as `connectionInUse` above
    // closing over `manager`). Env-override (`ANYCODE_API_KEY` in the boot
    // snapshot) means the pinned connection's OWN credential is not what
    // actually ran — its saved plaquette must not be painted from a request
    // that used a different, ephemeral key (cut §W11 env-override rule).
    onProviderHealthEvent: (connectionId, event) => {
      if (shouldSkipConnectionHealthBinding(bootEnv)) {
        return;
      }
      const healthEvent = normalizeProviderHealthEvent(event);
      if (healthEvent === undefined) {
        console.warn(`[main] dropping malformed provider-health event (kind=${JSON.stringify(event.kind)})`);
        return;
      }
      // TASK.45 W11-FIX (W13 live-dogfood finding): `applyConnectionHealthEvent`
      // deliberately never fires the normal `onMutation` broadcast (health
      // must not trigger the readiness/host-env/auto-tab cascade a real
      // settings mutation does) — but that also meant zero renderer push at
      // all, so an already-loaded app's connection tile stayed on a stale
      // reading until an unrelated mutation happened to refresh it. Pushed
      // ONLY after the write actually lands (never on a failed persist —
      // there is nothing new to reflect). No-op outcomes (read-only settings,
      // connection deleted mid-flight) resolve `false` and do not push.
      void applyConnectionHealthEvent(settingsIpcDeps, connectionId, healthEvent)
        .then((persisted) => {
          if (persisted) {
            win?.webContents.send(PROVIDER_HEALTH_CHANGED_CHANNEL);
          }
        })
        .catch((error) => {
          console.error(`[main] failed to record connection health`, error);
        });
    },
  });

  // S4-1 arm 2 (W4-F1): the rollout-import IPC (registered further below, once
  // persistence exists) owns the ephemeral import-model map; its consume-once
  // reader is captured into this holder there and read lazily here, so the resume
  // path can override the fork model. The holder is filled at boot wiring — long
  // before any user-driven resume can run — so the lazy indirection never races.
  let consumeImportModel: ((sessionId: string) => string | undefined) | undefined;
  // L4·1 peek-then-confirm: the resume path PEEKS the pick (read-only) to stamp
  // the override, then consumes it (holder above) only after createTab commits.
  let peekImportModel: ((sessionId: string) => string | undefined) | undefined;
  registerTabIpc({
    manager,
    persistence,
    dialog,
    // TASK.45 W10: a NEW core session pins to the active connection; a RESUMED
    // one re-pins to its stored connection (or refuses `connection_missing`).
    activeConnectionId: () => settings?.provider.activeConnectionId,
    // S4-1 arm 2: consume-once import-model override for the first resume of an
    // imported session (see the holder above). Undefined until the rollout IPC
    // wires it below; harmless (no override) for any resume before then.
    consumePendingImportModel: (sessionId) => consumeImportModel?.(sessionId),
    // L4·1: read-only peek of the import pick, burned via consume above only on a
    // successful createTab (see the holders above; wired below with the rollout IPC).
    peekPendingImportModel: (sessionId) => peekImportModel?.(sessionId),
    resolveResumePin,
    resolveCodexProfile: resolveCodexProfileForTab,
    // TASK.64: the boot-time Codex recheck is fire-and-forget, so a session
    // clicked before its first doctor snapshot lands (or pinned to a profile
    // nobody diagnosed since boot) would read the fail-closed default as "not
    // configured". The gate splits that UNKNOWN from a KNOWN not-ready and
    // awaits the first verdict instead of falsely refusing. Core readiness is
    // settled at boot before IPC registers, so it is always known here.
    engineReadyKnown: (engine, codexProfileId) => {
      // SLICE-CC A1 (cut §1.2): claude branch mirrors codex's — a session
      // pinned to claude nobody diagnosed yet is UNKNOWN, not known-bad, even
      // though canSpawn refuses it unconditionally regardless (main/tabs.ts).
      if (engine === "claude") return claudeOnboarding?.hasVerdictFor() ?? false;
      return engine === "core" ? true : engine === "codex" && (codexOnboarding?.hasVerdictFor(codexProfileId) ?? false);
    },
    hydrateEngineReady: async (engine, codexProfileId) => {
      if (engine === "codex" && codexOnboarding !== null) {
        // An argless recheck coalesces onto the in-flight boot run (same
        // active-profile key); an explicit profile id queues its own doctor
        // behind it — at most one extra run, only inside the boot window.
        await codexOnboarding.recheck(codexProfileId);
      }
      // SLICE-CC A1 (cut §1.2): claude has no profiles yet (CC-E), so there is
      // nothing to key a recheck by.
      if (engine === "claude" && claudeOnboarding !== null) {
        await claudeOnboarding.recheck();
      }
    },
    validateWorktreeResume: async (meta) => {
      if (meta.worktree === undefined || meta.projectRoot === undefined) return false;
      try {
        const root = await fsRealpath(meta.projectRoot);
        const target = await fsRealpath(meta.worktree.path);
        const rel = relative(root, target);
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
        const git = new NodeGitAdapter({ exec: new NodeExecutionAdapter(), cwd: root });
        const listed = await git.worktreeList?.();
        if (!listed?.ok) return false;
        for (const item of listed.value) {
          if (item.isMain || item.branch !== meta.worktree.branch) continue;
          try {
            if ((await fsRealpath(item.path)) === target) return true;
          } catch {
            // Ignore stale registrations; another entry may still match.
          }
        }
        return false;
      } catch {
        return false;
      }
    },
  });

  // Window control plane (design/ui-track custom-titlebar §4): the four caption
  // handlers the renderer's custom titlebar drives. getWindow mirrors the
  // module-level nullable `win`, the same accessor seam the manager/updater use.
  registerWindowIpc({ getWindow: () => win });

  // Settings control plane (ruling §4). After every successful mutation main
  // rebuilds the host env + readiness. Normal GUI launch stays at zero tabs;
  // only explicit initial targets (`--resume`/ANYCODE_RESUME or ANYCODE_WORKSPACE)
  // are started after a readiness flip. Named (not inlined) so codex-ipc's
  // `writeCodexSettings` below can reuse the EXACT SAME deps bag through
  // settings-ipc's own exported `handleSet` — one settings.json writer.
  const settingsIpcDeps: Omit<SettingsIpcDeps, "vault"> & { vault: Vault } = {
    vault,
    bootEnv,
    settingsPath,
    logger: fileLogger,
    // Slice 2.5: catalog allow-list + projection + oauth wiring (additive).
    // TASK.54: unioned with custom-provider ids so their vault keys are
    // recognized too; kept in sync post-boot by both onMutation hooks below.
    catalogIds: catalogIdsFor(currentSettings()),
    // Carry `isCustom` (TASK.43 W5-FIX #2/#5): core has no literal field, so it
    // is derived per entry from `isCustomProvider` and folded into the projected
    // summary the renderer consumes for credential-slot + fallback decisions.
    catalog: projectCatalogSummary(
      getBuiltinCatalog().providers.map((entry) => ({ ...entry, isCustom: isCustomProvider(entry.id) })),
    ),
    authKindFor,
    isCustom: isCustomProvider,
    // TASK.49: dev = apps/desktop/package.json's version, packaged = the bundled version.
    getAppVersion: () => app.getVersion(),
    oauth: oauthEngine,
    oauthConfigFor: (id) => oauthConfigFromEntry(findCatalogEntry(id)),
    // TASK.45 W10 delete-guard: refuse deleting a connection an open session is
    // pinned to (it still resolves that connection's credential on every respawn).
    // W10-FIX F3: "in use" is registered ∪ pending — a resume that has RESERVED a
    // pin but not yet registered its tab counts too, closing the resume/delete race.
    connectionInUse: (connectionId) =>
      (manager?.pinnedConnectionIds().has(connectionId) ?? false) || pinReservations.has(connectionId),
    onMutation: async () => {
      settings = (await loadSettings(settingsPath, fileLogger)).settings;
      // TASK.54: `provider.custom` is schema-reachable through this generic
      // patch channel too, so re-derive the union defensively here as well
      // (not just from registerProviderIpc's own onMutation below).
      settingsIpcDeps.catalogIds = catalogIdsFor(settings);
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
  };
  registerSettingsIpc(settingsIpcDeps);

  // Custom OpenAI-compatible model-provider control plane (TASK.54, cut
  // §9.2/§13.1): CRUD for `settings.provider.custom[]` + the guarded
  // `/v1/models` preview fetch, behind its own four invoke channels. Mirrors
  // settingsIpcDeps.onMutation immediately above — provider-ipc.ts already
  // hands back the POST-mutation `AnycodeSettings` (not a projected
  // snapshot), so no re-load from disk is needed here, unlike that hook.
  registerProviderIpc({
    vault,
    settingsPath,
    logger: fileLogger,
    // Connection-scoped fetch-models resolution (structural, same discipline
    // as settingsIpcDeps' catalog injection): only id/baseUrl/defaultTransport
    // ever cross this seam.
    catalogEntryById: (id) => {
      const entry = findCatalogEntry(id);
      return entry === undefined
        ? undefined
        : { id: entry.id, baseUrl: entry.baseUrl, defaultTransport: entry.defaultTransport };
    },
    onMutation: async (fresh) => {
      settings = fresh;
      settingsIpcDeps.catalogIds = catalogIdsFor(fresh);
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

  // Codex onboarding control plane (TASK.41, cut §2(g)): discovery ladder +
  // bounded doctor + native login, behind four invoke channels + one push.
  // `writeCodexSettings` routes through settings-ipc's own `handleSet` (same
  // zod validation / deep-partial merge / read_only guard as every other
  // settings-set patch) rather than a second ad-hoc settings.json writer.
  // Last-resort reap for the quit paths that never let us await anything (a
  // crash, an uncaught exception, app.exit()): one synchronous group SIGKILL
  // per live Codex child, from `process.on("exit")`. The graceful path is
  // before-quit's awaited `shutdown()` below; this is the floor under it.
  installCodexChildExitGuard();

  // W4-F0 (findings S1-2): the codex profiles-root home lever — the
  // module-scope `codexProfilesHome` const (W4-F0d eager fail-fast) —
  // threaded into every consumer below (registerCodexIpc /
  // registerCodexInstallIpc / refreshCodexManifest's cache file / the
  // rollout-import resolver / resolveCodexProfileForTab's record
  // resolution). `undefined` — the production case and any gate-refused
  // override — leaves every consumer on its own real `homedir()` default,
  // byte-identical to before this lever existed; a malformed value under
  // automation never reaches here (module-top boot refusal).
  codexOnboarding = registerCodexIpc({
    bootEnv,
    ...(codexProfilesHome !== undefined ? { home: codexProfilesHome } : {}),
    readBinaryPathSetting: async () => settings?.codex?.binaryPath,
    // The profile registry's settings slice (codex-profiles cut §2.3), read
    // fresh off the same in-memory settings the onMutation reload maintains.
    readCodexSettings: async () => settings?.codex,
    writeCodexSettings: (patch) => handleSet(settingsIpcDeps, { codex: patch }),
    dialog,
    openExternal: (url) => shell.openExternal(url),
    onSnapshot: (snapshot) => {
      codexBinaryPath = snapshot.binaryPath;
      // Per-tab session pushes are gated on ui_ready (durable rule); this is
      // a window-shell-level signal, the same unconditional-send shape as
      // WINDOW_STATE_CHANNEL/UPDATE_STATUS_CHANNEL — the renderer's listener
      // is registered at bundle load, well before this can ever fire.
      win?.webContents.send(ENGINES_CHANGED_CHANNEL);
    },
    // Profile CRUD (create/delete/set-active/repair) changes what the Agent
    // selector / Settings pane should show — same re-fetch push as above.
    onProfilesChanged: () => {
      win?.webContents.send(ENGINES_CHANGED_CHANNEL);
    },
  });

  // Kick off the first discovery+doctor pass in the background (TASK.41 п.1:
  // a compatible CLI on PATH must be found with no env var and no user
  // action). Never awaited here — a slow or hung Codex CLI must not delay
  // the window from appearing; `engineReady("codex")` simply stays false
  // (its safe default) until this resolves.
  void codexOnboarding.recheck().catch((error: unknown) => {
    console.warn("[main] initial Codex check failed", error);
  });

  // SLICE-CC A3 (cut §1.2): Claude onboarding wiring — mirrors the codex
  // block immediately above, minus everything CC-A is out of scope for
  // (native login, profile CRUD, quotas, install/manifest).
  claudeOnboarding = registerClaudeIpc({
    bootEnv,
    readBinaryPathSetting: async () => settings?.claude?.binaryPath,
    writeClaudeSettings: (patch) => handleSet(settingsIpcDeps, { claude: patch }),
    dialog,
    onSnapshot: (snapshot) => {
      claudeBinaryPath = snapshot.binaryPath;
      // Same unconditional-send push shape as the codex onSnapshot above.
      win?.webContents.send(ENGINES_CHANGED_CHANNEL);
    },
  });

  // Kick off the first discovery+doctor pass in the background, mirroring the
  // codex boot-time recheck above (`engineReady("claude")` simply stays false
  // until this resolves, and canSpawn("claude") refuses regardless of it
  // until CC-C).
  void claudeOnboarding.recheck().catch((error: unknown) => {
    console.warn("[main] initial Claude check failed", error);
  });

  // Codex install/version control plane (TASK.53, cut §7): download-with-
  // integrity + risk acceptance behind IPC; the version policy is seeded from
  // settings, then advisorily refreshed from the git manifest — fail-closed
  // on the bundled manifest for ANY refresh failure (404 until the file
  // lands on master, network down, garbage — none of them can WIDEN the
  // supported range).
  registerCodexInstallIpc({
    ...(codexProfilesHome !== undefined ? { home: codexProfilesHome } : {}),
    readRiskAcceptedVersions: async () => settings?.codex?.riskAcceptedVersions ?? [],
    writeCodexSettings: (patch) => handleSet(settingsIpcDeps, { codex: patch }),
    onChanged: () => {
      win?.webContents.send(ENGINES_CHANGED_CHANNEL);
      void codexOnboarding?.recheck().catch(() => {});
    },
  });
  setActiveCodexVersionPolicy({ riskAcceptedVersions: settings?.codex?.riskAcceptedVersions ?? [] });
  // `codexProfilesHome` (W4-F0 lever, undefined in production) rides into the
  // root derivation — codexProfilesRoot's own homedir() default applies when
  // the lever is refused/absent.
  void refreshCodexManifest({ cacheFile: join(codexProfilesRoot(codexProfilesHome), "manifest.json") })
    .then((result) => {
      // BM4: only an ACTUAL policy change re-spawns the doctor — an
      // identical manifest (the common case: cache hit, no-op refresh)
      // leaves whatever readiness the boot-time recheck already established.
      const changed = setActiveCodexVersionPolicy({ manifest: result.manifest });
      if (changed) {
        void codexOnboarding?.recheck().catch(() => {});
      }
    })
    .catch(() => {});

  // Rollout import control plane (TASK.52, cut §8): list/preview/import a
  // profile's Codex rollouts into OUR history format. Sessions live inside
  // that profile's CODEX_HOME (§1.3); the system pseudo-profile reads the
  // ambient home (env override or ~/.codex), matching what a codex spawned
  // with no injection would write to. Read-only with respect to the rollout
  // files themselves — the importer never writes into any CODEX_HOME.
  if (persistence !== null) {
    const rolloutIpc = registerCodexRolloutIpc({
      persistence,
      // S4-1 arm 1 (W4-F1): pin an imported session to the connection active at
      // apply time (same source as registerTabIpc's `activeConnectionId` above).
      activeConnectionId: () => settings?.provider.activeConnectionId,
      resolveProfileSessionsDir: async (profileId) => {
        if (profileId === SYSTEM_PROFILE_ID) {
          const ambient = process.env.CODEX_HOME;
          const systemHome = ambient !== undefined && ambient !== "" ? ambient : join(homedir(), ".codex");
          return join(systemHome, "sessions");
        }
        const record = settings?.codex?.profiles?.find((profile) => profile.id === profileId);
        if (record === undefined) return null;
        // This resolver derives a profile home OUTSIDE the registry, so the
        // W4-F0 lever must reach it too — else an isolated smoke's import
        // dialog would list rollouts from the owner's REAL profile tree.
        const resolution = resolveCodexProfile(record, codexProfilesHome);
        if (!resolution.ok || resolution.profile.codexHome === undefined) return null;
        return join(resolution.profile.codexHome, "sessions");
      },
    });
    // S4-1 arm 2: hand the import model plane's consume-once reader to tab-ipc's
    // resume path (captured in the holder wired above registerTabIpc).
    consumeImportModel = rolloutIpc.consumePendingImportModel;
    peekImportModel = rolloutIpc.peekPendingImportModel;
  }

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

  // Auto-updater (design/slice-2.6-cut.md §6; TASK.47 W15 adds the auto-check
  // schedule + darwin honest-manual-path): additive register — gated
  // internally on app.isPackaged, so a dev run never touches autoUpdater.
  // `platform`/`openExternal` drive TASK.47 defect 2 (darwin has no
  // Developer ID yet, so Squirrel.Mac would reject a downloaded update —
  // `openReleasesPage()` opens the fixed GitHub Releases URL instead).
  updaterController = registerUpdater({
    autoUpdater,
    isPackaged: app.isPackaged,
    getWindow: () => win,
    logger: fileLogger,
    platform: process.platform,
    openExternal: (url) => shell.openExternal(url),
  });

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
      await startAutomationServer({
        getWindow: () => win,
        manager: automationManager,
        app,
        // TASK.45 W10 (W13 live-dogfood finding): same source `registerTabIpc`'s
        // `handleCreate` pins a real "new" tab from — without this, every
        // automation-created tab silently spawned unpinned regardless of the
        // active connection.
        activeConnectionId: () => settings?.provider.activeConnectionId,
      });
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

/**
 * Every child this process owns dies BEFORE Electron exits — tab hosts and
 * Codex onboarding children alike (W2-review Critical: the latter were owned by
 * nothing, and being `detached`, survived quit; a login held its group for up to
 * five minutes). The two teardowns are independent, so they run concurrently and
 * are both awaited; persistence closes last, once every host has drained its
 * write-behind queue.
 */
async function shutdownEverything(): Promise<void> {
  const activeManager = manager;
  const activePersistence = persistence;
  const activeOnboarding = codexOnboarding;
  // SLICE-CC A3 (cut §1.2): mirrors `activeOnboarding` above.
  const activeClaudeOnboarding = claudeOnboarding;
  // TASK.47 W15: clear the armed auto-check timer, if any — synchronous,
  // ahead of the awaited teardown below (nothing here depends on it).
  updaterController?.stop();
  await Promise.allSettled([
    activeManager !== null && activeManager.count() > 0 ? activeManager.shutdownAllTabHosts() : Promise.resolve(),
    activeOnboarding?.shutdown() ?? Promise.resolve(),
    activeClaudeOnboarding?.shutdown() ?? Promise.resolve(),
  ]);
  await activePersistence?.close();
}

app.on("before-quit", (event) => {
  if (quitting) {
    // Second pass after the teardown resolved: let the quit proceed.
    return;
  }
  quitting = true;
  event.preventDefault();
  void shutdownEverything().finally(() => app.quit());
});

/**
 * Backstop for a quit that never routed through `before-quit` (or one whose
 * teardown was interrupted): `will-quit` is the last event that can still hold
 * the app open. Idempotent — after a completed `before-quit` pass every child is
 * already gone and `closeAllCodexChildren()` finds an empty registry, so this
 * costs a microtask on the normal path.
 */
app.on("will-quit", (event) => {
  if (liveCodexChildCount() === 0) return;
  event.preventDefault();
  void closeAllCodexChildren().finally(() => app.quit());
});

/**
 * Codex onboarding control plane (TASK.41, cut §2(g)/§3.8): the invoke-API
 * behind the Settings Codex card — recheck (discovery ladder + bounded
 * doctor), explicit file-picker override, and the native login flow
 * (start/cancel). Wires main/codex-binary.ts (discovery), main/codex-
 * doctor.ts (diagnosis), and main/codex-login.ts (sign-in) together, persists
 * ONLY path/status metadata into settings.codex (never a token — cut §2(g)),
 * and hands the caller a fresh snapshot on every successful step so the
 * renderer can re-render without a restart (TASK.41 п.5).
 *
 * CHANNEL NAMES ARE DUPLICATED LITERALS, not `shared/**` exports: every lane
 * in this track froze `shared/**` as read-only after block C0 (design cut §4
 * disjointness rules) specifically so no two parallel lanes fight over the
 * same file. This mirrors the codebase's existing precedent for a boundary
 * that can't reach a shared module (e.g. `ENV_WORKSPACE`/`ENV_DB_PATH` in
 * main/index.ts, `buildCodexChildEnv` duplicated in main/codex-doctor.ts) —
 * preload/index.ts and renderer/src/anycode-window.d.ts hold byte-identical
 * copies of these five constants, kept in sync by contract.
 */
import { ipcMain } from "electron";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { ENV_CODEX_BIN } from "../shared/engines.js";
import { CODEX_ONBOARDING_SHUTDOWN_BUDGET_MS } from "../shared/codex-timeouts.js";
import { closeAllCodexChildren } from "./codex-children.js";
import {
  discoverCodexBinary,
  resolveCodexBinary,
  type CodexBinaryFs,
  type CodexBinarySource,
  type CodexIdentity,
} from "./codex-binary.js";
import { runCodexDoctor, type RunCodexDoctorOptions } from "./codex-doctor.js";
import { runCodexLogin, type CodexLoginOutcome, type RunCodexLoginOptions } from "./codex-login.js";

// ── invoke/push channels (duplicated literals — see file header) ──

export const CODEX_RECHECK_CHANNEL = "anycode:codex-recheck";
export const CODEX_PICK_BINARY_CHANNEL = "anycode:codex-pick-binary";
export const CODEX_LOGIN_START_CHANNEL = "anycode:codex-login-start";
export const CODEX_LOGIN_CANCEL_CHANNEL = "anycode:codex-login-cancel";
/** Push: main -> renderer, fired after every snapshot-changing step (TASK.41 п.5). No payload — listeners re-fetch (`listAvailableEngines`/`codex-recheck`), same shape as `updates.onUpdateStatus`/`window.onWindowState`. */
export const ENGINES_CHANGED_CHANNEL = "anycode:engines-changed";

// ── wire shapes (duplicated structurally in anycode-window.d.ts; CodexDoctorReport itself is the frozen shared/codex-doctor.ts type, imported read-only) ──

export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  /** The winning candidate path, or null when nothing on the ladder resolved. */
  binaryPath: string | null;
  source: CodexBinarySource;
  /** ISO timestamp of this check. */
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

export interface DialogLike {
  showOpenDialog(options: { properties: Array<"openFile">; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface CodexIpcDeps {
  /** Immutable boot-env snapshot (main/index.ts's `bootEnv`) — read for `ANYCODE_CODEX_BIN`/`PATH`/`HOME`/`APPDATA`, and passed through as the doctor/login child's SOURCE env (buildDoctorChildEnv still allowlists it). */
  bootEnv: NodeJS.ProcessEnv;
  /** Reads the currently-persisted `settings.codex.binaryPath`, fresh, every call (main is the sole writer; this module never caches it). */
  readBinaryPathSetting: () => Promise<string | undefined>;
  /**
   * Persists `{binaryPath?, lastCheck}` into `settings.codex` (cut §3.5).
   * Expected to route through the SAME `settings-set` validation/merge/save
   * pipeline settings-ipc.ts's `handleSet` already owns (main/index.ts wires
   * this as a thin closure over it) — one write path, not two. Best-effort
   * from this module's point of view: a `read_only` refusal must not block
   * the LIVE snapshot this session already computed from reaching the caller.
   */
  writeCodexSettings: (patch: {
    binaryPath?: string;
    lastCheck: { status: CodexDoctorReport["status"]; version?: string; at: string };
  }) => Promise<SettingsMutationResult>;
  dialog: DialogLike;
  openExternal: (url: string) => Promise<void> | void;
  /** Fired after every successful recheck/pick/login with the fresh snapshot — main/index.ts updates its own `codexReady` gate and pushes `ENGINES_CHANGED_CHANNEL`. */
  onSnapshot: (snapshot: CodexOnboardingSnapshot) => void;
  platform?: NodeJS.Platform;
  fs?: CodexBinaryFs;
  /** Test seam for the trust gate's ownership rules; production reads the live process identity. */
  identity?: CodexIdentity;
  /** DI seams for tests; production defaults to the real doctor/login runners. */
  runDoctor?: (binaryPath: string, options?: RunCodexDoctorOptions) => Promise<CodexDoctorReport>;
  runLogin?: (binaryPath: string, options: RunCodexLoginOptions) => Promise<CodexLoginOutcome>;
}

export interface CodexOnboardingController {
  recheck(): Promise<CodexOnboardingSnapshot>;
  pickBinary(): Promise<CodexPickBinaryResult>;
  loginStart(): Promise<CodexLoginStartResult>;
  loginCancel(): void;
  /**
   * App-lifecycle teardown (W2-review Critical). Every child this controller
   * opened — doctor, login, version preflight — is spawned `detached` (its own
   * POSIX process group), so it does NOT die with main: an Electron exit that
   * only stopped the tab hosts left the whole group alive, for up to the login's
   * five-minute window. Quit MUST call this and MUST await it, exactly as it
   * awaits `shutdownAllTabHosts()`.
   *
   * Aborts every in-flight run, awaits its bounded teardown, and then reaps
   * whatever is somehow still registered. Idempotent, never rejects, and after
   * it is called the controller refuses to start new work — a late IPC during
   * quit must not spawn a fresh orphan behind the teardown's back.
   *
   * INVARIANT (W3.5-review Critical): NO `codex` process is spawned by this
   * controller once `shutdown()` has begun — not "spawned and later reaped".
   * That holds only because the refusal is re-read on the far side of EVERY
   * pre-spawn `await` (the settings read, the file picker), not merely at a
   * method's entrance: a run parked on one of those awaits when quit lands is
   * not yet in the registry this drains, so an entrance-only check would let it
   * resume and spawn after the drain has already finished. The runners hold the
   * same line from the other side — an already-aborted signal makes
   * `runCodexDoctor`/`runCodexLogin` return before their first spawn.
   */
  shutdown(): Promise<void>;
}

/** Only a freshly CONFIRMED, non-dev-override path is worth remembering — an env override never persists (cut §3.5: "не env-override"), and "nothing found" must not clobber a path that may just be transiently unreachable (e.g. an unmounted volume). */
function shouldPersistPath(source: CodexBinarySource, binaryPath: string | null): binaryPath is string {
  return binaryPath !== null && source !== "env" && source !== "none";
}

async function persist(deps: CodexIpcDeps, snapshot: CodexOnboardingSnapshot): Promise<void> {
  try {
    await deps.writeCodexSettings({
      ...(shouldPersistPath(snapshot.source, snapshot.binaryPath) ? { binaryPath: snapshot.binaryPath } : {}),
      lastCheck: {
        status: snapshot.report.status,
        ...(snapshot.report.version !== undefined ? { version: snapshot.report.version } : {}),
        at: snapshot.checkedAt,
      },
    });
  } catch {
    // Best-effort persistence — see writeCodexSettings's own doc comment.
  }
}

/**
 * Builds the exclusive controller: `recheck`/`pickBinary`/an in-flight
 * `loginStart` all share ONE `inFlight` slot so this module never spawns two
 * doctor/login children concurrently from itself (each already has its own
 * bounded, zero-orphan teardown — this is about not doing needless
 * concurrent work, not a correctness requirement of the child lifecycle).
 * Exported (not just `registerCodexIpc`) so main/codex-ipc.test.ts can drive
 * the handlers directly, off a fake deps bag, the same shape as every other
 * `main/*-ipc.ts` sibling in this codebase.
 */
export function createCodexOnboardingController(deps: CodexIpcDeps): CodexOnboardingController {
  const runDoctor = deps.runDoctor ?? runCodexDoctor;
  const runLogin = deps.runLogin ?? runCodexLogin;
  let inFlight: Promise<CodexOnboardingSnapshot> | null = null;
  let activeLoginAbort: AbortController | null = null;
  /** Aborted once, at quit: every doctor run started by this controller carries this signal. */
  const lifetime = new AbortController();
  let shuttingDown = false;
  /**
   * Every run currently unwinding. Awaiting these IS awaiting the teardown of
   * the children they own: each runner closes its child in a `finally` before
   * its promise settles.
   */
  const activeRuns = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    activeRuns.add(promise);
    const forget = (): void => {
      activeRuns.delete(promise);
    };
    // `then(forget, forget)` (not `finally`) — it marks a rejection handled here
    // without deriving a NEW rejected promise that nobody would ever observe.
    promise.then(forget, forget);
    return promise;
  }

  function runExclusive(fn: () => Promise<CodexOnboardingSnapshot>): Promise<CodexOnboardingSnapshot> {
    if (inFlight !== null) {
      return inFlight;
    }
    const promise = fn().finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return track(promise);
  }

  /** No child, no spawn: quit is in progress and the ladder is closed for business. */
  function shutdownSnapshot(): CodexOnboardingSnapshot {
    return {
      report: { status: "error", error: "AnyCode is shutting down" },
      binaryPath: null,
      source: "none",
      checkedAt: new Date().toISOString(),
    };
  }

  function discover(): { path: string | null; source: CodexBinarySource } {
    return discoverCodexBinary({
      envOverride: deps.bootEnv[ENV_CODEX_BIN],
      env: deps.bootEnv,
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
    });
  }

  /** Runs the doctor against ONE explicit path+source, persists, notifies, and returns the fresh snapshot. */
  async function checkPath(binaryPath: string | null, source: CodexBinarySource): Promise<CodexOnboardingSnapshot> {
    // The choke point every doctor spawn in this module funnels through, and
    // therefore where the shutdown gate has to be re-read — an entrance check is
    // worth nothing across an `await`. `shutdown()` snapshots `activeRuns` and
    // then drains the child registry; a caller that was parked on a pre-spawn
    // `await` while that happened would otherwise resume afterwards and spawn a
    // detached child BEHIND the completed teardown — an orphan by construction.
    if (shuttingDown) {
      return shutdownSnapshot();
    }
    const report: CodexDoctorReport =
      binaryPath === null
        ? { status: "not_installed" }
        : await runDoctor(binaryPath, {
            env: deps.bootEnv,
            // Quit aborts the doctor and awaits its bounded teardown; without
            // this signal the child outlives the app (W2-review Critical).
            signal: lifetime.signal,
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          });
    const snapshot: CodexOnboardingSnapshot = { report, binaryPath, source, checkedAt: new Date().toISOString() };
    await persist(deps, snapshot);
    deps.onSnapshot(snapshot);
    return snapshot;
  }

  /** Full ladder: settings rung reads fresh (discovery needs it as an input, unlike the env/PATH/common rungs which read directly off `deps.bootEnv`). */
  async function discoverAndCheck(): Promise<CodexOnboardingSnapshot> {
    const settingsPath = await deps.readBinaryPathSetting();
    const discovery = discoverCodexBinary({
      envOverride: deps.bootEnv[ENV_CODEX_BIN],
      ...(settingsPath !== undefined ? { settingsPath } : {}),
      env: deps.bootEnv,
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
    });
    return checkPath(discovery.path, discovery.source);
  }

  return {
    recheck: (): Promise<CodexOnboardingSnapshot> =>
      shuttingDown ? Promise.resolve(shutdownSnapshot()) : runExclusive(discoverAndCheck),

    async pickBinary(): Promise<CodexPickBinaryResult> {
      if (shuttingDown) {
        return { ok: false, reason: "cancelled" };
      }
      if (inFlight !== null) {
        await inFlight; // let a concurrent recheck/login settle before opening a picker on top of it
      }
      const picked = await deps.dialog.showOpenDialog({ properties: ["openFile"] });
      // A picker can sit open across the whole quit: re-read the gate on the far
      // side of it, before the confirmed path is handed to a doctor run.
      if (shuttingDown) {
        return { ok: false, reason: "cancelled" };
      }
      const filePath = picked.filePaths[0];
      if (picked.canceled || filePath === undefined) {
        return { ok: false, reason: "cancelled" };
      }
      const resolved = resolveCodexBinary(filePath, deps.fs, deps.platform ?? process.platform, deps.identity);
      if (resolved.path === null) {
        return { ok: false, reason: "invalid" };
      }
      const confirmedPath = resolved.path;
      const snapshot = await runExclusive(() => checkPath(confirmedPath, "picker"));
      return { ok: true, snapshot };
    },

    async loginStart(): Promise<CodexLoginStartResult> {
      if (shuttingDown || inFlight !== null || activeLoginAbort !== null) {
        return { ok: false, reason: "busy" };
      }
      // The lock is claimed HERE, synchronously, before the function's first
      // `await` — two back-to-back (same-tick) calls must serialize on this
      // check with no interleaving microtask, or a second call could slip
      // through while the first is still awaiting `readBinaryPathSetting()`.
      const controller = new AbortController();
      activeLoginAbort = controller;
      try {
        const settingsPath = await deps.readBinaryPathSetting();
        // THE window this gate exists for: a login is not in `activeRuns` until
        // the spawn below registers it, so a `shutdown()` that lands while this
        // `await` is parked drains a registry the login is not in, finishes, and
        // the continuation then spawns a detached child — and opens a browser
        // window in the user's face — into an app that has already quit. Same
        // refusal as the entrance check: one shutdown answer per method.
        if (shuttingDown) {
          return { ok: false, reason: "busy" };
        }
        const discovery = discoverCodexBinary({
          envOverride: deps.bootEnv[ENV_CODEX_BIN],
          ...(settingsPath !== undefined ? { settingsPath } : {}),
          env: deps.bootEnv,
          ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
          ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
        });
        if (discovery.path === null) {
          return { ok: false, reason: "unsupported" };
        }
        const binaryPath = discovery.path;
        // Quit aborts the login too: `shutdown()` fires this same controller,
        // and the runner's own `finally` closes the child before the promise
        // `shutdown()` is awaiting can settle.
        const outcome = await track(
          runLogin(binaryPath, {
            openExternal: deps.openExternal,
            signal: controller.signal,
            env: deps.bootEnv,
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          }),
        );
        if (!outcome.ok) {
          return { ok: false, reason: outcome.reason };
        }
        // Re-diagnose via the doctor (never trust the login handshake's own
        // success flag for account/version state) — one source of truth for
        // "is Codex ready", the same doctor every other path uses.
        const snapshot = await runExclusive(() => checkPath(binaryPath, discovery.source));
        return { ok: true, snapshot };
      } finally {
        activeLoginAbort = null;
      }
    },

    loginCancel(): void {
      activeLoginAbort?.abort();
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      lifetime.abort();
      activeLoginAbort?.abort();
      // Each aborted run tears its own child down (bounded) before its promise
      // settles, so awaiting the runs IS awaiting the teardown.
      await Promise.race([
        Promise.allSettled([...activeRuns]),
        new Promise<void>((resolve) => setTimeout(resolve, CODEX_ONBOARDING_SHUTDOWN_BUDGET_MS)),
      ]);
      // Backstop, and the reason this is a guarantee rather than a hope: any
      // child still registered (a run that never unwound, a preflight mid-flight)
      // gets its process GROUP reaped directly. Zero survivors either way.
      await closeAllCodexChildren();
    },
  };
}

/** Wires the four invoke channels onto ipcMain. Returns the controller so main/index.ts can also drive `recheck()` directly for the fire-and-forget boot-time check (TASK.41 п.1: discovery must run without the user visiting Settings first). */
export function registerCodexIpc(deps: CodexIpcDeps): CodexOnboardingController {
  const controller = createCodexOnboardingController(deps);
  ipcMain.handle(CODEX_RECHECK_CHANNEL, () => controller.recheck());
  ipcMain.handle(CODEX_PICK_BINARY_CHANNEL, () => controller.pickBinary());
  ipcMain.handle(CODEX_LOGIN_START_CHANNEL, () => controller.loginStart());
  ipcMain.handle(CODEX_LOGIN_CANCEL_CHANNEL, () => controller.loginCancel());
  return controller;
}

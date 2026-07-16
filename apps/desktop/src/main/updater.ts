/**
 * Main-process auto-updater wiring (design/slice-2.6-cut.md §6; extended by
 * TASK.47 W15 — working-docs/tasks/TASK.47.md defects 2/3), mirroring
 * settings-ipc.ts's split: `createUpdaterController` holds all the testable
 * logic off an injected `AutoUpdaterLike` (so a vitest fake drives the whole
 * check->available->progress->downloaded->install chain with no Electron
 * runtime involved), and `registerUpdater` is the thin `ipcMain.handle`
 * wiring around it — the real `electron-updater` `autoUpdater` singleton
 * (imported in main/index.ts) satisfies `AutoUpdaterLike` structurally.
 *
 * isPackaged gate (design §6): a dev build (`!app.isPackaged`) never touches
 * the injected `autoUpdater` at all — no listener is attached, `autoDownload`
 * is never set, no schedule is armed, and all four invoke channels answer
 * `not_packaged` without calling into it. This is deliberate, not cosmetic:
 * electron-updater reads `app-update.yml` (present only in a packaged build)
 * the moment any of its methods run, so a dev build must never call into it.
 *
 * TASK.47 defect 3 (auto-check schedule): under `isPackaged`, a first check
 * fires ~10-30s after boot, then re-arms every ~4-6h (re-rolled each cycle —
 * the "jitter" keeps a fleet of installs from hammering the feed at the same
 * instant). The schedule ONLY ever calls `checkForUpdates()` — the identical
 * path `check()` below drives — so it can only ever move `status` through
 * checking/available/not-available/error, never downloading/downloaded
 * (`autoDownload=false` below is what actually enforces that; the schedule
 * simply never calls `downloadUpdate()` either way).
 *
 * TASK.47 defect 2 (darwin honest path): an ad-hoc-signed darwin build has no
 * Developer ID yet, so Squirrel.Mac would reject any downloaded update's
 * signature mismatch (real fix tracked by TASK.46). Rather than let a user
 * hit a silent "Update check failed" or a broken install, darwin's
 * `update-available` event is decorated with `manualOnly: true` (renderer
 * hides Download/Install and shows a link to GitHub Releases instead — see
 * SettingsScreen.tsx), and `download()`/`install()` refuse `manual_only`
 * unconditionally on darwin — a structural backstop, not merely a UI hint,
 * matching this file's existing "nothing for a compromised renderer to
 * redirect" posture.
 *
 * registration, for the life of the process — nothing ever downloads except
 * in direct response to the renderer's `download` invoke, and nothing ever
 * installs except in direct response to `install`. `download` refuses
 * `invalid_state` unless the last forwarded status was `available`;
 * `install` refuses `invalid_state` unless it was `downloaded`. All four
 * invoke handlers take NO renderer-supplied argument whatsoever (no URL, no
 * version, no channel) — the update feed is entirely main's own
 * configuration (`app-update.yml` / `electron-builder.yml`'s `publish`), so
 * there is structurally nothing for a compromised renderer to redirect.
 */
import { ipcMain } from "electron";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_OPEN_RELEASES_CHANNEL,
  UPDATE_RELEASES_URL,
  UPDATE_STATUS_CHANNEL,
} from "../shared/updates.js";
import type { UpdateActionResult, UpdateStatus } from "../shared/updates.js";

/**
 * The `electron-updater` surface this module depends on — structural, so a
 * test substitutes a fake with no real HTTP/filesystem behaviour. The real
 * `autoUpdater` singleton (`electronUpdater.autoUpdater`, default-imported to
 * satisfy CJS interop — see index.ts) satisfies this without a cast: same
 * shape as `VaultLike`/`OAuthRunnerLike` in settings-ipc.ts.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Minimal structural view of the renderer window this module pushes status into (mirrors tabs.ts's WindowLike, narrowed to just `send`). */
export interface UpdaterWindowLike {
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/**
 * Auto-check schedule knobs (TASK.47 defect 3), all optional — production
 * defaults (`DEFAULT_STARTUP_DELAY_RANGE_MS`/`DEFAULT_PERIODIC_INTERVAL_RANGE_MS`
 * below) apply when omitted. Tests override the ranges (e.g. to a few
 * milliseconds) and inject a deterministic `random`/`setTimer`/`clearTimer`
 * so the schedule is exercised without any real wait — same DI ethic as
 * engine-reaper.ts's `schedule` deps.
 */
export interface UpdaterScheduleDeps {
  /** [min, max) ms range for the delay before the FIRST automatic check after boot. */
  startupDelayRangeMs?: readonly [number, number];
  /** [min, max) ms range for the delay between automatic checks — re-rolled every cycle (the "jitter"), not a fixed interval. */
  intervalRangeMs?: readonly [number, number];
  /** Uniform [0,1) source, `Math.random` by default. */
  random?: () => number;
  /** `setTimeout`-alike, injectable for deterministic tests (fake timers or synchronous fakes). */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  /** `clearTimeout`-alike, paired with `setTimer`. */
  clearTimer?: (handle: unknown) => void;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  /** `app.isPackaged` — the sole gate on whether this module ever touches `autoUpdater` or arms the auto-check schedule. */
  isPackaged: boolean;
  /** The renderer window, or null when there is none yet (mirrors tabs.ts's `getWindow`). */
  getWindow: () => UpdaterWindowLike | null;
  logger?: { warn(message: string, err?: unknown): void };
  /**
   * TASK.47 defect 2: drives the darwin honest-manual-path gate. Defaults to
   * `process.platform` — tests override it to exercise darwin/win32/linux
   * without touching the real OS.
   */
  platform?: NodeJS.Platform;
  /**
   * Opens a URL in the system browser (`shell.openExternal` in main/index.ts)
   * — the ONLY thing `openReleasesPage()` ever calls, and always with the
   * fixed `UPDATE_RELEASES_URL` constant (never a renderer-supplied value).
   */
  openExternal?: (url: string) => unknown;
  /** Auto-check schedule overrides (TASK.47 defect 3); see `UpdaterScheduleDeps`. */
  schedule?: UpdaterScheduleDeps;
}

export interface UpdaterController {
  /** Current status (idle until the first event/check). */
  getStatus(): UpdateStatus;
  check(): Promise<UpdateActionResult>;
  download(): Promise<UpdateActionResult>;
  install(): UpdateActionResult;
  /** TASK.47 defect 2: opens `UPDATE_RELEASES_URL` in the system browser (darwin honest-manual-path action). */
  openReleasesPage(): UpdateActionResult;
  /** Clears the armed auto-check timer, if any (idempotent). Not wired to any IPC channel — main/index.ts calls it on shutdown for hygiene. */
  stop(): void;
}

/** Default startup-check delay (TASK.47 defect 3): ~10-30s after boot. */
export const DEFAULT_STARTUP_DELAY_RANGE_MS: readonly [number, number] = [10_000, 30_000];

/** Default periodic-check interval (TASK.47 defect 3): re-rolled ~4-6h, every cycle. */
export const DEFAULT_PERIODIC_INTERVAL_RANGE_MS: readonly [number, number] = [4 * 60 * 60_000, 6 * 60 * 60_000];

/** Uniform pick within `[min, max)`; `max <= min` degenerates to `min` (guards a misconfigured/zero-width test range). */
function pickDelayMs(range: readonly [number, number], random: () => number): number {
  const [min, max] = range;
  if (max <= min) {
    return min;
  }
  return min + random() * (max - min);
}

/**
 * Builds the controller (exported separately from `registerUpdater` so a
 * test drives it directly with a fake `AutoUpdaterLike`, without an Electron
 * `ipcMain` — the same split as settings-ipc.ts's exported `handle*`
 * functions vs `registerSettingsIpc`).
 */
export function createUpdaterController(deps: UpdaterDeps): UpdaterController {
  let status: UpdateStatus = { kind: "idle" };
  const platform = deps.platform ?? process.platform;
  // TASK.47 defect 2: the ONE gate every darwin-specific branch below reads.
  const manualOnlyPlatform = platform === "darwin";

  const scheduleDeps = deps.schedule ?? {};
  const random = scheduleDeps.random ?? Math.random;
  const setTimer = scheduleDeps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = scheduleDeps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startupRange = scheduleDeps.startupDelayRangeMs ?? DEFAULT_STARTUP_DELAY_RANGE_MS;
  const intervalRange = scheduleDeps.intervalRangeMs ?? DEFAULT_PERIODIC_INTERVAL_RANGE_MS;
  let timerHandle: unknown = null;

  function emit(next: UpdateStatus): void {
    status = next;
    deps.getWindow()?.webContents.send(UPDATE_STATUS_CHANNEL, next);
  }

  async function check(): Promise<UpdateActionResult> {
    if (!deps.isPackaged) {
      return { ok: false, reason: "not_packaged" };
    }
    try {
      await deps.autoUpdater.checkForUpdates();
    } catch (err) {
      deps.logger?.warn("updater: checkForUpdates failed", err);
      throw err;
    }
    return { ok: true };
  }

  async function download(): Promise<UpdateActionResult> {
    if (!deps.isPackaged) {
      return { ok: false, reason: "not_packaged" };
    }
    if (manualOnlyPlatform) {
      return { ok: false, reason: "manual_only" };
    }
    if (status.kind !== "available") {
      return { ok: false, reason: "invalid_state" };
    }
    try {
      await deps.autoUpdater.downloadUpdate();
    } catch (err) {
      deps.logger?.warn("updater: downloadUpdate failed", err);
      throw err;
    }
    return { ok: true };
  }

  function install(): UpdateActionResult {
    if (!deps.isPackaged) {
      return { ok: false, reason: "not_packaged" };
    }
    if (manualOnlyPlatform) {
      return { ok: false, reason: "manual_only" };
    }
    if (status.kind !== "downloaded") {
      return { ok: false, reason: "invalid_state" };
    }
    deps.autoUpdater.quitAndInstall();
    return { ok: true };
  }

  function openReleasesPage(): UpdateActionResult {
    if (!deps.isPackaged) {
      return { ok: false, reason: "not_packaged" };
    }
    try {
      deps.openExternal?.(UPDATE_RELEASES_URL);
    } catch (err) {
      deps.logger?.warn("updater: openExternal failed", err);
    }
    return { ok: true };
  }

  /** Arms one timer; each fire re-arms itself with a freshly-rolled interval (recursive setTimeout, not setInterval — avoids drift and re-rolls the jitter every cycle). */
  function scheduleNextCheck(delayMs: number): void {
    timerHandle = setTimer(() => {
      void check().catch(() => {
        // check() already logged the failure via deps.logger; a transient
        // network blip must not kill the recurring schedule.
      });
      scheduleNextCheck(pickDelayMs(intervalRange, random));
    }, delayMs);
  }

  if (deps.isPackaged) {
    // Consent-first (design §6): disable electron-updater's own auto-download
    // for the life of the process — `download()` above is the ONLY path that
    // ever calls `downloadUpdate()`.
    deps.autoUpdater.autoDownload = false;
    deps.autoUpdater.on("checking-for-update", () => emit({ kind: "checking" }));
    deps.autoUpdater.on("update-available", (info) =>
      emit(
        manualOnlyPlatform
          ? { kind: "available", version: info.version, manualOnly: true }
          : { kind: "available", version: info.version },
      ),
    );
    deps.autoUpdater.on("update-not-available", () => emit({ kind: "not-available" }));
    deps.autoUpdater.on("download-progress", (info) => emit({ kind: "downloading", percent: info.percent }));
    deps.autoUpdater.on("update-downloaded", (info) => emit({ kind: "downloaded", version: info.version }));
    deps.autoUpdater.on("error", (error) => emit({ kind: "error", message: error.message }));

    // TASK.47 defect 3: arm the auto-check schedule. Only ever calls
    // checkForUpdates() (via `check()`, the exact same path the renderer's
    // "Check for updates" button drives) — never downloadUpdate().
    scheduleNextCheck(pickDelayMs(startupRange, random));
  }

  return {
    getStatus: () => status,
    check,
    download,
    install,
    openReleasesPage,
    stop(): void {
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
    },
  };
}

/**
 * Wires the four frozen channels onto `ipcMain` (design §6; TASK.47 adds the
 * fourth). Every handler takes ZERO parameters beyond the ipc event itself —
 * the renderer's invoke payload (if any) is never read, so there is no way
 * for a compromised renderer to redirect anything (`app-update.yml` /
 * `electron-builder.yml`'s `publish` block, main-side, is
 * ALL updater configuration, none of it travels over these channels).
 */
export function registerUpdater(deps: UpdaterDeps): UpdaterController {
  const controller = createUpdaterController(deps);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, () => controller.check());
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, () => controller.download());
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => controller.install());
  ipcMain.handle(UPDATE_OPEN_RELEASES_CHANNEL, () => controller.openReleasesPage());
  return controller;
}

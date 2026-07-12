/**
 * Main-process auto-updater wiring (design/slice-2.6-cut.md §6), mirroring
 * settings-ipc.ts's split: `createUpdaterController` holds all the testable
 * logic off an injected `AutoUpdaterLike` (so a vitest fake drives the whole
 * check->available->progress->downloaded->install chain with no Electron
 * runtime involved), and `registerUpdater` is the thin `ipcMain.handle`
 * wiring around it — the real `electron-updater` `autoUpdater` singleton
 * (imported in main/index.ts) satisfies `AutoUpdaterLike` structurally.
 *
 * isPackaged gate (design §6): a dev build (`!app.isPackaged`) never touches
 * the injected `autoUpdater` at all — no listener is attached, `autoDownload`
 * is never set, and all three invoke channels answer `not_packaged` without
 * calling into it. This is deliberate, not cosmetic: electron-updater reads
 * `app-update.yml` (present only in a packaged build) the moment any of its
 * methods run, so a dev build must never call into it.
 *

 * registration, for the life of the process — nothing ever downloads except
 * in direct response to the renderer's `download` invoke, and nothing ever
 * installs except in direct response to `install`. `download` refuses
 * `invalid_state` unless the last forwarded status was `available`;
 * `install` refuses `invalid_state` unless it was `downloaded`. All three
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

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  /** `app.isPackaged` — the sole gate on whether this module ever touches `autoUpdater`. */
  isPackaged: boolean;
  /** The renderer window, or null when there is none yet (mirrors tabs.ts's `getWindow`). */
  getWindow: () => UpdaterWindowLike | null;
  logger?: { warn(message: string, err?: unknown): void };
}

export interface UpdaterController {
  /** Current status (idle until the first event/check). */
  getStatus(): UpdateStatus;
  check(): Promise<UpdateActionResult>;
  download(): Promise<UpdateActionResult>;
  install(): UpdateActionResult;
}

/**
 * Builds the controller (exported separately from `registerUpdater` so a
 * test drives it directly with a fake `AutoUpdaterLike`, without an Electron
 * `ipcMain` — the same split as settings-ipc.ts's exported `handle*`
 * functions vs `registerSettingsIpc`).
 */
export function createUpdaterController(deps: UpdaterDeps): UpdaterController {
  let status: UpdateStatus = { kind: "idle" };

  function emit(next: UpdateStatus): void {
    status = next;
    deps.getWindow()?.webContents.send(UPDATE_STATUS_CHANNEL, next);
  }

  if (deps.isPackaged) {
    // Consent-first (design §6): disable electron-updater's own auto-download
    // for the life of the process — `download()` below is the ONLY path that
    // ever calls `downloadUpdate()`.
    deps.autoUpdater.autoDownload = false;
    deps.autoUpdater.on("checking-for-update", () => emit({ kind: "checking" }));
    deps.autoUpdater.on("update-available", (info) => emit({ kind: "available", version: info.version }));
    deps.autoUpdater.on("update-not-available", () => emit({ kind: "not-available" }));
    deps.autoUpdater.on("download-progress", (info) => emit({ kind: "downloading", percent: info.percent }));
    deps.autoUpdater.on("update-downloaded", (info) => emit({ kind: "downloaded", version: info.version }));
    deps.autoUpdater.on("error", (error) => emit({ kind: "error", message: error.message }));
  }

  return {
    getStatus: () => status,

    async check(): Promise<UpdateActionResult> {
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
    },

    async download(): Promise<UpdateActionResult> {
      if (!deps.isPackaged) {
        return { ok: false, reason: "not_packaged" };
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
    },

    install(): UpdateActionResult {
      if (!deps.isPackaged) {
        return { ok: false, reason: "not_packaged" };
      }
      if (status.kind !== "downloaded") {
        return { ok: false, reason: "invalid_state" };
      }
      deps.autoUpdater.quitAndInstall();
      return { ok: true };
    },
  };
}

/**
 * Wires the three frozen channels onto `ipcMain` (design §6). Every handler
 * takes ZERO parameters beyond the ipc event itself — the renderer's invoke
 * payload (if any) is never read, so there is no way for a compromised

 * ALL updater configuration, none of it travels over these channels).
 */
export function registerUpdater(deps: UpdaterDeps): UpdaterController {
  const controller = createUpdaterController(deps);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, () => controller.check());
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, () => controller.download());
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => controller.install());
  return controller;
}

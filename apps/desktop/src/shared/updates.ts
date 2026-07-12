/**
 * Auto-updater control-plane contract (design/slice-2.6-cut.md §6). Same
 * value-only shape as shared/tabs.ts / shared/settings.ts: channel name
 * constants + types only, ZERO runtime imports, so it is safe to import from
 * preload (sandboxed CJS), the renderer web bundle, AND main alike — none of
 * them may drag electron-updater's runtime into a bundle that cannot afford
 * it (same reasoning shared/tabs.ts's docstring gives for zod/@anycode/core).
 *
 * Three fixed invoke channels (check / download / install) mirror
 * electron-updater's own three-step flow, gated main-side (main/updater.ts)
 * by `app.isPackaged` and by the last `UpdateStatus` (download only valid
 * once `available`, install only valid once `downloaded`) — consent-first
 * (design §6): nothing downloads or installs without an explicit renderer
 * invoke, and `autoDownload` stays `false` for the life of the process. The
 * status channel is a PUSH (main -> renderer) event, not an invoke — main
 * forwards every electron-updater lifecycle event as one `UpdateStatus`.
 */

/** invoke channel: ask main to check the update feed. */
export const UPDATE_CHECK_CHANNEL = "anycode:update-check";

/** invoke channel: download the update found by the last check (refused unless the last status was `available`). */
export const UPDATE_DOWNLOAD_CHANNEL = "anycode:update-download";

/** invoke channel: quit and install the downloaded update (refused unless the last status was `downloaded`). */
export const UPDATE_INSTALL_CHANNEL = "anycode:update-install";

/** push-event channel: main -> renderer, one `UpdateStatus` per electron-updater lifecycle event. */
export const UPDATE_STATUS_CHANNEL = "anycode:update-status";

/**
 * Update lifecycle status — one variant per electron-updater event (design
 * §6), plus `idle` (the initial/never-checked state). `error` carries a
 * human-readable message only, never a stack or other internal detail that
 * could leak host paths to the renderer.
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "not-available" }
  | { kind: "error"; message: string };

/* */
export type UpdateActionReason =
  /** Dev build (`!app.isPackaged`) — the updater never initializes (design §6). */
  | "not_packaged"
  /** `download` without a prior `available` status, or `install` without a prior `downloaded` status. */
  | "invalid_state";

export type UpdateActionResult = { ok: true } | { ok: false; reason: UpdateActionReason };

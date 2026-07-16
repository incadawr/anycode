/**
 * Auto-updater control-plane contract (design/slice-2.6-cut.md §6; extended
 * by TASK.47 W15, working-docs/tasks/TASK.47.md). Same value-only shape as
 * shared/tabs.ts / shared/settings.ts: channel name constants + types only,
 * ZERO runtime imports, so it is safe to import from preload (sandboxed
 * CJS), the renderer web bundle, AND main alike — none of them may drag
 * electron-updater's runtime into a bundle that cannot afford it (same
 * reasoning shared/tabs.ts's docstring gives for zod/@anycode/core).
 *
 * Four fixed invoke channels (check / download / install / open-releases)
 * mirror electron-updater's own three-step flow plus the TASK.47 darwin
 * honest-manual-path action, gated main-side (main/updater.ts) by
 * `app.isPackaged` and by the last `UpdateStatus` (download only valid once
 * `available`, install only valid once `downloaded`) — consent-first (design
 * §6): nothing downloads or installs without an explicit renderer invoke,
 * `autoDownload` stays `false` for the life of the process, and the periodic
 * background check (TASK.47 defect 3) only ever calls `checkForUpdates()`,
 * never `downloadUpdate()`. The status channel is a PUSH (main -> renderer)
 * event, not an invoke — main forwards every electron-updater lifecycle
 * event as one `UpdateStatus`.
 */

/** invoke channel: ask main to check the update feed. */
export const UPDATE_CHECK_CHANNEL = "anycode:update-check";

/** invoke channel: download the update found by the last check (refused unless the last status was `available`). */
export const UPDATE_DOWNLOAD_CHANNEL = "anycode:update-download";

/** invoke channel: quit and install the downloaded update (refused unless the last status was `downloaded`). */
export const UPDATE_INSTALL_CHANNEL = "anycode:update-install";

/**
 * invoke channel (TASK.47 defect 2): open the fixed GitHub Releases page in
 * the system browser — the darwin honest-manual-path action. No argument
 * crosses this channel in either direction: the URL is a fixed constant
 * (`UPDATE_RELEASES_URL` below), resolved entirely main-side
 * (`shell.openExternal`), so a compromised renderer has nothing to redirect.
 */
export const UPDATE_OPEN_RELEASES_CHANNEL = "anycode:update-open-releases";

/** push-event channel: main -> renderer, one `UpdateStatus` per electron-updater lifecycle event. */
export const UPDATE_STATUS_CHANNEL = "anycode:update-status";

/**
 * Fixed public URL for the darwin honest-manual-path action (TASK.47 defect
 * 2): this repo is public (Apache-2.0), and `owner`/`repo` are already
 * baked into every packaged bundle's `app-update.yml`
 * (`electron-builder.yml`'s `publish` block) — not a secret.
 */
export const UPDATE_RELEASES_URL = "https://github.com/incadawr/anycode/releases/latest";

/**
 * Update lifecycle status — one variant per electron-updater event (design
 * §6), plus `idle` (the initial/never-checked state). `error` carries a
 * human-readable message only, never a stack or other internal detail that
 * could leak host paths to the renderer.
 *
 * TASK.47 defect 2 (additive): `available.manualOnly` is `true` only on
 * darwin, where the ad-hoc-signed build has no Developer ID yet — Squirrel.Mac
 * would reject a downloaded update's signature mismatch (TASK.46 tracks the
 * real fix). An old renderer built before this field existed simply ignores
 * it and keeps rendering the Download button darwin can never use — the
 * `manual_only` refusal on `download()`/`install()` (main-side, TASK.47
 * defect 2) is the actual backstop, not this display hint.
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; manualOnly?: boolean }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "not-available" }
  | { kind: "error"; message: string };

/* */
export type UpdateActionReason =
  /** Dev build (`!app.isPackaged`) — the updater never initializes (design §6). */
  | "not_packaged"
  /** `download` without a prior `available` status, or `install` without a prior `downloaded` status. */
  | "invalid_state"
  /** TASK.47 defect 2: darwin has no Developer ID yet — `download`/`install` refuse unconditionally there, regardless of status. */
  | "manual_only";

export type UpdateActionResult = { ok: true } | { ok: false; reason: UpdateActionReason };

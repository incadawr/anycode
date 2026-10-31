/**
 * Deadline budget for the dev-automation facade (shared main ↔ renderer so the
 * two sides can never drift apart).
 *
 * The main process races every facade call against a deadline (a stuck
 * renderer must answer HTTP with a bounded 504 `facade_timeout`, not hang).
 * Most routes are sub-second gestures; a few settings routes legitimately
 * wait much longer inside the renderer (a full telemetry-directory rescan, a
 * real recognizer network round trip). Those renderer-side settle ceilings
 * live HERE next to the facade timeouts derived from them, so the facade
 * deadline is always the renderer ceiling plus headroom — never below it.
 */

/**
 * Default facade-call deadline: a generous ceiling for ordinary routes (the
 * slowest common facade paths settle-poll up to 10 s in the renderer), while
 * still bounding a stuck page to a finite, diagnosable 504.
 */
export const DEFAULT_FACADE_TIMEOUT_MS = 30_000;

/**
 * Renderer-side settle ceiling for `profileRefresh`/`profileRebuild`: a real
 * uncached telemetry-directory pass was measured at 16.2 s of `JSON.parse`
 * alone (~60 k files), a rebuild re-reads all of them, and both routes wait
 * out the automatic catch-up chain rather than returning at the first
 * `ready`.
 */
export const PROFILE_PANE_SETTLE_DEADLINE_MS = 60_000;

/**
 * Renderer-side settle ceiling for `visionProbe`: its true worst case is a
 * hanging recognizer endpoint (~62 s including the recognizer's own grace
 * window) — the failure path a caller exercises on purpose — so it is sized
 * with headroom above that ceiling rather than flush against it.
 */
export const VISION_PANE_PROBE_DEADLINE_MS = 65_000;

/** Facade deadline for `profileRefresh`/`profileRebuild`: renderer ceiling + headroom. */
export const PROFILE_FACADE_TIMEOUT_MS = PROFILE_PANE_SETTLE_DEADLINE_MS + 10_000;

/** Facade deadline for `visionProbe`: renderer ceiling + headroom. */
export const VISION_PROBE_FACADE_TIMEOUT_MS = VISION_PANE_PROBE_DEADLINE_MS + 10_000;

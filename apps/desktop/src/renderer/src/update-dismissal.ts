/**
 * Dismissal state for the global update banner (`UpdateNoticeBanner`,
 * components/SettingsScreen.tsx). Device-local preference in renderer
 * localStorage — NOT the settings vault and NOT main-process state: the same
 * reasoning notifications.ts gives for TURN_NOTIFY_KEY (no IPC, no host
 * plumbing, per-machine by nature).
 *
 * Dismissal is keyed by the banner's MESSAGE, not by a plain "hidden" flag,
 * so closing the banner can never swallow news the user has not seen yet:
 * a newer version, or the same version reaching a different lifecycle state
 * (`available` -> `downloaded`, where the text changes from "download from
 * GitHub Releases" to "restart to install"), produces a different key and
 * shows again.
 */
import type { UpdateStatus } from "../../shared/updates.js";

/** localStorage key (namespaced like anycode.notifications.turnComplete). Absent = nothing dismissed. */
export const UPDATE_DISMISSED_KEY = "anycode.updates.dismissedBanner.v1";

/**
 * Identity of the exact banner message a status produces, or `null` for the
 * states that never raise a banner at all (`shouldShowUpdateBanner`). Both
 * fields matter: the version distinguishes releases, the kind distinguishes
 * "an update exists" from "it is downloaded and waiting".
 */
export function updateBannerKey(status: UpdateStatus): string | null {
  if (status.kind !== "available" && status.kind !== "downloaded") {
    return null;
  }
  return `${status.kind}:${status.version}`;
}

/** Whether `dismissed` (as returned by `readDismissedUpdateBanner`) is this status's own key. */
export function isUpdateBannerDismissed(status: UpdateStatus, dismissed: string | null): boolean {
  const key = updateBannerKey(status);
  return key !== null && key === dismissed;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Last dismissed banner key, or `null` when nothing was dismissed. Storage
 * that is unavailable or holds a non-string fails OPEN (nothing dismissed):
 * an unreadable preference must never hide an update notice.
 */
export function readDismissedUpdateBanner(): string | null {
  try {
    const raw = storage()?.getItem(UPDATE_DISMISSED_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Records `status`'s banner as dismissed and returns the stored key (`null`
 * for a status that raises no banner, which is a no-op). The return value is
 * what the caller renders with, so a denied/quota-exhausted localStorage
 * still hides the banner for the rest of this session rather than leaving a
 * close button that visibly does nothing.
 */
export function dismissUpdateBanner(status: UpdateStatus): string | null {
  const key = updateBannerKey(status);
  if (key === null) {
    return null;
  }
  try {
    storage()?.setItem(UPDATE_DISMISSED_KEY, key);
  } catch {
    // Device-local convenience only: a write failure must not break the close.
  }
  return key;
}

/**
 * UI-only provider diagnostics. These notices deliberately live in renderer
 * localStorage rather than the conversation history: a quota failure remains
 * visible after resuming a task, but is never sent back to the model.
 */

// parseUsageLimitNotice + UsageLimitNotice moved to shared/usage-limit.ts so the
// HOST parses the raw provider message at the wire boundary (the renderer now
// receives a redacted message it cannot parse). Re-exported here so existing
// renderer imports keep resolving (W7b-FIX #2).
export { parseUsageLimitNotice, type UsageLimitNotice } from "../../shared/usage-limit.js";
import type { UsageLimitNotice } from "../../shared/usage-limit.js";

const STORAGE_PREFIX = "anycode.provider-notices.v1:";
const MAX_NOTICES_PER_SESSION = 20;

/** Localized wall-clock label; Date renders in the user's current local timezone by default. */
export function formatUsageLimitReset(resetAt: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetAt));
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads a session's renderer-only diagnostics; corrupt/stale values fail soft. */
export function loadUsageLimitNotices(sessionId: string): UsageLimitNotice[] {
  try {
    const raw = storage()?.getItem(`${STORAGE_PREFIX}${sessionId}`);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is UsageLimitNotice => {
      if (typeof item !== "object" || item === null) return false;
      const value = item as Partial<UsageLimitNotice>;
      return value.kind === "usage_limit" && value.code === 1308 && typeof value.resetAt === "number" && Number.isFinite(value.resetAt);
    });
  } catch {
    return [];
  }
}

/** Appends one renderer-only notice, retaining a bounded newest-first history. */
export function saveUsageLimitNotice(sessionId: string, notice: UsageLimitNotice): void {
  try {
    storage()?.setItem(
      `${STORAGE_PREFIX}${sessionId}`,
      JSON.stringify([...loadUsageLimitNotices(sessionId), notice].slice(-MAX_NOTICES_PER_SESSION)),
    );
  } catch {
    // A denied/quota-exhausted localStorage must never perturb the agent turn.
  }
}

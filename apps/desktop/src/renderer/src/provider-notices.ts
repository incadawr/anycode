/**
 * UI-only provider diagnostics. These notices deliberately live in renderer
 * localStorage rather than the conversation history: a quota failure remains
 * visible after resuming a task, but is never sent back to the model.
 */

import type { SerializedError } from "../../shared/protocol.js";

const STORAGE_PREFIX = "anycode.provider-notices.v1:";
const MAX_NOTICES_PER_SESSION = 20;

export interface UsageLimitNotice {
  kind: "usage_limit";
  code: number;
  /** Epoch milliseconds; Z.AI 1308's timezone-less timestamp is interpreted as Asia/Shanghai (UTC+8). */
  resetAt: number;
}

const ZAI_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** Parses Z.AI's documented quota error shape, e.g. `[1308]...reset at 2026-07-12 19:07:09`. */
export function parseUsageLimitNotice(error: SerializedError): UsageLimitNotice | null {
  const code = /\[(1308)\]/.exec(error.message);
  const reset = /limit will reset at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(error.message);
  if (!code || !reset) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = reset;
  // 1308 omits an offset. Z.AI's service clock is China Standard Time
  // (Asia/Shanghai, no DST): 19:07 CST is 11:07 UTC, then the UI formatter
  // below renders that instant in the user's actual local timezone.
  const resetAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) - ZAI_TIMEZONE_OFFSET_MS;
  return Number.isFinite(resetAt) ? { kind: "usage_limit", code: Number(code[1]), resetAt } : null;
}

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

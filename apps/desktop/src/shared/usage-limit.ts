/**
 * Provider quota-notice parsing (TASK.33 W7b-FIX #2). Relocated here from the
 * renderer so the HOST can parse the RAW provider message at the wire boundary
 * (sanitizeAgentEvent) and attach a numbers-only UsageLimitNotice to the wire
 * event. The raw message itself is redacted before it crosses to the renderer,
 * so the renderer can no longer parse it — it reads `event.notice` instead.
 *
 * Shared (host + renderer): uses only regex + Date.UTC, no browser/Node APIs.
 */

export interface UsageLimitNotice {
  kind: "usage_limit";
  code: number;
  /** Epoch milliseconds; Z.AI 1308's timezone-less timestamp is interpreted as Asia/Shanghai (UTC+8). */
  resetAt: number;
}

const ZAI_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** Parses Z.AI's documented quota error shape, e.g. `[1308]...reset at 2026-07-12 19:07:09`. */
export function parseUsageLimitNotice(message: string): UsageLimitNotice | null {
  const code = /\[(1308)\]/.exec(message);
  const reset = /limit will reset at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(message);
  if (!code || !reset) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = reset;
  // 1308 omits an offset. Z.AI's service clock is China Standard Time
  // (Asia/Shanghai, no DST): 19:07 CST is 11:07 UTC, then the UI formatter
  // (renderer) renders that instant in the user's actual local timezone.
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

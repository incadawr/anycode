import type { ProviderQuotaUpdate, ProviderQuotaWindow } from "@anycode/core/provider/quota";

export function parseMiniMaxQuota(raw: unknown, now = Date.now()): ProviderQuotaUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!data.base_resp || typeof data.base_resp !== "object" || (data.base_resp as Record<string, unknown>).status_code !== 0 || !Array.isArray(data.model_remains) || data.model_remains.length !== 1) return null;
  const row = data.model_remains[0];
  if (!row || typeof row !== "object") return null;
  const fields = row as Record<string, unknown>;
  function window(percent: unknown, reset: unknown, minutes: number): ProviderQuotaWindow | undefined {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
    const plausibleReset = typeof reset === "number" && Number.isFinite(reset) && reset >= now && reset <= now + minutes * 60_000;
    return { usedPercent: 100 - percent, windowDurationMins: minutes, ...(plausibleReset ? { resetsAt: reset / 1000 } : {}) };
  }
  const primary = window(fields.current_interval_remaining_percent, fields.end_time, 300);
  const secondary = window(fields.current_weekly_remaining_percent, fields.weekly_end_time, 10080);
  if (!primary && !secondary) return null;
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), primarySource: "minimax-token-plan", sources: ["minimax-token-plan"] };
}

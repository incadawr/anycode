import type { ProviderQuotaUpdate, ProviderQuotaWindow } from "@anycode/core/provider/quota";

/**
 * The literal `lastQuota.source` stamped on observations parsed from the
 * Z.AI coding-plan monitor endpoint (`glm-quota.ts`). A distinct family
 * name so a MiniMax observation and a GLM observation never merge into one
 * line (connection-quota.ts's sparse-merge rule is per source).
 */
export const GLM_QUOTA_SOURCE = "glm-coding-plan";

/**
 * Z.AI coding-plan quota (the same endpoint the z.ai usage page reads,
 * verified live 04.11): GET .../monitor/usage/quota/limit returns
 * `{ data: { level, limits: [...] } }`. Only `CREDIT_LIMIT` entries carry
 * subscription windows: `unit 3` + `number N` = an N-hour window,
 * `unit 6` + `number N` = N weeks. Fields used: `percentage` (percent
 * USED), `currentValue`/`usage` (used/limit — the fallback ratio when the
 * percentage is unusable) and `nextResetTime` (epoch ms). Anything else
 * (other types, other units, garbage rows) is IGNORED, never thrown on.
 *
 * Fail-closed like `parseMiniMaxQuota`: a window with no usable percent is
 * dropped, an implausible reset time is omitted (never fabricated), and a
 * response with no usable window at all is `null` — which is exactly what
 * suppresses the connection card's quota line.
 */
export function parseGlmQuota(raw: unknown, now = Date.now()): ProviderQuotaUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = (raw as Record<string, unknown>).data;
  if (!envelope || typeof envelope !== "object") return null;
  const limits = (envelope as Record<string, unknown>).limits;
  if (!Array.isArray(limits)) return null;
  function window(fields: Record<string, unknown>, windowDurationMins: number): ProviderQuotaWindow | undefined {
    const percentage = fields.percentage;
    const currentValue = fields.currentValue;
    const usage = fields.usage;
    let usedPercent: number | undefined;
    if (typeof percentage === "number" && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
      usedPercent = Math.round(percentage);
    } else if (typeof currentValue === "number" && Number.isFinite(currentValue) && currentValue >= 0 && typeof usage === "number" && Number.isFinite(usage) && usage > 0) {
      usedPercent = Math.min(100, Math.round((100 * currentValue) / usage));
    }
    if (usedPercent === undefined) return undefined;
    const resetMs = fields.nextResetTime;
    const plausibleReset = typeof resetMs === "number" && Number.isFinite(resetMs) && resetMs >= now && resetMs <= now + windowDurationMins * 60_000;
    return { usedPercent, windowDurationMins, ...(plausibleReset ? { resetsAt: Math.round(resetMs / 1000) } : {}) };
  }
  let fiveHours: ProviderQuotaWindow | undefined;
  let week: ProviderQuotaWindow | undefined;
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    if (fields.type !== "CREDIT_LIMIT") continue;
    const number = fields.number;
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) continue;
    // unit 3 = hours, unit 6 = weeks (verified live); every other unit is
    // an unknown window we must not guess a length for.
    const windowDurationMins = fields.unit === 3 ? number * 60 : fields.unit === 6 ? number * 10080 : undefined;
    if (windowDurationMins === undefined) continue;
    const parsed = window(fields, windowDurationMins);
    if (!parsed) continue;
    if (fields.unit === 3) fiveHours ??= parsed;
    else week ??= parsed;
  }
  const primary = fiveHours ?? week;
  if (!primary) return null;
  return {
    primary,
    ...(fiveHours && week ? { secondary: week } : {}),
    primarySource: GLM_QUOTA_SOURCE,
    sources: [GLM_QUOTA_SOURCE],
  };
}

import type { GoQuotaSnapshot, GoQuotaWindow } from "../shared/opencode-go-quota.js";

function object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseOpenCodeGoQuota(raw: unknown, now: number): GoQuotaSnapshot["windows"] | null {
  try {
    if (!object(raw) || !object(raw.usage)) return null;
    const windows: GoQuotaSnapshot["windows"] = {};
    for (const name of ["rolling", "weekly", "monthly"] as const) {
      const input = raw.usage[name];
      if (!object(input) || typeof input.percent !== "number" || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) continue;
      const window: GoQuotaWindow = { usedPercent: input.percent };
      let reset: number | undefined;
      if (typeof input.resetsAt === "string" && /^\d{4}-\d\d-\d\dT/.test(input.resetsAt)) {
        const parsed = Date.parse(input.resetsAt);
        if (Number.isFinite(parsed)) reset = parsed / 1000;
      } else if (typeof input.resetsAt === "number" && Number.isFinite(input.resetsAt)) {
        if (input.resetsAt >= 1e9 && input.resetsAt < 1e11) reset = input.resetsAt;
        else if (input.resetsAt >= 1e12 && input.resetsAt < 1e14) reset = input.resetsAt / 1000;
      }
      if (reset !== undefined) {
        if (reset * 1000 <= now) continue;
        window.resetsAt = reset;
      }
      windows[name] = window;
    }
    return Object.keys(windows).length ? windows : null;
  } catch {
    return null;
  }
}

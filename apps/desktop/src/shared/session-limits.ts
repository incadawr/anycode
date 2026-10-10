export const SESSION_LIMIT_RANGES = {
  maxTabs: { min: 4, max: 40, default: 20 },            // TASK.119 (8 -> 20)
  childSessionsPerParentMax: { min: 1, max: 8, default: 3 },  // TASK.147 slice 2
  childSessionsGlobalMax: { min: 1, max: 24, default: 8 },
} as const;

export interface SessionLimitsSettings {
  maxTabs?: number;
  childSessionsPerParentMax?: number;
  childSessionsGlobalMax?: number;
}

/** NaN/±Infinity/non-number -> undefined (caller falls back); finite out-of-range -> clamp; fractions -> trunc. */
export function clampSessionLimit(
  kind: keyof typeof SESSION_LIMIT_RANGES,
  value: unknown,
): number | undefined {
  const r = SESSION_LIMIT_RANGES[kind];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(r.max, Math.max(r.min, Math.trunc(value)));
}

/** Defensive projection of whatever is on disk (hand-edited files included); never throws, drops garbage keys. */
export function readSessionLimits(raw: unknown): SessionLimitsSettings {
  const out: SessionLimitsSettings = {};
  if (typeof raw !== "object" || raw === null) return out;
  const src = raw as Record<string, unknown>;
  const maxTabs = clampSessionLimit("maxTabs", src.maxTabs);
  if (maxTabs !== undefined) out.maxTabs = maxTabs;
  const perParent = clampSessionLimit("childSessionsPerParentMax", src.childSessionsPerParentMax);
  if (perParent !== undefined) out.childSessionsPerParentMax = perParent;
  const global = clampSessionLimit("childSessionsGlobalMax", src.childSessionsGlobalMax);
  if (global !== undefined) out.childSessionsGlobalMax = global;
  return out;
}

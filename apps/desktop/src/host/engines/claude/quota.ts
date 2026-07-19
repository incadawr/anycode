/**
 * Subscription-quota decode for a Claude session (cut §1.4, contract §6.2):
 * a tolerant read of the `get_usage` control response ($0, ~770ms — pulled on
 * demand / after a turn, NEVER in a hot path).
 *
 * THREE normative rules, each of them a live finding rather than a preference:
 *
 *  1. SEVERITY COMES FROM `limits[]`, NOT the flat windows. In the captured
 *     payload the flat `seven_day.utilization` reads 76 while the `limits[]`
 *     entry that is actually `is_active` reads 94 with `severity:"critical"` —
 *     an 18-point divergence. Reading the flat window would under-report the
 *     user's real exposure by exactly that margin.
 *  2. RENDERING IS ALLOW-LISTED. The live payload carries eight code-named
 *     windows for unreleased features (`tangelo`, `nimbus_quill`,
 *     `cinder_cove`, ...). They are all `null` today and will light up without
 *     warning; an inclusive renderer would surface Anthropic's unannounced
 *     feature names inside AnyCode. Only the names below are ever displayed.
 *  3. THE PARSE IS OPEN, NEVER A CLOSED SCHEMA. The live payload is already a
 *     strict SUPERSET of the SDK type, so anything shaped like an exact match
 *     rejects valid traffic on day one. Every field here is optional; an
 *     unreadable payload yields `null` and the UI simply shows nothing.
 *
 * CC-B additionally observed an UNAUTHENTICATED variant of this response that
 * carries no rate-limit data at all — decoding must tolerate it (a snapshot
 * with a subscription type and no windows is valid, not a parse failure).
 */

import type { CodexRateLimitsWire } from "@anycode/core";

/** The only window keys ever rendered (rule 2). Everything else in the payload is decoded-but-never-shown. */
export const CLAUDE_RENDERABLE_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

export type ClaudeQuotaSeverity = "normal" | "warning" | "critical";

export interface ClaudeQuotaLimit {
  kind: string;
  group?: string;
  percent: number;
  severity: ClaudeQuotaSeverity;
  resetsAt?: string;
  isActive: boolean;
  /** Human label of a model-scoped limit (`scope.model.display_name`), when present. */
  scopeLabel?: string;
}

export interface ClaudeQuotaWindow {
  key: string;
  utilization: number;
  resetsAt?: string;
}

export interface ClaudeQuotaSnapshot {
  subscriptionType?: string;
  /** Allow-listed windows only (rule 2). */
  windows: ClaudeQuotaWindow[];
  /** The self-describing limits array — the authority for severity (rule 1). */
  limits: ClaudeQuotaLimit[];
  observedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function severity(value: unknown): ClaudeQuotaSeverity {
  return value === "warning" || value === "critical" ? value : "normal";
}

function decodeLimit(raw: unknown): ClaudeQuotaLimit | null {
  const limit = record(raw);
  const kind = string(limit?.kind);
  const percent = finite(limit?.percent);
  if (limit === null || kind === undefined || percent === undefined) return null;
  const group = string(limit.group);
  const resetsAt = string(limit.resets_at);
  const scopeLabel = string(record(record(limit.scope)?.model)?.display_name);
  return {
    kind,
    ...(group === undefined ? {} : { group }),
    percent,
    severity: severity(limit.severity),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    isActive: limit.is_active === true,
    ...(scopeLabel === undefined ? {} : { scopeLabel }),
  };
}

function decodeWindow(key: string, raw: unknown): ClaudeQuotaWindow | null {
  const window = record(raw);
  const utilization = finite(window?.utilization);
  if (utilization === undefined) return null;
  const resetsAt = string(window!.resets_at);
  return { key, utilization, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/**
 * Decodes a `get_usage` control response into a snapshot. Returns null only
 * for a structurally unusable payload (not an object) — an authenticated
 * payload with no windows, and the unauthenticated variant with no
 * `rate_limits` block at all, both decode successfully to an empty snapshot.
 */
export function decodeClaudeUsage(response: unknown, now: () => string = () => new Date().toISOString()): ClaudeQuotaSnapshot | null {
  const root = record(response);
  if (root === null) return null;
  const rateLimits = record(root.rate_limits);
  const subscriptionType = string(root.subscription_type);
  const windows: ClaudeQuotaWindow[] = [];
  if (rateLimits !== null) {
    for (const key of CLAUDE_RENDERABLE_WINDOWS) {
      const window = decodeWindow(key, rateLimits[key]);
      if (window !== null) windows.push(window);
    }
  }
  const rawLimits = rateLimits === null ? undefined : rateLimits.limits;
  const limits = Array.isArray(rawLimits)
    ? rawLimits.map(decodeLimit).filter((limit): limit is ClaudeQuotaLimit => limit !== null)
    : [];
  return {
    ...(subscriptionType === undefined ? {} : { subscriptionType }),
    windows,
    limits,
    observedAt: now(),
  };
}

/**
 * The limit that governs what the user should be told (rule 1): the most severe
 * one, preferring an `is_active` entry at equal severity. `limits[]` — never
 * the flat windows — is the authority.
 */
export function governingLimit(snapshot: ClaudeQuotaSnapshot): ClaudeQuotaLimit | null {
  const rank: Record<ClaudeQuotaSeverity, number> = { normal: 0, warning: 1, critical: 2 };
  let governing: ClaudeQuotaLimit | null = null;
  for (const limit of snapshot.limits) {
    if (governing === null) {
      governing = limit;
      continue;
    }
    const better =
      rank[limit.severity] > rank[governing.severity] ||
      (rank[limit.severity] === rank[governing.severity] && limit.isActive && !governing.isActive) ||
      (rank[limit.severity] === rank[governing.severity] && limit.isActive === governing.isActive && limit.percent > governing.percent);
    if (better) governing = limit;
  }
  return governing;
}

/**
 * The `engine_notice` a `warning`/`critical` limit earns (cut §1.4). A `normal`
 * snapshot is silent — a notice on every turn would be noise, and the quota UI
 * proper is CC-E.
 */
export function quotaNotice(snapshot: ClaudeQuotaSnapshot): { level: "warning"; message: string } | null {
  const governing = governingLimit(snapshot);
  if (governing === null || governing.severity === "normal") return null;
  const scope = governing.scopeLabel === undefined ? "" : ` (${governing.scopeLabel})`;
  const percent = Math.round(governing.percent);
  const headline =
    governing.severity === "critical"
      ? `Claude usage is at ${percent}% of your ${describeLimit(governing)} limit${scope}.`
      : `Claude usage has reached ${percent}% of your ${describeLimit(governing)} limit${scope}.`;
  return { level: "warning", message: headline };
}

/** A human phrase for a limit's `kind`/`group`; an unknown kind degrades to its own raw name rather than being hidden. */
function describeLimit(limit: ClaudeQuotaLimit): string {
  if (limit.kind === "session" || limit.group === "session") return "session";
  if (limit.group === "weekly" || limit.kind.startsWith("weekly")) return "weekly";
  return limit.kind;
}

/**
 * Projects a decoded Claude quota snapshot onto the SHARED quota wire the
 * renderer already reads (`EnginePresentation.quota`). No new wire is invented:
 * the shape is the one codex's quota seam populates, and its field names are
 * engine-neutral even though the type carries a Codex-era name.
 *
 * Rule 1 of this module governs the projection too — `primary` is the GOVERNING
 * limit from `limits[]` (severity first, then percent), never a flat window.
 * The flat windows under-report: the captured payload's `seven_day` reads 76
 * while its active critical limit reads 94, and showing 76 would tell a user at
 * the edge of a lockout that they have room. `secondary` is the next-highest
 * limit, so the pair still describes the session/weekly split the flat windows
 * were reaching for.
 */
export function claudeQuotaToWire(snapshot: ClaudeQuotaSnapshot | null): CodexRateLimitsWire | null {
  if (snapshot === null) return null;
  const governing = governingLimit(snapshot);
  const ranked = [...snapshot.limits].sort((a, b) => b.percent - a.percent);
  const next = ranked.find((limit) => limit !== governing);
  const project = (limit: ClaudeQuotaLimit | null | undefined): CodexRateLimitsWire["primary"] => {
    if (limit === null || limit === undefined) return null;
    const resetsAt = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
    return {
      usedPercent: limit.percent,
      ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
    };
  };
  return {
    primary: project(governing),
    secondary: project(next),
    ...(snapshot.subscriptionType === undefined ? {} : { planType: snapshot.subscriptionType }),
    ...(governing === null ? {} : { limitName: governing.scopeLabel ?? describeLimit(governing) }),
    observedAt: snapshot.observedAt,
  };
}

/**
 * Quota / rate-limit types for the Codex engine (codex-profiles cut §3.2,
 * amended §A3). VALUE-ONLY module, zero runtime imports — safe from host/**,
 * main/**, and the renderer, same discipline as shared/codex-doctor.ts.
 *
 * Source of truth is the live 0.144.5 `account/rateLimits/read` wire probe
 * (`working-docs/references/codex-rate-limits-probe/rate-limits-response.json`,
 * amendment §A3): a real `plus` account reports exactly ONE populated window
 * (`primary`, `windowDurationMins: 10080`) with `secondary` present-but-null —
 * there is no hardcoded "5h"/"weekly" pair; the label is ALWAYS derived from
 * `windowDurationMins` at render time (cut §6.2), never stored here.
 */

/**
 * One rate-limit window (`RateLimitWindow` on the wire). `resetsAt` is
 * epoch SECONDS — verified against the live probe (`1784791993` decodes to
 * 2026-07-23; as milliseconds it would be 1970, which is absurd). The
 * renderer multiplies by 1000 in exactly one place (the formatter) — this
 * type carries the raw wire unit unconverted.
 */
export interface CodexQuotaWindow {
  /** Sole required wire field. */
  usedPercent: number;
  /** Window length in MINUTES (live probe: 10080 = 7 days); absent/null ⇒ label falls back to `limitName`/"Limit" (cut §6.2). */
  windowDurationMins?: number | null;
  /** epoch seconds (verified W0-R1). */
  resetsAt?: number | null;
}

/** `CreditsSnapshot` on the wire. `balance` is a STRING (live probe: `"0"`) — never coerced to number. */
export interface CodexQuotaCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

/**
 * One `RateLimitSnapshot` — either the top-level backward-compat mirror or
 * one entry of `byLimitId` (amendment §A3.3: both are the identical shape;
 * the live probe showed `byLimitId.codex` byte-duplicating the top level).
 */
export interface CodexRateLimits {
  primary?: CodexQuotaWindow | null;
  secondary?: CodexQuotaWindow | null;
  credits?: CodexQuotaCredits | null;
  planType?: string | null;
  limitName?: string | null;
  /** Multi-bucket view (`rateLimitsByLimitId`) when the server provided one. */
  byLimitId?: Record<string, Omit<CodexRateLimits, "byLimitId">>;
  /** When this snapshot was observed — feeds "updated N min ago" AND the sparse-merge below (cut §6.3). */
  observedAt: string;
}

/**
 * Sparse-merge an `account/rateLimits/updated` push onto the most recently
 * observed snapshot (cut §6.3, wire doc verbatim: "Nullable account metadata
 * may be unavailable in a rolling update and does not clear a previously
 * observed value").
 *
 * Rules (ALL non-null-wins, byLimitId keyed, observedAt always advances):
 *  1. `primary`/`secondary` — present AND non-null replaces; null/absent
 *     PRESERVES the previous value. A whole-object field, not merged
 *     field-by-field within the window.
 *  2. `planType`/`limitName`/`credits` — same non-null-wins rule.
 *  3. `byLimitId` — merged PER KEY: an incoming bucket replaces its own key
 *     (recursively, by this same function); a bucket absent from the update
 *     is left untouched.
 *  4. `observedAt` always advances to the update's timestamp — even when
 *     every other field of the update was null/absent, "last observed" must
 *     reflect the fact that a fresh (if empty) snapshot arrived. This applies
 *     to EVERY bucket a merge touches: `observedAt` is a locally generated
 *     field that never exists on the wire, so updated AND newly introduced
 *     `byLimitId` buckets are stamped with the same outer `observedAt` — the
 *     update side of the signature (`CodexRateLimitsUpdate`) deliberately
 *     cannot carry one (C0 review F2, Fable ruling).
 *
 * No repeated delivery can ever DECREASE the information the snapshot holds
 * — a durable invariant from `codex-fixes` ERRATA-4/5/6, deliberately tested
 * for redness against an inverted (replace-on-null) implementation, see
 * codex-quota.test.ts.
 */
/**
 * Wire-shaped update input for `mergeCodexRateLimits`: everything optional,
 * and NO `observedAt` anywhere — neither top-level buckets nor the map may
 * carry one, because that field is minted locally at merge time. Making the
 * field unrepresentable on the update side is what guarantees a translator
 * can never ship a stale/fabricated per-bucket timestamp.
 */
export interface CodexRateLimitsUpdate extends Omit<Partial<CodexRateLimits>, "byLimitId" | "observedAt"> {
  byLimitId?: Record<string, Omit<Partial<CodexRateLimits>, "byLimitId" | "observedAt">>;
}

export function mergeCodexRateLimits(previous: CodexRateLimits, update: CodexRateLimitsUpdate, observedAt: string): CodexRateLimits {
  const merged: CodexRateLimits = {
    primary: update.primary != null ? update.primary : previous.primary,
    secondary: update.secondary != null ? update.secondary : previous.secondary,
    credits: update.credits != null ? update.credits : previous.credits,
    planType: update.planType != null ? update.planType : previous.planType,
    limitName: update.limitName != null ? update.limitName : previous.limitName,
    observedAt,
  };
  const byLimitId = mergeByLimitId(previous.byLimitId, update.byLimitId, observedAt);
  if (byLimitId !== undefined) {
    merged.byLimitId = byLimitId;
  }
  return merged;
}

/**
 * Per-key merge for the `byLimitId` map (rule 3 above) — absent buckets
 * survive untouched; updated AND new buckets are stamped with the OUTER
 * `observedAt` (rule 4: the wire never carries one).
 */
function mergeByLimitId(
  previous: Record<string, Omit<CodexRateLimits, "byLimitId">> | undefined,
  update: Record<string, Omit<Partial<CodexRateLimits>, "byLimitId" | "observedAt">> | undefined,
  observedAt: string,
): Record<string, Omit<CodexRateLimits, "byLimitId">> | undefined {
  if (update === undefined) return previous;
  const merged: Record<string, Omit<CodexRateLimits, "byLimitId">> = { ...previous };
  for (const [limitId, bucketUpdate] of Object.entries(update)) {
    const previousBucket = previous?.[limitId];
    merged[limitId] =
      previousBucket === undefined
        ? { ...bucketUpdate, observedAt }
        : (mergeCodexRateLimits(previousBucket, bucketUpdate, observedAt) as Omit<CodexRateLimits, "byLimitId">);
  }
  return merged;
}

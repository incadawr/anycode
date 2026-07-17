/**
 * Codex subscription-quota consumption for the host (codex-profiles cut §6,
 * amendment §A3): tolerant decode of the two wire sources —
 *
 *  - pull  `account/rateLimits/read`   (GetAccountRateLimitsResponse)
 *  - push  `account/rateLimits/updated` (AccountRateLimitsUpdatedNotification,
 *          SPARSE by schema doc: "does not clear a previously observed value")
 *
 * — plus the host-owned tracker that folds both into ONE snapshot via the
 * frozen sparse-merge policy (shared/codex-quota.ts `mergeCodexRateLimits`,
 * C0, red-proofed there). This module never BUILDS a merged snapshot by hand:
 * building from scratch is exactly the "null wipes known data" defect class
 * the merge invariant exists to prevent (cut §6.3).
 *
 * Decode is unknown-field-tolerant throughout: `rateLimitResetCredits`,
 * `individualLimit`, `rateLimitReachedType`, `limitId` are silently dropped
 * (amendment §A3.4 — residual, not consumed in v1).
 */

import type { CodexRateLimitsWire } from "@anycode/core";
import {
  mergeCodexRateLimits,
  type CodexQuotaCredits,
  type CodexQuotaWindow,
  type CodexRateLimits,
} from "../../../shared/codex-quota.js";

/** One decoded snapshot's fields, before the tracker stamps `observedAt`. */
export type QuotaSnapshotUpdate = Partial<Omit<CodexRateLimits, "observedAt" | "byLimitId">>;

/** A decoded `account/rateLimits/read` result: top-level fields + the multi-bucket map (amendment §A3.3). */
export interface QuotaReadUpdate extends QuotaSnapshotUpdate {
  byLimitId?: Record<string, QuotaSnapshotUpdate>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `RateLimitWindow` — only `usedPercent` is required on the wire; `resetsAt` stays raw epoch SECONDS (W0-R1). */
function decodeWindow(value: unknown): CodexQuotaWindow | null {
  const window = record(value);
  const usedPercent = finite(window?.usedPercent);
  if (window === null || usedPercent === undefined) return null;
  const windowDurationMins = finite(window.windowDurationMins);
  const resetsAt = finite(window.resetsAt);
  return {
    usedPercent,
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function decodeCredits(value: unknown): CodexQuotaCredits | null {
  const credits = record(value);
  if (credits === null || typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean") return null;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    // Live probe: balance is a STRING ("0") — never coerced to number (§A3.6).
    ...(typeof credits.balance === "string" ? { balance: credits.balance } : {}),
  };
}

/**
 * One `RateLimitSnapshot` → sparse update. A field that is absent, null, or
 * undecodable is OMITTED (never emitted as null): the frozen merge treats
 * null and absent identically ("null never wipes"), so omission is the
 * loss-free normalization.
 */
export function decodeRateLimitSnapshot(value: unknown): QuotaSnapshotUpdate | null {
  const snapshot = record(value);
  if (snapshot === null) return null;
  const primary = decodeWindow(snapshot.primary);
  const secondary = decodeWindow(snapshot.secondary);
  const credits = decodeCredits(snapshot.credits);
  return {
    ...(primary !== null ? { primary } : {}),
    ...(secondary !== null ? { secondary } : {}),
    ...(credits !== null ? { credits } : {}),
    ...(typeof snapshot.planType === "string" ? { planType: snapshot.planType } : {}),
    ...(typeof snapshot.limitName === "string" ? { limitName: snapshot.limitName } : {}),
  };
}

/**
 * `GetAccountRateLimitsResponse` → sparse update. Consumption rule (amendment
 * §A3.3): `rateLimitsByLimitId` is read FIRST — a single bucket (the live
 * shape: `{"codex": <snapshot>}` byte-duplicating the top level) supplies the
 * top-level fields; the top-level `rateLimits` mirror is the FALLBACK, used
 * when the map is absent/empty (and for the top-level fields when several
 * buckets exist, since no single bucket is canonical then). The full map is
 * always carried in `byLimitId` (rendering beyond primary/secondary is a
 * cut §11 residual).
 */
export function decodeAccountRateLimitsRead(result: unknown): QuotaReadUpdate | null {
  const root = record(result);
  if (root === null) return null;
  const buckets: Record<string, QuotaSnapshotUpdate> = {};
  const byLimitId = record(root.rateLimitsByLimitId);
  if (byLimitId !== null) {
    for (const [limitId, bucket] of Object.entries(byLimitId)) {
      const decoded = decodeRateLimitSnapshot(bucket);
      if (decoded !== null) buckets[limitId] = decoded;
    }
  }
  const bucketIds = Object.keys(buckets);
  const top = bucketIds.length === 1 ? buckets[bucketIds[0]!]! : (decodeRateLimitSnapshot(root.rateLimits) ?? {});
  return {
    ...top,
    ...(bucketIds.length > 0 ? { byLimitId: buckets } : {}),
  };
}

/** `account/rateLimits/updated` params → sparse update (schema: `{rateLimits}` required, no byLimitId on a push). */
export function decodeRateLimitsUpdatedParams(params: unknown): QuotaSnapshotUpdate | null {
  return decodeRateLimitSnapshot(record(params)?.rateLimits);
}

/**
 * Host-owned quota state for ONE Codex session: seeded by the boot pull
 * (cut §6.1 — after `thread/start`/`thread/resume`), advanced by every
 * live push, read back for `EnginePresentation.quota` on each `ui_ready`.
 * Every advance goes through the frozen `mergeCodexRateLimits` so no
 * repeated/sparse delivery can ever DECREASE the snapshot's information.
 */
export class CodexQuotaTracker {
  private snapshot: CodexRateLimits | null = null;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /** Folds a pull result in; a garbage result changes nothing (quota is additive, never boot-fatal). */
  seedFromRead(result: unknown): CodexRateLimitsWire | null {
    const update = decodeAccountRateLimitsRead(result);
    if (update !== null) this.merge(update);
    return this.current();
  }

  /**
   * Folds one `account/rateLimits/updated` push in and returns the merged
   * snapshot for the `engine_quota` event — or null for an undecodable push
   * (no event; the next pull re-delivers everything).
   */
  applyUpdate(params: unknown): CodexRateLimitsWire | null {
    const update = decodeRateLimitsUpdatedParams(params);
    if (update === null) return null;
    this.merge(update);
    return this.current();
  }

  /** The latest merged snapshot, in the additive wire shape `engine_quota`/`EnginePresentation.quota` carry. */
  current(): CodexRateLimitsWire | null {
    return this.snapshot;
  }

  private merge(update: QuotaReadUpdate): void {
    const observedAt = this.now();
    // The frozen merge stamps every touched byLimitId bucket with this same
    // outer observation time itself (C0 review F2 ruling) — the update side
    // structurally cannot carry a timestamp, so none is fabricated here.
    this.snapshot = mergeCodexRateLimits(this.snapshot ?? { observedAt }, update, observedAt);
  }
}

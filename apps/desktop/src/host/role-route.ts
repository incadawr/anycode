/**
 * Host-side role-route resolution (Taskana 4704 §3.6): pure chain-picking
 * logic plus the process-local health cache. The health cache is HOST state
 * (never persisted — Q3: a restart re-probes naturally), and this module is
 * deliberately free of I/O: `now` is injected everywhere, so tests drive the
 * cooldown ladder deterministically.
 *
 * Consumers: host/index.ts wires `resolveRoleRoute` (runner SubagentPort +
 * session-tier route stamping), the detached-terminal respawn path, and the
 * orchestrator's turn-start primary check.
 */

import type { RoleRouteEntry } from "@anycode/core";
import type { RoleRouteEntry as SettingsRoleRouteEntry } from "../shared/settings.js";

/**
 * Exponential cooldown: base 5min, doubling per consecutive failure, capped
 * at 60min (§3.6). First failure => 5m, second => 10m, third => 20m, then 40m,
 * then the cap.
 */
export const ROLE_COOLDOWN_BASE_MS = 5 * 60_000;
export const ROLE_COOLDOWN_MAX_MS = 60 * 60_000;

/** Stable identity for one (role, entry) pair — the health cache key. */
export function entryKey(role: string, e: RoleRouteEntry): string {
  return `${role}|${e.engine ?? e.connection ?? e.provider ?? ""}|${e.model ?? ""}`;
}

/** A human-facing label for an entry (engine or connection + model). */
export function entryLabel(e: RoleRouteEntry): string {
  const route = e.engine !== undefined ? `engine ${e.engine}` : e.connection !== undefined ? e.connection : e.provider ?? "session connection";
  return e.model !== undefined ? `${route} / ${e.model}` : route;
}

/** The health facts pickEntry/cooldown decisions are made against. */
export interface HealthSnapshotEntry {
  /** Consecutive failures (reset by markSuccess). */
  failures: number;
  /** Cooldown expiry (epoch ms); entries with until > now are unhealthy. */
  until: number;
  /** Human-facing reason of the LAST failure. */
  lastReason?: string;
}

export type HealthSnapshot = ReadonlyMap<string, HealthSnapshotEntry>;

export interface PickEntryResult {
  entry: RoleRouteEntry;
  index: number;
  skipped: ReadonlyArray<{ entry: RoleRouteEntry; reason: string }>;
}

/**
 * Picks the first healthy entry of a chain (§3.6 spawn-time selection).
 * Unhealthy (cooldown) entries are skipped with their last reason; an
 * exhausted chain returns null — the caller then stamps no route fields and
 * the parent model remains the implicit last resort.
 */
export function pickEntry(
  chain: ReadonlyArray<RoleRouteEntry>,
  health: HealthSnapshot,
  now: number,
  role: string,
): PickEntryResult | null {
  const skipped: { entry: RoleRouteEntry; reason: string }[] = [];
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;
    const key = entryKey(role, entry);
    const h = health.get(key);
    if (h !== undefined && h.until > now) {
      skipped.push({
        entry,
        reason: h.lastReason ?? "unhealthy",
      });
      continue;
    }
    return { entry, index: i, skipped };
  }
  return null;
}

/** Cooldown after `failures` consecutive failures (exponential, capped). */
export function cooldownUntil(failures: number, now: number): number {
  if (failures <= 0) return 0;
  const exp = ROLE_COOLDOWN_BASE_MS * Math.pow(2, failures - 1);
  return now + Math.min(exp, ROLE_COOLDOWN_MAX_MS);
}

/**
 * Infrastructure-failure classification (§2.7): fallback triggers are
 * infrastructure classes ONLY. Ordinary task failure / bad answer NEVER
 * falls back ("task failed", "test assertion failed" → none).
 */
export type InfraFailureKind =
  | "unreachable"
  | "auth"
  | "model_not_found"
  | "quota"
  | "timeout_first_token"
  | "none";

export function classifyInfraFailure(text: string): InfraFailureKind {
  const t = text.toLowerCase();
  // Model resolver messages (child model id disallowed/unknown on the
  // connection).
  if (t.includes("could not be resolved") || t.includes("not available on this connection") || t.includes("not available on the selected connection")) {
    return "model_not_found";
  }
  if (/\b401\b/.test(t) || /\b403\b/.test(t) || t.includes("auth") || t.includes("unauthorized") || t.includes("forbidden")) {
    return "auth";
  }
  if (/\b429\b/.test(t) || t.includes("quota") || t.includes("rate limit") || t.includes("rate_limit")) {
    return "quota";
  }
  if (
    t.includes("enotfound") ||
    t.includes("econnrefused") ||
    t.includes("econnreset") ||
    t.includes("etimedout") ||
    t.includes("tls") ||
    t.includes("certificate") ||
    t.includes("unreachable")
  ) {
    return "unreachable";
  }
  if (t.includes("before first token") || t.includes("stalled before")) {
    return "timeout_first_token";
  }
  return "none";
}

/**
 * Process-local health cache (Q3: never persisted). One per host. Failure
 * counts are per (role, entry) pair; markSuccess resets a key entirely.
 */
export class RoleHealthCache {
  private readonly entries = new Map<string, HealthSnapshotEntry>();

  markFailure(key: string, reason: string, now: number): HealthSnapshotEntry {
    const prev = this.entries.get(key);
    const failures = (prev?.failures ?? 0) + 1;
    const next: HealthSnapshotEntry = {
      failures,
      until: cooldownUntil(failures, now),
      lastReason: reason,
    };
    this.entries.set(key, next);
    return next;
  }

  markSuccess(key: string): void {
    this.entries.delete(key);
  }

  isUnhealthy(key: string, now: number): boolean {
    const h = this.entries.get(key);
    return h !== undefined && h.until > now;
  }

  lastReason(key: string): string | undefined {
    return this.entries.get(key)?.lastReason;
  }

  snapshot(): HealthSnapshot {
    return new Map(this.entries);
  }
}

/** Settings-side entry -> core-side entry (same shape; keeps module boundaries). */
export function toCoreEntry(e: SettingsRoleRouteEntry): RoleRouteEntry {
  return {
    ...(e.engine !== undefined ? { engine: e.engine } : {}),
    ...(e.connection !== undefined ? { connection: e.connection } : {}),
    ...(e.provider !== undefined ? { provider: e.provider } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
  };
}

// ── detached-terminal respawn decisions (Taskana 4704 §3.6, fallback point 2) ──

/** The per-spawn facts the respawn decision needs (mirrors index.ts's record). */
export interface RoutedSpawnFacts {
  role: string;
  entry: RoleRouteEntry;
  rest: ReadonlyArray<RoleRouteEntry>;
  usedFallback: boolean;
  skipReason?: string;
}

/**
 * PURE decision for a routed role child's detached terminal. Returns one of:
 * - `{ action: "deliver" }` — deliver unchanged (non-infra failure, or an
 *   unrouted spawn; the caller may still have a visibility line to prepend).
 * - `{ action: "deliver_exhausted" }` — chain exhausted: deliver the ORIGINAL
 *   error with the appended failure line (the caller appends it).
 * - `{ action: "respawn", entry, ... }` — mark the failed entry dead and
 *   re-spawn the same prompt on the next healthy entry (fresh id; short
 *   retrying notice replaces the child's error report).
 * Health mutations are RETURNED, never performed here — the caller applies
 * them to its live cache (this function is pure and testable).
 */
export type RoutedTerminalDecision =
  | { action: "deliver" }
  | { action: "deliver_exhausted"; failedKey: string; reason: string }
  | {
      action: "respawn";
      failedKey: string;
      reason: string;
      entry: RoleRouteEntry;
      /** The notice line that replaces the child's error report. */
      notice: string;
      /** The next record's facts (rest of the chain after the new entry). */
      next: Omit<RoutedSpawnFacts, "skipReason" | "usedFallback"> & { usedFallback: true; skipReason: string };
    };

export function decideRoutedTerminal(
  facts: RoutedSpawnFacts | undefined,
  status: SessionOutcomeStatus,
  finalText: string,
  health: RoleHealthCache,
  now: number,
): RoutedTerminalDecision {
  if (facts === undefined) return { action: "deliver" };
  if (status === "completed") {
    // markSuccess on ANY completed terminal of a routed role child.
    health.markSuccess(entryKey(facts.role, facts.entry));
    return { action: "deliver" };
  }
  // Fallback point 2: infrastructure classes ONLY (§2.7).
  const kind = classifyInfraFailure(finalText);
  if (kind === "none") return { action: "deliver" };
  const failedKey = entryKey(facts.role, facts.entry);
  health.markFailure(failedKey, kind, now);
  const chain = [facts.entry, ...facts.rest];
  const picked = pickEntry(chain, health.snapshot(), now, facts.role);
  if (picked === null) {
    return { action: "deliver_exhausted", failedKey, reason: kind };
  }
  return {
    action: "respawn",
    failedKey,
    reason: kind,
    entry: picked.entry,
    notice: `Agent: role ${facts.role} retrying on ${entryLabel(picked.entry)} after ${kind}.`,
    next: {
      role: facts.role,
      entry: picked.entry,
      rest: chain.slice(picked.index + 1),
      usedFallback: true,
      skipReason: kind,
    },
  };
}

/** The status subset the decision needs (kept local to avoid a core import cycle). */
type SessionOutcomeStatus = "completed" | "error" | "max_turns" | "cancelled";

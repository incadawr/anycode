/**
 * Profile stats aggregator (slice P7.22/F19, design slice-P7.22-cut.md §2-D3/D4).
 * Pure math over already-parsed JSONL lines from the 6.6 telemetry sink
 * (ports/telemetry.ts) — this module touches NO filesystem itself; the caller
 * (Electron main, via the `./telemetry-admin` subpath) supplies an iterable of
 * `{name, lines}` per sink file, already sorted or not (this function sorts
 * defensively by name so processing order — and therefore the truncation
 * cutoff — is deterministic regardless of caller iteration order).
 *
 * Every field is derived ONLY from the frozen record union (envelope `{v:1,
 * ts, session}` + a `t`-discriminated variant) — no free-form text is ever
 * read or surfaced, matching the ports/telemetry.ts privacy theorem.
 */

import { PROFILE_ACTIVITY_GAP_CAP_MS, PROFILE_STATS_MAX_SCAN_BYTES } from "../types/config.js";

export interface ProfileStats {
  lifetimeTokens: number;
  peakDay: { day: string; tokens: number } | null;
  longestSessionMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  /** dayKey -> total tokens (usage records only). */
  dailyTokens: Record<string, number>;
  /** Distinct sink files that yielded >=1 valid record. */
  totalSessions: number;
  /** Count of `loop_end` records. */
  totalRuns: number;
  /** Count of `tool` records. */
  toolCalls: number;
  /** Count of `subagent_start` records. */
  subagentRuns: number;
  topTools: { name: string; count: number }[];
  topModels: { model: string; tokens: number }[];
  /** True when the scan stopped early on PROFILE_STATS_MAX_SCAN_BYTES. */
  truncated: boolean;
}

/** One sink file's name plus its raw JSONL lines (not yet parsed/validated). */
export interface ProfileStatsFile {
  name: string;
  lines: Iterable<string>;
}

export interface AggregateProfileStatsOptions {
  /** Current time in ms; anchors the current-streak "today/yesterday" grace window. */
  now: number;
  /** Local-day bucket key for a ts (ms). Defaults to LOCAL YYYY-MM-DD (owner-facing
   *  stat). MUST always be YYYY-MM-DD SHAPED (any calendar/timezone) — the streak
   *  adjacency math below parses this string back into a day ordinal via
   *  `Date.UTC`, which only works for that shape. Tests inject a UTC formatter of
   *  the same shape for determinism. */
  dayKey?: (ts: number) => string;
}

/** LOCAL calendar date `YYYY-MM-DD` from a ts in ms. */
function defaultDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parses a YYYY-MM-DD dayKey string into a UTC day ordinal (days since the
 * Unix epoch) purely for ADJACENCY comparisons (streaks) — never used to
 * re-derive a wall-clock time. Any dayKey function's output, default or
 * test-injected, is assumed to be this exact shape (see AggregateProfileStatsOptions
 * doc); a non-conforming key parses to NaN and is excluded from streak math
 * (fail-soft — it still counts toward dailyTokens/peakDay, which key off the
 * raw string, not the ordinal).
 */
function dayOrdinal(dayKeyStr: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKeyStr);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

interface SessionAgg {
  timestamps: number[];
  model: string | undefined;
  tokens: number;
}

/**
 * The exact `t` discriminant values of the frozen TelemetryRecord union
 * (ports/telemetry.ts) — enumerate-the-good (W5-FIX finding 2): a line with a
 * valid envelope (`v:1` + finite `ts`) but an unknown/missing `t` is a
 * phantom/garbage variant and must be skipped exactly like a malformed line,
 * never contributing a session, a streak/activity day, or any count.
 */
const VALID_RECORD_TYPES: ReadonlySet<string> = new Set([
  // TelemetryEventRecord
  "turn_end",
  "usage",
  "tool",
  "loop_end",
  "compaction_start",
  "compaction_end",
  "microcompact",
  "context_usage",
  "subagent_start",
  "subagent_end",
  "workflow_end",
  "stream_retry",
  "error",
  "checkpoint_created",
  "checkpoint_failed",
  // TelemetryLifecycleRecord
  "session_start",
  "session_end",
]);

/** Coerces a token field to a non-negative finite number, else 0 — never lets
 *  an Infinity/NaN/negative value (a malformed or hostile line) enter a sum
 *  (W5-FIX finding 2, PoC-2). */
function clampTokenValue(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
}

function usageTokens(rec: Record<string, unknown>): number {
  const totalTokens = rec.totalTokens;
  if (typeof totalTokens === "number") return clampTokenValue(totalTokens);
  return clampTokenValue(rec.inputTokens) + clampTokenValue(rec.outputTokens);
}

export function aggregateProfileStats(
  files: Iterable<ProfileStatsFile>,
  opts: AggregateProfileStatsOptions,
): ProfileStats {
  const dayKey = opts.dayKey ?? defaultDayKey;

  const sortedFiles = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let cumulativeBytes = 0;
  let truncated = false;

  let lifetimeTokens = 0;
  const dailyTokens = new Map<string, number>();
  const activeDays = new Set<string>();
  const filesWithValidRecord = new Set<string>();

  let totalRuns = 0;
  let toolCalls = 0;
  let subagentRuns = 0;
  const toolCounts = new Map<string, number>();

  const sessions = new Map<string, SessionAgg>();

  scan: for (const file of sortedFiles) {
    for (const line of file.lines) {
      cumulativeBytes += line.length;
      if (cumulativeBytes > PROFILE_STATS_MAX_SCAN_BYTES) {
        truncated = true;
        break scan;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as Record<string, unknown>;
      if (rec.v !== 1) continue;
      if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) continue;
      if (typeof rec.t !== "string" || !VALID_RECORD_TYPES.has(rec.t)) continue;

      filesWithValidRecord.add(file.name);

      const ts = rec.ts;
      const day = dayKey(ts);
      activeDays.add(day);

      const sessionId = typeof rec.session === "string" && rec.session.length > 0 ? rec.session : file.name;
      let session = sessions.get(sessionId);
      if (session === undefined) {
        session = { timestamps: [], model: undefined, tokens: 0 };
        sessions.set(sessionId, session);
      }
      session.timestamps.push(ts);

      switch (rec.t) {
        case "usage": {
          const tokens = usageTokens(rec);
          lifetimeTokens += tokens;
          dailyTokens.set(day, (dailyTokens.get(day) ?? 0) + tokens);
          session.tokens += tokens;
          break;
        }
        case "tool": {
          toolCalls += 1;
          if (typeof rec.tool === "string" && rec.tool.length > 0) {
            toolCounts.set(rec.tool, (toolCounts.get(rec.tool) ?? 0) + 1);
          }
          break;
        }
        case "loop_end": {
          totalRuns += 1;
          break;
        }
        case "subagent_start": {
          subagentRuns += 1;
          break;
        }
        case "session_start": {
          if (typeof rec.model === "string" && rec.model.length > 0) {
            session.model = rec.model;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // peakDay: max tokens, tie-break earliest day string (literal string compare).
  let peakDay: { day: string; tokens: number } | null = null;
  for (const [day, tokens] of dailyTokens) {
    if (peakDay === null || tokens > peakDay.tokens || (tokens === peakDay.tokens && day < peakDay.day)) {
      peakDay = { day, tokens };
    }
  }

  // longestSessionMs: per session, sum of consecutive-record gaps, each capped.
  let longestSessionMs = 0;
  for (const session of sessions.values()) {
    const ts = [...session.timestamps].sort((a, b) => a - b);
    let active = 0;
    for (let i = 1; i < ts.length; i += 1) {
      const gap = ts[i]! - ts[i - 1]!;
      active += Math.min(gap, PROFILE_ACTIVITY_GAP_CAP_MS);
    }
    if (active > longestSessionMs) longestSessionMs = active;
  }

  // Model join: attribute each session's total usage tokens to its
  // session_start model, "(unknown)" fallback per rollup precedent.
  const modelTokens = new Map<string, number>();
  for (const session of sessions.values()) {
    const model = session.model ?? "(unknown)";
    modelTokens.set(model, (modelTokens.get(model) ?? 0) + session.tokens);
  }
  const topModels = [...modelTokens.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    .slice(0, 3);

  const topTools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  // Streaks: day ordinals derived from the dayKey STRING (adjacency-only —
  // never re-derives a wall-clock time), so this works for both the default
  // local formatter and any injected test formatter of the same YYYY-MM-DD shape.
  const ordinals = [...new Set([...activeDays].map(dayOrdinal).filter((n) => Number.isFinite(n)))].sort(
    (a, b) => a - b,
  );

  let longestStreakDays = 0;
  let run = 0;
  let prevOrdinal: number | undefined;
  for (const ordinal of ordinals) {
    run = prevOrdinal !== undefined && ordinal === prevOrdinal + 1 ? run + 1 : 1;
    prevOrdinal = ordinal;
    if (run > longestStreakDays) longestStreakDays = run;
  }

  const ordinalSet = new Set(ordinals);
  const nowOrdinal = dayOrdinal(dayKey(opts.now));
  let endOrdinal: number | undefined;
  if (ordinalSet.has(nowOrdinal)) {
    endOrdinal = nowOrdinal;
  } else if (ordinalSet.has(nowOrdinal - 1)) {
    endOrdinal = nowOrdinal - 1;
  }
  let currentStreakDays = 0;
  if (endOrdinal !== undefined) {
    let cursor = endOrdinal;
    while (ordinalSet.has(cursor)) {
      currentStreakDays += 1;
      cursor -= 1;
    }
  }

  return {
    lifetimeTokens,
    peakDay,
    longestSessionMs,
    currentStreakDays,
    longestStreakDays,
    dailyTokens: Object.fromEntries(dailyTokens),
    totalSessions: filesWithValidRecord.size,
    totalRuns,
    toolCalls,
    subagentRuns,
    topTools,
    topModels,
    truncated,
  };
}

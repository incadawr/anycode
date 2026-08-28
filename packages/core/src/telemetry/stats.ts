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
  /** Distinct sink files that yielded >=1 valid record. */
  totalSessions: number;
  /** Count of `loop_end` records. */
  totalRuns: number;
  /** Count of `tool` records. */
  toolCalls: number;
  /** Count of `subagent_start` records. */
  subagentRuns: number;
  /** True when the scan stopped early on PROFILE_STATS_MAX_SCAN_BYTES. */
  truncated: boolean;
  /** Telemetry track (TASK.158 slice 1) additions — additive, §2.6 of
   *  telemetry-track-plan.md; these are projections over the SAME single scan.
   *  (S10: the pre-TASK.158 `dailyTokens`/`topTools`/`topModels` top-N/single-map
   *  fields these superseded have been removed — `days`/`models` below are the
   *  only wire source for daily totals and tool/model breakdowns now.) */
  /** dayKey (same `dayKey(ts)` call used throughout this module) -> that day's stats. */
  days: Record<string, ProfileDayStats>;
  /** FULL model list (no top-N cut), tokens desc then name. Absent `engine`
   *  means every session attributed to that model was core (no engine boot). */
  models: { model: string; tokens: number; sessions: number; engine?: "codex" | "claude" }[];
  /** "core" | "codex" | "claude" -> lifetime tokens attributed to that engine.
   *  Session-level: an inline subagent's tokens count here even when its
   *  `sub.model` overrides the model (they land in a different `models`/
   *  `days[].models` bucket, but the subagent still executes inside its
   *  parent session and inherits that session's engine) — so this sum
   *  always equals `lifetimeTokens` exactly, never less. */
  engineTokens: Record<string, number>;
}

export interface ProfileDayStats {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  /** Sessions whose FIRST record (min ts) falls on this day. */
  sessions: number;
  /** Tool name -> calls that day. */
  tools: Record<string, number>;
  /** Model -> tokens that day (deferred join — see the model-attribution
   *  comment on aggregateProfileStats). */
  models: Record<string, number>;
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
 * (fail-soft — it still counts toward `days`/peakDay, which key off the
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
  /** Telemetry track (TASK.158 slice 1, deferred join — trap 158-1): usage
   *  tokens NOT overridden by a `sub.model` (master-tier, or a subagent that
   *  ran on the session's own model), bucketed by dayKey. Joined to
   *  `model ?? "(unknown)"` and to `engine` only AFTER the scan, because
   *  `session_start` (which carries both) may arrive after usage lines in the
   *  same file — the same reason `model`/`tokens` above are deferred. */
  tokensByDay: Map<string, number>;
  /** `session_start.engine`; absent = core. Captured post-hoc same as `model`. */
  engine: string | undefined;
  /** Min ts seen for this session so far (lines are not chronological). */
  firstTs: number;
}

/** Envelope `sub` is present only on inline-subagent-tier records (TASK.160).
 *  Validated defensively — same fail-soft posture as the rest of this file —
 *  a malformed `sub` (not an object, or missing/empty `agentType`) is treated
 *  as "no sub" rather than trusted. */
function hasEnvelopeSub(rec: Record<string, unknown>): boolean {
  const sub = rec.sub;
  if (sub === null || typeof sub !== "object" || Array.isArray(sub)) return false;
  const agentType = (sub as Record<string, unknown>).agentType;
  return typeof agentType === "string" && agentType.length > 0;
}

/** The `sub.model` override, when present and valid — signals a record's
 *  tokens go to the DIRECT (model, day) accumulator instead of the session's
 *  own `tokensByDay` (§2.6: "absent = the child ran on the session's own
 *  model", which folds through the session exactly like a master-tier record). */
function envelopeSubModel(rec: Record<string, unknown>): string | undefined {
  const sub = rec.sub;
  if (sub === null || typeof sub !== "object" || Array.isArray(sub)) return undefined;
  const model = (sub as Record<string, unknown>).model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/** Internal (Map-based) mirror of ProfileDayStats, converted to plain
 *  Records only once, at the end of aggregateProfileStats. */
interface DayAggInternal {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  sessions: number;
  tools: Map<string, number>;
  models: Map<string, number>;
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
  const activeDays = new Set<string>();
  const filesWithValidRecord = new Set<string>();

  let totalRuns = 0;
  let toolCalls = 0;
  let subagentRuns = 0;

  const sessions = new Map<string, SessionAgg>();

  // Telemetry track (TASK.158 slice 1): per-day aggregate, keyed by the SAME
  // dayKey(ts) call used everywhere else in this scan (158-trap-2 — never a
  // second formatter). Model attribution inside a day is a deferred join
  // (158-trap-1); see the post-scan fold below.
  const dayAggs = new Map<string, DayAggInternal>();
  function ensureDay(day: string): DayAggInternal {
    let agg = dayAggs.get(day);
    if (agg === undefined) {
      agg = { tokens: 0, runs: 0, toolCalls: 0, subagentRuns: 0, sessions: 0, tools: new Map(), models: new Map() };
      dayAggs.set(day, agg);
    }
    return agg;
  }

  // Direct (model, day) accumulator for usage records whose `sub.model`
  // overrides the session's own model — bypasses session attribution entirely
  // (§2.6): these tokens count toward `models`/`days[d].models` but NOT
  // toward `engineTokens` or a model's `sessions` count (those are session-
  // level, derived from `SessionAgg.tokensByDay` in the post-scan fold).
  const subModelDayTokens = new Map<string, Map<string, number>>();

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
      const dayAgg = ensureDay(day);

      const sessionId = typeof rec.session === "string" && rec.session.length > 0 ? rec.session : file.name;
      let session = sessions.get(sessionId);
      if (session === undefined) {
        session = { timestamps: [], model: undefined, tokens: 0, tokensByDay: new Map(), engine: undefined, firstTs: ts };
        sessions.set(sessionId, session);
      } else if (ts < session.firstTs) {
        session.firstTs = ts;
      }
      session.timestamps.push(ts);

      switch (rec.t) {
        case "usage": {
          const tokens = usageTokens(rec);
          lifetimeTokens += tokens;
          session.tokens += tokens;
          dayAgg.tokens += tokens;
          // Deferred model attribution (158-trap-1): a sub.model override
          // routes straight to the (model, day) accumulator; everything else
          // (no sub, or sub without a model override) folds through the
          // session's own model, joined AFTER the scan since session_start
          // may not have been seen yet.
          const subModel = envelopeSubModel(rec);
          if (subModel !== undefined) {
            let byDay = subModelDayTokens.get(subModel);
            if (byDay === undefined) {
              byDay = new Map();
              subModelDayTokens.set(subModel, byDay);
            }
            byDay.set(day, (byDay.get(day) ?? 0) + tokens);
          } else {
            session.tokensByDay.set(day, (session.tokensByDay.get(day) ?? 0) + tokens);
          }
          break;
        }
        case "tool": {
          toolCalls += 1;
          dayAgg.toolCalls += 1;
          if (typeof rec.tool === "string" && rec.tool.length > 0) {
            dayAgg.tools.set(rec.tool, (dayAgg.tools.get(rec.tool) ?? 0) + 1);
          }
          break;
        }
        case "loop_end": {
          // A sub-tier loop_end is a child run, already counted in
          // subagentRuns (via its subagent_start) — excluding it here avoids
          // double-counting a single delegation as two runs (§2.6 tier rule).
          if (!hasEnvelopeSub(rec)) {
            totalRuns += 1;
            dayAgg.runs += 1;
          }
          break;
        }
        case "subagent_start": {
          subagentRuns += 1;
          dayAgg.subagentRuns += 1;
          break;
        }
        case "session_start": {
          // `sub` on a session_start is structurally impossible (a session
          // boot is never itself a subagent record) — ignore defensively,
          // no gating needed.
          if (typeof rec.model === "string" && rec.model.length > 0) {
            session.model = rec.model;
          }
          if (rec.engine === "codex" || rec.engine === "claude") {
            session.engine = rec.engine;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // peakDay: max tokens, tie-break earliest day string (literal string compare).
  // Reads `dayAggs` (the same per-day accumulator `days` is built from below)
  // rather than a dedicated map — `dayAgg.tokens` is incremented in lockstep
  // with lifetimeTokens in the "usage" case above, so it carries the exact
  // per-day totals the removed `dailyTokens` map used to hold.
  let peakDay: { day: string; tokens: number } | null = null;
  for (const [day, agg] of dayAggs) {
    if (peakDay === null || agg.tokens > peakDay.tokens || (agg.tokens === peakDay.tokens && day < peakDay.day)) {
      peakDay = { day, tokens: agg.tokens };
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

  // Telemetry track (TASK.158 slice 1) — deferred joins, post-scan (158-trap-1/2):
  // full model list + per-day model breakdown + engineTokens + days[d].sessions.
  // Session-level attribution ONLY (`session.tokensByDay`, built above from
  // usage records with no sub.model override) feeds `sessions`/`engine` here;
  // the direct sub.model accumulator (`subModelDayTokens`) adds tokens only,
  // never a session or an engine — those are session-scoped concepts and a
  // model-overriding subagent does not change its parent session's engine.
  interface ModelAggInternal {
    tokens: number;
    sessions: number;
    engine: string | undefined;
    engineSet: boolean;
  }
  const modelAgg = new Map<string, ModelAggInternal>();
  function ensureModelAgg(model: string): ModelAggInternal {
    let agg = modelAgg.get(model);
    if (agg === undefined) {
      agg = { tokens: 0, sessions: 0, engine: undefined, engineSet: false };
      modelAgg.set(model, agg);
    }
    return agg;
  }
  const engineTokensMap = new Map<string, number>();

  for (const session of sessions.values()) {
    const model = session.model ?? "(unknown)";
    const agg = ensureModelAgg(model);
    agg.sessions += 1;
    // "first-seen wins on conflict" (§2.6) — sessions.values() iterates in
    // the order each session's FIRST record was scanned, so the earliest
    // session attributed to this model decides the model's engine, even if
    // that engine is core (undefined).
    if (!agg.engineSet) {
      agg.engine = session.engine;
      agg.engineSet = true;
    }

    for (const [day, tokens] of session.tokensByDay) {
      agg.tokens += tokens;
      const dayAgg = ensureDay(day);
      dayAgg.models.set(model, (dayAgg.models.get(model) ?? 0) + tokens);
    }

    // Engine attribution uses session.tokens (the FULL, unconditional
    // per-session total, already summed at the "usage" case above) rather
    // than the tokensByDay sum: an inline subagent's tokens still belong to
    // the parent session's engine even when a `sub.model` override sends
    // them to a DIFFERENT model bucket above — a model override changes
    // which `models` row the tokens land in, never which engine ran them.
    // This keeps engineTokens summing to exactly lifetimeTokens.
    const engineKey = session.engine ?? "core";
    engineTokensMap.set(engineKey, (engineTokensMap.get(engineKey) ?? 0) + session.tokens);

    const sessionDay = dayKey(session.firstTs);
    ensureDay(sessionDay).sessions += 1;
  }

  for (const [model, byDay] of subModelDayTokens) {
    const agg = ensureModelAgg(model);
    for (const [day, tokens] of byDay) {
      agg.tokens += tokens;
      const dayAgg = ensureDay(day);
      dayAgg.models.set(model, (dayAgg.models.get(model) ?? 0) + tokens);
    }
  }

  const models = [...modelAgg.entries()]
    .map(([model, agg]) => ({
      model,
      tokens: agg.tokens,
      sessions: agg.sessions,
      ...(agg.engine !== undefined ? { engine: agg.engine as "codex" | "claude" } : {}),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  const engineTokens = Object.fromEntries(engineTokensMap);

  const days: Record<string, ProfileDayStats> = {};
  for (const [day, agg] of dayAggs) {
    days[day] = {
      tokens: agg.tokens,
      runs: agg.runs,
      toolCalls: agg.toolCalls,
      subagentRuns: agg.subagentRuns,
      sessions: agg.sessions,
      tools: Object.fromEntries(agg.tools),
      models: Object.fromEntries(agg.models),
    };
  }

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
    totalSessions: filesWithValidRecord.size,
    totalRuns,
    toolCalls,
    subagentRuns,
    truncated,
    days,
    models,
    engineTokens,
  };
}

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
  /** Cumulative processed-line char budget for the WHOLE scan; defaults to
   *  PROFILE_STATS_MAX_SCAN_BYTES. `Infinity` disables truncation entirely —
   *  that is the uncapped oracle the TASK.187 S2 equivalence harness compares
   *  the per-file partial path against (partials never truncate a file, so
   *  equivalence is only ever claimed for FULL files). Additive: existing
   *  callers that omit it keep the exact previous behavior. */
  byteBudget?: number;
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

/** A line that cleared every envelope/variant gate; `ts`/`t` are narrowed so
 *  callers need not re-check them. */
type ValidTelemetryRecord = Record<string, unknown> & { ts: number; t: string };

/**
 * The SINGLE record-validity filter of this module (task187-aggregator-
 * semantics.md §0): JSON-parses one line, then applies the envelope gate
 * (`v === 1`, finite `ts`) and the enumerate-the-good variant gate, returning
 * undefined for anything that fails. Every reader of a sink file goes through
 * here — the whole-directory aggregator, `aggregateFilePartial` and
 * `collectSessionTimestamps` — because a second copy of these rules is exactly
 * how a cached per-file partial would start disagreeing with a full scan.
 */
function parseValidRecord(line: string): ValidTelemetryRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return undefined;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return undefined;
  if (typeof rec.t !== "string" || !VALID_RECORD_TYPES.has(rec.t)) return undefined;
  return rec as ValidTelemetryRecord;
}

/** Session key: the envelope's `session` when it is a non-empty string, else
 *  the FILE NAME (§0) — shared by both paths so a file's partial keys sessions
 *  exactly as the whole-directory scan does. */
function sessionIdFor(rec: ValidTelemetryRecord, fileName: string): string {
  return typeof rec.session === "string" && rec.session.length > 0 ? rec.session : fileName;
}

/** Deterministic processing order for files/partials (defensive sort by name,
 *  §2) — it decides first-seen engine attribution and the truncation cutoff. */
function compareFileNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ensureDayAgg(dayAggs: Map<string, DayAggInternal>, day: string): DayAggInternal {
  let agg = dayAggs.get(day);
  if (agg === undefined) {
    agg = { tokens: 0, runs: 0, toolCalls: 0, subagentRuns: 0, sessions: 0, tools: new Map(), models: new Map() };
    dayAggs.set(day, agg);
  }
  return agg;
}

/**
 * Gap-capped active duration of one session: the sum of consecutive-timestamp
 * gaps, each capped at PROFILE_ACTIVITY_GAP_CAP_MS (§1). 0 for fewer than two
 * timestamps.
 *
 * PRECONDITION: `sortedTs` is ascending. The caller sorts — for the whole-scan
 * path that is the session's own timestamp array, for the cross-file second
 * pass it is the sorted UNION of every participating file's timestamps. This
 * one definition is the only gap math in the module, so both paths cap
 * identically.
 */
export function sessionActiveMs(sortedTs: readonly number[]): number {
  let active = 0;
  for (let i = 1; i < sortedTs.length; i += 1) {
    active += Math.min(sortedTs[i]! - sortedTs[i - 1]!, PROFILE_ACTIVITY_GAP_CAP_MS);
  }
  return active;
}

/**
 * A half-open-free activity interval `[start, end]` in ms: the span of one run
 * of a session's timestamps whose consecutive gaps are all <=
 * PROFILE_ACTIVITY_GAP_CAP_MS. A single timestamp is the degenerate cluster
 * `[t, t]`.
 */
export type ActivityCluster = [start: number, end: number];

/**
 * Folds timestamps (or another cluster list) into a cluster list, returning
 * the CANONICAL form: sorted by start, pairwise disjoint, and split exactly
 * where a gap exceeds the cap.
 *
 * WHY CLUSTERS EXIST (TASK.187 S3): the incremental cache computes a
 * cross-file session's exact activity over SEVERAL passes, one participant
 * file at a time. Clusters are the state it carries between passes because
 * this fold is associative and commutative — participants may arrive in any
 * order, in any number of passes, and the answer is the one a single
 * union-sort of every timestamp would give (see `clustersActiveMs`). They are
 * also O(number of >cap pauses) instead of O(number of records), which is
 * what keeps a pathological session from bloating the cache file.
 *
 * Non-finite inputs are dropped (fail-soft: cluster state round-trips through
 * an untrusted cache file); a reversed pair is normalised rather than
 * rejected.
 */
export function mergeActivityClusters(
  clusters: readonly ActivityCluster[],
  addition: readonly number[] | readonly ActivityCluster[],
): ActivityCluster[] {
  const all: ActivityCluster[] = [];
  const push = (start: number, end: number): void => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    all.push(start <= end ? [start, end] : [end, start]);
  };
  for (const cluster of clusters) push(cluster[0], cluster[1]);
  for (const item of addition) {
    if (typeof item === "number") push(item, item);
    else if (Array.isArray(item)) push(item[0]!, item[1]!);
  }
  if (all.length === 0) return [];
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: ActivityCluster[] = [];
  let current: ActivityCluster = [all[0]![0], all[0]![1]];
  for (let i = 1; i < all.length; i += 1) {
    const next = all[i]!;
    // `<=` matches sessionActiveMs: a gap of exactly the cap contributes the
    // cap either way, so joining or splitting there gives the same total.
    if (next[0] - current[1] <= PROFILE_ACTIVITY_GAP_CAP_MS) {
      if (next[1] > current[1]) current[1] = next[1];
    } else {
      merged.push(current);
      current = [next[0], next[1]];
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Gap-capped active duration of a CANONICAL cluster list (the output of
 * `mergeActivityClusters`): every within-cluster gap is <= the cap, so it
 * contributes in full and the whole run sums to `end - start`; every
 * between-cluster gap exceeds the cap, so it contributes exactly the cap.
 *
 *   activeMs = Σ (end - start) + CAP × (clusters - 1)
 *
 * Identical to `sessionActiveMs` over the union of all the timestamps the
 * clusters were built from — pinned directly and by the randomized
 * cross-check in stats.test.ts.
 */
export function clustersActiveMs(clusters: readonly ActivityCluster[]): number {
  if (clusters.length === 0) return 0;
  let total = 0;
  for (const cluster of clusters) total += cluster[1] - cluster[0];
  return total + PROFILE_ACTIVITY_GAP_CAP_MS * (clusters.length - 1);
}

export function aggregateProfileStats(
  files: Iterable<ProfileStatsFile>,
  opts: AggregateProfileStatsOptions,
): ProfileStats {
  const dayKey = opts.dayKey ?? defaultDayKey;
  const byteBudget = opts.byteBudget ?? PROFILE_STATS_MAX_SCAN_BYTES;

  const sortedFiles = [...files].sort((a, b) => compareFileNames(a.name, b.name));

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
    return ensureDayAgg(dayAggs, day);
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
      if (cumulativeBytes > byteBudget) {
        truncated = true;
        break scan;
      }

      const rec = parseValidRecord(line);
      if (rec === undefined) continue;

      filesWithValidRecord.add(file.name);

      const ts = rec.ts;
      const day = dayKey(ts);
      activeDays.add(day);
      const dayAgg = ensureDay(day);

      const sessionId = sessionIdFor(rec, file.name);
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
    const active = sessionActiveMs([...session.timestamps].sort((a, b) => a - b));
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

  const days: Record<string, ProfileDayStats> = Object.fromEntries(
    [...dayAggs].map(
      ([day, agg]) =>
        [
          day,
          {
            tokens: agg.tokens,
            runs: agg.runs,
            toolCalls: agg.toolCalls,
            subagentRuns: agg.subagentRuns,
            sessions: agg.sessions,
            tools: Object.fromEntries(agg.tools),
            models: Object.fromEntries(agg.models),
          },
        ] as const,
    ),
  );

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

// ---------------------------------------------------------------------------
// TASK.187 S2 — per-file partials + merge.
//
// Why a second path exists at all: opening the owner's ~58 763 sink files
// costs ~16 s per Profile-pane open, and 90 % of that is the file opens
// themselves. A partial is one file's whole contribution in a plain-JSON,
// cacheable shape, so an unchanged file never has to be opened again; the
// caching/scanning layer lives above this module (S3).
//
// `aggregateProfileStats` above is deliberately NOT reimplemented on top of
// these functions: it stays an INDEPENDENT implementation so the equivalence
// harness in stats.test.ts is a real cross-check rather than a tautology. The
// price is that the post-scan fold exists twice; the harness is what detects
// any drift between the copies, and it runs every fixture of the legacy suite.

/** Per-session slice of one file's contribution. */
export interface ProfileFilePartialSession {
  /** `rec.session`, else the file's own name (§0). */
  id: string;
  /** Last valid `session_start.model` IN THIS FILE (§2); absent = none seen. */
  model?: string;
  /** Last valid `session_start.engine` IN THIS FILE (§2); absent = core. */
  engine?: "codex" | "claude";
  /** Min/max ts of this session's valid records in this file. */
  firstTs: number;
  lastTs: number;
  /** Unconditional per-session usage total (the engineTokens base, §6). */
  tokens: number;
  /** Usage tokens NOT redirected by a `sub.model` override, by dayKey (§6). */
  tokensByDay: Record<string, number>;
  /** Gap-capped active duration WITHIN this file (§1). Not `lastTs - firstTs`:
   *  inner gaps are capped too. */
  activeMs: number;
}

/** Per-day counters of one file; `models`/`sessions` are deferred to the merge
 *  (§5), so they are absent here on purpose. */
export interface ProfileFilePartialDay {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  tools: Record<string, number>;
}

/**
 * One sink file's entire contribution to ProfileStats, in a shape that
 * survives `JSON.parse(JSON.stringify(p))` unchanged — no Map, no Set, no
 * `undefined` values — because the caching layer writes it to disk.
 *
 * `sessions` is an ARRAY, not a Record: its order is each session's first
 * appearance in the file, and that order decides which engine a model gets
 * ("first-seen wins", §2). An object would renumber integer-like session ids
 * ("3" before "20") on a JSON round trip and flip that attribution silently.
 */
export interface ProfileFilePartial {
  /** Whether the file yielded >=1 valid record — `totalSessions` counts FILES
   *  (§3), so this, not the session count, is what merge tallies. */
  hasValidRecord: boolean;
  sessions: ProfileFilePartialSession[];
  days: Record<string, ProfileFilePartialDay>;
  /** model -> dayKey -> tokens for usage records with a `sub.model` override:
   *  tokens only, never a session or an engine (§5/§6). */
  subModelDayTokens: Record<string, Record<string, number>>;
}

export interface AggregateFilePartialOptions {
  /** MUST be the same formatter later handed to `mergeProfilePartials` (§8) —
   *  unenforceable at runtime (a function cannot be fingerprinted), so it is
   *  the caller's contract. */
  dayKey?: (ts: number) => string;
}

export interface NamedProfileFilePartial {
  name: string;
  partial: ProfileFilePartial;
}

/** A session whose per-file segments OVERLAP, so the merge could not compute
 *  its activity exactly (§1). `files` names the participants so the caller can
 *  re-read exactly those — and cache the exact value against them. */
export interface CrossFileSession {
  id: string;
  files: string[];
}

export interface MergeProfilePartialsOptions {
  /** Anchors the current-streak "today/yesterday" grace window. */
  now: number;
  /** Same formatter the partials were built with (§8). */
  dayKey?: (ts: number) => string;
  /** Session id -> exact gap-capped activity, from a second pass over the
   *  files of `crossFileSessions` (§1). Honored for ANY id present, so a
   *  caller may also supply values remembered from an earlier pass. */
  exactSessionActiveMs?: Record<string, number>;
}

export interface MergeProfilePartialsResult {
  /** `truncated` is ALWAYS false here: truncation is a property of a scanning
   *  pass, not of a set of partials — the scanning layer sets it (§7). */
  stats: ProfileStats;
  /** Empty whenever every session's activity is already exact. */
  crossFileSessions: CrossFileSession[];
}

interface PartialSessionAgg {
  id: string;
  model: string | undefined;
  engine: "codex" | "claude" | undefined;
  firstTs: number;
  lastTs: number;
  tokens: number;
  tokensByDay: Map<string, number>;
  timestamps: number[];
}

interface PartialDayAgg {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  tools: Map<string, number>;
}

/**
 * Reduces ONE sink file to its ProfileStats contribution.
 *
 * Deliberately has NO byte cap (§7): a partial is the atom of the cache, and
 * half a file must never be cached as if it were the whole file. The
 * whole-directory byte budget stays with `aggregateProfileStats`, which is why
 * equivalence between the two paths is claimed for full files only.
 */
export function aggregateFilePartial(
  file: ProfileStatsFile,
  opts: AggregateFilePartialOptions = {},
): ProfileFilePartial {
  const dayKey = opts.dayKey ?? defaultDayKey;

  let hasValidRecord = false;
  const sessions = new Map<string, PartialSessionAgg>();
  const days = new Map<string, PartialDayAgg>();
  const subModelDayTokens = new Map<string, Map<string, number>>();

  for (const line of file.lines) {
    const rec = parseValidRecord(line);
    if (rec === undefined) continue;

    hasValidRecord = true;

    const ts = rec.ts;
    const day = dayKey(ts);
    let dayAgg = days.get(day);
    if (dayAgg === undefined) {
      dayAgg = { tokens: 0, runs: 0, toolCalls: 0, subagentRuns: 0, tools: new Map() };
      days.set(day, dayAgg);
    }

    const sessionId = sessionIdFor(rec, file.name);
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = {
        id: sessionId,
        model: undefined,
        engine: undefined,
        firstTs: ts,
        lastTs: ts,
        tokens: 0,
        tokensByDay: new Map(),
        timestamps: [],
      };
      sessions.set(sessionId, session);
    } else {
      if (ts < session.firstTs) session.firstTs = ts;
      if (ts > session.lastTs) session.lastTs = ts;
    }
    session.timestamps.push(ts);

    switch (rec.t) {
      case "usage": {
        const tokens = usageTokens(rec);
        session.tokens += tokens;
        dayAgg.tokens += tokens;
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
        dayAgg.toolCalls += 1;
        if (typeof rec.tool === "string" && rec.tool.length > 0) {
          dayAgg.tools.set(rec.tool, (dayAgg.tools.get(rec.tool) ?? 0) + 1);
        }
        break;
      }
      case "loop_end": {
        if (!hasEnvelopeSub(rec)) dayAgg.runs += 1;
        break;
      }
      case "subagent_start": {
        dayAgg.subagentRuns += 1;
        break;
      }
      case "session_start": {
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

  const partialSessions: ProfileFilePartialSession[] = [];
  for (const session of sessions.values()) {
    partialSessions.push({
      id: session.id,
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.engine !== undefined ? { engine: session.engine } : {}),
      firstTs: session.firstTs,
      lastTs: session.lastTs,
      tokens: session.tokens,
      tokensByDay: Object.fromEntries(session.tokensByDay),
      activeMs: sessionActiveMs([...session.timestamps].sort((a, b) => a - b)),
    });
  }

  const partialDays: Record<string, ProfileFilePartialDay> = Object.fromEntries(
    [...days].map(
      ([day, agg]) =>
        [
          day,
          {
            tokens: agg.tokens,
            runs: agg.runs,
            toolCalls: agg.toolCalls,
            subagentRuns: agg.subagentRuns,
            tools: Object.fromEntries(agg.tools),
          },
        ] as const,
    ),
  );

  // Built through `Object.fromEntries`, never `obj[key] = v`: a model may be
  // called "__proto__" (any non-empty string off a record is legal), and a
  // bare assignment on a plain object would write the prototype instead of an
  // own property, dropping that model's whole token bucket — silently, and
  // only for that one name.
  const partialSubModel: Record<string, Record<string, number>> = Object.fromEntries(
    [...subModelDayTokens].map(([model, byDay]) => [model, Object.fromEntries(byDay)] as const),
  );

  return { hasValidRecord, sessions: partialSessions, days: partialDays, subModelDayTokens: partialSubModel };
}

/**
 * Timestamps of a file's valid records, grouped by session id — the input to
 * the exact cross-file second pass (§1). Uses `parseValidRecord`/`sessionIdFor`,
 * i.e. byte-for-byte the aggregator's own validity filter and session keying;
 * anything else would make the recomputed activity disagree with a full scan.
 *
 * Deliberately NOT part of ProfileFilePartial: timestamp lists would add
 * megabytes to a cache file for a case measured at zero occurrences in the
 * owner's 60 773 real sessions.
 *
 * The returned arrays are in FILE order, not sorted: the caller concatenates
 * every participating file's arrays first and sorts the union once, then calls
 * `sessionActiveMs` on it.
 */
export function collectSessionTimestamps(
  file: ProfileStatsFile,
  opts: { sessionIds?: Iterable<string> } = {},
): Record<string, number[]> {
  const wanted = opts.sessionIds === undefined ? undefined : new Set(opts.sessionIds);
  const out = new Map<string, number[]>();
  for (const line of file.lines) {
    const rec = parseValidRecord(line);
    if (rec === undefined) continue;
    const sessionId = sessionIdFor(rec, file.name);
    if (wanted !== undefined && !wanted.has(sessionId)) continue;
    const acc = out.get(sessionId);
    if (acc === undefined) out.set(sessionId, [rec.ts]);
    else acc.push(rec.ts);
  }
  return Object.fromEntries(out);
}

interface MergedSessionSegment {
  firstTs: number;
  lastTs: number;
  activeMs: number;
}

interface MergedSession {
  id: string;
  model: string | undefined;
  engine: "codex" | "claude" | undefined;
  firstTs: number;
  tokens: number;
  tokensByDay: Map<string, number>;
  segments: MergedSessionSegment[];
  files: string[];
}

/**
 * First-pass activity of a session assembled from several files (§1):
 *
 *   Σ activeMs_i + Σ min(max(firstTs_{i+1} - lastTs_i, 0), CAP)
 *
 * over segments sorted by `firstTs`. When the segments do not overlap this is
 * EXACTLY the whole-scan answer — the union sort is then just the segments
 * concatenated, so every within-file adjacency is unchanged and the only new
 * adjacencies are the joins, capped by the same cap. When they do overlap the
 * interleaving changes which gaps hit the cap, the formula is wrong (10/10 for
 * [0,10] and [5,15] bridges to 20 where the true answer is 15), and the
 * session is reported for the exact second pass instead.
 */
function segmentsActiveMs(segments: MergedSessionSegment[]): { activeMs: number; overlapping: boolean } {
  if (segments.length <= 1) return { activeMs: segments[0]?.activeMs ?? 0, overlapping: false };
  const ordered = [...segments].sort((a, b) => a.firstTs - b.firstTs);
  let activeMs = 0;
  let overlapping = false;
  let prevLast: number | undefined;
  for (const segment of ordered) {
    if (prevLast !== undefined) {
      if (segment.firstTs < prevLast) overlapping = true;
      activeMs += Math.min(Math.max(segment.firstTs - prevLast, 0), PROFILE_ACTIVITY_GAP_CAP_MS);
    }
    activeMs += segment.activeMs;
    prevLast = prevLast === undefined || segment.lastTs > prevLast ? segment.lastTs : prevLast;
  }
  return { activeMs, overlapping };
}

/** Own-property lookup with a finite-number gate: session ids come from disk,
 *  and a plain-object read of `"constructor"` would hand back a function. */
function exactActiveMsFor(table: Record<string, number> | undefined, id: string): number | undefined {
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, id)) return undefined;
  const value = table[id];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Combines per-file partials into the same ProfileStats a single whole-
 * directory scan would produce (proven by the equivalence harness in
 * stats.test.ts over every fixture of the legacy suite).
 *
 * Partials are sorted by file name, exactly as the legacy scan sorts files, so
 * "first-seen wins" for a model's engine resolves identically.
 */
export function mergeProfilePartials(
  named: Iterable<NamedProfileFilePartial>,
  opts: MergeProfilePartialsOptions,
): MergeProfilePartialsResult {
  const dayKey = opts.dayKey ?? defaultDayKey;

  const sorted = [...named].sort((a, b) => compareFileNames(a.name, b.name));

  let lifetimeTokens = 0;
  let totalRuns = 0;
  let toolCalls = 0;
  let subagentRuns = 0;

  const filesWithValidRecord = new Set<string>();
  const activeDays = new Set<string>();
  const dayAggs = new Map<string, DayAggInternal>();
  const sessions = new Map<string, MergedSession>();
  const subModelDayTokens = new Map<string, Map<string, number>>();

  for (const { name, partial } of sorted) {
    if (partial.hasValidRecord) filesWithValidRecord.add(name);

    // Global counters are the sum of the per-day counters: the legacy scan
    // increments each global and its day's counterpart in lock-step (§6).
    for (const [day, counts] of Object.entries(partial.days)) {
      activeDays.add(day);
      const agg = ensureDayAgg(dayAggs, day);
      agg.tokens += counts.tokens;
      agg.runs += counts.runs;
      agg.toolCalls += counts.toolCalls;
      agg.subagentRuns += counts.subagentRuns;
      for (const [tool, calls] of Object.entries(counts.tools)) {
        agg.tools.set(tool, (agg.tools.get(tool) ?? 0) + calls);
      }
      lifetimeTokens += counts.tokens;
      totalRuns += counts.runs;
      toolCalls += counts.toolCalls;
      subagentRuns += counts.subagentRuns;
    }

    for (const session of partial.sessions) {
      let merged = sessions.get(session.id);
      if (merged === undefined) {
        merged = {
          id: session.id,
          model: session.model,
          engine: session.engine,
          firstTs: session.firstTs,
          tokens: 0,
          tokensByDay: new Map(),
          segments: [],
          files: [],
        };
        sessions.set(session.id, merged);
      } else {
        // Per FIELD, last defined value in traversal order wins (§2): a later
        // session_start without a model never clears an earlier model.
        if (session.model !== undefined) merged.model = session.model;
        if (session.engine !== undefined) merged.engine = session.engine;
        if (session.firstTs < merged.firstTs) merged.firstTs = session.firstTs;
      }
      merged.tokens += session.tokens;
      for (const [day, tokens] of Object.entries(session.tokensByDay)) {
        merged.tokensByDay.set(day, (merged.tokensByDay.get(day) ?? 0) + tokens);
      }
      merged.segments.push({ firstTs: session.firstTs, lastTs: session.lastTs, activeMs: session.activeMs });
      merged.files.push(name);
    }

    for (const [model, byDay] of Object.entries(partial.subModelDayTokens)) {
      let acc = subModelDayTokens.get(model);
      if (acc === undefined) {
        acc = new Map();
        subModelDayTokens.set(model, acc);
      }
      for (const [day, tokens] of Object.entries(byDay)) {
        acc.set(day, (acc.get(day) ?? 0) + tokens);
      }
    }
  }

  let peakDay: { day: string; tokens: number } | null = null;
  for (const [day, agg] of dayAggs) {
    if (peakDay === null || agg.tokens > peakDay.tokens || (agg.tokens === peakDay.tokens && day < peakDay.day)) {
      peakDay = { day, tokens: agg.tokens };
    }
  }

  let longestSessionMs = 0;
  const crossFileSessions: CrossFileSession[] = [];
  for (const session of sessions.values()) {
    const bridged = segmentsActiveMs(session.segments);
    if (bridged.overlapping) crossFileSessions.push({ id: session.id, files: [...session.files] });
    const active = exactActiveMsFor(opts.exactSessionActiveMs, session.id) ?? bridged.activeMs;
    if (active > longestSessionMs) longestSessionMs = active;
  }

  // Deferred joins, mirroring the post-scan fold of aggregateProfileStats:
  // full model list + per-day model breakdown + engineTokens + days[].sessions.
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
    if (!agg.engineSet) {
      agg.engine = session.engine;
      agg.engineSet = true;
    }

    for (const [day, tokens] of session.tokensByDay) {
      agg.tokens += tokens;
      const dayAgg = ensureDayAgg(dayAggs, day);
      dayAgg.models.set(model, (dayAgg.models.get(model) ?? 0) + tokens);
    }

    const engineKey = session.engine ?? "core";
    engineTokensMap.set(engineKey, (engineTokensMap.get(engineKey) ?? 0) + session.tokens);

    ensureDayAgg(dayAggs, dayKey(session.firstTs)).sessions += 1;
  }

  for (const [model, byDay] of subModelDayTokens) {
    const agg = ensureModelAgg(model);
    for (const [day, tokens] of byDay) {
      agg.tokens += tokens;
      const dayAgg = ensureDayAgg(dayAggs, day);
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

  const days: Record<string, ProfileDayStats> = Object.fromEntries(
    [...dayAggs].map(
      ([day, agg]) =>
        [
          day,
          {
            tokens: agg.tokens,
            runs: agg.runs,
            toolCalls: agg.toolCalls,
            subagentRuns: agg.subagentRuns,
            sessions: agg.sessions,
            tools: Object.fromEntries(agg.tools),
            models: Object.fromEntries(agg.models),
          },
        ] as const,
    ),
  );

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
    stats: {
      lifetimeTokens,
      peakDay,
      longestSessionMs,
      currentStreakDays,
      longestStreakDays,
      totalSessions: filesWithValidRecord.size,
      totalRuns,
      toolCalls,
      subagentRuns,
      truncated: false,
      days,
      models,
      engineTokens,
    },
    crossFileSessions,
  };
}

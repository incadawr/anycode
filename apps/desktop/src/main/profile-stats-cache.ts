/**
 * TASK.187 S3 — the incremental Profile-stats cache (plan
 * `working-docs/build/task187-plan.md`, decisions D-1/D-2/D-5/D-6; aggregator
 * semantics: `working-docs/build/task187-aggregator-semantics.md`).
 *
 * WHY THIS EXISTS: the pre-S3 scan opened EVERY sink file on every request —
 * 58 763 opens / ~16 s on the owner's directory, 90 % of it spent in `open`
 * alone. The fix is a per-file cache: a file whose fingerprint has not moved
 * is never opened again, and its contribution is replayed from a stored
 * `ProfileFilePartial` (core's `aggregateFilePartial`), merged by core's
 * `mergeProfilePartials`.
 *
 * THREE PROPERTIES THIS MODULE IS RESPONSIBLE FOR (core cannot enforce them):
 *
 *  1. `crossFileSessions` returned by the merge MUST be acted on. A session
 *     whose per-file segments overlap has an activity number the first merge
 *     pass cannot compute (the bridge formula and the union-sort answer
 *     differ, in either direction and by an unbounded amount). Ignoring the
 *     list would make `longestSessionMs` silently wrong. See the exact-pass
 *     section below.
 *  2. A cache read off disk is UNTRUSTED input — `mergeProfilePartials`
 *     trusts the shape of a partial completely. Every field is re-validated
 *     here; anything unexpected discards the whole file and rebuilds.
 *  3. `dayKey` must be the same formatter that built the partials. Both sides
 *     use core's production default (local `YYYY-MM-DD`), and a `timeZone`
 *     stamp in the header plus the `algo` version are what catch the cases a
 *     function identity cannot be checked for.
 *
 * THE EXACT PASS IS CUMULATIVE (third-review blocker). Its unit of work is
 * "one participant file", not "one whole session": each pass folds as many
 * participants as its budget allows into the session's ACTIVITY CLUSTERS and
 * persists them, so a session with more participant files than a single pass
 * can open still converges, one pass at a time. An all-or-nothing exact pass
 * would restart such a session on every Refresh and never finish it.
 *
 * Clusters (core's `mergeActivityClusters`/`clustersActiveMs`) are the
 * cross-pass state rather than raw timestamps because the fold is associative
 * and commutative — participants may arrive in any order over any number of
 * passes — and because their size is O(pauses longer than the cap) instead of
 * O(records), which keeps a pathological session from bloating this file.
 * The fold is irreversible, so a participant that CHANGES after being folded
 * in resets that session's clusters and the work restarts.
 *
 * Until every participant is folded in, a session's activity is PROVISIONAL
 * (the merge's bridge formula) and the pass reports it in
 * `pendingExactSessions`. The provisional figure can sit on either side of
 * the truth — the bridge formula neither bounds nor signs its error — so it
 * must never be presented as final.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  aggregateFilePartial,
  clustersActiveMs,
  collectSessionTimestamps,
  mergeActivityClusters,
  mergeProfilePartials,
  PROFILE_STATS_CACHE_MAX_BYTES,
  PROFILE_STATS_MAX_NEW_READS_PER_PASS,
  PROFILE_STATS_MAX_SCAN_BYTES,
  type ActivityCluster,
  type ProfileFilePartial,
  type ProfileFilePartialDay,
  type ProfileFilePartialSession,
  type ProfileStats,
} from "@anycode/core/telemetry-admin";
import type { ProfileFileStat, ProfileFs } from "./profile-ipc.js";

/** Cache-file format version — bump when the ON-DISK ENCODING below changes. */
export const PROFILE_STATS_CACHE_SCHEMA = 2;
/** Aggregation-rules version — bump when the MATH changes while the encoding
 *  stays put (a stale cache would otherwise be a silent lie). */
export const PROFILE_STATS_CACHE_ALGO = 1;
/** Cache file name, next to `config.json` under `<home>/.anycode`. */
export const PROFILE_STATS_CACHE_FILE_NAME = "profile-stats-cache.json";
/** Orphaned tmp files (a crash between the tmp write and the rename) older
 *  than this are swept when a store first touches its directory. */
const TMP_SWEEP_AGE_MS = 60 * 60 * 1000;
/** D-6: one re-open per suspicion of a mid-read rewrite, at most twice. */
const COHERENT_READ_RETRY_LIMIT = 2;

// ── fs surface ─────────────────────────────────────────────────────────────

/** One coherent-read attempt: the content plus BOTH by-handle stats (D-6). */
export interface ProfileHandleStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface ProfileFileSnapshot {
  content: string;
  /** Bytes actually read — a short read is itself evidence of a shrink. */
  bytesRead: number;
  /** `fstat` on the open handle BEFORE the read. */
  before: ProfileHandleStat;
  /** `fstat` on the SAME handle after it. */
  after: ProfileHandleStat;
}

/**
 * The cache store needs `rename` (atomic publish) and `rm` (tmp sweep) on top
 * of the plain scan port; both are required members of `ProfileFs`, so this
 * alias only documents the dependency.
 */
export type ProfileCacheFs = ProfileFs;

// ── budgets (D-2) ──────────────────────────────────────────────────────────

export interface ProfileScanBudgets {
  /** New file opens allowed in ONE pass; cache hits are free and uncounted.
   *  This is the primary throttle — opens, not bytes, are the bottleneck. */
  maxNewReadsPerPass: number;
  /** New bytes read in ONE pass; secondary guard against a directory of a few
   *  gigantic files. Exact-pass reads count here too. */
  maxScanBytes: number;
  /** Per-file ceiling: a file bigger than this is NEVER aggregated, never
   *  opened, and permanently ends the reachable history behind it. */
  maxFileBytes: number;
}

export function resolveScanBudgets(overrides?: Partial<ProfileScanBudgets>): ProfileScanBudgets {
  return {
    maxNewReadsPerPass: overrides?.maxNewReadsPerPass ?? PROFILE_STATS_MAX_NEW_READS_PER_PASS,
    maxScanBytes: overrides?.maxScanBytes ?? PROFILE_STATS_MAX_SCAN_BYTES,
    maxFileBytes: overrides?.maxFileBytes ?? PROFILE_STATS_MAX_SCAN_BYTES,
  };
}

// ── in-memory cache state ──────────────────────────────────────────────────

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
  ctimeMs: number;
}

interface CachedFileEntry extends FileFingerprint {
  /** `ts` of the file's FIRST parseable record — the honest lower bound of
   *  what the oldest included file covers (TASK.169). `null` when its first
   *  line carries no usable `ts`; the caller then falls back to `mtimeMs`. */
  firstLineTs: number | null;
  partial: ProfileFilePartial;
  /**
   * Whether the last completed pass put this file inside the active
   * contiguous prefix. Membership is STAMPED here rather than re-derived by
   * `getStatsCached` from a saved boundary key: the scan orders files by the
   * `lstat` it took at the start of the pass while a cache entry carries the
   * fingerprint of the version actually read, and on a live sink those two
   * disagree for any file appended to in between. Any rule that compares one
   * against the other can silently drop files the pass did include — so the
   * membership question is answered once, by the pass that knows, and simply
   * recorded.
   */
  active: boolean;
}

/** One participant file of a cross-file session's exact activity. */
interface ExactParticipant extends FileFingerprint {
  name: string;
  /** Whether this file's timestamps are already folded into `clusters`. The
   *  fingerprint is the version they were folded FROM (meaningless until
   *  then). */
  read: boolean;
}

/** Cumulative exact-pass state for ONE session (see the module doc). */
interface ExactSessionEntry {
  participants: ExactParticipant[];
  /** Canonical activity clusters over every participant folded in so far. */
  clusters: ActivityCluster[];
  /** The final answer — non-null ONLY when every participant is `read`. */
  activeMs: number | null;
}

interface CacheState {
  dir: string;
  timeZone: string;
  revision: string;
  truncated: boolean;
  coverageStartTs: number | null;
  backlogRemaining: number;
  files: Map<string, CachedFileEntry>;
  exact: Map<string, ExactSessionEntry>;
}

// ── on-disk encoding (D-1: compact keys — the owner's cache is ~60k entries) ──

interface EncodedDay {
  t?: number;
  r?: number;
  c?: number;
  g?: number;
  l?: Record<string, number>;
}

interface EncodedSession {
  i: string;
  m?: string;
  e?: string;
  f: number;
  l: number;
  k?: number;
  d?: Record<string, number>;
  a?: number;
}

interface EncodedPartial {
  v?: 1;
  s?: EncodedSession[];
  d?: Record<string, EncodedDay>;
  u?: Record<string, Record<string, number>>;
}

/** Header fields only — the bulk maps are validated by hand below, because
 *  running a zod schema over ~60 000 nested entries costs more than the whole
 *  warm pass it is guarding. */
const cacheHeaderSchema = z.object({
  schema: z.number(),
  algo: z.number(),
  dir: z.string(),
  tz: z.string(),
  rev: z.string(),
  trunc: z.boolean(),
  cov: z.union([z.number(), z.null()]),
  backlog: z.number().int().nonnegative(),
  files: z.record(z.string(), z.unknown()),
  exact: z.record(z.string(), z.unknown()),
});

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A quantity that cannot be negative in this domain: token sums may be
 *  fractional (the aggregator clamps but does not round), counts may not. */
function nonNegativeNumber(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = nonNegativeNumber(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Decodes a `key -> number` map with a range gate.
 *
 * Built through `Object.fromEntries` rather than `out[key] = n`: tool, model
 * and day keys all come from the file being aggregated, and a bare assignment
 * on a plain object silently writes the prototype for the key "__proto__" —
 * the entry would vanish on the first cache round trip and never come back,
 * because the file's fingerprint still matches and nothing re-reads it.
 */
function numberMap(value: unknown, integral: boolean): Record<string, number> | undefined {
  const obj = plainObject(value);
  if (obj === undefined) return undefined;
  const entries: Array<readonly [string, number]> = [];
  for (const [key, raw] of Object.entries(obj)) {
    const n = integral ? nonNegativeInteger(raw) : nonNegativeNumber(raw);
    if (n === undefined) return undefined;
    entries.push([key, n] as const);
  }
  return Object.fromEntries(entries);
}

function encodeDay(day: ProfileFilePartialDay): EncodedDay {
  const out: EncodedDay = {};
  if (day.tokens !== 0) out.t = day.tokens;
  if (day.runs !== 0) out.r = day.runs;
  if (day.toolCalls !== 0) out.c = day.toolCalls;
  if (day.subagentRuns !== 0) out.g = day.subagentRuns;
  if (Object.keys(day.tools).length > 0) out.l = day.tools;
  return out;
}

function decodeDay(value: unknown): ProfileFilePartialDay | undefined {
  const obj = plainObject(value);
  if (obj === undefined) return undefined;
  // Counts are whole and non-negative by construction; tokens are
  // non-negative but may be fractional (clampTokenValue rejects negatives and
  // non-finite values, nothing else). A cache file that got past JSON parsing
  // with an impossible number here would pin wrong statistics permanently,
  // because every file fingerprint still matches and no pass recomputes it.
  const tokens = obj.t === undefined ? 0 : nonNegativeNumber(obj.t);
  const runs = obj.r === undefined ? 0 : nonNegativeInteger(obj.r);
  const toolCalls = obj.c === undefined ? 0 : nonNegativeInteger(obj.c);
  const subagentRuns = obj.g === undefined ? 0 : nonNegativeInteger(obj.g);
  const tools = obj.l === undefined ? {} : numberMap(obj.l, true);
  if (tokens === undefined || runs === undefined || toolCalls === undefined) return undefined;
  if (subagentRuns === undefined || tools === undefined) return undefined;
  return { tokens, runs, toolCalls, subagentRuns, tools };
}

function encodeSession(session: ProfileFilePartialSession): EncodedSession {
  const out: EncodedSession = { i: session.id, f: session.firstTs, l: session.lastTs };
  if (session.model !== undefined) out.m = session.model;
  if (session.engine !== undefined) out.e = session.engine;
  if (session.tokens !== 0) out.k = session.tokens;
  if (Object.keys(session.tokensByDay).length > 0) out.d = session.tokensByDay;
  if (session.activeMs !== 0) out.a = session.activeMs;
  return out;
}

function decodeSession(value: unknown): ProfileFilePartialSession | undefined {
  const obj = plainObject(value);
  if (obj === undefined) return undefined;
  const id = typeof obj.i === "string" ? obj.i : undefined;
  const firstTs = finiteNumber(obj.f);
  const lastTs = finiteNumber(obj.l);
  const tokens = obj.k === undefined ? 0 : nonNegativeNumber(obj.k);
  const activeMs = obj.a === undefined ? 0 : nonNegativeNumber(obj.a);
  const tokensByDay = obj.d === undefined ? {} : numberMap(obj.d, false);
  if (id === undefined || firstTs === undefined || lastTs === undefined) return undefined;
  if (tokens === undefined || activeMs === undefined || tokensByDay === undefined) return undefined;
  if (firstTs > lastTs) return undefined;
  // Within ONE file the gap-capped activity is a sum of capped consecutive
  // gaps, so it can never exceed the session's own span there (bridges
  // between files are added at merge time, not stored). The 1 ms slack only
  // absorbs float summation on fractional timestamps — a poisoned value is
  // wrong by orders of magnitude, not by an ulp.
  if (activeMs > lastTs - firstTs + 1) return undefined;
  if (obj.m !== undefined && typeof obj.m !== "string") return undefined;
  if (obj.e !== undefined && obj.e !== "codex" && obj.e !== "claude") return undefined;
  return {
    id,
    ...(typeof obj.m === "string" ? { model: obj.m } : {}),
    ...(obj.e === "codex" || obj.e === "claude" ? { engine: obj.e } : {}),
    firstTs,
    lastTs,
    tokens,
    tokensByDay,
    activeMs,
  };
}

function encodePartial(partial: ProfileFilePartial): EncodedPartial {
  const out: EncodedPartial = {};
  if (partial.hasValidRecord) out.v = 1;
  if (partial.sessions.length > 0) out.s = partial.sessions.map(encodeSession);
  const days = Object.entries(partial.days);
  if (days.length > 0) {
    const encoded: Record<string, EncodedDay> = {};
    for (const [day, counts] of days) encoded[day] = encodeDay(counts);
    out.d = encoded;
  }
  if (Object.keys(partial.subModelDayTokens).length > 0) out.u = partial.subModelDayTokens;
  return out;
}

function decodePartial(value: unknown): ProfileFilePartial | undefined {
  const obj = plainObject(value);
  if (obj === undefined) return undefined;
  if (obj.v !== undefined && obj.v !== 1) return undefined;

  const sessions: ProfileFilePartialSession[] = [];
  if (obj.s !== undefined) {
    if (!Array.isArray(obj.s)) return undefined;
    for (const raw of obj.s) {
      const session = decodeSession(raw);
      if (session === undefined) return undefined;
      sessions.push(session);
    }
  }

  const dayEntries: Array<readonly [string, ProfileFilePartialDay]> = [];
  if (obj.d !== undefined) {
    const rawDays = plainObject(obj.d);
    if (rawDays === undefined) return undefined;
    for (const [day, raw] of Object.entries(rawDays)) {
      const decoded = decodeDay(raw);
      if (decoded === undefined) return undefined;
      dayEntries.push([day, decoded] as const);
    }
  }
  const days: Record<string, ProfileFilePartialDay> = Object.fromEntries(dayEntries);

  const modelEntries: Array<readonly [string, Record<string, number>]> = [];
  if (obj.u !== undefined) {
    const rawModels = plainObject(obj.u);
    if (rawModels === undefined) return undefined;
    for (const [model, raw] of Object.entries(rawModels)) {
      const byDay = numberMap(raw, false);
      if (byDay === undefined) return undefined;
      modelEntries.push([model, byDay] as const);
    }
  }
  const subModelDayTokens: Record<string, Record<string, number>> = Object.fromEntries(modelEntries);

  const hasValidRecord = obj.v === 1;
  // `totalSessions` counts files that yielded a record; a partial carrying
  // sessions or days while claiming it yielded none is self-contradictory.
  if (!hasValidRecord && (sessions.length > 0 || dayEntries.length > 0)) return undefined;

  return { hasValidRecord, sessions, days, subModelDayTokens };
}

function decodeFileEntry(value: unknown): CachedFileEntry | undefined {
  const obj = plainObject(value);
  if (obj === undefined) return undefined;
  const size = nonNegativeNumber(obj.s);
  const mtimeMs = nonNegativeNumber(obj.m);
  const ino = nonNegativeNumber(obj.i);
  const ctimeMs = nonNegativeNumber(obj.c);
  if (size === undefined || mtimeMs === undefined || ino === undefined || ctimeMs === undefined) return undefined;
  const firstLineTs = obj.t === null || obj.t === undefined ? null : finiteNumber(obj.t);
  if (firstLineTs === undefined) return undefined;
  const partial = decodePartial(obj.p);
  if (partial === undefined) return undefined;
  return { size, mtimeMs, ino, ctimeMs, firstLineTs, partial, active: obj.x === 1 };
}

function decodeExactEntry(value: unknown): ExactSessionEntry | undefined {
  const obj = plainObject(value);
  if (obj === undefined || !Array.isArray(obj.p) || !Array.isArray(obj.k)) return undefined;
  const participants: ExactParticipant[] = [];
  for (const raw of obj.p) {
    const item = plainObject(raw);
    if (item === undefined) return undefined;
    const name = typeof item.n === "string" ? item.n : undefined;
    const size = nonNegativeNumber(item.s);
    const mtimeMs = nonNegativeNumber(item.m);
    const ino = nonNegativeNumber(item.i);
    const ctimeMs = nonNegativeNumber(item.c);
    if (name === undefined || size === undefined || mtimeMs === undefined) return undefined;
    if (ino === undefined || ctimeMs === undefined) return undefined;
    participants.push({ name, size, mtimeMs, ino, ctimeMs, read: item.r === 1 });
  }
  const clusters: ActivityCluster[] = [];
  for (const raw of obj.k) {
    if (!Array.isArray(raw) || raw.length !== 2) return undefined;
    const start = finiteNumber(raw[0]);
    const end = finiteNumber(raw[1]);
    if (start === undefined || end === undefined || start > end) return undefined;
    clusters.push([start, end]);
  }
  const activeMs = obj.a === null || obj.a === undefined ? null : nonNegativeNumber(obj.a);
  if (activeMs === undefined) return undefined;
  return { participants, clusters, activeMs };
}

function serializeState(state: CacheState): string {
  const fileEntries: Array<readonly [string, unknown]> = [];
  for (const [name, entry] of state.files) {
    fileEntries.push([
      name,
      {
      s: entry.size,
      m: entry.mtimeMs,
      i: entry.ino,
      c: entry.ctimeMs,
      t: entry.firstLineTs,
        p: encodePartial(entry.partial),
        ...(entry.active ? { x: 1 } : {}),
      },
    ] as const);
  }
  // `Object.fromEntries`, never `map[key] = v`: a session id is an arbitrary
  // string out of a telemetry record, "__proto__" included.
  const files = Object.fromEntries(fileEntries);
  const exact = Object.fromEntries(
    [...state.exact].map(
      ([id, entry]) =>
        [
          id,
          {
            p: entry.participants.map((participant) => ({
              n: participant.name,
              s: participant.size,
              m: participant.mtimeMs,
              i: participant.ino,
              c: participant.ctimeMs,
              ...(participant.read ? { r: 1 } : {}),
            })),
            k: entry.clusters,
            a: entry.activeMs,
          },
        ] as const,
    ),
  );
  return JSON.stringify({
    schema: PROFILE_STATS_CACHE_SCHEMA,
    algo: PROFILE_STATS_CACHE_ALGO,
    dir: state.dir,
    tz: state.timeZone,
    rev: state.revision,
    gen: Date.now(),
    trunc: state.truncated,
    cov: state.coverageStartTs,
    backlog: state.backlogRemaining,
    files,
    exact,
  });
}

function deserializeState(raw: string): CacheState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const header = cacheHeaderSchema.safeParse(parsed);
  if (!header.success) return null;
  const data = header.data;
  if (data.schema !== PROFILE_STATS_CACHE_SCHEMA || data.algo !== PROFILE_STATS_CACHE_ALGO) return null;

  const files = new Map<string, CachedFileEntry>();
  for (const [name, value] of Object.entries(data.files)) {
    const entry = decodeFileEntry(value);
    if (entry === undefined) return null;
    files.set(name, entry);
  }
  const exact = new Map<string, ExactSessionEntry>();
  for (const [id, value] of Object.entries(data.exact)) {
    const entry = decodeExactEntry(value);
    if (entry === undefined) return null;
    exact.set(id, entry);
  }
  return {
    dir: data.dir,
    timeZone: data.tz,
    revision: data.rev,
    truncated: data.trunc,
    coverageStartTs: data.cov,
    backlogRemaining: data.backlog,
    files,
    exact,
  };
}

// ── scan-order helpers (unchanged rules, lifted out of the old listJsonlFiles) ──

interface StatedJsonlFile {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  ino: number;
  ctimeMs: number;
  /**
   * The entry is listed in the directory but its `lstat` failed with
   * something other than ENOENT — it EXISTS and we simply cannot judge it
   * this pass. Such a file is never read and never counted as available: its
   * cached partial is preserved untouched, and coverage is cut at its
   * position so the shortfall is visible instead of silent.
   */
  statUnavailable?: boolean;
}

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

/**
 * `ts` of a sink file's earliest event, read off its first JSONL line only
 * (TASK.169): telemetry JSONL is append-ordered, so line 1 is always the
 * oldest record. Fail-soft `null` on anything that is not a JSON object with
 * a finite `ts`.
 */
function earliestEventTs(firstLine: string | undefined): number | null {
  if (firstLine === undefined || firstLine.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  const obj = plainObject(parsed);
  if (obj === undefined) return null;
  return finiteNumber(obj.ts) ?? null;
}

/** Newest-mtime-first, name-ascending on an exact tie (determinism, never a
 *  readdir-order artifact) — the order every budget and the prefix rule below
 *  are defined against. */
function compareNewestFirst(a: StatedJsonlFile, b: StatedJsonlFile): number {
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.ctimeMs === b.ctimeMs;
}

type CoherentRead =
  | { ok: true; lines: string[]; firstLineTs: number | null; fingerprint: FileFingerprint }
  /** `gone` distinguishes "this file no longer exists" from "this file could
   *  not be read right now", which the scan must handle differently. */
  | { ok: false; gone: boolean };

/**
 * D-6 coherent read: `fstat` the OPEN HANDLE before and after reading exactly
 * the pre-read size, then judge.
 *
 * - inode changed, or the file shrank (by stat or by a short read), or the
 *   size held still while `ctime` moved (a completed same-size rewrite):
 *   the bytes may straddle two versions — re-open and try again, at most
 *   twice, then give up on the file for this pass;
 * - the file GREW with the same inode: a legitimate append landed behind us.
 *   The bytes we read are exactly the pre-read version, so they are cached
 *   under the PRE-READ fingerprint and the growth is picked up next pass.
 */
async function readCoherent(
  fs: ProfileCacheFs,
  path: string,
): Promise<CoherentRead> {
  for (let attempt = 0; attempt <= COHERENT_READ_RETRY_LIMIT; attempt += 1) {
    let snapshot: ProfileFileSnapshot;
    try {
      snapshot = await fs.readFileSnapshot(path);
    } catch (error) {
      // ENOENT is reported separately from ELOOP/EPERM: a file that no longer
      // exists is not a gap in coverage waiting to be filled, it is one file
      // fewer. Treating it as a hole would blank every OLDER file out of the
      // view for a pass, over data that is simply gone.
      const gone = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
      return { ok: false, gone };
    }
    const { before, after } = snapshot;
    const shrank = after.size < before.size || snapshot.bytesRead < before.size;
    const swapped = after.ino !== before.ino;
    const rewritten = after.size === before.size && after.ctimeMs !== before.ctimeMs;
    if (!shrank && !swapped && !rewritten) {
      const lines = snapshot.content.split("\n");
      return {
        ok: true,
        lines,
        firstLineTs: earliestEventTs(lines[0]),
        fingerprint: { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino, ctimeMs: before.ctimeMs },
      };
    }
  }
  return { ok: false, gone: false };
}

// ── pass results ───────────────────────────────────────────────────────────

export interface ProfileCacheStatsOutcome {
  ok: true;
  stats: ProfileStats;
  /** Some file the directory holds is not represented in `stats`. */
  truncated: boolean;
  /** Earliest event of the oldest INCLUDED file, when truncated. */
  coverageStartTs: number | null;
  /** REACHABLE files still waiting to be opened (never counts the permanent
   *  cut behind an oversized file — "Refresh continues" must not be a lie). */
  backlogRemaining: number;
  /** Cross-file sessions whose exact activity has not finished folding yet:
   *  their contribution to `longestSessionMs` is provisional. */
  pendingExactSessions: number;
}

export type ProfileCacheScanResult = ProfileCacheStatsOutcome | { ok: false };

export type ProfileCacheReadResult = ProfileCacheStatsOutcome | { ok: false; reason: "no_cache" };

// ── the store ──────────────────────────────────────────────────────────────

/**
 * Disk + process-memory cache for one cache-file path.
 *
 * Every entry point re-checks the cache FILE itself (D-6 "reset without a
 * button"): a deleted file wipes the in-memory copy, so `rm
 * ~/.anycode/profile-stats-cache.json` is a real reset and not a gesture a
 * live store quietly ignores; a file replaced by another process is re-read
 * and continued from, because any INTACT version is correct with respect to
 * its own fingerprints.
 */
export class ProfileStatsCacheStore {
  private state: CacheState | null = null;
  /** Fingerprint of the cache file version currently held in `state`. */
  private diskFingerprint: { size: number; mtimeMs: number; ino: number } | null = null;
  private readonly inflight = new Map<string, Promise<ProfileCacheScanResult>>();
  private tmpSwept = false;
  /** Bumped by every reset. A pass carries the epoch it started in and
   *  refuses to publish under a newer one, so a pass that was already running
   *  when the cache was discarded cannot resurrect pre-reset state. */
  private epoch = 0;

  constructor(
    private readonly fs: ProfileCacheFs,
    readonly path: string,
    private readonly timeZone: string,
  ) {}

  /**
   * Reconciles memory with the cache file. Missing file -> memory dropped;
   * a different file than the one we hold -> re-read from disk (and full
   * rebuild if that copy is unusable).
   */
  private async sync(): Promise<void> {
    await this.sweepOrphanTmpFiles();
    let stat: ProfileFileStat | undefined;
    try {
      stat = await this.fs.lstat(this.path);
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isFile || stat.isSymbolicLink === true) {
      this.state = null;
      this.diskFingerprint = null;
      return;
    }
    const fingerprint = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    if (
      this.state !== null &&
      this.diskFingerprint !== null &&
      this.diskFingerprint.size === fingerprint.size &&
      this.diskFingerprint.mtimeMs === fingerprint.mtimeMs &&
      this.diskFingerprint.ino === fingerprint.ino
    ) {
      return;
    }
    this.state = await this.readFromDisk(stat.size);
    this.diskFingerprint = this.state === null ? null : fingerprint;
  }

  private async readFromDisk(size: number): Promise<CacheState | null> {
    if (size > PROFILE_STATS_CACHE_MAX_BYTES) {
      console.warn(`[profile-stats-cache] ignoring oversized cache file (${size} bytes) at ${this.path}`);
      return null;
    }
    let raw: string;
    try {
      raw = await this.fs.readFileNoFollow(this.path);
    } catch (error) {
      console.warn("[profile-stats-cache] cache read failed", error);
      return null;
    }
    const state = deserializeState(raw);
    if (state === null) {
      console.warn(`[profile-stats-cache] discarding unusable cache at ${this.path}`);
      return null;
    }
    if (state.timeZone !== this.timeZone) return null;
    return state;
  }

  /** Sweeps `<cache>.<pid>.<rand>.tmp` leftovers of a crash between write and
   *  rename. Once per store; fresh tmp files (a concurrent writer) are left. */
  private async sweepOrphanTmpFiles(): Promise<void> {
    if (this.tmpSwept) return;
    this.tmpSwept = true;
    const slash = this.path.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = this.path.slice(0, slash);
    const prefix = `${this.path.slice(slash + 1)}.`;
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TMP_SWEEP_AGE_MS;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const full = `${dir}/${name}`;
      try {
        const stat = await this.fs.lstat(full);
        if (stat.mtimeMs >= cutoff) continue;
        await this.fs.rm(full);
      } catch {
        // Best-effort housekeeping; never fails a pass.
      }
    }
  }

  /** tmp + rename, always — a half-written cache file must never be visible. */
  private async persist(state: CacheState): Promise<void> {
    state.revision = randomUUID();
    const tmp = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await this.fs.writeFile(tmp, serializeState(state), { mode: 0o600 });
      await this.fs.rename(tmp, this.path);
    } catch (error) {
      console.warn("[profile-stats-cache] cache write failed", error);
      try {
        await this.fs.rm(tmp);
      } catch {
        // The sweep above collects it later.
      }
      // Memory keeps the newer state, but it is no longer what the file holds:
      // forget the disk fingerprint so the next pass re-reads and re-syncs.
      this.diskFingerprint = null;
      return;
    }
    try {
      const stat = await this.fs.lstat(this.path);
      this.diskFingerprint = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    } catch {
      this.diskFingerprint = null;
    }
    this.state = state;
  }

  /**
   * Discards the cache — the file AND the in-memory copy — so the next pass
   * starts from empty. The pass itself is an ordinary budget-cut one: a
   * rebuild must not become a whole-directory stall.
   */
  async reset(): Promise<void> {
    this.epoch += 1;
    // In-flight passes are disowned rather than awaited: the next `scan` must
    // start a NEW pass from the empty state, not be handed the promise of one
    // that is still working from the cache the caller just discarded.
    this.inflight.clear();
    this.state = null;
    this.diskFingerprint = null;
    // Deliberately NOT swallowed: if the file survives, the very next `sync`
    // adopts it again and the "rebuild" never happened. The caller turns this
    // into a refusal so the channel never reports a reset it did not perform.
    // (`rm` is force-style — a missing file is already the desired state.)
    await this.fs.rm(this.path);
  }

  /**
   * One incremental pass. Concurrent callers on the SAME directory share the
   * in-flight pass (a single readdir, one result) — a queue would still scan
   * twice.
   */
  async scan(dir: string, budgets: ProfileScanBudgets, now: number): Promise<ProfileCacheScanResult> {
    const running = this.inflight.get(dir);
    if (running !== undefined) return running;
    let pass!: Promise<ProfileCacheScanResult>;
    pass = this.runScan(dir, budgets, now).finally(() => {
      // Only clear the slot if it is still ours: a reset may have dropped it
      // and a newer pass may already own the directory.
      if (this.inflight.get(dir) === pass) this.inflight.delete(dir);
    });
    this.inflight.set(dir, pass);
    return pass;
  }

  private async runScan(dir: string, budgets: ProfileScanBudgets, now: number): Promise<ProfileCacheScanResult> {
    const epoch = this.epoch;
    await this.sync();

    let state = this.state;
    // A cache built for another directory (or in another timezone) describes
    // a different world — rebuilding is the only honest option.
    if (state !== null && (state.dir !== dir || state.timeZone !== this.timeZone)) state = null;
    let dirty = state === null;
    if (state === null) {
      state = {
        dir,
        timeZone: this.timeZone,
        revision: randomUUID(),
        truncated: false,
        coverageStartTs: null,
        backlogRemaining: 0,
        files: new Map(),
        exact: new Map(),
      };
    }

    const stated = await this.listSinkFiles(dir, state.files);
    if (stated === null) return { ok: false };

    // ── phase 1: read what changed, newest-first, under both budgets ───────
    const contentThisPass = new Map<string, string[]>();
    /**
     * Files this pass read successfully. They are AVAILABLE regardless of how
     * their fresh snapshot compares to the directory listing taken earlier:
     * the listing is a photograph of the past, and on a live sink the session
     * file being appended to routinely grows between its `lstat` and its
     * `open` (the listing sweep alone takes ~1 s over 60 000 entries). Judging
     * such a file by the stale listing marks the NEWEST file a hole, which the
     * contiguous-prefix rule then turns into an empty — but perfectly
     * successful — view laid over the numbers already on screen.
     */
    const readThisPass = new Set<string>();
    /** Files that were listed but no longer exist by the time we open them —
     *  removed from this pass's world entirely rather than counted as gaps. */
    const vanished = new Set<string>();
    let opens = 0;
    let bytes = 0;
    /** Index of the first file over the per-file ceiling: the permanent end
     *  of reachable history (D-2). `stated.length` when there is none. */
    let reachableEnd = stated.length;
    for (let index = 0; index < stated.length; index += 1) {
      const entry = stated[index]!;
      // Unjudgeable this pass: not read, not compared, not treated as an
      // oversized cut either — its recorded size is last pass's, not today's.
      if (entry.statUnavailable === true) continue;
      if (entry.size > budgets.maxFileBytes) {
        // Never read, never cached, and nothing behind it is worth opening:
        // the prefix rule could never show it.
        if (state.files.delete(entry.name)) dirty = true;
        reachableEnd = index;
        break;
      }
      const cached = state.files.get(entry.name);
      if (cached !== undefined && sameFingerprint(cached, entry)) continue;
      if (opens >= budgets.maxNewReadsPerPass) break;
      // `opens > 0` keeps the byte guard from starving a pass: the first file
      // of a pass is always allowed through (its size is already bounded by
      // the per-file ceiling above), so every pass makes progress and the
      // backlog cannot wedge forever.
      if (opens > 0 && bytes + entry.size > budgets.maxScanBytes) break;

      // ONE open charged per file: the coherent read may re-open on a
      // suspected mid-read rewrite, and charging those retries would let a
      // flapping file eat a whole pass's budget.
      opens += 1;
      const read = await readCoherent(this.fs, entry.fullPath);
      if (!read.ok) {
        // Truthfulness over completeness (D-5): a stale partial for a file we
        // KNOW has changed is worse than a hole in coverage.
        if (state.files.delete(entry.name)) dirty = true;
        if (read.gone) vanished.add(entry.name);
        continue;
      }
      bytes += read.fingerprint.size;
      state.files.set(entry.name, {
        ...read.fingerprint,
        firstLineTs: read.firstLineTs,
        partial: aggregateFilePartial({ name: entry.name, lines: read.lines }),
        // Restamped for every entry once the prefix is known, below.
        active: false,
      });
      contentThisPass.set(entry.name, read.lines);
      readThisPass.add(entry.name);
      dirty = true;
    }

    // ── phase 2: prune, then the contiguous newest prefix (D-2) ────────────
    const statedNames = new Set(stated.map((entry) => entry.name));
    for (const name of [...state.files.keys()]) {
      if (!statedNames.has(name)) {
        state.files.delete(name);
        dirty = true;
      }
    }

    // An accumulator whose every participant has left the cache can never be
    // completed again; a session merely hidden behind a hole keeps its
    // progress, because its files are still cached.
    for (const [id, entry] of [...state.exact]) {
      if (entry.participants.every((participant) => !state.files.has(participant.name))) {
        state.exact.delete(id);
        dirty = true;
      }
    }

    // Files that disappeared mid-pass leave the pass's world; everything else
    // up to the permanent oversized cut is what coverage is measured against.
    const reachable = stated.slice(0, reachableEnd).filter((entry) => !vanished.has(entry.name));
    const knownFiles = stated.length - vanished.size;

    let backlogRemaining = 0;
    const available: boolean[] = [];
    for (let index = 0; index < reachable.length; index += 1) {
      const entry = reachable[index]!;
      const cached = state.files.get(entry.name);
      // Available means "the cache holds a coherent whole-file snapshot of
      // this file", which is true either because this pass just read one or
      // because the cached fingerprint still matches the listing. A file that
      // grew after we read it is NOT backlog: its tail is picked up next pass
      // by the ordinary fingerprint check, and calling the pass truncated for
      // it would leave a live machine permanently "catching up".
      const ok =
        entry.statUnavailable !== true &&
        cached !== undefined &&
        (readThisPass.has(entry.name) || sameFingerprint(cached, entry));
      available.push(ok);
      if (!ok) backlogRemaining += 1;
    }
    let prefixEnd = 0;
    while (prefixEnd < reachable.length && available[prefixEnd] === true) prefixEnd += 1;

    const included: Array<{ name: string; entry: CachedFileEntry }> = [];
    for (let index = 0; index < prefixEnd; index += 1) {
      const name = reachable[index]!.name;
      included.push({ name, entry: state.files.get(name)! });
    }
    const truncated = prefixEnd < knownFiles;
    const oldest = included.length === 0 ? undefined : included[included.length - 1]!.entry;
    const coverageStartTs = truncated && oldest !== undefined ? (oldest.firstLineTs ?? oldest.mtimeMs) : null;

    // Stamp membership onto the entries themselves, so `getStatsCached` after
    // a restart replays exactly this prefix instead of re-deriving it.
    const includedNames = new Set(included.map(({ name }) => name));
    for (const [name, entry] of state.files) {
      const active = includedNames.has(name);
      if (entry.active !== active) {
        entry.active = active;
        dirty = true;
      }
    }

    // ── phase 3: merge + the cumulative exact pass ─────────────────────────
    const resolved = await this.mergeIncluded(included, now, state, {
      dir,
      contentThisPass,
      budgets,
      opens,
      bytes,
    });
    if (resolved.exactDirty) dirty = true;

    if (
      state.truncated !== truncated ||
      state.coverageStartTs !== coverageStartTs ||
      state.backlogRemaining !== backlogRemaining
    ) {
      dirty = true;
    }
    state.truncated = truncated;
    state.coverageStartTs = coverageStartTs;
    state.backlogRemaining = backlogRemaining;

    if (this.epoch !== epoch) {
      // The cache was discarded while this pass was running. Its numbers are
      // still a truthful answer to the request that started it, but the state
      // behind them describes the world before the reset, so it is neither
      // published in memory nor written to disk.
      return {
        ok: true,
        stats: resolved.stats,
        truncated,
        coverageStartTs,
        backlogRemaining,
        pendingExactSessions: resolved.pendingExactSessions,
      };
    }
    this.state = state;
    if (dirty) await this.persist(state);

    return {
      ok: true,
      stats: resolved.stats,
      truncated,
      coverageStartTs,
      backlogRemaining,
      pendingExactSessions: resolved.pendingExactSessions,
    };
  }

  /** Reads the cached view without touching the telemetry directory at all. */
  async cachedStats(dir: string, now: number): Promise<ProfileCacheReadResult> {
    await this.sync();
    const state = this.state;
    if (state === null || state.dir !== dir || state.timeZone !== this.timeZone) {
      return { ok: false, reason: "no_cache" };
    }

    // Exactly the prefix the last completed pass stamped — no re-derivation,
    // so a sleeping partial behind a hole cannot resurface just because the
    // directory is not being scanned. Order is irrelevant: the merge sorts
    // partials by file name itself, and the coverage numbers come from the
    // header.
    const included: Array<{ name: string; entry: CachedFileEntry }> = [];
    for (const [name, entry] of state.files) {
      if (entry.active) included.push({ name, entry });
    }

    const resolved = await this.mergeIncluded(included, now, state, null);
    return {
      ok: true,
      stats: resolved.stats,
      truncated: state.truncated,
      coverageStartTs: state.coverageStartTs,
      backlogRemaining: state.backlogRemaining,
      // KNOWN LIMIT: like `backlogRemaining` above, this number is the last
      // completed pass's verdict. The cached channel does not scan, so a
      // participant that changed since then is invisible here and a session
      // can read as settled until the next real pass says otherwise.
      pendingExactSessions: resolved.pendingExactSessions,
    };
  }

  /**
   * Merges the included partials and, when the merge reports cross-file
   * sessions whose activity it could not compute exactly, drives the
   * cumulative exact pass.
   *
   * `work === null` is the read-only (cached-channel) mode: exact values are
   * used only where the stored accumulation is already complete, and nothing
   * is read or written.
   */
  private async mergeIncluded(
    included: Array<{ name: string; entry: CachedFileEntry }>,
    now: number,
    state: CacheState,
    work: {
      dir: string;
      contentThisPass: Map<string, string[]>;
      budgets: ProfileScanBudgets;
      opens: number;
      bytes: number;
    } | null,
  ): Promise<{ stats: ProfileStats; pendingExactSessions: number; exactDirty: boolean }> {
    const named = included.map(({ name, entry }) => ({ name, partial: entry.partial }));
    const first = mergeProfilePartials(named, { now });
    if (first.crossFileSessions.length === 0) {
      // The overwhelmingly common case (measured: 0 cross-file sessions over
      // 60 773 real files) — one merge, no second pass, nothing pending.
      return { stats: first.stats, pendingExactSessions: 0, exactDirty: false };
    }

    const entriesByName = new Map(included.map(({ name, entry }) => [name, entry] as const));
    // A Map, converted once at the end: a session id is arbitrary text from a
    // record, and `table["__proto__"] = v` on a plain object creates no own
    // property at all — the exact value would be dropped while the session
    // still counted as settled, publishing the provisional number as final.
    const exactActiveMs = new Map<string, number>();
    let pendingExactSessions = 0;
    let exactDirty = false;
    let opens = work?.opens ?? 0;
    let bytes = work?.bytes ?? 0;

    for (const session of first.crossFileSessions) {
      const participantNames = [...new Set(session.files)];
      const entry = reconcileExactEntry(state, session.id, participantNames, work !== null);
      if (entry.changed) exactDirty = true;

      if (work !== null) {
        for (const participant of entry.value.participants) {
          if (participant.read) continue;
          const current = entriesByName.get(participant.name);
          if (current === undefined) continue;
          let lines = work.contentThisPass.get(participant.name);
          if (lines === undefined) {
            // Not read this pass: the exact pass pays for the open out of the
            // SAME per-pass open AND byte budgets as the partial reads.
            if (opens >= work.budgets.maxNewReadsPerPass) continue;
            if (opens > 0 && bytes + current.size > work.budgets.maxScanBytes) continue;
            opens += 1;
            const read = await readCoherent(this.fs, `${stripTrailingSep(work.dir)}/${participant.name}`);
            if (!read.ok || !sameFingerprint(read.fingerprint, current)) continue;
            bytes += read.fingerprint.size;
            lines = read.lines;
            work.contentThisPass.set(participant.name, lines);
          }
          const byId = collectSessionTimestamps({ name: participant.name, lines }, { sessionIds: [session.id] });
          // Folding is associative, so this participant's arrival order and
          // the pass it arrives in are both irrelevant to the result.
          entry.value.clusters = mergeActivityClusters(entry.value.clusters, byId[session.id] ?? []);
          participant.read = true;
          participant.size = current.size;
          participant.mtimeMs = current.mtimeMs;
          participant.ino = current.ino;
          participant.ctimeMs = current.ctimeMs;
          exactDirty = true;
        }
      }

      const complete = entry.value.participants.every((participant) => participant.read);
      const activeMs = complete ? clustersActiveMs(entry.value.clusters) : null;
      if (entry.value.activeMs !== activeMs) {
        entry.value.activeMs = activeMs;
        exactDirty = true;
      }
      if (activeMs === null) {
        pendingExactSessions += 1;
        continue;
      }
      exactActiveMs.set(session.id, activeMs);
    }

    if (exactActiveMs.size === 0) {
      return { stats: first.stats, pendingExactSessions, exactDirty };
    }
    const second = mergeProfilePartials(named, { now, exactSessionActiveMs: Object.fromEntries(exactActiveMs) });
    return { stats: second.stats, pendingExactSessions, exactDirty };
  }

  /**
   * Names inside the active prefix right now — DIAGNOSTICS ONLY. The bench's
   * per-pass differential has to know exactly which files a pass claims to
   * have aggregated in order to compare against the uncapped oracle on the
   * same set; nothing in the product path reads this.
   */
  includedFileNames(): string[] {
    const state = this.state;
    if (state === null) return [];
    const names: string[] = [];
    for (const [name, entry] of state.files) {
      if (entry.active) names.push(name);
    }
    return names;
  }

  /**
   * Flat `*.jsonl` regular files, symlinks skipped, newest-mtime-first.
   * `null` = the directory exists but could not be listed.
   *
   * Every failure is classified by ERROR CODE, never by a boolean probe: only
   * ENOENT means "not there". An `access`-style existence check cannot tell a
   * missing directory from an unreadable one, and answering "empty" for an
   * unreadable directory would paint zeros over the user's whole history with
   * no later pass able to correct them.
   */
  private async listSinkFiles(dir: string, cached: Map<string, CachedFileEntry>): Promise<StatedJsonlFile[] | null> {
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      console.warn(`[profile-stats-cache] readdir failed for ${dir}`, error);
      return null;
    }
    const stated: StatedJsonlFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const fullPath = `${stripTrailingSep(dir)}/${name}`;
      let stat: ProfileFileStat;
      try {
        stat = await this.fs.lstat(fullPath);
      } catch (error) {
        // Gone between readdir and lstat: one file fewer, nothing to report.
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
        const known = cached.get(name);
        stated.push({
          name,
          fullPath,
          size: known?.size ?? 0,
          // Without a cached position the file could be the newest one there
          // is; assuming so is the conservative choice, because it cuts
          // coverage rather than hiding a file behind data it may postdate.
          mtimeMs: known?.mtimeMs ?? Number.MAX_SAFE_INTEGER,
          ino: known?.ino ?? 0,
          ctimeMs: known?.ctimeMs ?? 0,
          statUnavailable: true,
        });
        continue;
      }
      if (stat.isSymbolicLink === true || !stat.isFile) continue;
      stated.push({
        name,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        ctimeMs: stat.ctimeMs,
      });
    }
    stated.sort(compareNewestFirst);
    return stated;
  }
}


/**
 * Brings one session's cumulative exact state in line with its CURRENT
 * participant set.
 *
 * A participant that was already folded in and has since moved — changed
 * fingerprint, dropped out of the cache, or left the session — invalidates
 * the whole fold: cluster merging is irreversible, so its contribution cannot
 * be subtracted and the session's exact work restarts. Participants merely
 * ADDED cost nothing: folding is associative, so the clusters built so far
 * stay valid and only the newcomer has to be read.
 *
 * `persist: false` is the read-only (cached-channel) mode — the reconciled
 * value is computed but never written back into the store.
 */
function reconcileExactEntry(
  state: CacheState,
  id: string,
  participantNames: string[],
  persist: boolean,
): { value: ExactSessionEntry; changed: boolean } {
  const stored = state.exact.get(id);
  const wanted = new Set(participantNames);
  let changed = false;

  let reset = false;
  for (const participant of stored?.participants ?? []) {
    if (!participant.read) continue;
    const cached = state.files.get(participant.name);
    if (cached === undefined || !sameFingerprint(cached, participant) || !wanted.has(participant.name)) {
      reset = true;
      break;
    }
  }
  if (reset) changed = true;

  const previous = new Map((stored?.participants ?? []).map((participant) => [participant.name, participant] as const));
  const participants: ExactParticipant[] = [];
  for (const name of participantNames) {
    const prior = previous.get(name);
    const read = !reset && prior?.read === true;
    const source = read ? prior! : (state.files.get(name) ?? { size: 0, mtimeMs: 0, ino: 0, ctimeMs: 0 });
    participants.push({ name, size: source.size, mtimeMs: source.mtimeMs, ino: source.ino, ctimeMs: source.ctimeMs, read });
    if (prior === undefined || prior.read !== read) changed = true;
  }
  if ((stored?.participants.length ?? -1) !== participants.length) changed = true;

  const value: ExactSessionEntry = {
    participants,
    clusters: reset ? [] : (stored?.clusters ?? []),
    activeMs: reset ? null : (stored?.activeMs ?? null),
  };
  if (persist) state.exact.set(id, value);
  return { value, changed };
}

// ── construction ───────────────────────────────────────────────────────────

/** `<home>/.anycode/profile-stats-cache.json` — beside the user config. */
export function profileStatsCachePath(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/${PROFILE_STATS_CACHE_FILE_NAME}`;
}

/** The process's IANA zone id; partials carry LOCAL day buckets, so a zone
 *  change invalidates them (D-5). */
export function resolveCacheTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

export function createProfileStatsCacheStore(
  fs: ProfileCacheFs,
  path: string,
  timeZone: string = resolveCacheTimeZone(),
): ProfileStatsCacheStore {
  return new ProfileStatsCacheStore(fs, path, timeZone);
}

/** Process-wide stores, one per cache-file path: two IPC calls must share the
 *  in-memory copy (and the in-flight pass), or nothing is cached at all. */
const stores = new Map<string, ProfileStatsCacheStore>();

export function sharedProfileStatsCacheStore(fs: ProfileCacheFs, path: string): ProfileStatsCacheStore {
  const existing = stores.get(path);
  if (existing !== undefined) return existing;
  const created = createProfileStatsCacheStore(fs, path);
  stores.set(path, created);
  return created;
}

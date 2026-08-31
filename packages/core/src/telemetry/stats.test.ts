/**
 * stats.test.ts (slice P7.22/F19 W1): aggregateProfileStats — every ProfileStats
 * field pinned exactly against hand-computed sums, fail-soft malformed-line
 * handling, the byte-cap truncation flag, gap-capped active duration, streak
 * edges (grace + gap-day break), and model join + "(unknown)" fallback (S10:
 * the removed `topTools`/`topModels` top-N fields' ordering/cap behavior is
 * documented, not replicated, at its former call site below). All tests
 * inject a UTC dayKey formatter of the YYYY-MM-DD shape for determinism
 * (owner-facing local-day math is exercised once via the default formatter in
 * its own test).
 */

import { describe, expect, it } from "vitest";
import { aggregateProfileStats, type ProfileStatsFile } from "./stats.js";
import { PROFILE_ACTIVITY_GAP_CAP_MS, PROFILE_STATS_MAX_SCAN_BYTES } from "../types/config.js";
// TASK.187 S2 (task187-aggregator-semantics.md): the per-file partial +
// merge path. Imported separately from the block above so that every line of
// the pre-existing suite stays byte-identical (the slice's accept criterion).
import {
  aggregateFilePartial,
  collectSessionTimestamps,
  mergeProfilePartials,
  sessionActiveMs,
  type ProfileFilePartial,
} from "./stats.js";
// TASK.187 S3: the cumulative form of that exact pass — cluster state, folded
// participant by participant across scan passes.
import { clustersActiveMs, mergeActivityClusters, type ActivityCluster } from "./stats.js";

const utcDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

function file(name: string, records: unknown[]): ProfileStatsFile {
  return { name, lines: records.map((r) => JSON.stringify(r)) };
}

describe("aggregateProfileStats — full fixture (2 sessions x 3 days, every field pinned)", () => {
  const T1 = Date.UTC(2026, 0, 1, 10, 0, 0); // 2026-01-01
  const T2 = Date.UTC(2026, 0, 2, 9, 0, 0); // 2026-01-02
  const T3 = Date.UTC(2026, 0, 3, 9, 0, 0); // 2026-01-03
  const NOW = T3 + 120_000; // 2026-01-03T09:02:00Z — "today" per utcDayKey

  const sessA = file("sess-a.jsonl", [
    { v: 1, ts: T1, session: "sess-a", t: "session_start", model: "model-x", provider: "p", mode: "auto" },
    { v: 1, ts: T1 + 60_000, session: "sess-a", t: "usage", totalTokens: 100 },
    { v: 1, ts: T1 + 180_000, session: "sess-a", t: "usage", totalTokens: 50 },
    { v: 1, ts: T1 + 600_000, session: "sess-a", t: "tool", tool: "Read", status: "ok", durationMs: 5 },
    { v: 1, ts: T1 + 660_000, session: "sess-a", t: "loop_end", reason: "completed", turns: 2 },
    { v: 1, ts: T1 + 720_000, session: "sess-a", t: "subagent_start", agentType: "explorer" },
  ]);

  const sessB = file("sess-b.jsonl", [
    { v: 1, ts: T2, session: "sess-b", t: "session_start", model: "model-y", provider: "p", mode: "auto" },
    { v: 1, ts: T2 + 60_000, session: "sess-b", t: "usage", totalTokens: 1000 },
    { v: 1, ts: T2 + 120_000, session: "sess-b", t: "usage", totalTokens: 500 },
    { v: 1, ts: T2 + 180_000, session: "sess-b", t: "tool", tool: "Bash", status: "ok", durationMs: 10 },
    { v: 1, ts: T2 + 240_000, session: "sess-b", t: "tool", tool: "Bash", status: "ok", durationMs: 8 },
    { v: 1, ts: T2 + 300_000, session: "sess-b", t: "tool", tool: "Read", status: "ok", durationMs: 3 },
    { v: 1, ts: T2 + 360_000, session: "sess-b", t: "loop_end", reason: "completed", turns: 5 },
    { v: 1, ts: T3, session: "sess-b", t: "usage", totalTokens: 300 },
    { v: 1, ts: T3 + 60_000, session: "sess-b", t: "subagent_start", agentType: "reviewer" },
  ]);

  it("pins every field exactly", () => {
    const stats = aggregateProfileStats([sessB, sessA], { now: NOW, dayKey: utcDayKey });
    expect(stats).toEqual({
      lifetimeTokens: 1950,
      peakDay: { day: "2026-01-02", tokens: 1500 },
      longestSessionMs: 720_000,
      currentStreakDays: 3,
      longestStreakDays: 3,
      totalSessions: 2,
      totalRuns: 2,
      toolCalls: 4,
      subagentRuns: 2,
      truncated: false,
      // TASK.158 slice 1 additions (§2.6) — no sub/engine anywhere in this
      // fixture, so every session is core and every usage record folds
      // through its own session's model (deferred join).
      days: {
        "2026-01-01": {
          tokens: 150,
          runs: 1,
          toolCalls: 1,
          subagentRuns: 1,
          sessions: 1, // sess-a's session_start (its min ts) is on this day
          tools: { Read: 1 },
          models: { "model-x": 150 },
        },
        "2026-01-02": {
          tokens: 1500,
          runs: 1,
          toolCalls: 3,
          subagentRuns: 0,
          sessions: 1, // sess-b's session_start (its min ts) is on this day
          tools: { Bash: 2, Read: 1 },
          models: { "model-y": 1500 },
        },
        "2026-01-03": {
          tokens: 300,
          runs: 0,
          toolCalls: 0,
          subagentRuns: 1,
          sessions: 0, // sess-b already attributed to 01-02 (its min ts) — not double-counted
          tools: {},
          models: { "model-y": 300 },
        },
      },
      models: [
        { model: "model-y", tokens: 1800, sessions: 1 },
        { model: "model-x", tokens: 150, sessions: 1 },
      ],
      engineTokens: { core: 1950 },
    });
  });

  it("file iteration order does not matter (sorted defensively by name)", () => {
    const a = aggregateProfileStats([sessA, sessB], { now: NOW, dayKey: utcDayKey });
    const b = aggregateProfileStats([sessB, sessA], { now: NOW, dayKey: utcDayKey });
    expect(a).toEqual(b);
  });
});

describe("aggregateProfileStats — fail-soft line handling", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("skips malformed JSON lines", () => {
    const f: ProfileStatsFile = {
      name: "s.jsonl",
      lines: ["not json {{{", JSON.stringify({ v: 1, ts: now, session: "s", t: "usage", totalTokens: 10 })],
    };
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(10);
    expect(stats.totalSessions).toBe(1);
  });

  it("skips lines with v !== 1", () => {
    const f = file("s.jsonl", [
      { v: 2, ts: now, session: "s", t: "usage", totalTokens: 999 },
      { v: 1, ts: now, session: "s", t: "usage", totalTokens: 10 },
    ]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(10);
  });

  it("skips lines with a non-number ts", () => {
    const f = file("s.jsonl", [
      { v: 1, ts: "not-a-number", session: "s", t: "usage", totalTokens: 999 },
      { v: 1, ts: now, session: "s", t: "usage", totalTokens: 10 },
    ]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(10);
  });

  it("an empty file contributes nothing and is not counted as a session", () => {
    const f: ProfileStatsFile = { name: "empty.jsonl", lines: [] };
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(0);
    expect(stats.lifetimeTokens).toBe(0);
    expect(stats.peakDay).toBeNull();
  });

  it("a missing/empty file iterable yields a fully-zeroed result", () => {
    const stats = aggregateProfileStats([], { now, dayKey: utcDayKey });
    expect(stats).toEqual({
      lifetimeTokens: 0,
      peakDay: null,
      longestSessionMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      totalSessions: 0,
      totalRuns: 0,
      toolCalls: 0,
      subagentRuns: 0,
      truncated: false,
      days: {},
      models: [],
      engineTokens: {},
    });
  });
});

describe("aggregateProfileStats — byte-cap truncation", () => {
  it("stops scanning once cumulative bytes exceed PROFILE_STATS_MAX_SCAN_BYTES and sets truncated", () => {
    // Build lines whose stringified length is exactly 1 MiB each: 64 lines fit
    // exactly at the cap (64 * 1MiB = cap, NOT exceeding); the 65th line tips
    // cumulative bytes over the cap and is never parsed.
    const oneMiB = 1024 * 1024;
    const FIXED_TS = 1_700_000_000_000; // constant so every line is byte-identical in length
    const baseLenWithoutPad = JSON.stringify({
      v: 1,
      ts: FIXED_TS,
      session: "big",
      t: "usage",
      totalTokens: 1,
      pad: "",
    }).length;
    const padLen = oneMiB - baseLenWithoutPad;
    expect(padLen).toBeGreaterThan(0);

    const lines: string[] = [];
    for (let i = 0; i < 65; i += 1) {
      const rec = { v: 1, ts: FIXED_TS, session: "big", t: "usage", totalTokens: 1, pad: "x".repeat(padLen) };
      const line = JSON.stringify(rec);
      expect(line.length).toBe(oneMiB);
      lines.push(line);
    }
    expect(65 * oneMiB).toBeGreaterThan(PROFILE_STATS_MAX_SCAN_BYTES);
    expect(64 * oneMiB).toBeLessThanOrEqual(PROFILE_STATS_MAX_SCAN_BYTES);

    const stats = aggregateProfileStats([{ name: "big.jsonl", lines }], {
      now: 100,
      dayKey: () => "2026-01-01",
    });
    expect(stats.truncated).toBe(true);
    // Only the first 64 (1-indexed ts 1..64) lines were parsed before the cap tripped.
    expect(stats.lifetimeTokens).toBe(64);
  });

  it("does not truncate when total bytes stay under the cap", () => {
    const f = file("small.jsonl", [{ v: 1, ts: 1, session: "s", t: "usage", totalTokens: 5 }]);
    const stats = aggregateProfileStats([f], { now: 100, dayKey: () => "2026-01-01" });
    expect(stats.truncated).toBe(false);
  });
});

describe("aggregateProfileStats — gap-cap active duration", () => {
  it("caps a 6-minute gap between two records at PROFILE_ACTIVITY_GAP_CAP_MS (5 min)", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("s.jsonl", [
      { v: 1, ts: t0, session: "s", t: "session_start", model: "m", provider: "p", mode: "auto" },
      { v: 1, ts: t0 + 6 * 60_000, session: "s", t: "usage", totalTokens: 1 },
    ]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    expect(stats.longestSessionMs).toBe(PROFILE_ACTIVITY_GAP_CAP_MS);
  });

  it("a single-record session contributes 0 active duration", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("s.jsonl", [{ v: 1, ts: t0, session: "s", t: "usage", totalTokens: 1 }]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    expect(stats.longestSessionMs).toBe(0);
  });
});

describe("aggregateProfileStats — streak edges", () => {
  const dayTs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);

  it("three consecutive days with data ending today yields a streak of 3", () => {
    const files = [
      file("d1.jsonl", [{ v: 1, ts: dayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: dayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
      file("d3.jsonl", [{ v: 1, ts: dayTs(2026, 1, 3), session: "d3", t: "usage", totalTokens: 1 }]),
    ];
    const stats = aggregateProfileStats(files, { now: dayTs(2026, 1, 3), dayKey: utcDayKey });
    expect(stats.currentStreakDays).toBe(3);
    expect(stats.longestStreakDays).toBe(3);
  });

  it("a gap day breaks the streak (longest stays at the earlier run, current resets)", () => {
    const files = [
      file("d1.jsonl", [{ v: 1, ts: dayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: dayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
      // 2026-01-03 has no data (gap day)
      file("d4.jsonl", [{ v: 1, ts: dayTs(2026, 1, 4), session: "d4", t: "usage", totalTokens: 1 }]),
    ];
    const stats = aggregateProfileStats(files, { now: dayTs(2026, 1, 4), dayKey: utcDayKey });
    expect(stats.longestStreakDays).toBe(2); // the 01-01/01-02 run
    expect(stats.currentStreakDays).toBe(1); // only 01-04 is contiguous with "today"
  });

  it("today has no data but yesterday does — grace keeps the streak counting from yesterday", () => {
    const files = [
      file("d1.jsonl", [{ v: 1, ts: dayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: dayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
    ];
    // "now" is 2026-01-03 — no data that day, but 01-02 (yesterday) has data.
    const stats = aggregateProfileStats(files, { now: dayTs(2026, 1, 3), dayKey: utcDayKey });
    expect(stats.currentStreakDays).toBe(2);
  });

  it("neither today nor yesterday has data — current streak is 0", () => {
    const files = [file("d1.jsonl", [{ v: 1, ts: dayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }])];
    const stats = aggregateProfileStats(files, { now: dayTs(2026, 1, 10), dayKey: utcDayKey });
    expect(stats.currentStreakDays).toBe(0);
    expect(stats.longestStreakDays).toBe(1);
  });
});

describe("aggregateProfileStats — model join + (unknown) fallback", () => {
  it("attributes a session's usage tokens to (unknown) when session_start.model is absent", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("orphan.jsonl", [{ v: 1, ts: t0, session: "orphan", t: "usage", totalTokens: 42 }]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    // S10: the removed top-3 `topModels` field pinned this same fallback —
    // `models` (the full list) carries it now, plus `sessions`.
    expect(stats.models).toEqual([{ model: "(unknown)", tokens: 42, sessions: 1 }]);
  });

  it("ranks models by descending tokens, tie-broken alphabetically", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      file("a.jsonl", [
        { v: 1, ts: t0, session: "a", t: "session_start", model: "zeta", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "a", t: "usage", totalTokens: 5 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: t0, session: "b", t: "session_start", model: "alpha", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "b", t: "usage", totalTokens: 5 },
      ]),
    ];
    const stats = aggregateProfileStats(files, { now: t0, dayKey: utcDayKey });
    expect(stats.models).toEqual([
      { model: "alpha", tokens: 5, sessions: 1 },
      { model: "zeta", tokens: 5, sessions: 1 },
    ]);
  });
});

// S10: the "topTools ordering + top-5 cap" describe block that lived here
// pinned the removed `topTools` field's top-5-cap-and-descending-order
// behavior. That cap no longer exists anywhere in this module by design (the
// owner's own complaint about the old pane was "only top 3" — the fix is a
// full, uncapped per-day tool count, never a bigger cap). Consciously NOT
// replaced 1:1: the underlying per-record counting this test exercised
// (`dayAgg.tools`) is already pinned elsewhere in this file (the "days
// aggregate: multi-file bucketing" and "sub tier" describes below), and the
// full-list ordering + tie-break behavior this test also covered now lives
// in `ProfilePane.tsx`'s `sortRowsDesc` (via `sumWindow`), tested in
// ProfilePane.test.ts's own `sumWindow` describe (its "with startKey null"
// case pins the exact same descending + alphabetical-tie-break ordering for
// tool rows, uncapped).

describe("aggregateProfileStats — malformed record hardening (W5-FIX finding 2, codex R1 P2-B)", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("PoC-1: an unknown t discriminant is skipped like a malformed line — no phantom session/model/streak day", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s", t: "unknown" }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(0);
    expect(stats.days).toEqual({});
    expect(stats.models).toEqual([]);
    expect(stats.currentStreakDays).toBe(0);
    expect(stats.longestStreakDays).toBe(0);
  });

  it("a missing t discriminant (envelope-only line) is skipped the same way", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s" }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(0);
    expect(stats.days).toEqual({});
  });

  it("PoC-2: a non-finite totalTokens is clamped to 0, never propagates Infinity into any total", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s", t: "usage", totalTokens: 1e999 }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(0);
    expect(Number.isFinite(stats.lifetimeTokens)).toBe(true);
    expect(stats.peakDay === null || stats.peakDay.tokens === 0).toBe(true);
    for (const d of Object.values(stats.days)) {
      expect(Number.isFinite(d.tokens)).toBe(true);
    }
    for (const m of stats.models) {
      expect(Number.isFinite(m.tokens)).toBe(true);
    }
  });

  it("clamps a negative inputTokens/outputTokens fallback sum to 0 rather than going negative", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s", t: "usage", inputTokens: -5, outputTokens: -10 }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(0);
  });

  it("TASK.210: a degeneration record is a VALID discriminant, not a phantom variant — a file carrying only one still counts as a session", () => {
    const f = file("s.jsonl", [
      { v: 1, ts: 0, session: "s", t: "degeneration", channel: "text", period: 296, repeats: 341, turn: 4 },
    ]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    // If "degeneration" were still missing from VALID_RECORD_TYPES this file
    // would be indistinguishable from PoC-1's "unknown" case above — 0
    // sessions, no day bucket — silently discarding a real guard-cutoff line.
    expect(stats.totalSessions).toBe(1);
  });
});

describe("aggregateProfileStats — default dayKey (LOCAL calendar date)", () => {
  it("buckets by local calendar date when dayKey is not supplied", () => {
    const now = Date.now();
    const f = file("s.jsonl", [{ v: 1, ts: now, session: "s", t: "usage", totalTokens: 7 }]);
    const stats = aggregateProfileStats([f], { now });
    const d = new Date(now);
    const expectedDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    expect(stats.days).toEqual({ [expectedDay]: expect.objectContaining({ tokens: 7 }) });
  });
});

// TASK.158 slice 1 (telemetry-track-plan.md §2.6/§S4): days/models/engineTokens.
// All fixtures below reuse the `file`/`utcDayKey` helpers from the top of this
// file. Every new field is pinned, never spot-checked, per the plan's
// "presence over green" review rule.
describe("aggregateProfileStats — days aggregate: multi-file bucketing", () => {
  it("buckets tokens/runs/toolCalls/subagentRuns/tools/models per day, across files", () => {
    const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const T2 = Date.UTC(2026, 0, 2, 9, 0, 0);
    const fx = file("x.jsonl", [
      { v: 1, ts: T1, session: "sx", t: "session_start", model: "mx", provider: "p", mode: "auto" },
      { v: 1, ts: T1 + 1000, session: "sx", t: "usage", totalTokens: 40 },
      { v: 1, ts: T1 + 2000, session: "sx", t: "tool", tool: "Bash", status: "ok", durationMs: 1 },
      { v: 1, ts: T1 + 3000, session: "sx", t: "loop_end", reason: "completed", turns: 1 },
    ]);
    const fy = file("y.jsonl", [
      { v: 1, ts: T2, session: "sy", t: "session_start", model: "my", provider: "p", mode: "auto" },
      { v: 1, ts: T2 + 1000, session: "sy", t: "usage", totalTokens: 70 },
      { v: 1, ts: T2 + 2000, session: "sy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
      { v: 1, ts: T2 + 2500, session: "sy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
      { v: 1, ts: T2 + 3000, session: "sy", t: "subagent_start", agentType: "explorer" },
    ]);
    const stats = aggregateProfileStats([fx, fy], { now: T2, dayKey: utcDayKey });
    expect(stats.days).toEqual({
      "2026-01-01": {
        tokens: 40,
        runs: 1,
        toolCalls: 1,
        subagentRuns: 0,
        sessions: 1,
        tools: { Bash: 1 },
        models: { mx: 40 },
      },
      "2026-01-02": {
        tokens: 70,
        runs: 0,
        toolCalls: 2,
        subagentRuns: 1,
        sessions: 1,
        tools: { Read: 2 },
        models: { my: 70 },
      },
    });
  });
});

describe("aggregateProfileStats — deferred join: session_start after usage lines", () => {
  it("attributes tokens to the right model even when session_start appears AFTER usage in the line list", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    // Line order is reversed vs ts order — the deferred join must not depend
    // on scan order (158-trap-1: on-the-fly attribution would book this to
    // "(unknown)" since session.model isn't set yet when the usage line is
    // processed).
    const f: ProfileStatsFile = {
      name: "s.jsonl",
      lines: [
        JSON.stringify({ v: 1, ts: t0 + 1000, session: "s", t: "usage", totalTokens: 99 }),
        JSON.stringify({ v: 1, ts: t0, session: "s", t: "session_start", model: "late-bound", provider: "p", mode: "auto" }),
      ],
    };
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    expect(stats.models).toEqual([{ model: "late-bound", tokens: 99, sessions: 1 }]);
    expect(stats.days["2026-01-01"]?.models).toEqual({ "late-bound": 99 });
  });
});

describe("aggregateProfileStats — session day = min ts, midnight-crossing session counted once", () => {
  it("a session spanning two days is attributed to the day of its EARLIEST record, and only once", () => {
    const day1 = Date.UTC(2026, 0, 1, 23, 0, 0);
    const day2 = Date.UTC(2026, 0, 2, 1, 0, 0); // 2h later, next calendar day
    const f = file("s.jsonl", [
      { v: 1, ts: day1, session: "s", t: "session_start", model: "cross", provider: "p", mode: "auto" },
      { v: 1, ts: day1 + 1000, session: "s", t: "usage", totalTokens: 5 },
      { v: 1, ts: day2, session: "s", t: "usage", totalTokens: 8 },
    ]);
    const stats = aggregateProfileStats([f], { now: day2, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(1);
    expect(stats.days["2026-01-01"]?.sessions).toBe(1);
    expect(stats.days["2026-01-02"]?.sessions).toBe(0);
    // Per-day token/model split still happens for both days (tokens are
    // day-scoped even though the session itself is not).
    expect(stats.days["2026-01-01"]?.models).toEqual({ cross: 5 });
    expect(stats.days["2026-01-02"]?.models).toEqual({ cross: 8 });
    expect(stats.models).toEqual([{ model: "cross", tokens: 13, sessions: 1 }]);
  });
});

describe("aggregateProfileStats — sub-token attribution: both branches", () => {
  it("sub usage WITHOUT a model override folds into the session's own model; WITH an override goes direct", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("p.jsonl", [
      { v: 1, ts: t0, session: "p", t: "session_start", model: "parent-model", provider: "p", mode: "auto" },
      { v: 1, ts: t0 + 1000, session: "p", t: "usage", totalTokens: 10, sub: { agentType: "explorer" } },
      {
        v: 1,
        ts: t0 + 2000,
        session: "p",
        t: "usage",
        totalTokens: 25,
        sub: { agentType: "explorer", model: "child-model" },
      },
    ]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    // Existing (untouched) fields still count sub tokens unconditionally.
    expect(stats.lifetimeTokens).toBe(35);
    expect(stats.models).toEqual(
      expect.arrayContaining([
        { model: "parent-model", tokens: 10, sessions: 1 },
        { model: "child-model", tokens: 25, sessions: 0 },
      ]),
    );
    expect(stats.models).toHaveLength(2);
    // engineTokens is session-scoped by ENGINE, not by model: the sub.model
    // override only redirects which `models` row the 25 tokens land in — the
    // subagent still ran inside session "p", so all 35 tokens count toward
    // that session's engine (core here). engineTokens must never undercount
    // lifetimeTokens.
    expect(stats.engineTokens).toEqual({ core: 35 });
    expect(stats.days["2026-01-01"]?.models).toEqual({ "parent-model": 10, "child-model": 25 });
  });
});

describe("aggregateProfileStats — sub tier: loop_end excluded from runs, tool included", () => {
  it("a sub-marked loop_end does not count as a run; a sub-marked tool call still counts", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("q.jsonl", [
      { v: 1, ts: t0, session: "q", t: "session_start", model: "m", provider: "p", mode: "auto" },
      { v: 1, ts: t0 + 1000, session: "q", t: "loop_end", reason: "completed", turns: 1 },
      {
        v: 1,
        ts: t0 + 2000,
        session: "q",
        t: "loop_end",
        reason: "completed",
        turns: 1,
        sub: { agentType: "explorer" },
      },
      { v: 1, ts: t0 + 3000, session: "q", t: "tool", tool: "Grep", status: "ok", durationMs: 1, sub: { agentType: "explorer" } },
    ]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    expect(stats.totalRuns).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.days["2026-01-01"]).toMatchObject({
      runs: 1,
      toolCalls: 1,
      tools: { Grep: 1 },
    });
  });
});

describe("aggregateProfileStats — full models list, beyond 3, including zero-token models", () => {
  it("keeps a model with a session_start but zero usage tokens in the FULL list (S10: no top-N cut exists anywhere anymore)", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      file("a.jsonl", [
        { v: 1, ts: t0, session: "a", t: "session_start", model: "m1", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "a", t: "usage", totalTokens: 40 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: t0, session: "b", t: "session_start", model: "m2", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "b", t: "usage", totalTokens: 30 },
      ]),
      file("c.jsonl", [
        { v: 1, ts: t0, session: "c", t: "session_start", model: "m3", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "c", t: "usage", totalTokens: 20 },
      ]),
      // No usage records at all — a real "connected but never spent" model.
      file("d.jsonl", [{ v: 1, ts: t0, session: "d", t: "session_start", model: "m4-idle", provider: "p", mode: "auto" }]),
    ];
    const stats = aggregateProfileStats(files, { now: t0, dayKey: utcDayKey });
    expect(stats.models).toHaveLength(4);
    expect(stats.models).toContainEqual({ model: "m4-idle", tokens: 0, sessions: 1 });
  });
});

describe("aggregateProfileStats — engine capture, engineTokens, first-seen wins on conflict", () => {
  it("attributes engineTokens per session.engine (core/codex/claude) and models[].engine, first-seen on a shared model", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      // Processed FIRST (name sort): codex session on "shared-model".
      file("a-codex.jsonl", [
        { v: 1, ts: t0, session: "c1", t: "session_start", model: "shared-model", provider: "p", enginePreset: "ask", engine: "codex" },
        { v: 1, ts: t0 + 1000, session: "c1", t: "usage", totalTokens: 50 },
      ]),
      // Processed SECOND: claude session, SAME model — must not override
      // the model's engine (first-seen wins).
      file("b-claude-shared.jsonl", [
        { v: 1, ts: t0, session: "c2", t: "session_start", model: "shared-model", provider: "p", enginePreset: "workspace", engine: "claude" },
        { v: 1, ts: t0 + 1000, session: "c2", t: "usage", totalTokens: 15 },
      ]),
      file("c-claude-other.jsonl", [
        { v: 1, ts: t0, session: "l1", t: "session_start", model: "other-model", provider: "p", enginePreset: "workspace", engine: "claude" },
        { v: 1, ts: t0 + 1000, session: "l1", t: "usage", totalTokens: 30 },
      ]),
      file("d-core.jsonl", [
        { v: 1, ts: t0, session: "n1", t: "session_start", model: "core-model", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "n1", t: "usage", totalTokens: 20 },
      ]),
    ];
    const stats = aggregateProfileStats(files, { now: t0, dayKey: utcDayKey });
    expect(stats.models).toContainEqual({ model: "shared-model", tokens: 65, sessions: 2, engine: "codex" });
    expect(stats.models).toContainEqual({ model: "other-model", tokens: 30, sessions: 1, engine: "claude" });
    expect(stats.models).toContainEqual({ model: "core-model", tokens: 20, sessions: 1 });
    expect(stats.engineTokens).toEqual({ codex: 50, claude: 45, core: 20 });
  });
});

describe("aggregateProfileStats — mixed-era fixture: legacy records + new records in one run", () => {
  it("legacy core record WITH `mode` + engine record WITHOUT `mode` (S9: `enginePreset` instead) score identically to before", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const legacyFile = file("legacy.jsonl", [
      // No `engine` field anywhere, no `sub` anywhere, HAS `mode` — exactly
      // the shape of every one of the owner's 60 601 pre-existing files
      // (all core-path, all written before `enginePreset` existed).
      { v: 1, ts: t0, session: "legacy", t: "session_start", model: "legacy-model", provider: "p", mode: "auto" },
      { v: 1, ts: t0 + 1000, session: "legacy", t: "usage", totalTokens: 77 },
      { v: 1, ts: t0 + 2000, session: "legacy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
      { v: 1, ts: t0 + 3000, session: "legacy", t: "loop_end", reason: "completed", turns: 1 },
    ]);
    const newFile = file("new.jsonl", [
      {
        // S9 shape for an engine boot: no `mode` at all, `enginePreset`
        // instead — the two vocabularies are never conflated in one field.
        v: 1,
        ts: t0,
        session: "new",
        t: "session_start",
        model: "new-model",
        provider: "p",
        enginePreset: "workspace",
        engine: "claude",
      },
      { v: 1, ts: t0 + 1000, session: "new", t: "usage", totalTokens: 33, sub: { agentType: "worker" } },
    ]);
    const stats = aggregateProfileStats([legacyFile, newFile], { now: t0, dayKey: utcDayKey });

    // Existing fields: pin exactly what they would be for the legacy file
    // alone, summed with the new file's unconditional (sub-agnostic) counts —
    // proof that new-style siblings never perturb legacy computation.
    expect(stats.lifetimeTokens).toBe(110);
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalRuns).toBe(1); // only legacy's plain loop_end
    expect(stats.toolCalls).toBe(1);
    expect(stats.days["2026-01-01"]?.tokens).toBe(110);

    // New fields: legacy session has no engine (core); new session does.
    // (This also carries what the removed `topModels` field used to pin —
    // same tokens-desc ranking, now via the full `models` list below.)
    expect(stats.models).toEqual([
      { model: "legacy-model", tokens: 77, sessions: 1 },
      { model: "new-model", tokens: 33, sessions: 1, engine: "claude" },
    ]);
    expect(stats.engineTokens).toEqual({ core: 77, claude: 33 });
  });
});

describe("aggregateProfileStats — S9 poisoned-window fixture: `mode` holding a non-PermissionMode preset id", () => {
  it("session_start.mode:\"ask\" (not a member of PERMISSION_MODES) parses and aggregates without error", () => {
    // Real-world provenance, not a hypothetical: between S5 landing and the
    // S9 fix, a codex boot wrote its preset id straight into `mode` via an
    // `as PermissionMode` cast (host/index.ts, since removed). "ask" is a
    // valid codex preset id but not a member of PERMISSION_MODES
    // (plan|build|edit|auto|yolo) — exactly the shape any file written in
    // that window would have on disk today. stats.ts never reads `.mode`
    // (§8: "поле `mode` не читает вовсе"), so this must aggregate identically
    // to a record with no `mode` at all — no throw, no skipped line.
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const poisoned = file("poisoned.jsonl", [
      { v: 1, ts: t0, session: "poisoned", t: "session_start", model: "m", provider: "p", mode: "ask", engine: "codex" },
      { v: 1, ts: t0 + 1000, session: "poisoned", t: "usage", totalTokens: 42 },
      { v: 1, ts: t0 + 2000, session: "poisoned", t: "loop_end", reason: "completed", turns: 1 },
    ]);
    expect(() => aggregateProfileStats([poisoned], { now: t0, dayKey: utcDayKey })).not.toThrow();
    const stats = aggregateProfileStats([poisoned], { now: t0, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(42);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalRuns).toBe(1);
    expect(stats.models).toEqual([{ model: "m", tokens: 42, sessions: 1, engine: "codex" }]);
    expect(stats.engineTokens).toEqual({ codex: 42 });
  });
});

describe("aggregateProfileStats — malformed envelope `sub` is fail-soft (treated as master-tier)", () => {
  it("a non-object / empty / non-string-agentType `sub` never gates as sub-tier, and never crashes the scan", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const f = file("s.jsonl", [
      { v: 1, ts: t0, session: "s", t: "session_start", model: "m", provider: "p", mode: "auto" },
      // loop_end: every one of these malformed `sub` shapes must still count
      // as a plain (master-tier) run — the reader must not throw either.
      { v: 1, ts: t0 + 1000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: "not-an-object" },
      { v: 1, ts: t0 + 2000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: null },
      { v: 1, ts: t0 + 3000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: [] },
      { v: 1, ts: t0 + 4000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: {} },
      { v: 1, ts: t0 + 5000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: { agentType: 123 } },
      { v: 1, ts: t0 + 6000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: { agentType: "" } },
      // usage: a malformed `sub.model` must still fold to the session's own
      // model rather than crashing or silently vanishing.
      { v: 1, ts: t0 + 7000, session: "s", t: "usage", totalTokens: 12, sub: { agentType: "explorer", model: 999 } },
      // Contrast case: a VALID sub still gates correctly, so this fixture
      // isn't vacuously green (it proves the malformed cases above are
      // actually being told apart from a real one).
      { v: 1, ts: t0 + 8000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: { agentType: "explorer" } },
    ]);
    const stats = aggregateProfileStats([f], { now: t0, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalRuns).toBe(6); // the 6 malformed-sub loop_ends count; the 1 valid-sub loop_end is excluded
    expect(stats.lifetimeTokens).toBe(12);
    expect(stats.models).toEqual([{ model: "m", tokens: 12, sessions: 1 }]);
    expect(stats.engineTokens).toEqual({ core: 12 });
  });
});

describe("aggregateProfileStats — days is a faithful projection of lifetimeTokens", () => {
  it("summing tokens across every days[] bucket equals lifetimeTokens exactly (Accept criterion)", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const t1 = Date.UTC(2026, 0, 2, 9, 0, 0);
    const files = [
      file("a.jsonl", [
        { v: 1, ts: t0, session: "a", t: "session_start", model: "m1", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 1000, session: "a", t: "usage", totalTokens: 17 },
        { v: 1, ts: t0 + 2000, session: "a", t: "usage", totalTokens: 8, sub: { agentType: "x" } },
        { v: 1, ts: t0 + 3000, session: "a", t: "usage", totalTokens: 5, sub: { agentType: "x", model: "override" } },
      ]),
      file("b.jsonl", [
        { v: 1, ts: t1, session: "b", t: "session_start", model: "m2", provider: "p", enginePreset: "ask", engine: "codex" },
        { v: 1, ts: t1 + 1000, session: "b", t: "usage", totalTokens: 23 },
      ]),
    ];
    const stats = aggregateProfileStats(files, { now: t1, dayKey: utcDayKey });
    const dayTokenSum = Object.values(stats.days).reduce((sum, d) => sum + d.tokens, 0);
    expect(dayTokenSum).toBe(stats.lifetimeTokens);
    // Anchor so the invariant check above isn't vacuously true on 0 == 0.
    expect(stats.lifetimeTokens).toBe(53);
  });
});

// ---------------------------------------------------------------------------
// TASK.187 S2 — per-file partials + merge (spec:
// working-docs/build/task187-aggregator-semantics.md). Everything below this
// banner is ADDITIVE: no line above it is modified, because the whole point of
// the slice is that the legacy aggregator's behavior is unchanged, and a
// touched expectation would be indistinguishable from a silent drift.

/** One fixture set run through BOTH paths and required to agree exactly. */
interface EquivalenceCase {
  label: string;
  files: ProfileStatsFile[];
  now: number;
  /** Omitted = the production default (LOCAL calendar day), exercised too. */
  dayKey?: (ts: number) => string;
}

function partialsFor(
  files: ProfileStatsFile[],
  dayKey: ((ts: number) => string) | undefined,
): { name: string; partial: ProfileFilePartial }[] {
  return files.map((f) => ({ name: f.name, partial: aggregateFilePartial(f, { dayKey }) }));
}

/**
 * The EXACT second-pass recipe the cache layer (S3) must use: re-read only the
 * files of the sessions merge reported as inexact, collect their timestamps
 * through the aggregator's own validity filter, sort the UNION, and hand
 * `sessionActiveMs` of that union back to merge. Lives in the test so the
 * contract is executable, not just prose.
 */
function exactSessionActiveMsFor(files: ProfileStatsFile[], ids: string[]): Record<string, number> {
  const byId = new Map<string, number[]>();
  for (const f of files) {
    for (const [id, ts] of Object.entries(collectSessionTimestamps(f, { sessionIds: ids }))) {
      const acc = byId.get(id);
      if (acc === undefined) byId.set(id, [...ts]);
      else acc.push(...ts);
    }
  }
  // `Object.fromEntries`, not `out[id] = v`: a session may be called
  // "__proto__", and a bare assignment would drop it from the table.
  return Object.fromEntries([...byId].map(([id, ts]) => [id, sessionActiveMs([...ts].sort((a, b) => a - b))] as const));
}

/** Legacy path with the byte cap lifted — the oracle (spec §7). */
function legacyStats(files: ProfileStatsFile[], now: number, dayKey?: (ts: number) => string) {
  return aggregateProfileStats(files, { now, dayKey, byteBudget: Infinity });
}

/** Partial-per-file -> merge, plus the exact second pass when merge asks for it. */
function mergedStats(files: ProfileStatsFile[], now: number, dayKey?: (ts: number) => string) {
  const named = partialsFor(files, dayKey);
  const first = mergeProfilePartials(named, { now, dayKey });
  if (first.crossFileSessions.length === 0) return first.stats;
  const exact = exactSessionActiveMsFor(
    files,
    first.crossFileSessions.map((s) => s.id),
  );
  return mergeProfilePartials(named, { now, dayKey, exactSessionActiveMs: exact }).stats;
}

const EQ_T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const EQ_T2 = Date.UTC(2026, 0, 2, 9, 0, 0);
const EQ_T3 = Date.UTC(2026, 0, 3, 9, 0, 0);
const eqDayTs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);

/**
 * One entry per pre-existing describe block (fixtures COPIED, not refactored
 * out of them — the old blocks must stay byte-identical), plus the cross-file
 * cases the legacy suite has no reason to cover. The byte-cap truncation block
 * is deliberately absent: the cap is a legacy-path-only contract (spec §7) and
 * `aggregateFilePartial` never truncates a file, so equivalence is asserted
 * for FULL files only. Its own pin lives in the `byteBudget` describe below.
 */
const EQUIVALENCE_CASES: EquivalenceCase[] = [
  {
    label: "full fixture (2 sessions x 3 days)",
    now: EQ_T3 + 120_000,
    dayKey: utcDayKey,
    files: [
      file("sess-a.jsonl", [
        { v: 1, ts: EQ_T1, session: "sess-a", t: "session_start", model: "model-x", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 60_000, session: "sess-a", t: "usage", totalTokens: 100 },
        { v: 1, ts: EQ_T1 + 180_000, session: "sess-a", t: "usage", totalTokens: 50 },
        { v: 1, ts: EQ_T1 + 600_000, session: "sess-a", t: "tool", tool: "Read", status: "ok", durationMs: 5 },
        { v: 1, ts: EQ_T1 + 660_000, session: "sess-a", t: "loop_end", reason: "completed", turns: 2 },
        { v: 1, ts: EQ_T1 + 720_000, session: "sess-a", t: "subagent_start", agentType: "explorer" },
      ]),
      file("sess-b.jsonl", [
        { v: 1, ts: EQ_T2, session: "sess-b", t: "session_start", model: "model-y", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T2 + 60_000, session: "sess-b", t: "usage", totalTokens: 1000 },
        { v: 1, ts: EQ_T2 + 120_000, session: "sess-b", t: "usage", totalTokens: 500 },
        { v: 1, ts: EQ_T2 + 180_000, session: "sess-b", t: "tool", tool: "Bash", status: "ok", durationMs: 10 },
        { v: 1, ts: EQ_T2 + 240_000, session: "sess-b", t: "tool", tool: "Bash", status: "ok", durationMs: 8 },
        { v: 1, ts: EQ_T2 + 300_000, session: "sess-b", t: "tool", tool: "Read", status: "ok", durationMs: 3 },
        { v: 1, ts: EQ_T2 + 360_000, session: "sess-b", t: "loop_end", reason: "completed", turns: 5 },
        { v: 1, ts: EQ_T3, session: "sess-b", t: "usage", totalTokens: 300 },
        { v: 1, ts: EQ_T3 + 60_000, session: "sess-b", t: "subagent_start", agentType: "reviewer" },
      ]),
    ],
  },
  {
    label: "fail-soft: malformed JSON line + valid line in one file",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      {
        name: "s.jsonl",
        lines: ["not json {{{", JSON.stringify({ v: 1, ts: EQ_T1, session: "s", t: "usage", totalTokens: 10 })],
      },
    ],
  },
  {
    label: "fail-soft: v !== 1 and a non-number ts",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("s.jsonl", [
        { v: 2, ts: EQ_T1, session: "s", t: "usage", totalTokens: 999 },
        { v: 1, ts: "not-a-number", session: "s", t: "usage", totalTokens: 999 },
        { v: 1, ts: EQ_T1, session: "s", t: "usage", totalTokens: 10 },
      ]),
    ],
  },
  {
    label: "fail-soft: an empty file next to a populated one",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      { name: "empty.jsonl", lines: [] },
      file("s.jsonl", [{ v: 1, ts: EQ_T1, session: "s", t: "usage", totalTokens: 3 }]),
    ],
  },
  { label: "fail-soft: no files at all", now: EQ_T1, dayKey: utcDayKey, files: [] },
  {
    label: "gap-cap: a 6-minute gap and a single-record session",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("gap.jsonl", [
        { v: 1, ts: EQ_T1, session: "gap", t: "session_start", model: "m", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 6 * 60_000, session: "gap", t: "usage", totalTokens: 1 },
      ]),
      file("lone.jsonl", [{ v: 1, ts: EQ_T1, session: "lone", t: "usage", totalTokens: 1 }]),
    ],
  },
  {
    label: "streaks: three consecutive days ending today",
    now: eqDayTs(2026, 1, 3),
    dayKey: utcDayKey,
    files: [
      file("d1.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
      file("d3.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 3), session: "d3", t: "usage", totalTokens: 1 }]),
    ],
  },
  {
    label: "streaks: a gap day breaks the run",
    now: eqDayTs(2026, 1, 4),
    dayKey: utcDayKey,
    files: [
      file("d1.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
      file("d4.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 4), session: "d4", t: "usage", totalTokens: 1 }]),
    ],
  },
  {
    label: "streaks: yesterday-only grace window",
    now: eqDayTs(2026, 1, 3),
    dayKey: utcDayKey,
    files: [
      file("d1.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }]),
      file("d2.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 2), session: "d2", t: "usage", totalTokens: 1 }]),
    ],
  },
  {
    label: "streaks: neither today nor yesterday",
    now: eqDayTs(2026, 1, 10),
    dayKey: utcDayKey,
    files: [file("d1.jsonl", [{ v: 1, ts: eqDayTs(2026, 1, 1), session: "d1", t: "usage", totalTokens: 1 }])],
  },
  {
    label: "model join: (unknown) fallback",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [file("orphan.jsonl", [{ v: 1, ts: EQ_T1, session: "orphan", t: "usage", totalTokens: 42 }])],
  },
  {
    label: "model join: tokens-desc, alphabetical tie-break",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "a", t: "session_start", model: "zeta", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "a", t: "usage", totalTokens: 5 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1, session: "b", t: "session_start", model: "alpha", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "b", t: "usage", totalTokens: 5 },
      ]),
    ],
  },
  {
    label: "hardening: unknown/missing t, Infinity tokens, negative tokens",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("u.jsonl", [{ v: 1, ts: 0, session: "u", t: "unknown" }]),
      file("v.jsonl", [{ v: 1, ts: 0, session: "v" }]),
      file("w.jsonl", [{ v: 1, ts: 0, session: "w", t: "usage", totalTokens: 1e999 }]),
      file("x.jsonl", [{ v: 1, ts: 0, session: "x", t: "usage", inputTokens: -5, outputTokens: -10 }]),
    ],
  },
  {
    // dayKey OMITTED on purpose: pins that the default LOCAL formatter is the
    // same one on both paths (spec §8).
    label: "default dayKey (local calendar day)",
    now: Date.now(),
    files: [file("s.jsonl", [{ v: 1, ts: Date.now(), session: "s", t: "usage", totalTokens: 7 }])],
  },
  {
    label: "days aggregate: multi-file bucketing",
    now: EQ_T2,
    dayKey: utcDayKey,
    files: [
      file("x.jsonl", [
        { v: 1, ts: EQ_T1, session: "sx", t: "session_start", model: "mx", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "sx", t: "usage", totalTokens: 40 },
        { v: 1, ts: EQ_T1 + 2000, session: "sx", t: "tool", tool: "Bash", status: "ok", durationMs: 1 },
        { v: 1, ts: EQ_T1 + 3000, session: "sx", t: "loop_end", reason: "completed", turns: 1 },
      ]),
      file("y.jsonl", [
        { v: 1, ts: EQ_T2, session: "sy", t: "session_start", model: "my", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T2 + 1000, session: "sy", t: "usage", totalTokens: 70 },
        { v: 1, ts: EQ_T2 + 2000, session: "sy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
        { v: 1, ts: EQ_T2 + 2500, session: "sy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
        { v: 1, ts: EQ_T2 + 3000, session: "sy", t: "subagent_start", agentType: "explorer" },
      ]),
    ],
  },
  {
    label: "deferred join: session_start AFTER usage in line order",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      {
        name: "s.jsonl",
        lines: [
          JSON.stringify({ v: 1, ts: EQ_T1 + 1000, session: "s", t: "usage", totalTokens: 99 }),
          JSON.stringify({
            v: 1,
            ts: EQ_T1,
            session: "s",
            t: "session_start",
            model: "late-bound",
            provider: "p",
            mode: "auto",
          }),
        ],
      },
    ],
  },
  {
    label: "session day = min ts, midnight-crossing session counted once",
    now: Date.UTC(2026, 0, 2, 1, 0, 0),
    dayKey: utcDayKey,
    files: [
      file("s.jsonl", [
        {
          v: 1,
          ts: Date.UTC(2026, 0, 1, 23, 0, 0),
          session: "s",
          t: "session_start",
          model: "cross",
          provider: "p",
          mode: "auto",
        },
        { v: 1, ts: Date.UTC(2026, 0, 1, 23, 0, 1), session: "s", t: "usage", totalTokens: 5 },
        { v: 1, ts: Date.UTC(2026, 0, 2, 1, 0, 0), session: "s", t: "usage", totalTokens: 8 },
      ]),
    ],
  },
  {
    label: "sub-token attribution: both branches",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("p.jsonl", [
        { v: 1, ts: EQ_T1, session: "p", t: "session_start", model: "parent-model", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "p", t: "usage", totalTokens: 10, sub: { agentType: "explorer" } },
        {
          v: 1,
          ts: EQ_T1 + 2000,
          session: "p",
          t: "usage",
          totalTokens: 25,
          sub: { agentType: "explorer", model: "child-model" },
        },
      ]),
    ],
  },
  {
    label: "sub tier: loop_end excluded from runs, tool included",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("q.jsonl", [
        { v: 1, ts: EQ_T1, session: "q", t: "session_start", model: "m", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "q", t: "loop_end", reason: "completed", turns: 1 },
        {
          v: 1,
          ts: EQ_T1 + 2000,
          session: "q",
          t: "loop_end",
          reason: "completed",
          turns: 1,
          sub: { agentType: "explorer" },
        },
        {
          v: 1,
          ts: EQ_T1 + 3000,
          session: "q",
          t: "tool",
          tool: "Grep",
          status: "ok",
          durationMs: 1,
          sub: { agentType: "explorer" },
        },
      ]),
    ],
  },
  {
    label: "full models list including a zero-token model",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "a", t: "session_start", model: "m1", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "a", t: "usage", totalTokens: 40 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1, session: "b", t: "session_start", model: "m2", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "b", t: "usage", totalTokens: 30 },
      ]),
      file("c.jsonl", [
        { v: 1, ts: EQ_T1, session: "c", t: "session_start", model: "m3", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "c", t: "usage", totalTokens: 20 },
      ]),
      file("d.jsonl", [
        { v: 1, ts: EQ_T1, session: "d", t: "session_start", model: "m4-idle", provider: "p", mode: "auto" },
      ]),
    ],
  },
  {
    label: "engine capture + first-seen wins on a shared model",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a-codex.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "c1",
          t: "session_start",
          model: "shared-model",
          provider: "p",
          enginePreset: "ask",
          engine: "codex",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "c1", t: "usage", totalTokens: 50 },
      ]),
      file("b-claude-shared.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "c2",
          t: "session_start",
          model: "shared-model",
          provider: "p",
          enginePreset: "workspace",
          engine: "claude",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "c2", t: "usage", totalTokens: 15 },
      ]),
      file("c-claude-other.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "l1",
          t: "session_start",
          model: "other-model",
          provider: "p",
          enginePreset: "workspace",
          engine: "claude",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "l1", t: "usage", totalTokens: 30 },
      ]),
      file("d-core.jsonl", [
        { v: 1, ts: EQ_T1, session: "n1", t: "session_start", model: "core-model", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "n1", t: "usage", totalTokens: 20 },
      ]),
    ],
  },
  {
    label: "mixed era: legacy `mode` record + engine record without `mode`",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("legacy.jsonl", [
        { v: 1, ts: EQ_T1, session: "legacy", t: "session_start", model: "legacy-model", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "legacy", t: "usage", totalTokens: 77 },
        { v: 1, ts: EQ_T1 + 2000, session: "legacy", t: "tool", tool: "Read", status: "ok", durationMs: 1 },
        { v: 1, ts: EQ_T1 + 3000, session: "legacy", t: "loop_end", reason: "completed", turns: 1 },
      ]),
      file("new.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "new",
          t: "session_start",
          model: "new-model",
          provider: "p",
          enginePreset: "workspace",
          engine: "claude",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "new", t: "usage", totalTokens: 33, sub: { agentType: "worker" } },
      ]),
    ],
  },
  {
    label: "poisoned window: `mode` holding a preset id",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("poisoned.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "poisoned",
          t: "session_start",
          model: "m",
          provider: "p",
          mode: "ask",
          engine: "codex",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "poisoned", t: "usage", totalTokens: 42 },
        { v: 1, ts: EQ_T1 + 2000, session: "poisoned", t: "loop_end", reason: "completed", turns: 1 },
      ]),
    ],
  },
  {
    label: "malformed envelope `sub` is fail-soft",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("s.jsonl", [
        { v: 1, ts: EQ_T1, session: "s", t: "session_start", model: "m", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: "not-an-object" },
        { v: 1, ts: EQ_T1 + 2000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: null },
        { v: 1, ts: EQ_T1 + 3000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: [] },
        { v: 1, ts: EQ_T1 + 4000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: {} },
        { v: 1, ts: EQ_T1 + 5000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: { agentType: 123 } },
        { v: 1, ts: EQ_T1 + 6000, session: "s", t: "loop_end", reason: "completed", turns: 1, sub: { agentType: "" } },
        {
          v: 1,
          ts: EQ_T1 + 7000,
          session: "s",
          t: "usage",
          totalTokens: 12,
          sub: { agentType: "explorer", model: 999 },
        },
        {
          v: 1,
          ts: EQ_T1 + 8000,
          session: "s",
          t: "loop_end",
          reason: "completed",
          turns: 1,
          sub: { agentType: "explorer" },
        },
      ]),
    ],
  },
  {
    label: "days is a faithful projection of lifetimeTokens",
    now: EQ_T2,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "a", t: "session_start", model: "m1", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "a", t: "usage", totalTokens: 17 },
        { v: 1, ts: EQ_T1 + 2000, session: "a", t: "usage", totalTokens: 8, sub: { agentType: "x" } },
        { v: 1, ts: EQ_T1 + 3000, session: "a", t: "usage", totalTokens: 5, sub: { agentType: "x", model: "override" } },
      ]),
      file("b.jsonl", [
        {
          v: 1,
          ts: EQ_T2,
          session: "b",
          t: "session_start",
          model: "m2",
          provider: "p",
          enginePreset: "ask",
          engine: "codex",
        },
        { v: 1, ts: EQ_T2 + 1000, session: "b", t: "usage", totalTokens: 23 },
      ]),
    ],
  },
  {
    // Session id absent -> keyed by FILE NAME (spec §0): two anonymous files
    // are two sessions, never one.
    label: "anonymous records key their session by file name",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("anon-a.jsonl", [
        { v: 1, ts: EQ_T1, t: "session_start", model: "anon", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, t: "usage", totalTokens: 4 },
      ]),
      file("anon-b.jsonl", [{ v: 1, ts: EQ_T1 + 2000, t: "usage", totalTokens: 6 }]),
    ],
  },
  {
    // A day that exists ONLY because of a non-counting record (spec §4).
    label: "a day carried by a non-counting record alone",
    now: EQ_T2,
    dayKey: utcDayKey,
    files: [
      file("s.jsonl", [
        { v: 1, ts: EQ_T1, session: "s", t: "session_start", model: "m", provider: "p", mode: "auto" },
        { v: 1, ts: EQ_T1 + 1000, session: "s", t: "usage", totalTokens: 9 },
        { v: 1, ts: EQ_T2, session: "s", t: "session_end", reason: "exit" },
      ]),
    ],
  },
  {
    // Two session_start records: last VALID value wins, per field (spec §2).
    label: "second session_start overrides model but not engine",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "s",
          t: "session_start",
          model: "first",
          provider: "p",
          enginePreset: "ask",
          engine: "codex",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "s", t: "usage", totalTokens: 11 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1 + 2000, session: "s", t: "session_start", model: "second", provider: "p", engine: "bogus" },
        { v: 1, ts: EQ_T1 + 3000, session: "s", t: "usage", totalTokens: 13 },
      ]),
    ],
  },
  {
    label: "cross-file session, DISJOINT segments",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 10, session: "shared", t: "usage", totalTokens: 1 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1 + 20, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 30, session: "shared", t: "usage", totalTokens: 1 },
      ]),
    ],
  },
  {
    label: "cross-file session, OVERLAPPING segments",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 10, session: "shared", t: "usage", totalTokens: 1 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1 + 5, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 15, session: "shared", t: "usage", totalTokens: 1 },
      ]),
    ],
  },
  {
    // Segments that touch exactly (firstTs[i+1] === lastTs[i]) are NOT an
    // overlap: the bridge is 0 and the first pass is already exact (spec §1).
    label: "cross-file session, segments touching at a point",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 10, session: "shared", t: "usage", totalTokens: 1 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1 + 10, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 20, session: "shared", t: "usage", totalTokens: 1 },
      ]),
    ],
  },
  {
    // Inner gaps LONGER than the cap in both segments, so the bridge is not
    // the only capped edge — pins that activeMs !== lastTs - firstTs.
    label: "cross-file session, disjoint with over-cap inner gaps",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        { v: 1, ts: EQ_T1, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 10 * 60_000, session: "shared", t: "usage", totalTokens: 1 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: EQ_T1 + 30 * 60_000, session: "shared", t: "usage", totalTokens: 1 },
        { v: 1, ts: EQ_T1 + 31 * 60_000, session: "shared", t: "usage", totalTokens: 1 },
      ]),
    ],
  },
  {
    label: "integer-like session ids in one file (first-seen order hazard)",
    now: EQ_T1,
    dayKey: utcDayKey,
    files: [
      file("a.jsonl", [
        {
          v: 1,
          ts: EQ_T1,
          session: "20",
          t: "session_start",
          model: "shared",
          provider: "p",
          enginePreset: "ask",
          engine: "codex",
        },
        { v: 1, ts: EQ_T1 + 1000, session: "20", t: "usage", totalTokens: 5 },
        {
          v: 1,
          ts: EQ_T1 + 2000,
          session: "3",
          t: "session_start",
          model: "shared",
          provider: "p",
          enginePreset: "workspace",
          engine: "claude",
        },
        { v: 1, ts: EQ_T1 + 3000, session: "3", t: "usage", totalTokens: 7 },
      ]),
    ],
  },
];

describe("TASK.187 S2 — partial+merge equivalence harness (full files)", () => {
  for (const testCase of EQUIVALENCE_CASES) {
    it(`matches aggregateProfileStats: ${testCase.label}`, () => {
      const legacy = legacyStats(testCase.files, testCase.now, testCase.dayKey);
      const merged = mergedStats(testCase.files, testCase.now, testCase.dayKey);
      expect(merged).toEqual(legacy);
    });
  }

  it("covers every legacy describe block except byte-cap truncation", () => {
    // Guard against the case list silently shrinking; the number is the count
    // of fixture sets above, not a property of the code under test.
    expect(EQUIVALENCE_CASES.length).toBeGreaterThanOrEqual(30);
  });
});

describe("TASK.187 S2 — merge is order-invariant", () => {
  it("permuting the partials does not change the merged stats", () => {
    const files = EQUIVALENCE_CASES[0]!.files;
    const now = EQUIVALENCE_CASES[0]!.now;
    const named = partialsFor(files, utcDayKey);
    const forward = mergeProfilePartials(named, { now, dayKey: utcDayKey });
    const backward = mergeProfilePartials([...named].reverse(), { now, dayKey: utcDayKey });
    expect(backward.stats).toEqual(forward.stats);
  });

  it("permuting partials preserves first-seen engine attribution", () => {
    const engineCase = EQUIVALENCE_CASES.find((c) => c.label.startsWith("engine capture"))!;
    const named = partialsFor(engineCase.files, utcDayKey);
    const reversed = mergeProfilePartials([...named].reverse(), { now: engineCase.now, dayKey: utcDayKey });
    expect(reversed.stats.models).toContainEqual({
      model: "shared-model",
      tokens: 65,
      sessions: 2,
      engine: "codex",
    });
  });
});

describe("TASK.187 S2 — dropping a file drops exactly that file's contribution", () => {
  it("merge(partials minus f) equals aggregate(files minus f)", () => {
    const all = EQUIVALENCE_CASES.find((c) => c.label.startsWith("full models list"))!;
    const kept = all.files.filter((f) => f.name !== "b.jsonl");
    const named = partialsFor(all.files, utcDayKey).filter((p) => p.name !== "b.jsonl");
    const merged = mergeProfilePartials(named, { now: all.now, dayKey: utcDayKey });
    expect(merged.stats).toEqual(legacyStats(kept, all.now, utcDayKey));
    // Not vacuous: the dropped file really did contribute.
    expect(merged.stats).not.toEqual(legacyStats(all.files, all.now, utcDayKey));
  });
});

describe("TASK.187 S2 — a partial survives a JSON round trip", () => {
  const roundTrip = (p: ProfileFilePartial): ProfileFilePartial => JSON.parse(JSON.stringify(p)) as ProfileFilePartial;

  it("is strictly equal to itself after JSON.parse(JSON.stringify(...)) — no Map/Set/undefined inside", () => {
    for (const testCase of EQUIVALENCE_CASES) {
      for (const { partial } of partialsFor(testCase.files, testCase.dayKey)) {
        expect(roundTrip(partial)).toStrictEqual(partial);
      }
    }
  });

  it("merging round-tripped partials yields the same stats as merging live ones", () => {
    for (const testCase of EQUIVALENCE_CASES) {
      const named = partialsFor(testCase.files, testCase.dayKey);
      const revived = named.map((n) => ({ name: n.name, partial: roundTrip(n.partial) }));
      const live = mergeProfilePartials(named, { now: testCase.now, dayKey: testCase.dayKey });
      const fromDisk = mergeProfilePartials(revived, { now: testCase.now, dayKey: testCase.dayKey });
      expect(fromDisk.stats).toEqual(live.stats);
      expect(fromDisk.crossFileSessions).toEqual(live.crossFileSessions);
    }
  });
});

describe("TASK.187 S2 — cross-file session activity (blocker 1)", () => {
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const seg = (name: string, tss: number[]) =>
    file(
      name,
      tss.map((ts) => ({ v: 1, ts, session: "shared", t: "usage", totalTokens: 1 })),
    );

  it("a single-file session needs no second pass and matches the legacy path", () => {
    const files = [seg("a.jsonl", [t0, t0 + 10, t0 + 20])];
    const first = mergeProfilePartials(partialsFor(files, utcDayKey), { now: t0, dayKey: utcDayKey });
    expect(first.crossFileSessions).toEqual([]);
    expect(first.stats.longestSessionMs).toBe(legacyStats(files, t0, utcDayKey).longestSessionMs);
  });

  it("DISJOINT segments are exact in the FIRST pass and are not reported", () => {
    const files = [seg("a.jsonl", [t0, t0 + 10]), seg("b.jsonl", [t0 + 20, t0 + 30])];
    const legacy = legacyStats(files, t0, utcDayKey);
    const first = mergeProfilePartials(partialsFor(files, utcDayKey), { now: t0, dayKey: utcDayKey });
    expect(first.crossFileSessions).toEqual([]);
    expect(first.stats.longestSessionMs).toBe(legacy.longestSessionMs);
    // Anchor: the union-sorted legacy answer is 30, NOT the naive per-file
    // sum of 20 — the inter-segment gap counts.
    expect(legacy.longestSessionMs).toBe(30);
  });

  it("OVERLAPPING segments are reported, and the exact second pass matches the legacy path", () => {
    const files = [seg("a.jsonl", [t0, t0 + 10]), seg("b.jsonl", [t0 + 5, t0 + 15])];
    const legacy = legacyStats(files, t0, utcDayKey);
    const named = partialsFor(files, utcDayKey);
    const first = mergeProfilePartials(named, { now: t0, dayKey: utcDayKey });

    expect(first.crossFileSessions).toEqual([{ id: "shared", files: ["a.jsonl", "b.jsonl"] }]);
    // The first pass is the naive-ish bridge sum (20) and is KNOWN to differ
    // from the legacy union-sort (15) — that difference is the whole reason
    // the second pass exists.
    expect(first.stats.longestSessionMs).toBe(20);
    expect(legacy.longestSessionMs).toBe(15);

    const exact = exactSessionActiveMsFor(
      files,
      first.crossFileSessions.map((s) => s.id),
    );
    expect(exact).toEqual({ shared: 15 });
    const second = mergeProfilePartials(named, { now: t0, dayKey: utcDayKey, exactSessionActiveMs: exact });
    expect(second.stats).toEqual(legacy);
  });

  it("a fully nested segment counts as an overlap", () => {
    const files = [seg("a.jsonl", [t0, t0 + 100]), seg("b.jsonl", [t0 + 40, t0 + 50])];
    const first = mergeProfilePartials(partialsFor(files, utcDayKey), { now: t0, dayKey: utcDayKey });
    expect(first.crossFileSessions.map((s) => s.id)).toEqual(["shared"]);
  });

  it("collectSessionTimestamps applies the aggregator's validity filter and honors the id filter", () => {
    const f = file("mixed.jsonl", [
      { v: 1, ts: 1, session: "keep", t: "usage", totalTokens: 1 },
      { v: 1, ts: 2, session: "keep", t: "unknown-variant" },
      { v: 2, ts: 3, session: "keep", t: "usage", totalTokens: 1 },
      { v: 1, ts: "nope", session: "keep", t: "usage", totalTokens: 1 },
      { v: 1, ts: 5, session: "other", t: "usage", totalTokens: 1 },
      { v: 1, ts: 6, t: "usage", totalTokens: 1 },
    ]);
    expect(collectSessionTimestamps(f, { sessionIds: ["keep"] })).toEqual({ keep: [1] });
    // No id filter: every session in the file, including the file-name-keyed
    // anonymous one.
    expect(collectSessionTimestamps(f)).toEqual({ keep: [1], other: [5], "mixed.jsonl": [6] });
  });

  it("sessionActiveMs caps each gap and returns 0 for 0/1 timestamps", () => {
    expect(sessionActiveMs([])).toBe(0);
    expect(sessionActiveMs([5])).toBe(0);
    expect(sessionActiveMs([0, 10, 20])).toBe(20);
    expect(sessionActiveMs([0, 10 * 60_000])).toBe(PROFILE_ACTIVITY_GAP_CAP_MS);
  });

  it("an exactSessionActiveMs entry is used even for a session merge did not report", () => {
    const files = [seg("a.jsonl", [t0, t0 + 10])];
    const merged = mergeProfilePartials(partialsFor(files, utcDayKey), {
      now: t0,
      dayKey: utcDayKey,
      exactSessionActiveMs: { shared: 4242 },
    });
    expect(merged.stats.longestSessionMs).toBe(4242);
  });

  it("a prototype-named session id cannot pull a function out of exactSessionActiveMs", () => {
    const files = [
      file("a.jsonl", [
        { v: 1, ts: t0, session: "constructor", t: "usage", totalTokens: 1 },
        { v: 1, ts: t0 + 10, session: "constructor", t: "usage", totalTokens: 1 },
      ]),
    ];
    const merged = mergeProfilePartials(partialsFor(files, utcDayKey), { now: t0, dayKey: utcDayKey });
    expect(merged.stats.longestSessionMs).toBe(10);
  });
});

describe("TASK.187 S2 — totalSessions counts FILES, not sessions", () => {
  it("one session spread over two files still counts as two files and one model session", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      file("a.jsonl", [
        { v: 1, ts: t0, session: "shared", t: "session_start", model: "m", provider: "p", mode: "auto" },
        { v: 1, ts: t0 + 10, session: "shared", t: "usage", totalTokens: 4 },
      ]),
      file("b.jsonl", [{ v: 1, ts: t0 + 20, session: "shared", t: "usage", totalTokens: 6 }]),
    ];
    const merged = mergedStats(files, t0, utcDayKey);
    expect(merged).toEqual(legacyStats(files, t0, utcDayKey));
    expect(merged.totalSessions).toBe(2);
    expect(merged.models).toEqual([{ model: "m", tokens: 10, sessions: 1 }]);
  });

  it("a file with no valid record is not counted, even next to a valid one", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      file("junk.jsonl", [{ v: 1, ts: t0, session: "j", t: "not-a-variant" }]),
      file("ok.jsonl", [{ v: 1, ts: t0, session: "o", t: "usage", totalTokens: 1 }]),
    ];
    expect(mergedStats(files, t0, utcDayKey).totalSessions).toBe(1);
  });
});

describe("TASK.187 S2 — first-seen engine survives integer-like session ids", () => {
  it("the partial's session array keeps insertion order through JSON, unlike an object", () => {
    // The hazard this pins: an object keyed by session id renumbers
    // integer-like keys on a JSON round trip, which would silently flip
    // "first-seen wins" for the model's engine.
    expect(Object.keys(JSON.parse(JSON.stringify({ "20": 1, "3": 1 })))).toEqual(["3", "20"]);

    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const files = [
      file("a.jsonl", [
        {
          v: 1,
          ts: t0,
          session: "20",
          t: "session_start",
          model: "shared",
          provider: "p",
          enginePreset: "ask",
          engine: "codex",
        },
        { v: 1, ts: t0 + 1000, session: "20", t: "usage", totalTokens: 5 },
        {
          v: 1,
          ts: t0 + 2000,
          session: "3",
          t: "session_start",
          model: "shared",
          provider: "p",
          enginePreset: "workspace",
          engine: "claude",
        },
        { v: 1, ts: t0 + 3000, session: "3", t: "usage", totalTokens: 7 },
      ]),
    ];
    const named = partialsFor(files, utcDayKey);
    expect(named[0]!.partial.sessions.map((s) => s.id)).toEqual(["20", "3"]);

    const revived = named.map((n) => ({
      name: n.name,
      partial: JSON.parse(JSON.stringify(n.partial)) as ProfileFilePartial,
    }));
    const merged = mergeProfilePartials(revived, { now: t0, dayKey: utcDayKey });
    expect(merged.stats.models).toEqual([{ model: "shared", tokens: 12, sessions: 2, engine: "codex" }]);
    expect(merged.stats).toEqual(legacyStats(files, t0, utcDayKey));
  });
});

describe("TASK.187 S2 — byteBudget option (uncapped oracle)", () => {
  it("byteBudget: Infinity reads past PROFILE_STATS_MAX_SCAN_BYTES; the default still truncates", () => {
    const oneMiB = 1024 * 1024;
    const FIXED_TS = 1_700_000_000_000;
    const baseLenWithoutPad = JSON.stringify({
      v: 1,
      ts: FIXED_TS,
      session: "big",
      t: "usage",
      totalTokens: 1,
      pad: "",
    }).length;
    const padLen = oneMiB - baseLenWithoutPad;
    const lines: string[] = [];
    for (let i = 0; i < 65; i += 1) {
      lines.push(JSON.stringify({ v: 1, ts: FIXED_TS, session: "big", t: "usage", totalTokens: 1, pad: "x".repeat(padLen) }));
    }
    expect(65 * oneMiB).toBeGreaterThan(PROFILE_STATS_MAX_SCAN_BYTES);

    const capped = aggregateProfileStats([{ name: "big.jsonl", lines }], { now: 100, dayKey: () => "2026-01-01" });
    expect(capped.truncated).toBe(true);
    expect(capped.lifetimeTokens).toBe(64);

    const uncapped = aggregateProfileStats([{ name: "big.jsonl", lines }], {
      now: 100,
      dayKey: () => "2026-01-01",
      byteBudget: Infinity,
    });
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.lifetimeTokens).toBe(65);

    // aggregateFilePartial has no cap at all (spec §7): it reads all 65.
    const partial = aggregateFilePartial({ name: "big.jsonl", lines }, { dayKey: () => "2026-01-01" });
    expect(partial.days["2026-01-01"]?.tokens).toBe(65);
    const merged = mergeProfilePartials([{ name: "big.jsonl", partial }], { now: 100, dayKey: () => "2026-01-01" });
    expect(merged.stats.lifetimeTokens).toBe(65);
    // Truncation is the scanning layer's flag, never merge's (spec §7).
    expect(merged.stats.truncated).toBe(false);
  });

  it("an explicit finite byteBudget truncates exactly where the legacy default would", () => {
    const f = file("s.jsonl", [
      { v: 1, ts: 1, session: "s", t: "usage", totalTokens: 5 },
      { v: 1, ts: 2, session: "s", t: "usage", totalTokens: 7 },
    ]);
    const firstLineLen = [...f.lines][0]!.length;
    const stats = aggregateProfileStats([f], { now: 100, dayKey: utcDayKey, byteBudget: firstLineLen });
    expect(stats.truncated).toBe(true);
    expect(stats.lifetimeTokens).toBe(5);
  });
});

describe("TASK.187 S2 — randomized cross-check against the legacy aggregator", () => {
  /** Deterministic LCG: a failing run is reproducible from its printed seed. */
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
  }

  const RECORD_TYPES = [
    "usage",
    "usage",
    "usage",
    "tool",
    "tool",
    "loop_end",
    "subagent_start",
    "session_start",
    "session_end",
    "context_usage",
    "error",
  ];
  // "__proto__" is a legal model/tool/session name: every one of them reaches
  // a plain-object accumulator somewhere, where a bare `obj[key] = v` writes
  // the prototype instead of an own property and the value silently vanishes.
  const MODELS = ["alpha", "beta", "gamma", "__proto__"];
  const ENGINES = [undefined, "codex", "claude", "bogus"];
  const TOOLS = ["Read", "Bash", "__proto__"];
  const SESSION_IDS = ["s0", "s1", "__proto__"];
  const DAY0 = Date.UTC(2026, 2, 1, 0, 0, 0);

  /**
   * A directory of files whose sessions deliberately straddle file boundaries
   * (the id pool is smaller than the file count), so overlapping segments —
   * the one case the first merge pass cannot compute exactly — occur often.
   */
  function randomFiles(rnd: () => number): ProfileStatsFile[] {
    const fileCount = 2 + Math.floor(rnd() * 6);
    const files: ProfileStatsFile[] = [];
    for (let f = 0; f < fileCount; f += 1) {
      const lines: string[] = [];
      const recordCount = Math.floor(rnd() * 12);
      for (let i = 0; i < recordCount; i += 1) {
        const roll = rnd();
        if (roll < 0.06) {
          lines.push("}{ not json");
          continue;
        }
        if (roll < 0.1) {
          lines.push(JSON.stringify({ v: 2, ts: DAY0, session: "s1", t: "usage", totalTokens: 9999 }));
          continue;
        }
        if (roll < 0.14) {
          lines.push(JSON.stringify({ v: 1, ts: DAY0, session: "s1", t: "phantom-variant" }));
          continue;
        }
        const rec: Record<string, unknown> = {
          v: 1,
          // Up to ~4 days out, in 90-second steps: plenty of gaps on both
          // sides of PROFILE_ACTIVITY_GAP_CAP_MS, and several distinct days.
          ts: DAY0 + Math.floor(rnd() * 4000) * 90_000,
          t: RECORD_TYPES[Math.floor(rnd() * RECORD_TYPES.length)]!,
        };
        if (rnd() < 0.85) rec.session = SESSION_IDS[Math.floor(rnd() * SESSION_IDS.length)]!;
        if (rec.t === "usage") {
          if (rnd() < 0.7) rec.totalTokens = Math.floor(rnd() * 500);
          else {
            rec.inputTokens = Math.floor(rnd() * 200);
            rec.outputTokens = Math.floor(rnd() * 200);
          }
        }
        if (rec.t === "tool") rec.tool = TOOLS[Math.floor(rnd() * TOOLS.length)]!;
        if (rec.t === "session_start") {
          if (rnd() < 0.85) rec.model = MODELS[Math.floor(rnd() * MODELS.length)]!;
          const engine = ENGINES[Math.floor(rnd() * ENGINES.length)];
          if (engine !== undefined) rec.engine = engine;
        }
        if (rnd() < 0.2) {
          rec.sub = rnd() < 0.5 ? { agentType: "worker" } : { agentType: "worker", model: `child-${Math.floor(rnd() * 2)}` };
        }
        lines.push(JSON.stringify(rec));
      }
      files.push({ name: `f${f}.jsonl`, lines });
    }
    return files;
  }

  it("300 random directories agree field-for-field, second pass included", () => {
    let sawCrossFile = false;
    let sawTokens = false;
    for (let seed = 1; seed <= 300; seed += 1) {
      const rnd = lcg(seed * 7919);
      const files = randomFiles(rnd);
      const now = DAY0 + Math.floor(rnd() * 5) * 86_400_000;
      const legacy = legacyStats(files, now, utcDayKey);
      const named = partialsFor(files, utcDayKey);
      const first = mergeProfilePartials(named, { now, dayKey: utcDayKey });
      let merged = first.stats;
      if (first.crossFileSessions.length > 0) {
        sawCrossFile = true;
        const exact = exactSessionActiveMsFor(
          files,
          first.crossFileSessions.map((s) => s.id),
        );
        merged = mergeProfilePartials(named, { now, dayKey: utcDayKey, exactSessionActiveMs: exact }).stats;
      }
      if (legacy.lifetimeTokens > 0) sawTokens = true;
      expect(merged, `seed ${seed}`).toEqual(legacy);
    }
    // The generator really did produce the hard cases it is meant to.
    expect(sawCrossFile).toBe(true);
    expect(sawTokens).toBe(true);
  });

  it("every generated session's cluster fold equals its union-sort activity, in any participant order", () => {
    let sawMultiCluster = false;
    let sawMultiFile = false;
    for (let seed = 1; seed <= 300; seed += 1) {
      const rnd = lcg(seed * 7919);
      const files = randomFiles(rnd);

      // Per session: the timestamps each FILE contributes, in file order —
      // exactly the unit of work the incremental cache folds one pass at a time.
      const perFile = new Map<string, number[][]>();
      for (const f of files) {
        for (const [id, ts] of Object.entries(collectSessionTimestamps(f))) {
          const acc = perFile.get(id);
          if (acc === undefined) perFile.set(id, [[...ts]]);
          else acc.push([...ts]);
        }
      }

      for (const [id, chunks] of perFile) {
        if (chunks.length > 1) sawMultiFile = true;
        const flat = chunks.flat().sort((a, b) => a - b);
        const truth = sessionActiveMs(flat);

        let clusters: ActivityCluster[] = [];
        for (const chunk of chunks) clusters = mergeActivityClusters(clusters, chunk);
        if (clusters.length > 1) sawMultiCluster = true;
        expect(clustersActiveMs(clusters), `seed ${seed} session ${id}`).toBe(truth);

        // Associativity/commutativity is the whole reason clusters (not raw
        // timestamps) are the cross-pass state: reversing the order in which
        // participants are folded in must not change the answer.
        let reversed: ActivityCluster[] = [];
        for (const chunk of [...chunks].reverse()) reversed = mergeActivityClusters(reversed, chunk);
        expect(clustersActiveMs(reversed), `seed ${seed} session ${id} reversed`).toBe(truth);

        // Folding cluster lists into each other (two half-done passes meeting)
        // must agree with folding raw timestamps.
        const half = Math.floor(chunks.length / 2);
        let left: ActivityCluster[] = [];
        for (const chunk of chunks.slice(0, half)) left = mergeActivityClusters(left, chunk);
        let right: ActivityCluster[] = [];
        for (const chunk of chunks.slice(half)) right = mergeActivityClusters(right, chunk);
        expect(clustersActiveMs(mergeActivityClusters(left, right)), `seed ${seed} session ${id} halves`).toBe(truth);
      }
    }
    expect(sawMultiCluster).toBe(true);
    expect(sawMultiFile).toBe(true);
  });
});

describe("TASK.187 — prototype-named keys reach plain-object accumulators", () => {
  const T = Date.UTC(2026, 4, 1, 9, 0, 0);
  const NOW = T + 60_000;

  it("a sub-model named __proto__ is not swallowed by the partial path", () => {
    // The legacy scan accumulates sub-model tokens in a Map and reports the
    // model; a partial that accumulates them in `{}` loses the whole bucket,
    // taking `models[]` and `days[d].models` with it.
    const files = [
      file("a.jsonl", [
        { v: 1, ts: T, session: "s", t: "session_start", model: "alpha", provider: "p", mode: "auto" },
        { v: 1, ts: T + 10, session: "s", t: "usage", totalTokens: 40, sub: { agentType: "worker", model: "__proto__" } },
      ]),
    ];
    const merged = mergedStats(files, NOW, utcDayKey);
    expect(merged).toEqual(legacyStats(files, NOW, utcDayKey));
    expect(merged.models.map((m) => m.model)).toContain("__proto__");
  });

  it("a tool named __proto__ is not swallowed by the partial path", () => {
    const files = [
      file("a.jsonl", [{ v: 1, ts: T, session: "s", t: "tool", tool: "__proto__", status: "ok", durationMs: 2 }]),
    ];
    const merged = mergedStats(files, NOW, utcDayKey);
    expect(merged).toEqual(legacyStats(files, NOW, utcDayKey));
    expect(Object.values(merged.days).flatMap((d) => Object.keys(d.tools))).toEqual(["__proto__"]);
  });

  it("a session named __proto__ keeps its exact cross-file activity", () => {
    const files = [
      file("a.jsonl", [
        { v: 1, ts: T, session: "__proto__", t: "usage", totalTokens: 1 },
        { v: 1, ts: T + 10, session: "__proto__", t: "usage", totalTokens: 1 },
      ]),
      file("b.jsonl", [
        { v: 1, ts: T + 5, session: "__proto__", t: "usage", totalTokens: 1 },
        { v: 1, ts: T + 15, session: "__proto__", t: "usage", totalTokens: 1 },
      ]),
    ];
    expect(mergedStats(files, NOW, utcDayKey)).toEqual(legacyStats(files, NOW, utcDayKey));
    expect(mergedStats(files, NOW, utcDayKey).longestSessionMs).toBe(15);
  });
});

describe("TASK.187 S3 — activity clusters", () => {
  const CAP = PROFILE_ACTIVITY_GAP_CAP_MS;

  it("folds timestamps into canonical, disjoint, cap-split clusters", () => {
    expect(mergeActivityClusters([], [])).toEqual([]);
    expect(mergeActivityClusters([], [5])).toEqual([[5, 5]]);
    // A gap of exactly the cap joins; one millisecond more splits.
    expect(mergeActivityClusters([], [0, CAP])).toEqual([[0, CAP]]);
    expect(mergeActivityClusters([], [0, CAP + 1])).toEqual([
      [0, 0],
      [CAP + 1, CAP + 1],
    ]);
    // Out-of-order input, and a point that bridges two existing clusters.
    expect(mergeActivityClusters([[0, 0], [2 * CAP, 2 * CAP]], [CAP])).toEqual([[0, 2 * CAP]]);
    expect(mergeActivityClusters([], [30, 10, 20])).toEqual([[10, 30]]);
  });

  it("reproduces sessionActiveMs on the three counterexamples of the review", () => {
    // 1) The 700 000 case: three per-file segments, the last one far away.
    const chunksA = [
      [0, 1_000_000],
      [100_000, 200_000],
      [300_000, 400_000],
    ];
    let clustersA: ActivityCluster[] = [];
    for (const chunk of chunksA) clustersA = mergeActivityClusters(clustersA, chunk);
    expect(clustersActiveMs(clustersA)).toBe(700_000);
    expect(clustersActiveMs(clustersA)).toBe(sessionActiveMs(chunksA.flat().sort((a, b) => a - b)));

    // 2) Overlapping segments [0,10] / [5,15]: the bridge formula says 20.
    let clustersB: ActivityCluster[] = [];
    for (const chunk of [[0, 10], [5, 15]]) clustersB = mergeActivityClusters(clustersB, chunk);
    expect(clustersActiveMs(clustersB)).toBe(15);

    // 3) Non-overlapping segments [0,10] / [20,30] with a bridged gap.
    let clustersC: ActivityCluster[] = [];
    for (const chunk of [[0, 10], [20, 30]]) clustersC = mergeActivityClusters(clustersC, chunk);
    expect(clustersActiveMs(clustersC)).toBe(30);
  });

  it("drops non-finite input and normalises a reversed pair (cluster state comes off an untrusted cache)", () => {
    expect(mergeActivityClusters([], [Number.NaN, 7, Number.POSITIVE_INFINITY])).toEqual([[7, 7]]);
    expect(mergeActivityClusters([[9, 4]], [])).toEqual([[4, 9]]);
  });

  it("counts one capped bridge per cluster boundary", () => {
    expect(clustersActiveMs([])).toBe(0);
    expect(clustersActiveMs([[10, 40]])).toBe(30);
    expect(
      clustersActiveMs([
        [0, 10],
        [10 * CAP, 10 * CAP + 5],
      ]),
    ).toBe(15 + CAP);
  });
});

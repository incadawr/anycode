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

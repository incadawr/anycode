/**
 * stats.test.ts (slice P7.22/F19 W1): aggregateProfileStats — every ProfileStats
 * field pinned exactly against hand-computed sums, fail-soft malformed-line
 * handling, the byte-cap truncation flag, gap-capped active duration, streak
 * edges (grace + gap-day break), model join + "(unknown)" fallback, and
 * topTools ordering/cap. All tests inject a UTC dayKey formatter of the
 * YYYY-MM-DD shape for determinism (owner-facing local-day math is exercised
 * once via the default formatter in its own test).
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
      dailyTokens: { "2026-01-01": 150, "2026-01-02": 1500, "2026-01-03": 300 },
      totalSessions: 2,
      totalRuns: 2,
      toolCalls: 4,
      subagentRuns: 2,
      topTools: [
        { name: "Bash", count: 2 },
        { name: "Read", count: 2 },
      ],
      topModels: [
        { model: "model-y", tokens: 1800 },
        { model: "model-x", tokens: 150 },
      ],
      truncated: false,
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
      dailyTokens: {},
      totalSessions: 0,
      totalRuns: 0,
      toolCalls: 0,
      subagentRuns: 0,
      topTools: [],
      topModels: [],
      truncated: false,
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
    expect(stats.topModels).toEqual([{ model: "(unknown)", tokens: 42 }]);
  });

  it("ranks topModels by descending tokens, tie-broken alphabetically", () => {
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
    expect(stats.topModels).toEqual([
      { model: "alpha", tokens: 5 },
      { model: "zeta", tokens: 5 },
    ]);
  });
});

describe("aggregateProfileStats — topTools ordering + top-5 cap", () => {
  it("caps topTools at 5, descending by count", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const toolCounts: Record<string, number> = { Read: 6, Write: 5, Bash: 4, Edit: 3, Grep: 2, Glob: 1 };
    const records: unknown[] = [];
    let ts = t0;
    for (const [tool, count] of Object.entries(toolCounts)) {
      for (let i = 0; i < count; i += 1) {
        records.push({ v: 1, ts: ts++, session: "s", t: "tool", tool, status: "ok", durationMs: 1 });
      }
    }
    const stats = aggregateProfileStats([file("s.jsonl", records)], { now: t0, dayKey: utcDayKey });
    expect(stats.topTools).toEqual([
      { name: "Read", count: 6 },
      { name: "Write", count: 5 },
      { name: "Bash", count: 4 },
      { name: "Edit", count: 3 },
      { name: "Grep", count: 2 },
    ]);
  });
});

describe("aggregateProfileStats — malformed record hardening (W5-FIX finding 2, codex R1 P2-B)", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("PoC-1: an unknown t discriminant is skipped like a malformed line — no phantom session/model/streak day", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s", t: "unknown" }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(0);
    expect(stats.dailyTokens).toEqual({});
    expect(stats.topModels).toEqual([]);
    expect(stats.currentStreakDays).toBe(0);
    expect(stats.longestStreakDays).toBe(0);
  });

  it("a missing t discriminant (envelope-only line) is skipped the same way", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s" }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.totalSessions).toBe(0);
    expect(stats.dailyTokens).toEqual({});
  });

  it("PoC-2: a non-finite totalTokens is clamped to 0, never propagates Infinity into any total", () => {
    const f = file("s.jsonl", [{ v: 1, ts: 0, session: "s", t: "usage", totalTokens: 1e999 }]);
    const stats = aggregateProfileStats([f], { now, dayKey: utcDayKey });
    expect(stats.lifetimeTokens).toBe(0);
    expect(Number.isFinite(stats.lifetimeTokens)).toBe(true);
    expect(stats.peakDay === null || stats.peakDay.tokens === 0).toBe(true);
    for (const tokens of Object.values(stats.dailyTokens)) {
      expect(Number.isFinite(tokens)).toBe(true);
    }
    for (const m of stats.topModels) {
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
    expect(stats.dailyTokens).toEqual({ [expectedDay]: 7 });
  });
});

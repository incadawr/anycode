/**
 * Pure-logic tests for ProfilePane's exported helpers (P7.22/F19 W3, design
 * slice-P7.22-cut.md §1/§2-D2/§2-D3 W3 gate). Same `.test.ts`-only, no-jsdom
 * rationale as every other Settings pane in this directory (vitest.config.ts
 * runs `environment: "node"`, no jsdom/@testing-library in the tree — see
 * SkillsPane.test.ts's own docstring): every behavior the gate asks for
 * (tile formatting incl. 0/absent, the 4-branch empty-state matrix, heatmap
 * cell count/intensity bucketing, the toggle's flip/disabled logic) is
 * exercised through the component's exported pure functions — the exact
 * values its click handlers and render branches feed from.
 */
import { describe, expect, it } from "vitest";
import type { ProfileDayStatsView, ProfileStatsResult, ProfileStatsView } from "../../../shared/profile-config.js";
import { initialProfileLoadState } from "./profile-loader.js";
import {
  buildHeatmapCells,
  buildProfileTiles,
  computeIntensityBuckets,
  computeProfileBranch,
  coverageCollapseNoteText,
  coverageNotice,
  formatCompactTokens,
  formatDuration,
  HEATMAP_WEEKS,
  hasProfileData,
  heatmapMonthLabels,
  isActivityRefining,
  isTelemetryToggleDisabled,
  isTelemetryToggleHeld,
  nextTelemetryToggleValue,
  PROFILE_REFINING_NOTE,
  periodStartKey,
  profileBusyNoteText,
  profilePaneDataAttributes,
  PROFILE_MODELS_COLLAPSED_ROWS,
  PROFILE_PERIODS,
  sumWindow,
  tokensByDay,
  truncatedNoteText,
  visibleModelRows,
} from "./ProfilePane.js";

function day(overrides: Partial<ProfileDayStatsView> = {}): ProfileDayStatsView {
  return { tokens: 0, runs: 0, toolCalls: 0, subagentRuns: 0, sessions: 0, tools: {}, models: {}, ...overrides };
}

function view(overrides: Partial<ProfileStatsView> = {}): ProfileStatsView {
  return {
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
    coverageStartTs: null,
    backlogRemaining: 0,
    pendingExactSessions: 0,
    days: {},
    models: [],
    engineTokens: {},
    telemetryEnabled: false,
    killSwitchActive: false,
    dir: "/Users/x/.anycode/telemetry",
    ...overrides,
  };
}

// ── formatCompactTokens (design §1: "1.1bn", "44m", "12.3k") ──

describe("formatCompactTokens", () => {
  it("pins the exact ref-PNG examples", () => {
    expect(formatCompactTokens(1_100_000_000)).toBe("1.1bn");
    expect(formatCompactTokens(44_000_000)).toBe("44m");
    expect(formatCompactTokens(12_300)).toBe("12.3k");
  });

  it("values under 1000 render as-is (rounded)", () => {
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(42.4)).toBe("42");
  });

  it("a clean multiple never shows a false-precision trailing .0", () => {
    expect(formatCompactTokens(2_000)).toBe("2k");
    expect(formatCompactTokens(3_000_000)).toBe("3m");
  });

  it("non-finite or non-positive input is never NaN", () => {
    expect(formatCompactTokens(Number.NaN)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
  });
});

// ── formatDuration (design §2-D3.3 measurement; F5#1b relabels the tile "Longest task") ──

describe("formatDuration", () => {
  it("pins the exact ref-PNG examples", () => {
    expect(formatDuration(2 * 3_600_000 + 41 * 60_000)).toBe("2h 41m");
    expect(formatDuration(44 * 60_000)).toBe("44m");
    expect(formatDuration(3_000)).toBe("3s");
  });

  it("zero/absent duration is an honest 0s, never NaN", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });

  it("shows at most two units — hours+minutes OR minutes alone OR seconds alone", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(60_000)).toBe("1m");
  });
});

// ── buildProfileTiles (design §1.1: 5-tile row, exact ref order) ──

describe("buildProfileTiles", () => {
  it("renders the 5 tiles in ref order with compact/duration/day formatting", () => {
    const tiles = buildProfileTiles(
      view({
        lifetimeTokens: 1_100_000_000,
        peakDay: { day: "2026-07-04", tokens: 44_000_000 },
        longestSessionMs: 2 * 3_600_000 + 41 * 60_000,
        currentStreakDays: 5,
        longestStreakDays: 17,
      }),
    );
    expect(tiles).toEqual([
      { label: "Lifetime tokens", value: "1.1bn" },
      { label: "Peak tokens · 1 day", value: "44m" },
      { label: "Longest task", value: "2h 41m" },
      { label: "Current streak", value: "5 days" },
      { label: "Longest streak", value: "17 days" },
    ]);
  });

  it("peakDay === null -> '—', never '0' or NaN (only field with a null-able shape)", () => {
    const tiles = buildProfileTiles(view({ peakDay: null }));
    expect(tiles[1]).toEqual({ label: "Peak tokens · 1 day", value: "—" });
  });

  it("an all-zero view renders honest zero values, not NaN/undefined", () => {
    const tiles = buildProfileTiles(view());
    expect(tiles).toEqual([
      { label: "Lifetime tokens", value: "0" },
      { label: "Peak tokens · 1 day", value: "—" },
      { label: "Longest task", value: "0s" },
      { label: "Current streak", value: "0 days" },
      { label: "Longest streak", value: "0 days" },
    ]);
  });

  it("singular '1 day' — pluralization is not a hardcoded 's'", () => {
    const tiles = buildProfileTiles(view({ currentStreakDays: 1, longestStreakDays: 1 }));
    expect(tiles[3]!.value).toBe("1 day");
    expect(tiles[4]!.value).toBe("1 day");
  });
});

// ── empty-state matrix (design §2-D2, all 4 branches) ──

describe("computeProfileBranch", () => {
  it("no data + disabled -> hero", () => {
    const result: ProfileStatsResult = { ok: true, view: view({ telemetryEnabled: false }) };
    expect(computeProfileBranch(result)).toBe("hero");
  });

  it("data + disabled -> banner (frozen stats)", () => {
    const result: ProfileStatsResult = {
      ok: true,
      view: view({ telemetryEnabled: false, lifetimeTokens: 500 }),
    };
    expect(computeProfileBranch(result)).toBe("banner");
  });

  it("data + enabled -> normal (full stats, toggle on)", () => {
    const result: ProfileStatsResult = {
      ok: true,
      view: view({ telemetryEnabled: true, lifetimeTokens: 500 }),
    };
    expect(computeProfileBranch(result)).toBe("normal");
  });

  it("no data + enabled -> normal too (fresh opt-in shows real UI with honest zeroes, not a scary hero)", () => {
    const result: ProfileStatsResult = { ok: true, view: view({ telemetryEnabled: true }) };
    expect(computeProfileBranch(result)).toBe("normal");
  });

  it("getStats refusal -> io-error, regardless of anything else", () => {
    const result: ProfileStatsResult = { ok: false, reason: "io_error" };
    expect(computeProfileBranch(result)).toBe("io-error");
  });
});

describe("hasProfileData", () => {
  it("any of lifetimeTokens/totalSessions/days non-empty counts as data", () => {
    expect(hasProfileData(view())).toBe(false);
    expect(hasProfileData(view({ lifetimeTokens: 1 }))).toBe(true);
    expect(hasProfileData(view({ totalSessions: 1 }))).toBe(true);
    expect(hasProfileData(view({ days: { "2026-07-01": day({ tokens: 1 }) } }))).toBe(true);
  });
});

// ── heatmap (design §1.2/§2-D3.6) ──

const FIXED_TODAY = new Date(2026, 6, 10); // 2026-07-10 local, matches currentDate context

describe("buildHeatmapCells", () => {
  it("produces ~HEATMAP_WEEKS full 7-day columns ending on `today` (week count varies +-1 by calendar alignment — the grid backs up to a Sunday boundary)", () => {
    const weeks = buildHeatmapCells({}, FIXED_TODAY);
    expect(weeks.length).toBeGreaterThanOrEqual(HEATMAP_WEEKS);
    expect(weeks.length).toBeLessThanOrEqual(HEATMAP_WEEKS + 1);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
    const days = weeks.flat().map((c) => c.day).filter((d): d is string => d !== null);
    expect(days.reduce((max, d) => (d > max ? d : max))).toBe("2026-07-10");
  });

  it("a known 3-day dailyTokens map yields exactly 3 non-null day cells carrying those tokens", () => {
    const dailyTokens = { "2026-07-08": 100, "2026-07-09": 5_000, "2026-07-10": 500 };
    const weeks = buildHeatmapCells(dailyTokens, FIXED_TODAY);
    const dataCells = weeks.flat().filter((c) => c.day !== null && c.tokens > 0);
    expect(dataCells).toHaveLength(3);
    expect(dataCells.map((c) => c.tokens).sort((a, b) => a - b)).toEqual([100, 500, 5_000]);
  });

  it("padding cells before the 12-month window render day: null, bucket: 0", () => {
    const weeks = buildHeatmapCells({}, FIXED_TODAY);
    const firstCell = weeks[0]![0]!;
    expect(firstCell.bucket).toBe(0);
  });

  it("a high-token day gets a strictly higher bucket than a low-token day", () => {
    const dailyTokens = { "2026-07-01": 10, "2026-07-02": 1_000, "2026-07-03": 100_000 };
    const weeks = buildHeatmapCells(dailyTokens, FIXED_TODAY);
    const byDay = new Map(weeks.flat().filter((c) => c.day !== null).map((c) => [c.day!, c.bucket]));
    expect(byDay.get("2026-07-01")!).toBeGreaterThan(0);
    expect(byDay.get("2026-07-03")!).toBeGreaterThan(byDay.get("2026-07-01")!);
  });

  it("an empty dailyTokens map -> every cell is bucket 0 (design §2-D2 hero path)", () => {
    const weeks = buildHeatmapCells({}, FIXED_TODAY);
    expect(weeks.flat().every((c) => c.bucket === 0)).toBe(true);
  });
});

describe("computeIntensityBuckets", () => {
  it("empty map -> always bucket 0", () => {
    const bucketOf = computeIntensityBuckets({});
    expect(bucketOf("2026-07-01")).toBe(0);
  });

  it("a day absent from the map is bucket 0, same as an explicit zero", () => {
    const bucketOf = computeIntensityBuckets({ "2026-07-01": 500 });
    expect(bucketOf("2026-07-02")).toBe(0);
  });
});

describe("heatmapMonthLabels", () => {
  it("one label per week column; only the first week of a new month carries text", () => {
    const weeks = buildHeatmapCells({}, FIXED_TODAY);
    const labels = heatmapMonthLabels(weeks);
    expect(labels).toHaveLength(weeks.length);
    const nonNull = labels.filter((l): l is string => l !== null);
    // ~12-month window -> 12-13 month-change boundaries; a >365-day window can
    // legitimately re-show the same month abbreviation for a different year
    // at the far edge (no year suffix — accepted cosmetic residual, design
    // has no year-disambiguation requirement), so this checks count, not
    // uniqueness.
    expect(nonNull.length).toBeGreaterThanOrEqual(12);
    expect(nonNull.length).toBeLessThanOrEqual(14);
  });
});

// ── period filter (TASK.158 slice 2, telemetry-track-plan.md §3 S7) ──

describe("PROFILE_PERIODS labels", () => {
  it("pins the sliding-window vocabulary exactly — '7 days'/'30 days', never 'Week'/'Month' (158's own DoD: a calendar word would misdescribe a sliding window and read as a lie on the 1st)", () => {
    expect(PROFILE_PERIODS).toEqual([
      { period: "today", label: "Today" },
      { period: "7d", label: "7 days" },
      { period: "30d", label: "30 days" },
      { period: "all", label: "All" },
    ]);
  });
});

describe("periodStartKey", () => {
  it("'today' at 00:05 local is a 1-day window — just today's own key, no bleed into yesterday", () => {
    const now = new Date(2026, 7, 27, 0, 5); // 2026-08-27 00:05 local
    expect(periodStartKey("today", now)).toBe("2026-08-27");
  });

  it("'today' late at night is still just today, not tomorrow", () => {
    const now = new Date(2026, 7, 27, 23, 55);
    expect(periodStartKey("today", now)).toBe("2026-08-27");
  });

  it("'7d' is a 7-day INCLUSIVE sliding window (today minus 6), not a calendar week", () => {
    const now = new Date(2026, 7, 27, 12, 0);
    expect(periodStartKey("7d", now)).toBe("2026-08-21");
  });

  it("'30d' is a 30-day inclusive sliding window (today minus 29)", () => {
    const now = new Date(2026, 7, 27, 12, 0);
    expect(periodStartKey("30d", now)).toBe("2026-07-29");
  });

  it("'7d' crosses a month boundary correctly", () => {
    const now = new Date(2026, 8, 2, 12, 0); // 2026-09-02
    expect(periodStartKey("7d", now)).toBe("2026-08-27");
  });

  it("'all' has no lower bound", () => {
    expect(periodStartKey("all", new Date(2026, 7, 27))).toBeNull();
  });
});

describe("sumWindow", () => {
  const days: Record<string, ProfileDayStatsView> = {
    "2026-08-01": day({
      tokens: 100,
      runs: 1,
      toolCalls: 2,
      subagentRuns: 0,
      sessions: 1,
      tools: { Bash: 2 },
      models: { "model-a": 100 },
    }),
    "2026-08-02": day({
      tokens: 50,
      runs: 0,
      toolCalls: 1,
      subagentRuns: 1,
      sessions: 0,
      tools: { Read: 1 },
      models: { "(unknown)": 50 },
    }),
    "2026-08-03": day({
      tokens: 200,
      runs: 2,
      toolCalls: 3,
      subagentRuns: 0,
      sessions: 1,
      tools: { Bash: 1, Read: 2 },
      models: { "model-a": 150, "model-b": 50 },
    }),
  };

  it("with startKey null ('all'), sums every bucket — arithmetic + sessions summation", () => {
    const w = sumWindow(days, null);
    expect(w.tokens).toBe(350);
    expect(w.runs).toBe(3);
    expect(w.toolCalls).toBe(6);
    expect(w.subagentRuns).toBe(1);
    expect(w.sessions).toBe(2);
    expect(w.tools).toEqual([
      { name: "Bash", count: 3 },
      { name: "Read", count: 3 },
    ]);
  });

  it("with a startKey, excludes buckets strictly before it (string-compare slicing)", () => {
    const w = sumWindow(days, "2026-08-02");
    expect(w.tokens).toBe(250); // 08-02 + 08-03 only
    expect(w.sessions).toBe(1); // only 08-03's session
  });

  it("(unknown)/(other) model rows sort LAST regardless of token magnitude", () => {
    const w = sumWindow(days, null);
    // model-a (250) > model-b (50) > (unknown) (50, but trailing) — (unknown)
    // ties model-b on tokens yet must still land after it.
    expect(w.models).toEqual([
      { model: "model-a", tokens: 250 },
      { model: "model-b", tokens: 50 },
      { model: "(unknown)", tokens: 50 },
    ]);
  });

  it("an empty days map yields an all-zero summary with empty lists", () => {
    const w = sumWindow({}, null);
    expect(w).toEqual({ tokens: 0, runs: 0, toolCalls: 0, subagentRuns: 0, sessions: 0, tools: [], models: [] });
  });
});

describe("tokensByDay", () => {
  it("projects days -> dayKey/tokens, the heatmap's data source", () => {
    const days: Record<string, ProfileDayStatsView> = {
      "2026-08-01": day({ tokens: 40 }),
      "2026-08-02": day({ tokens: 0 }),
    };
    expect(tokensByDay(days)).toEqual({ "2026-08-01": 40, "2026-08-02": 0 });
  });
});

describe("coverageNotice", () => {
  const now = new Date(2026, 7, 27, 12, 0);

  it("null coverage (never truncated) -> no notice, for any period", () => {
    expect(coverageNotice(null, "2026-08-01", now, 0, "advancing")).toBeNull();
    expect(coverageNotice(null, null, now, 12, "advancing")).toBeNull();
  });

  it("a window starting exactly AT the coverage boundary day -> no notice (fully covered)", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime(); // covers from 2026-08-20
    expect(coverageNotice(coverageStartTs, "2026-08-20", now, 0, "advancing")).toBeNull();
  });

  it("a window starting AFTER the coverage boundary -> no notice", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-25", now, 0, "advancing")).toBeNull();
  });

  it("a window reaching BEFORE the coverage boundary -> names the boundary date", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 0, "advancing")).toBe(
      "History before 2026-08-20 not included — a telemetry file exceeds the per-file limit.",
    );
  });

  it("'all' (startKey null) while truncated -> always notices, regardless of coverage recency", () => {
    const coverageStartTs = new Date(2026, 7, 26, 9, 0).getTime(); // covers from yesterday
    expect(coverageNotice(coverageStartTs, null, now, 0, "advancing")).toBe(
      "History before 2026-08-26 not included — a telemetry file exceeds the per-file limit.",
    );
  });

  // TASK.187 S4 (plan D-2 + catch-up): a backlog is a TEMPORARY cut the pane
  // eats into by itself, a zero backlog with a truncated view is a PERMANENT
  // one behind an oversized file. The copy must never ask for a gesture that
  // is already happening automatically, nor promise self-advance once the
  // progress guard has stopped it.
  it("a backlog that is still being eaten says so itself, and counts the files", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 3, "advancing")).toBe(
      "History before 2026-08-20 not aggregated yet — still collecting (3 files left).",
    );
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 1, "advancing")).toBe(
      "History before 2026-08-20 not aggregated yet — still collecting (1 file left).",
    );
  });

  it("an advancing backlog never asks the user to press anything", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 3, "advancing")).not.toContain("Refresh");
  });

  it("a STOPPED backlog stops promising self-advance and names the gesture instead", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 3, "stalled")).toBe(
      "History before 2026-08-20 not aggregated yet — collection stopped with 3 files left; Refresh to retry.",
    );
  });

  it("the permanent per-file cut reads the same either way — nothing is pending there", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    const permanent = "History before 2026-08-20 not included — a telemetry file exceeds the per-file limit.";
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 0, "advancing")).toBe(permanent);
    expect(coverageNotice(coverageStartTs, "2026-08-01", now, 0, "stalled")).toBe(permanent);
  });

  it("the backlog never resurrects a notice for a window that is already fully covered", () => {
    const coverageStartTs = new Date(2026, 7, 20, 9, 0).getTime();
    expect(coverageNotice(coverageStartTs, "2026-08-25", now, 9, "advancing")).toBeNull();
  });
});

// ── truncated note (TASK.187 S4 — first pin in this string's life: pre-187
//    it was a bare JSX literal, `ProfilePane.tsx:584`) ──

describe("truncatedNoteText", () => {
  it("a backlog being eaten automatically reads as work in progress, with no gesture asked for", () => {
    expect(truncatedNoteText(24_000, "advancing")).toBe(
      "Still aggregating — 24000 files left, filling in automatically.",
    );
    expect(truncatedNoteText(1, "advancing")).toBe("Still aggregating — 1 file left, filling in automatically.");
    expect(truncatedNoteText(24_000, "advancing")).not.toContain("Refresh");
  });

  it("a stopped backlog admits it stopped and names the gesture", () => {
    expect(truncatedNoteText(3, "stalled")).toBe("Aggregation stopped with 3 files left — Refresh to retry.");
    expect(truncatedNoteText(1, "stalled")).toBe("Aggregation stopped with 1 file left — Refresh to retry.");
  });

  it("no backlog left means the missing history is NOT coming — no Refresh promise, either way", () => {
    const permanent = "Stats truncated — a telemetry file is over the per-file scan limit and is never read.";
    expect(truncatedNoteText(0, "advancing")).toBe(permanent);
    expect(truncatedNoteText(0, "stalled")).toBe(permanent);
    expect(permanent).not.toContain("Refresh");
  });
});

// ── collapsed-coverage banner (TASK.187 S4, live-smoke blank) ──

describe("coverageCollapseNoteText", () => {
  it("every reading says the numbers are stale AND why the scan brought nothing", () => {
    for (const progress of ["permanent", "stopped", "retrying"] as const) {
      const text = coverageCollapseNoteText(progress);
      expect(text).toContain("came back empty");
      expect(text).toContain("last successful pass");
    }
  });

  it("the permanent cause names the only thing that fixes it and promises no retry", () => {
    const text = coverageCollapseNoteText("permanent");
    expect(text).toBe(
      "The last scan came back empty — the newest telemetry file is over the per-file scan limit and hides every older file behind it. The numbers below are from the last successful pass and will not change until that file is removed or truncated.",
    );
    expect(text).not.toContain("retries");
    expect(text).not.toContain("Refresh");
  });

  it("only the armed reading promises a pass, and it asks for nothing", () => {
    const text = coverageCollapseNoteText("retrying");
    expect(text).toBe(
      "The last scan came back empty — the newest telemetry file could not be read this pass. The numbers below are from the last successful pass; the next pass retries by itself.",
    );
    expect(text).not.toContain("Refresh");
  });

  it("once the guard has stopped the chain the text stops promising and asks instead", () => {
    const text = coverageCollapseNoteText("stopped");
    expect(text).toBe(
      "The last scan came back empty — the newest telemetry file could not be read, and repeated passes made no progress. The numbers below are from the last successful pass; Refresh to try again.",
    );
    expect(text).not.toContain("retries by itself");
    expect(text).toContain("Refresh");
  });
});

// ── the pane root's data attributes (TASK.187 S4 review round) ──
//
// Phase and catch-up already travel as attributes; the backlog counter did
// not, so the automation probe had to parse "N files left" out of HUMAN
// copy that changed twice in one session. An attribute cannot drift with a
// rewording.

describe("profilePaneDataAttributes", () => {
  const idle = initialProfileLoadState();

  it("carries the phase, and nothing numeric before any view exists", () => {
    expect(profilePaneDataAttributes(idle)).toEqual({ "data-profile-phase": "skeleton" });
  });

  it("publishes the counters the notes quote, as strings, including the zeroes", () => {
    const state = {
      ...idle,
      view: view({ backlogRemaining: 24_000, pendingExactSessions: 2 }),
      source: "fresh" as const,
    };
    expect(profilePaneDataAttributes(state)).toEqual({
      "data-profile-phase": "ready",
      "data-profile-backlog": "24000",
      "data-profile-pending-exact": "2",
    });
    expect(
      profilePaneDataAttributes({ ...state, view: view({ backlogRemaining: 0, pendingExactSessions: 0 }) }),
    ).toMatchObject({ "data-profile-backlog": "0", "data-profile-pending-exact": "0" });
  });

  it("the backlog attribute equals what the rendered notes quote, collapse included", () => {
    // Under the coverage-collapse guard the DISPLAYED view and the last
    // answer disagree; the attribute follows the view, so the probe and the
    // screen can never report different numbers.
    const state = {
      ...idle,
      view: view({ backlogRemaining: 3, pendingExactSessions: 0 }),
      source: "fresh" as const,
      coverageCollapse: { backlogRemaining: 9 },
      lastFreshBacklog: 9,
    };
    expect(profilePaneDataAttributes(state)["data-profile-backlog"]).toBe("3");
    expect(truncatedNoteText(3, "advancing")).toContain("3 files left");
  });

  it("marks a catch-up pass, and only a catch-up pass", () => {
    const catching = {
      ...idle,
      view: view({ backlogRemaining: 5 }),
      source: "fresh" as const,
      inFlight: "refresh" as const,
      autoPass: true,
    };
    expect(profilePaneDataAttributes(catching)["data-profile-catchup"]).toBe("true");
    expect(profilePaneDataAttributes({ ...catching, autoPass: false })["data-profile-catchup"]).toBeUndefined();
    expect(profilePaneDataAttributes({ ...catching, autoPass: false })["data-profile-phase"]).toBe("refreshing");
  });
});

// ── toolbar in-flight line (TASK.187 S4 catch-up) ──

describe("profileBusyNoteText", () => {
  const idle = initialProfileLoadState();

  it("nothing outstanding -> no line at all", () => {
    expect(profileBusyNoteText(idle)).toBeNull();
  });

  it("a cold first collection names itself", () => {
    expect(profileBusyNoteText({ ...idle, inFlight: "mount-fresh" })).toBe("Collecting telemetry…");
  });

  it("a user-driven replacement of existing numbers reads as an update", () => {
    expect(profileBusyNoteText({ ...idle, inFlight: "refresh", view: view(), source: "fresh" })).toBe("Updating…");
  });

  it("an automatic catch-up pass says what is left, so the spinner is not mute", () => {
    expect(
      profileBusyNoteText({
        ...idle,
        inFlight: "refresh",
        autoPass: true,
        source: "fresh",
        view: view({ backlogRemaining: 12_000 }),
      }),
    ).toBe("Catching up — 12000 files left…");
  });
});

// ── provisional activity signal (TASK.187 S4, plan blocker 2в v3) ──

describe("isActivityRefining / PROFILE_REFINING_NOTE", () => {
  it("flags exactly the views whose exact activity pass has not converged", () => {
    expect(isActivityRefining(view({ pendingExactSessions: 0 }))).toBe(false);
    expect(isActivityRefining(view({ pendingExactSessions: 1 }))).toBe(true);
  });

  it("is independent of the file backlog — they are different kinds of incompleteness", () => {
    expect(isActivityRefining(view({ backlogRemaining: 99, pendingExactSessions: 0 }))).toBe(false);
    expect(isActivityRefining(view({ backlogRemaining: 0, pendingExactSessions: 2 }))).toBe(true);
  });

  it("the note calls the figure an estimate and never claims a direction of error", () => {
    expect(PROFILE_REFINING_NOTE).toContain("estimate");
    for (const forbidden of ["overest", "too high", "upper bound", "at most"]) {
      expect(PROFILE_REFINING_NOTE.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("visibleModelRows / PROFILE_MODELS_COLLAPSED_ROWS", () => {
  const models = Array.from({ length: 12 }, (_, i) => ({ model: `m-${i}`, tokens: 12 - i }));

  it("collapsed (not expanded) shows exactly the first PROFILE_MODELS_COLLAPSED_ROWS rows", () => {
    expect(PROFILE_MODELS_COLLAPSED_ROWS).toBe(8);
    const visible = visibleModelRows(models, false);
    expect(visible).toHaveLength(8);
    expect(visible).toEqual(models.slice(0, 8));
  });

  it("expanded shows every row, including the ones past the threshold", () => {
    expect(visibleModelRows(models, true)).toHaveLength(12);
  });

  it("a list at or under the threshold is untouched by either expanded state", () => {
    const small = models.slice(0, 5);
    expect(visibleModelRows(small, false)).toHaveLength(5);
    expect(visibleModelRows(small, true)).toHaveLength(5);
  });
});

// ── telemetry toggle (design §2-D2) ──

describe("nextTelemetryToggleValue", () => {
  it("always flips the CURRENT effective state", () => {
    expect(nextTelemetryToggleValue(view({ telemetryEnabled: false }))).toBe(true);
    expect(nextTelemetryToggleValue(view({ telemetryEnabled: true }))).toBe(false);
  });
});

describe("isTelemetryToggleDisabled", () => {
  it("disabled when there is no view at all (io-error branch)", () => {
    expect(isTelemetryToggleDisabled(null)).toBe(true);
  });

  it("disabled when the env kill-switch is active, regardless of the enabled flag", () => {
    expect(isTelemetryToggleDisabled(view({ killSwitchActive: true, telemetryEnabled: true }))).toBe(true);
    expect(isTelemetryToggleDisabled(view({ killSwitchActive: true, telemetryEnabled: false }))).toBe(true);
  });

  it("enabled otherwise", () => {
    expect(isTelemetryToggleDisabled(view({ killSwitchActive: false }))).toBe(false);
  });
});

describe("isTelemetryToggleHeld", () => {
  it("holds the switch while the user's own write is in flight", () => {
    expect(isTelemetryToggleHeld(view({ killSwitchActive: false }), true)).toBe(true);
    expect(isTelemetryToggleHeld(view({ killSwitchActive: false }), false)).toBe(false);
  });

  it("keeps every pre-existing disabled condition", () => {
    expect(isTelemetryToggleHeld(null, false)).toBe(true);
    expect(isTelemetryToggleHeld(view({ killSwitchActive: true }), false)).toBe(true);
  });
});

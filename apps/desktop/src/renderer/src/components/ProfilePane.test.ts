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
import type { ProfileStatsResult, ProfileStatsView } from "../../../shared/profile-config.js";
import {
  buildHeatmapCells,
  buildProfileTiles,
  computeIntensityBuckets,
  computeProfileBranch,
  formatCompactTokens,
  formatDuration,
  HEATMAP_WEEKS,
  hasProfileData,
  heatmapMonthLabels,
  isTelemetryToggleDisabled,
  nextTelemetryToggleValue,
  topModelRows,
  topToolRows,
} from "./ProfilePane.js";

function view(overrides: Partial<ProfileStatsView> = {}): ProfileStatsView {
  return {
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
  it("any of lifetimeTokens/totalSessions/dailyTokens non-empty counts as data", () => {
    expect(hasProfileData(view())).toBe(false);
    expect(hasProfileData(view({ lifetimeTokens: 1 }))).toBe(true);
    expect(hasProfileData(view({ totalSessions: 1 }))).toBe(true);
    expect(hasProfileData(view({ dailyTokens: { "2026-07-01": 1 } }))).toBe(true);
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

// ── top lists (design §2-D3.8) ──

describe("topToolRows / topModelRows", () => {
  it("caps at 5 tools / 3 models respectively", () => {
    const v = view({
      topTools: Array.from({ length: 8 }, (_, i) => ({ name: `tool-${i}`, count: i })),
      topModels: Array.from({ length: 5 }, (_, i) => ({ model: `model-${i}`, tokens: i })),
    });
    expect(topToolRows(v)).toHaveLength(5);
    expect(topModelRows(v)).toHaveLength(3);
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

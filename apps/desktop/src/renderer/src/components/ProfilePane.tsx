/**
 * Profile settings pane (P7.22/F19 W3, design/slice-P7.22-cut.md §1/§2-D3/
 * §2-D7 W3; period filter + full model list added TASK.158 slice 2): a
 * read-only usage-stats dashboard aggregated from the local telemetry sink —
 * a 5-tile stat strip (ALWAYS lifetime, never filtered), a 12-month "Token
 * activity" daily heatmap (also always the full calendar), a Today/7 days/
 * 30 days/All segmented period control, and — governed by that control — two
 * info columns ("Activity insights" / "Tools" + a full, expandable "Models"
 * list), plus a telemetry enable toggle. Structural sibling of SkillsPane.tsx/
 * SubagentsPane.tsx (same DI/bridge-on-mount shape) but with NO mutable row
 * list — the only mutation surface is the single telemetry toggle (the period
 * control is local UI state, never persisted, never round-tripped to main).
 *
 * REF-PNG INVARIANTS (design §1 — LAW for this wave): tiles row = one
 * bordered strip of 5 equal tiles (big value + muted caption); "Token
 * activity" heatmap = weeks as columns, 7 day-of-week rows, GitHub-style
 * intensity cells, month labels along the bottom, a static "Daily" mode
 * caption top-right (Weekly/Cumulative are a deferred XS follow-up — no dead
 * toggle buttons, design §2-D3). Two columns below the period control:
 * "Activity insights" (label/value rows, period-scoped) and "Tools" (name +
 * "N calls", period-scoped, full list) with the full "Models" list
 * underneath (tokens desc, 8-row collapse + "Show all (N)") as our
 * data-honest substitute for the ref's "Most used plugins" (plugin identity
 * is never recorded — design §0/§2-D3 CUT list). Avatar/
 *
 * EMPTY-STATE MATRIX (design §2-D2, all 4 branches — see
 * `computeProfileBranch`): no-data+disabled -> hero empty-state; data+
 * disabled -> full stats behind a "stats are frozen" banner; data+enabled ->
 * full stats, toggle on; `getStats` refusal (`{ok:false}`) -> the same hero
 * copy plus a small io note (no view to bind the toggle to, so the toggle is
 * simply omitted in that branch — the pane-level Refresh button is the retry
 * affordance).
 *
 * TESTABILITY (mirrors SkillsPane.test.ts/SubagentsPane.test.ts exactly):
 * this package's vitest config runs `environment: "node"` with no jsdom/
 * @testing-library in the tree, so — same as every other Settings pane —
 * there is no mounted-DOM click-simulation test here. Every behavior the
 * gate asks for is instead pinned at the pure-function level: tile/duration/
 * token formatting, the branch matrix, heatmap cell/bucket math, and the
 * toggle's flip/disabled logic (`nextTelemetryToggleValue`/
 * `isTelemetryToggleDisabled`) — the exact values the click handlers below
 * feed into `bridge.setTelemetry`. Wiring-level assurance (does a real click
 * actually call the bridge) is the W4 automation smoke's job, same division
 * of labor as every sibling pane in this directory.
 */
import { useEffect, useState } from "react";
import type {
  ProfileDayStatsView,
  ProfileRevealDirResult,
  ProfileStatsResult,
  ProfileStatsView,
  ProfileTelemetrySetResult,
} from "../../../shared/profile-config.js";
import "../profile-pane.css";

// ── bridge (DI, same ethic as SkillsPane's SkillsBridge) ──

/** Subset of `window.anycode.profile` this pane drives, injectable so tests never touch a real `window`. */
export interface ProfileBridge {
  getStats(): Promise<ProfileStatsResult>;
  setTelemetry(enabled: boolean): Promise<ProfileTelemetrySetResult>;
  revealDir(): Promise<ProfileRevealDirResult>;
}

// ── pure formatters (unit-tested directly — see ProfilePane.test.ts) ──

/**
 * Compact number formatter for large token counts (design §1: "1.1bn",
 * "44m", "12.3k"). Values under 1000 render as-is (rounded to the nearest
 * integer — token counts are never fractional). One decimal place, trailing
 * ".0" stripped so a clean multiple ("44m") never shows a false-precision
 * "44.0m".
 */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  const scales: [number, string][] = [
    [1_000_000_000, "bn"],
    [1_000_000, "m"],
    [1_000, "k"],
  ];
  for (const [divisor, suffix] of scales) {
    if (n >= divisor) {
      const scaled = Math.round((n / divisor) * 10) / 10;
      const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/**
 * Humanized duration for the "Longest task" tile (design §2-D3.3: the
 * MEASUREMENT is a gap-capped active-time span, unchanged by this label
 * change). F5#1b supersedes §2-D3.3's original "session" label choice with
 * "task" — the owner's own reference screenshots read "Longest task", and a
 * resumed task also starts a host, so "task" is the honest vocabulary here.
 * Shows the two most significant units only: hours+minutes once past an
 * hour, otherwise minutes alone, otherwise seconds alone ("2h 41m" / "44m" /
 * "3s") — never three units at once (matches the ref's tile density).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

export interface ProfileTile {
  label: string;
  value: string;
}

/** The 5-tile row, in ref order (design §1.1). `peakDay === null` -> "—", not "0"/NaN — there is no day to report a value for. */
export function buildProfileTiles(view: ProfileStatsView): ProfileTile[] {
  return [
    { label: "Lifetime tokens", value: formatCompactTokens(view.lifetimeTokens) },
    { label: "Peak tokens · 1 day", value: view.peakDay ? formatCompactTokens(view.peakDay.tokens) : "—" },
    { label: "Longest task", value: formatDuration(view.longestSessionMs) },
    { label: "Current streak", value: pluralDays(view.currentStreakDays) },
    { label: "Longest streak", value: pluralDays(view.longestStreakDays) },
  ];
}

// ── empty-state matrix (design §2-D2) ──

export type ProfileBranch = "hero" | "banner" | "normal" | "io-error";

/** True when there is any history to show at all, independent of the current enable flag.
 *  TASK.158 slice 2: reads `days` (the period-filter's own data source) — the
 *  pre-TASK.158 `dailyTokens` map it superseded no longer exists on the wire
 *  (removed S10). */
export function hasProfileData(view: ProfileStatsView): boolean {
  return view.lifetimeTokens > 0 || view.totalSessions > 0 || Object.keys(view.days).length > 0;
}

/**
 * The 4-branch matrix (design §2-D2): a getStats refusal is `io-error`
 * regardless of anything else; otherwise disabled+no-data is the hero empty
 * state, disabled+data is the frozen-stats banner, and enabled is always the
 * normal full render (even with zero history yet — a fresh opt-in shows the
 * real UI with honest zeroes, not a scary hero).
 */
export function computeProfileBranch(result: ProfileStatsResult): ProfileBranch {
  if (!result.ok) {
    return "io-error";
  }
  if (!result.view.telemetryEnabled) {
    return hasProfileData(result.view) ? "banner" : "hero";
  }
  return "normal";
}

// ── heatmap (design §1.2/§2-D3.6: 12-month daily calendar, GitHub-style) ──

export const HEATMAP_WEEKS = 53;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local calendar date key `YYYY-MM-DD`, matching the core aggregator's `dayKey` (design §2-D4: local days for an owner-facing stat). */
function dayKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 5-step intensity bucketing (design §1.2 / dataviz skill sequential-hue
 * ramp): bucket 0 is reserved for zero/absent days; the 4 non-zero buckets
 * are quartile breakpoints over the non-zero daily values actually present,
 * so the scale adapts to each user's own activity range instead of a fixed
 * token threshold that would read as "all empty" for a light user or "all
 * max" for a heavy one.
 */
export function computeIntensityBuckets(dailyTokens: Record<string, number>): (day: string) => number {
  const nonZero = Object.values(dailyTokens)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (nonZero.length === 0) {
    return () => 0;
  }
  const quantile = (p: number): number => nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))]!;
  const t1 = quantile(0.25);
  const t2 = quantile(0.5);
  const t3 = quantile(0.75);
  return (day: string) => {
    const v = dailyTokens[day] ?? 0;
    if (v <= 0) {
      return 0;
    }
    if (v <= t1) {
      return 1;
    }
    if (v <= t2) {
      return 2;
    }
    if (v <= t3) {
      return 3;
    }
    return 4;
  };
}

export interface HeatmapCell {
  /** `YYYY-MM-DD`, or `null` for a padding cell outside the 12-month window (grid-alignment filler). */
  day: string | null;
  tokens: number;
  /** 0-4; always 0 for a padding cell. */
  bucket: number;
}

/**
 * Builds the week-columns x 7-day-rows grid ending on `today` (design §1.2:
 * "weeks as columns, 7 rows"). The window covers the trailing `HEATMAP_DAYS`
 * days, then backs up to the most recent on-or-before Sunday so every column
 * is a full week (leading padding cells render `day: null`, matching the
 * ref's empty gap cells).
 */
export function buildHeatmapCells(dailyTokens: Record<string, number>, today: Date): HeatmapCell[][] {
  const bucketOf = computeIntensityBuckets(dailyTokens);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - (HEATMAP_DAYS - 1));
  const gridStart = new Date(start);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const weeks: HeatmapCell[][] = [];
  const cursor = new Date(gridStart);
  while (cursor <= end) {
    const week: HeatmapCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      if (cursor < start || cursor > end) {
        week.push({ day: null, tokens: 0, bucket: 0 });
      } else {
        const key = dayKeyLocal(cursor);
        const tokens = dailyTokens[key] ?? 0;
        week.push({ day: key, tokens, bucket: bucketOf(key) });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** One label per week column — only the first column of a new month carries text, matching the ref's sparse bottom axis. Fixed English abbreviations (locale-independent, deterministic in tests). */
export function heatmapMonthLabels(weeks: HeatmapCell[][]): (string | null)[] {
  const labels: (string | null)[] = [];
  let lastMonth: string | null = null;
  for (const week of weeks) {
    const firstDay = week.find((c) => c.day !== null)?.day ?? null;
    if (!firstDay) {
      labels.push(null);
      continue;
    }
    const month = firstDay.slice(0, 7);
    if (month !== lastMonth) {
      labels.push(MONTH_ABBR[Number(firstDay.slice(5, 7)) - 1] ?? null);
      lastMonth = month;
    } else {
      labels.push(null);
    }
  }
  return labels;
}

// ── period filter (TASK.158 slice 2, telemetry-track-plan.md §2/§3 S7) ──
//
// Everything below reads ONLY `view.days` — the pre-TASK.158 `dailyTokens`/
// `topTools`/`topModels` top-N/single-map fields no longer exist on the wire
// at all (removed S10; see the module doc on ProfileStatsView). The 5-tile
// row and the heatmap's *window* stay global by design (§158 DoD:
// "ряд из пяти плиток остаётся общим"); everything BELOW the heatmap —
// Activity insights, the tools list, and the full models list — is a pure
// re-slice of `days` governed by the selected period. No IPC round-trip is
// ever involved in a period switch.

export type ProfilePeriod = "today" | "7d" | "30d" | "all";

export const PROFILE_PERIODS: { period: ProfilePeriod; label: string }[] = [
  { period: "today", label: "Today" },
  // Sliding windows, not calendar week/month (158's own DoD: a calendar
  // month reads as broken on the 1st) — the label says "7 days"/"30 days",
  // never "week"/"month", so it never implies a calendar boundary it isn't.
  { period: "7d", label: "7 days" },
  { period: "30d", label: "30 days" },
  { period: "all", label: "All" },
];

/** Local calendar date key `YYYY-MM-DD` — same shape/definition as the core aggregator's `dayKey`, re-declared here for the same zero-cross-module-drift reason `dayKeyLocal` above exists. */
function periodDayKey(d: Date): string {
  return dayKeyLocal(d);
}

/**
 * The inclusive lower bound (a dayKey string) of a period's sliding window,
 * or `null` for "all" (no lower bound). MUST be recomputed every render from
 * a live `now` (158-trap-6) — never memoized without a time dependency, or a
 * pane left open across midnight silently shows yesterday under "Today".
 * Window slicing downstream is a plain STRING comparison (`day >= startKey`)
 * — `YYYY-MM-DD` lexicographic order equals chronological order, so no date
 * parsing is needed in the hot path (158-trap-3's own rationale, reused here).
 */
export function periodStartKey(period: ProfilePeriod, now: Date): string | null {
  if (period === "all") {
    return null;
  }
  const offsetDays = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - offsetDays);
  return periodDayKey(start);
}

export interface ProfileWindowSummary {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  sessions: number;
  tools: { name: string; count: number }[];
  models: { model: string; tokens: number }[];
}

/** Row names the sort below always pushes to the END, regardless of magnitude — a fallback bucket reads as noise, not a leaderboard entry. */
const TRAILING_ROW_NAMES = new Set(["(other)", "(unknown)"]);

/** Shared sort for both tools/models rows: value-desc, name-asc tie-break, with `(other)`/`(unknown)` forced last within their own group. */
function sortRowsDesc<T>(rows: T[], value: (r: T) => number, name: (r: T) => string): T[] {
  const normal = rows.filter((r) => !TRAILING_ROW_NAMES.has(name(r)));
  const trailing = rows.filter((r) => TRAILING_ROW_NAMES.has(name(r)));
  const byValueDesc = (a: T, b: T) => value(b) - value(a) || name(a).localeCompare(name(b));
  normal.sort(byValueDesc);
  trailing.sort(byValueDesc);
  return [...normal, ...trailing];
}

/**
 * Sums every `days[d]` bucket with `d >= startKey` (or every bucket, when
 * `startKey` is `null` — the "all" period) into one window summary — a pure
 * re-projection over already-fetched data, never a new disk/IPC read
 * (158-trap: a period switch must never round-trip to main). `tools`/`models`
 * are full lists (no top-N cut), tokens/count-desc, `(other)`/`(unknown)`
 * rows forced last.
 */
export function sumWindow(days: Record<string, ProfileDayStatsView>, startKey: string | null): ProfileWindowSummary {
  let tokens = 0;
  let runs = 0;
  let toolCalls = 0;
  let subagentRuns = 0;
  let sessions = 0;
  const toolTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();

  for (const [day, stat] of Object.entries(days)) {
    if (startKey !== null && day < startKey) {
      continue;
    }
    tokens += stat.tokens;
    runs += stat.runs;
    toolCalls += stat.toolCalls;
    subagentRuns += stat.subagentRuns;
    sessions += stat.sessions;
    for (const [name, count] of Object.entries(stat.tools)) {
      toolTotals.set(name, (toolTotals.get(name) ?? 0) + count);
    }
    for (const [model, modelTokens] of Object.entries(stat.models)) {
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + modelTokens);
    }
  }

  return {
    tokens,
    runs,
    toolCalls,
    subagentRuns,
    sessions,
    tools: sortRowsDesc(
      [...toolTotals.entries()].map(([name, count]) => ({ name, count })),
      (r) => r.count,
      (r) => r.name,
    ),
    models: sortRowsDesc(
      [...modelTotals.entries()].map(([model, modelTokens]) => ({ model, tokens: modelTokens })),
      (r) => r.tokens,
      (r) => r.model,
    ),
  };
}

/** `dayKey -> tokens` projection of `days`, the heatmap's data source (design §S7 item 4: the heatmap stays the global 12-month calendar, fed by `days`, never by the period filter). */
export function tokensByDay(days: Record<string, ProfileDayStatsView>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [day, stat] of Object.entries(days)) {
    result[day] = stat.tokens;
  }
  return result;
}

/**
 * Honesty plashka for a period whose lower bound reaches past what the scan
 * actually covered (TASK.158 slice 0's `coverageStartTs`): `null` when the
 * scan was never truncated, or when the window's start is on/after the
 * covered boundary; otherwise names the boundary date. `now` is accepted for
 * signature symmetry with `periodStartKey`/`buildHeatmapCells` (every
 * time-dependent helper in this file takes a live clock reference) — the
 * coverage date itself is already fully disambiguated (YYYY-MM-DD includes
 * the year), so nothing here currently branches on it.
 */
export function coverageNotice(coverageStartTs: number | null, startKey: string | null, now: Date): string | null {
  if (coverageStartTs === null) {
    return null;
  }
  const coverageDayKey = periodDayKey(new Date(coverageStartTs));
  if (startKey !== null && startKey >= coverageDayKey) {
    return null;
  }
  return `History before ${coverageDayKey} not included — telemetry folder exceeds the scan budget.`;
}

/** Collapsed row count for the full models list before a "Show all (N)" expander appears (design §S7 item 3). */
export const PROFILE_MODELS_COLLAPSED_ROWS = 8;

export function visibleModelRows(
  models: { model: string; tokens: number }[],
  expanded: boolean,
): { model: string; tokens: number }[] {
  return expanded ? models : models.slice(0, PROFILE_MODELS_COLLAPSED_ROWS);
}

// ── telemetry toggle (design §2-D2) ──

/** The value a toggle click sends — always the flip of the CURRENT effective (user-scope) state. */
export function nextTelemetryToggleValue(view: ProfileStatsView): boolean {
  return !view.telemetryEnabled;
}

/** No view to bind to (io-error branch), or the env kill-switch is active -> the switch renders disabled (design §2-D2c). */
export function isTelemetryToggleDisabled(view: ProfileStatsView | null): boolean {
  return view === null || view.killSwitchActive;
}

// ── component ──

export interface ProfilePaneProps {
  /** Injectable for tests / isolation; defaults to `window.anycode.profile` (same DI ethic as SettingsBridge/SkillsBridge). */
  bridge?: ProfileBridge;
  /**
   * Injectable "today" for a deterministic heatmap/period window; defaults to
   * the real current time. Passed straight through to `ProfileBody` UNCHANGED
   * (never defaulted here with `now ?? new Date()`) — `ProfileBody` is where
   * the default has to be taken, since that's where the period-filter state
   * lives (see its own doc comment for why).
   */
  now?: Date;
}

export function ProfilePane({ bridge = window.anycode.profile, now }: ProfilePaneProps) {
  const [result, setResult] = useState<ProfileStatsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.getStats().then((r) => {
      if (!cancelled) {
        setResult(r);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  async function refresh(): Promise<void> {
    setResult(await bridge.getStats());
  }

  async function toggleTelemetry(view: ProfileStatsView): Promise<void> {
    setResult(await bridge.setTelemetry(nextTelemetryToggleValue(view)));
  }

  async function reveal(): Promise<void> {
    await bridge.revealDir();
  }

  return (
    <section className="settings-section profile-pane">
      <div className="profile-pane-toolbar">
        <button type="button" className="settings-button profile-refresh-button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {!result ? (
        <div className="settings-mcp-empty">Loading profile…</div>
      ) : (
        <ProfileBody result={result} now={now} onToggle={toggleTelemetry} onReveal={reveal} />
      )}
    </section>
  );
}

interface ProfileBodyProps {
  result: ProfileStatsResult;
  /** Injectable for deterministic tests; production always omits this and gets a fresh clock read below. */
  now?: Date;
  onToggle: (view: ProfileStatsView) => void;
  onReveal: () => void;
}

function ProfileBody({ result, now, onToggle, onReveal }: ProfileBodyProps) {
  // Hooks must run unconditionally on every render (Rules of Hooks) — the
  // hero/io-error early return below never reads either, but both still have
  // to be called ahead of it.
  const [period, setPeriod] = useState<ProfilePeriod>("all");
  const [modelsExpanded, setModelsExpanded] = useState(false);

  // MUST be read fresh on every render of THIS component, not passed down
  // already-resolved from `ProfilePane` (158-trap-6, review fix): `period`/
  // `modelsExpanded` state live HERE, so clicking a period button re-renders
  // only `ProfileBody` — it does NOT re-render `ProfilePane` above it (React
  // only re-renders the subtree whose own state changed). If `now` were
  // computed once in `ProfilePane` and threaded down as a resolved prop, a
  // click after the last data fetch would keep reusing that stale timestamp:
  // pane opened 23:58, left open, "Today" clicked at 00:05 next day would
  // still resolve yesterday's dayKey — exactly the bug the plan's "Отвергнуто"
  // section rejected building-in-main to avoid. Reading `new Date()` HERE
  // means every one of those re-renders (period click, expand click, a fresh
  // fetch) sees the real current instant.
  const effectiveNow = now ?? new Date();

  const branch = computeProfileBranch(result);
  const view = result.ok ? result.view : null;

  if (branch === "hero" || branch === "io-error") {
    return (
      <div className="profile-empty-hero" data-profile-branch={branch}>
        <p className="profile-empty-title">No usage stats yet — telemetry is off</p>
        <p className="profile-empty-privacy">
          Local, opt-in — records are counts and enums only, never prompts, code, or file contents.
        </p>
        {branch === "io-error" && (
          <p className="profile-io-note">Couldn't read the telemetry folder — showing an empty view.</p>
        )}
        {view && <TelemetryToggleBlock view={view} onToggle={() => onToggle(view)} onReveal={onReveal} />}
      </div>
    );
  }

  // branch is "banner" or "normal" here, so `view` is non-null (result.ok).
  const v = view!;
  // Window bounds derive from `effectiveNow` (fresh every render — see its
  // own doc comment above) — never memoized without that time dependency.
  // Switching `period` re-renders through this same path with no IPC call —
  // `v.days` was already fetched.
  const startKey = periodStartKey(period, effectiveNow);
  const windowSummary = sumWindow(v.days, startKey);
  // `coverageStartTs` is a required `number | null` on the wire type (S10) —
  // no absent case left to normalize here.
  const notice = coverageNotice(v.coverageStartTs, startKey, effectiveNow);

  return (
    <>
      {branch === "banner" && (
        <div className="profile-banner" role="status">
          Telemetry is off — stats are frozen
        </div>
      )}
      {v.truncated && <p className="profile-truncated-note">Stats truncated (very large telemetry dir).</p>}
      <TilesRow view={v} />
      <TokenActivitySection view={v} today={effectiveNow} />
      <PeriodControl period={period} onChange={setPeriod} />
      {notice && <p className="profile-coverage-notice">{notice}</p>}
      <div className="profile-columns">
        <ActivityInsights summary={windowSummary} engineTokens={v.engineTokens} />
        <ToolsAndModelsColumn
          summary={windowSummary}
          modelsExpanded={modelsExpanded}
          onToggleModelsExpanded={() => setModelsExpanded((e) => !e)}
        />
      </div>
      <TelemetryToggleBlock view={v} onToggle={() => onToggle(v)} onReveal={onReveal} />
    </>
  );
}

/** Segmented Today / 7 days / 30 days / All control (design §S7 item 4) — a pure client-side re-render, never an IPC call. */
function PeriodControl({ period, onChange }: { period: ProfilePeriod; onChange: (period: ProfilePeriod) => void }) {
  return (
    <div className="profile-period-control" role="group" aria-label="Stats period">
      {PROFILE_PERIODS.map((p) => (
        <button
          key={p.period}
          type="button"
          className={`profile-period-button${p.period === period ? " profile-period-button-active" : ""}`}
          aria-pressed={p.period === period}
          onClick={() => onChange(p.period)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function TilesRow({ view }: { view: ProfileStatsView }) {
  return (
    <div className="profile-tiles-row" role="list" aria-label="Usage stat tiles">
      {buildProfileTiles(view).map((tile) => (
        <div className="profile-tile" role="listitem" key={tile.label}>
          <div className="profile-tile-value">{tile.value}</div>
          <div className="profile-tile-caption">{tile.label}</div>
        </div>
      ))}
    </div>
  );
}

function TokenActivitySection({ view, today }: { view: ProfileStatsView; today: Date }) {
  // The heatmap stays the GLOBAL 12-month calendar, unfiltered by the period
  // control below it (design §S7 item 4) — fed by `days` via `tokensByDay`.
  const weeks = buildHeatmapCells(tokensByDay(view.days), today);
  const monthLabels = heatmapMonthLabels(weeks);
  return (
    <section className="profile-heatmap-section">
      <div className="profile-heatmap-header">
        <span className="settings-section-title">Token activity</span>
        {/* Daily mode only in v1 — Weekly/Cumulative are a deferred XS follow-up (design §2-D3.6): a static caption, not a dead toggle. */}
        <span className="profile-heatmap-mode">Daily</span>
      </div>
      <div className="profile-heatmap-grid">
        {weeks.map((week, wi) => (
          <div className="profile-heatmap-col" key={wi}>
            {week.map((cell, di) => (
              <div
                key={di}
                className={`profile-heatmap-cell profile-heatmap-bucket-${cell.bucket}`}
                data-profile-heatmap-day={cell.day ?? undefined}
                title={cell.day ? `${cell.day} · ${cell.tokens} tokens` : undefined}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="profile-heatmap-months">
        {monthLabels.map((label, i) => (
          <span key={i} className="profile-heatmap-month">
            {label ?? ""}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Activity insights (design §S7 item 4) — every row here is a re-slice of the SELECTED period's `ProfileWindowSummary`, never the lifetime scalars the tiles row above uses. */
function ActivityInsights({
  summary,
  engineTokens,
}: {
  summary: ProfileWindowSummary;
  engineTokens: Record<string, number>;
}) {
  const rows: [string, string][] = [
    ["Tokens in period", formatCompactTokens(summary.tokens)],
    ["Total tasks", String(summary.sessions)],
    ["Total runs", String(summary.runs)],
    ["Tool calls", String(summary.toolCalls)],
    ["Subagent runs", String(summary.subagentRuns)],
    ["Most used model", summary.models[0]?.model ?? "—"],
  ];
  // engineTokens is session-scoped LIFETIME accounting (no per-day breakdown
  // exists in the aggregate) — this row is deliberately always the full
  // history, never re-sliced by the period control above it.
  const engineEntries = Object.entries(engineTokens).filter(([, tokens]) => tokens > 0);
  return (
    <div className="profile-insights">
      <div className="settings-section-title">Activity insights</div>
      {rows.map(([label, value]) => (
        <div className="profile-insight-row" key={label}>
          <span className="profile-insight-label">{label}</span>
          <span className="profile-insight-value">{value}</span>
        </div>
      ))}
      {engineEntries.length > 0 && (
        <div className="profile-engines-row">
          Engines (lifetime): {engineEntries.map(([engine, tokens]) => `${engine} ${formatCompactTokens(tokens)}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

/**
 * Tools + full models list (design §S7 items 3/4): the tools `<ul>` keeps
 * its exact pre-existing markup/classes (automation.ts's no-touch DOM
 * contract reads it as the FIRST `.profile-top-tools ul.profile-top-list`)
 * — it's simply unbounded now (no `.slice(0, 5)` cut) since `sumWindow`
 * already returns the full per-window list. The models list below it is new
 * markup (`profile-pane.css` classes only) with an 8-row collapse + "Show
 * all (N)" expander, `k3`-style long tails included.
 */
function ToolsAndModelsColumn({
  summary,
  modelsExpanded,
  onToggleModelsExpanded,
}: {
  summary: ProfileWindowSummary;
  modelsExpanded: boolean;
  onToggleModelsExpanded: () => void;
}) {
  const visibleModels = visibleModelRows(summary.models, modelsExpanded);
  return (
    <div className="profile-top-tools">
      <div className="settings-section-title">Tools</div>
      {summary.tools.length === 0 ? (
        <div className="settings-mcp-empty">No tool calls recorded yet.</div>
      ) : (
        <ul className="profile-top-list">
          {summary.tools.map((t) => (
            <li key={t.name} className="profile-top-row">
              <span className="settings-mcp-name">{t.name}</span>
              <span className="profile-top-count">
                {t.count} call{t.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-section-title profile-models-title">Models</div>
      {summary.models.length === 0 ? (
        <div className="settings-mcp-empty">No model usage recorded yet.</div>
      ) : (
        <>
          <ul className="profile-models-list">
            {visibleModels.map((m) => (
              <li key={m.model} className="profile-model-row">
                <span className="profile-model-name">{m.model}</span>
                <span className="profile-model-tokens">{formatCompactTokens(m.tokens)}</span>
              </li>
            ))}
          </ul>
          {summary.models.length > PROFILE_MODELS_COLLAPSED_ROWS && (
            <button
              type="button"
              className="settings-button profile-show-all-models"
              onClick={onToggleModelsExpanded}
            >
              {modelsExpanded ? "Show less" : `Show all (${summary.models.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function TelemetryToggleBlock({
  view,
  onToggle,
  onReveal,
}: {
  view: ProfileStatsView;
  onToggle: () => void;
  onReveal: () => void;
}) {
  const disabled = isTelemetryToggleDisabled(view);
  return (
    <div className="profile-telemetry-block settings-field-row">
      <button
        type="button"
        role="switch"
        aria-checked={view.telemetryEnabled}
        aria-label={view.telemetryEnabled ? "Disable telemetry" : "Enable telemetry"}
        className={`settings-switch${view.telemetryEnabled ? " settings-switch-on" : ""}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="settings-switch-thumb" />
      </button>
      <div className="profile-telemetry-copy">
        <span className="settings-switch-caption">
          Telemetry {view.telemetryEnabled ? "on" : "off"} — applies to newly started tasks.
        </span>
        <span className="profile-telemetry-note">
          A project .anycode/config.json telemetry section overrides this per workspace.
        </span>
        {view.killSwitchActive && (
          <span className="profile-telemetry-note profile-telemetry-killswitch">
            Disabled by ANYCODE_TELEMETRY env kill-switch.
          </span>
        )}
        <div className="profile-telemetry-reveal-row">
          <button type="button" className="settings-button profile-reveal-button" onClick={onReveal}>
            Reveal telemetry folder
          </button>
          <span className="profile-telemetry-dir">{view.dir}</span>
        </div>
      </div>
    </div>
  );
}

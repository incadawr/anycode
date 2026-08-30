/**
 * Profile stats control-plane contract (design slice-P7.22-cut.md §2-D5 W2).
 * Five additive invoke channels between main and the renderer for the
 * Settings "Profile" pane: read the aggregated usage-stats view, read the
 * cached view without scanning, rebuild the cache from scratch (both
 * TASK.187 S3), toggle the user-scope `telemetry.enabled` flag, and reveal
 * the resolved telemetry sink directory in the OS file manager.
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/skills-config.ts:
 * it is imported by preload (sandboxed CJS), the renderer web bundle, AND
 * main, so it must never drag zod or the @anycode/core barrel into a bundle
 * that cannot afford it. Request validation lives in main/profile-ipc.ts (main
 * is the trust boundary), not here.
 *
 * Host↔ui wire delta: ZERO — these are independent invoke-channel
 * registrations, not a HostToUiMessage/AgentEvent variant, so there is no
 * exhaustive-`never` hazard and no protocol-fixture fallout.
 *
 * PATH CUSTODY: the renderer NEVER supplies a filesystem path in any request
 * below — `profile-stats-get`/`profile-reveal-dir` carry no payload at all
 * (main resolves the user-scope dir itself from its own home + config read),
 * and `profile-telemetry-set` carries only a boolean. `ProfileStatsView.dir`
 * DOES cross to the renderer (display-only, same trusted-config custody class
 * as the MCP pane's `cwd` / the skills pane's `SkillRowView.path` — the user's
 * own resolved directory, needed for the pane's "reveal" affordance) but is
 * never accepted back as a request field.
 */

// ── invoke channels (5, additive — independent registrations, no union exhaustiveness) ──

/** invoke channel: read the aggregated Profile-stats view for the current user. */
export const PROFILE_STATS_GET_CHANNEL = "anycode:profile-stats-get";

/**
 * invoke channel (TASK.187 S3): the INSTANT view — whatever the on-disk
 * aggregation cache already holds, with NO directory scan at all. Answers in
 * milliseconds on a warm cache where `profile-stats-get` still has to lstat
 * every sink file; the renderer fires both on mount and lets the fresh one
 * supersede the cached one.
 */
export const PROFILE_STATS_CACHED_CHANNEL = "anycode:profile-stats-cached";

/**
 * invoke channel (TASK.187 S3): drop the aggregation cache and start over.
 * The rebuild is a NORMAL incremental pass from an empty cache, cut by the
 * SAME per-pass budgets — it answers quickly with an honest
 * `backlogRemaining` and catches up over the next few refreshes. Rebuilding
 * the whole directory in one call would reintroduce exactly the 16-second
 * block this task removes.
 */
export const PROFILE_STATS_REBUILD_CHANNEL = "anycode:profile-stats-rebuild";

/** invoke channel: toggle the user-scope `telemetry.enabled` flag. */
export const PROFILE_TELEMETRY_SET_CHANNEL = "anycode:profile-telemetry-set";

/** invoke channel: reveal the resolved telemetry sink directory in the OS file manager. */
export const PROFILE_REVEAL_DIR_CHANNEL = "anycode:profile-reveal-dir";

// ── shared vocabulary ──

export type ProfileRefusalReason = "invalid" | "io_error";

/**
 * One day's slice of the `days` aggregate (TASK.158 slice 1/2, telemetry-
 * track-plan.md §2.6) — hand-mirrors `packages/core/src/telemetry/stats.ts`'s
 * `ProfileDayStats` byte-for-byte (same zero-import constraint as the module
 * doc above: no importing the core type).
 */
export interface ProfileDayStatsView {
  tokens: number;
  runs: number;
  toolCalls: number;
  subagentRuns: number;
  /** Sessions whose FIRST record (min ts) falls on this day. */
  sessions: number;
  /** Tool name -> calls that day. */
  tools: Record<string, number>;
  /** Model -> tokens that day (deferred join, see stats.ts). */
  models: Record<string, number>;
}

/**
 * Renderer-facing usage-stats view (design §2-D5): the core `ProfileStats`
 * shape (redeclared structurally here — this module has ZERO imports, so it
 * cannot import the type from `@anycode/core/telemetry-admin`; main/profile-
 * ipc.ts is responsible for keeping this in sync with `packages/core/src/
 * telemetry/stats.ts`'s `ProfileStats`) plus the three D2 toggle/status
 * fields main resolves alongside the scan.
 *
 * S10 (telemetry-track-plan.md's final cleanup step) removed the pre-
 * TASK.158 `dailyTokens`/`topTools`/`topModels` top-N/single-map fields these
 * superseded — `main/profile-ipc.ts`'s `toView` no longer spreads them (its
 * source, `packages/core/src/telemetry/stats.ts`'s `ProfileStats`, dropped
 * them too), and the period-filtered renderer below has read `days`/`models`/
 * `engineTokens` exclusively since S7. There is no wire back-compat concern:
 * this whole channel is main<->renderer only, both sides ship together.
 */
export interface ProfileStatsView {
  lifetimeTokens: number;
  peakDay: { day: string; tokens: number } | null;
  longestSessionMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  totalSessions: number;
  totalRuns: number;
  toolCalls: number;
  subagentRuns: number;
  /** True when the scan stopped early on the byte cap (design §2-D1). */
  truncated: boolean;
  /**
   * Earliest event `ts` in the oldest file actually included in the scan
   * (falls back to that file's `mtimeMs` only when its first line has no
   * usable `ts` — TASK.169), when `truncated` is true; `null` when not
   * truncated (TASK.158 slice 0 — honest lower bound of what a period filter
   * can trust). REQUIRED (S10): `main/profile-ipc.ts`'s `toView` now sets
   * this field inside its own returned object literal (no post-construction
   * assignment left to appease an optional type), so the type can guarantee
   * the coverage boundary is never silently dropped by a future producer
   * that forgets to set it.
   */
  coverageStartTs: number | null;
  /**
   * TASK.187 S3 (D-2): REACHABLE sink files still waiting to be aggregated —
   * the backlog the next pass (panel open / Refresh) will eat into. `0` with
   * `truncated: true` means the missing history is NOT coming: it sits behind
   * a file over the per-file size ceiling, which is a permanent cut, and the
   * UI must not promise that Refresh will fetch it. REQUIRED, not optional:
   * both producers fill it, so no future one can silently drop the number.
   */
  backlogRemaining: number;
  /**
   * TASK.187 S3: how many sessions spanning several files still have a
   * PROVISIONAL `longestSessionMs` contribution — the exact second pass over
   * their participant files has not finished within the pass budgets yet. The
   * provisional figure can sit either side of the truth (the bridge formula
   * neither bounds nor signs its error), so the UI shows activity as "still
   * being refined" rather than as final while this is non-zero. Independent
   * of `backlogRemaining`, which talks about unread FILES and says nothing
   * about activity precision.
   */
  pendingExactSessions: number;
  /** dayKey (same `dayKey(ts)` call as the core aggregator) -> that day's stats. TASK.158 slice 2: the period filter's only data source below the heatmap. */
  days: Record<string, ProfileDayStatsView>;
  /** FULL model list (no top-N cut), tokens desc then name. Absent `engine` means every session attributed to that model was core (no engine boot). */
  models: { model: string; tokens: number; sessions: number; engine?: "codex" | "claude" }[];
  /** "core" | "codex" | "claude" -> LIFETIME tokens attributed to that engine (session-scoped, not day-bucketed — always the full-history total, never filtered by period). */
  engineTokens: Record<string, number>;
  /** Effective USER-scope resolution (§2-D2) — never per-tab, never a project override. */
  telemetryEnabled: boolean;
  /** True when the `ANYCODE_TELEMETRY` env kill-switch is active (toggle rendered disabled). */
  killSwitchActive: boolean;
  /** The resolved scan directory (display-only, reveal-affordance custody — see module doc). */
  dir: string;
}

/** Response of profile-stats-get / profile-telemetry-set: a fresh view, or a typed refusal. */
export type ProfileStatsResult =
  | { ok: true; view: ProfileStatsView }
  | { ok: false; reason: ProfileRefusalReason };

/**
 * Response of profile-stats-cached (TASK.187 S3): a view rebuilt from the
 * cache alone, or an honest refusal. `no_cache` is not an error — it is the
 * normal answer before the first pass has ever completed, or right after the
 * cache file was deleted; the renderer simply waits for the fresh view. The
 * reason set is deliberately its own type: `ProfileRefusalReason` describes
 * request-shaped failures and gains nothing from a "there is nothing cached"
 * member.
 */
export type ProfileStatsCachedResult =
  | { ok: true; view: ProfileStatsView }
  | { ok: false; reason: "no_cache" | "io_error" };

export interface ProfileTelemetrySetRequest {
  enabled: boolean;
}

/** Same shape as ProfileStatsResult — a successful toggle returns a fresh view (D2: "applies to newly started tasks" is a display hint, not a stale-view problem). */
export type ProfileTelemetrySetResult = ProfileStatsResult;

/** Reveal has no view to return on success — just an ok/refusal. */
export type ProfileRevealDirResult = { ok: true } | { ok: false; reason: ProfileRefusalReason };

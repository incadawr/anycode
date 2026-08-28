/**
 * Profile stats control-plane contract (design slice-P7.22-cut.md §2-D5 W2).
 * Three additive invoke channels between main and the renderer for the
 * Settings "Profile" pane: read the aggregated usage-stats view, toggle the
 * user-scope `telemetry.enabled` flag, and reveal the resolved telemetry sink
 * directory in the OS file manager.
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

// ── invoke channels (3, additive — independent registrations, no union exhaustiveness) ──

/** invoke channel: read the aggregated Profile-stats view for the current user. */
export const PROFILE_STATS_GET_CHANNEL = "anycode:profile-stats-get";

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

export interface ProfileTelemetrySetRequest {
  enabled: boolean;
}

/** Same shape as ProfileStatsResult — a successful toggle returns a fresh view (D2: "applies to newly started tasks" is a display hint, not a stale-view problem). */
export type ProfileTelemetrySetResult = ProfileStatsResult;

/** Reveal has no view to return on success — just an ok/refusal. */
export type ProfileRevealDirResult = { ok: true } | { ok: false; reason: ProfileRefusalReason };

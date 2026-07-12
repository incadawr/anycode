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
 * Renderer-facing usage-stats view (design §2-D5): the core `ProfileStats`
 * shape (redeclared structurally here — this module has ZERO imports, so it
 * cannot import the type from `@anycode/core/telemetry-admin`; main/profile-
 * ipc.ts is responsible for keeping this in sync with `packages/core/src/
 * telemetry/stats.ts`'s `ProfileStats`) plus the three D2 toggle/status
 * fields main resolves alongside the scan.
 */
export interface ProfileStatsView {
  lifetimeTokens: number;
  peakDay: { day: string; tokens: number } | null;
  longestSessionMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  /** dayKey -> total tokens (usage records only). */
  dailyTokens: Record<string, number>;
  totalSessions: number;
  totalRuns: number;
  toolCalls: number;
  subagentRuns: number;
  topTools: { name: string; count: number }[];
  topModels: { model: string; tokens: number }[];
  /** True when the scan stopped early on the byte cap (design §2-D1). */
  truncated: boolean;
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

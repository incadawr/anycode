/**
 * Main-safe telemetry admin barrel (subpath `@anycode/core/telemetry-admin`,
 * design slice-P7.22-cut.md §2-D4). Re-exports the Profile-stats aggregator,
 * the user-scope enable patcher, and `loadTelemetryConfig` for user-scope
 * resolution (§2-D2: `loadTelemetryConfig(fs, home, home, env)`).
 *
 * ⚠ NO ai-SDK imports: the Electron main process imports telemetry admin ONLY
 * through this subpath so it never drags the full `@anycode/core` barrel (and
 * the ai-SDK with it). `stats.ts` imports only ports/telemetry.js types (via
 * doc reference, no runtime import) plus the two types/config.js constants;
 * `settings.ts` imports only ports/file-system.js + util/config-file.js —
 * verified clean of ai-SDK/loop.
 */

export { aggregateProfileStats } from "./stats.js";
export type { ProfileStats, ProfileDayStats, ProfileStatsFile, AggregateProfileStatsOptions } from "./stats.js";
/** TASK.187 S2: the per-file partial + merge path the incremental cache in main
 *  is built on (semantics: working-docs/build/task187-aggregator-semantics.md).
 *  `collectSessionTimestamps` + `sessionActiveMs` are the exact second pass for
 *  a session whose per-file segments overlap. */
export { aggregateFilePartial, mergeProfilePartials, collectSessionTimestamps, sessionActiveMs } from "./stats.js";
/** TASK.187 S3: the cumulative form of the exact second pass. Cluster state is
 *  what the incremental cache carries between passes, so a session with more
 *  participant files than one pass can open still converges. */
export { mergeActivityClusters, clustersActiveMs } from "./stats.js";
export type { ActivityCluster } from "./stats.js";
export type {
  ProfileFilePartial,
  ProfileFilePartialSession,
  ProfileFilePartialDay,
  AggregateFilePartialOptions,
  NamedProfileFilePartial,
  CrossFileSession,
  MergeProfilePartialsOptions,
  MergeProfilePartialsResult,
} from "./stats.js";
export { setUserTelemetryEnabled, userTelemetryConfigPath } from "./settings.js";
export { loadTelemetryConfig } from "./config.js";
export type { LoadedTelemetryConfig, ResolvedTelemetryConfig, TelemetryConfigEntry } from "./config.js";
/** Byte-accurate scan cap (W5-FIX finding 1): main resolves REAL file sizes via
 *  lstat, so the byte-accurate gate belongs in the IPC scan, not just the
 *  aggregator's post-read char-based secondary guard. */
export {
  PROFILE_STATS_MAX_SCAN_BYTES,
  PROFILE_STATS_MAX_NEW_READS_PER_PASS,
  PROFILE_STATS_CACHE_MAX_BYTES,
} from "../types/config.js";

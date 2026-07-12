/** Barrel for the hand-written Telemetry core (slice 6.6). */

export { loadTelemetryConfig, telemetryConfigSchema } from "./config.js";
export type { LoadedTelemetryConfig, ResolvedTelemetryConfig, TelemetryConfigEntry } from "./config.js";
export { buildTelemetryTap, telemetryRecordFor } from "./records.js";

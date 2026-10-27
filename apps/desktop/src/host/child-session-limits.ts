/**
 * GitHub #17 slice B: the HOST-side read of the shared
 * effective per-parent child cap. Main remains the admission authority; this
 * host-local read is only an early-refusal optimization so a same-step burst
 * of detached spawns is refused before it ever reaches main. It must agree
 * with main's own resolution, so both call the SAME shared resolver
 * (`shared/session-limits.ts`) over the same two inputs: the session setting
 * section and an EXPLICIT selected role profile's `maxParallelChildren`.
 */
import { readFileSync } from "node:fs";
import { parseSettings } from "../settings/schema.js";
import { resolveProfileRoles } from "../shared/role-profiles.js";
import { resolveChildSessionsPerParentMax, SESSION_LIMIT_RANGES } from "../shared/session-limits.js";

/**
 * Reads the resolved settings file (NOT a new home-directory search) and
 * returns the effective per-parent child cap. Missing/unreadable/invalid file
 * returns the shared default (3); a role profile with no explicit
 * `maxParallelChildren` leaves the session setting (or default) unchanged.
 */
export function readChildSessionsPerParentMax(path: string, projectRoot: string): number {
  try {
    const parsed = parseSettings(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.status !== "ok") {
      return SESSION_LIMIT_RANGES.childSessionsPerParentMax.default;
    }
    const roles = resolveProfileRoles(parsed.settings, projectRoot);
    return resolveChildSessionsPerParentMax(parsed.settings.sessionLimits, roles?.maxParallelChildren);
  } catch {
    return SESSION_LIMIT_RANGES.childSessionsPerParentMax.default;
  }
}

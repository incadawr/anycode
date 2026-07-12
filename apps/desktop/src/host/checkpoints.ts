/**
 * Desktop host checkpoint-capture wiring (slice P7.26/R1, design
 * slice-P7.26-cut.md §3). Factored out of host/index.ts (which touches
 * process.parentPort at module load and so cannot be imported by a unit) so the
 * gate is testable in isolation, mirroring the sibling host helpers
 * (permission-broker.ts / git-bridge.ts / snapshot-hook.ts).
 *
 * Mirrors the CLI's construction contract (cli/main.ts checkpointService): the
 * per-workspace ShadowGitCheckpoints service is built ONLY when the execution
 * port can spawn a binary (runBinary). Without runBinary every capture would
 * self-disable on the first turn anyway (shadow-git.ts NO_RUNBINARY_REASON), so
 * returning null keeps the loop's checkpoint arc dormant and the turn
 * byte-identical to pre-wiring — no service handle, no git spawn. The returned
 * service is lazy: it performs zero I/O until its first capture (git-dir init +
 * add/write-tree/commit-tree happen on demand), so boot is never slowed.
 */

import { ShadowGitCheckpoints, type ShadowGitCheckpointsOptions } from "@anycode/core";

export function buildCheckpointService(opts: ShadowGitCheckpointsOptions): ShadowGitCheckpoints | null {
  return typeof opts.exec.runBinary === "function" ? new ShadowGitCheckpoints(opts) : null;
}

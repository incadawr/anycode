/**
 * Main-owned cleanup for a POSIX process group reported by the current host
 * generation. C2 intentionally has no Windows implementation: W0 does not
 * provide equivalent tree-cleanup evidence there.
 */

import { SIGKILL_GRACE_MS } from "@anycode/core";
import type { EngineProcessRegistration } from "../shared/engines.js";

export interface EngineReaperDeps {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  schedule?: (fn: () => void, delayMs: number) => void;
}

/**
 * Returns an idempotent reaper. `pgid` is only used on POSIX where the client
 * starts its app-server in a dedicated detached group (pid === pgid).
 */
export function createEngineProcessReaper(deps: EngineReaperDeps = {}): (registration: EngineProcessRegistration) => void {
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const schedule = deps.schedule ?? ((fn, delayMs) => { setTimeout(fn, delayMs); });
  const reaped = new Set<string>();

  return (registration) => {
    if (platform === "win32") return;
    const key = `${registration.hostPid}:${registration.generation}:${registration.pgid}`;
    if (reaped.has(key)) return;
    reaped.add(key);
    const group = -registration.pgid;
    try {
      kill(group, "SIGTERM");
    } catch {
      // ESRCH means the direct child already self-exited; still retain the key
      // so a duplicate stale exit cannot signal a reused process group.
      return;
    }
    schedule(() => {
      try {
        kill(group, "SIGKILL");
      } catch {
        // A clean SIGTERM exit is the expected path.
      }
    }, SIGKILL_GRACE_MS);
  };
}

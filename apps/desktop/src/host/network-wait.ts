/**
 * Host-side network waiting (Taskana 4772). One desktop-wide waiter is handed
 * to every model port this host builds (host/index.ts). It answers probes with
 * the core TCP reachability check and is woken by two sources: the main process
 * forwards OS connectivity hints (`anycode:network-hint`), and the renderer's
 * Retry-now control reaches session.ts, which calls wakeNetworkWaiters().
 */

import { performance } from "node:perf_hooks";
import { tcpReachable, type NetworkWaiter } from "@anycode/core";

const hintListeners = new Set<() => void>();

/** Wakes every turn that is parked waiting for the network (OS hint or Retry now). */
export function wakeNetworkWaiters(): void {
  for (const listener of [...hintListeners]) listener();
}

export const desktopNetworkWaiter: NetworkWaiter = {
  probe: (baseUrl, signal) => tcpReachable(baseUrl, 3_000, { signal }),
  onHint(listener) {
    hintListeners.add(listener);
    return () => {
      hintListeners.delete(listener);
    };
  },
  monotonicNow: () => performance.now(),
};

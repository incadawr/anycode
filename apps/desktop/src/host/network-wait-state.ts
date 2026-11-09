import type { AgentEvent, ProviderFailureCode } from "@anycode/core";
import type { SessionNetworkWait } from "../shared/communication.js";

/** Exhaustive over core's codes: adding a failure code is a compile error here, not a silently dropped value. */
const safeCodeTable: Record<ProviderFailureCode, true> = {
  proxy_unreachable: true, proxy_auth: true, tls: true, connect_timeout: true, network: true, rate_limited: true,
  auth: true, forbidden: true, server: true, quota: true, input_limit: true, unknown: true,
};
const safeCodes: ReadonlySet<string> = new Set(Object.keys(safeCodeTable));

export class NetworkWaitState {
  private readonly waits = new Map<string, SessionNetworkWait>();
  /** Ids already ended this turn: a late duplicate start must not resurrect a finished episode. */
  private readonly ended = new Set<string>();

  observe(event: AgentEvent): boolean {
    if (event.type === "waiting_for_network") {
      // Events without a waitId share one key, so only the first such start per turn is tracked.
      const id = event.waitId ?? "";
      if (this.waits.has(id) || this.ended.has(id)) return false;
      this.waits.set(id, {
        source: event.waitSource ?? "parent",
        ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
        ...(event.deadlineAt !== undefined ? { deadlineAt: event.deadlineAt } : {}),
        ...(event.failureCode && safeCodes.has(event.failureCode) ? { failureCode: event.failureCode } : {}),
      });
      return true;
    }
    if (event.type === "network_wait_end") {
      if (!this.waits.delete(event.waitId)) return false;
      this.ended.add(event.waitId);
      return true;
    }
    if (event.type === "loop_end" && this.waits.size > 0) { this.clear(); return true; }
    return false;
  }

  clear(): void { this.waits.clear(); this.ended.clear(); }
  /** Earliest active episode; episodes without a startedAt sort last. */
  get summary(): SessionNetworkWait | undefined {
    return [...this.waits.values()].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))[0];
  }
}
